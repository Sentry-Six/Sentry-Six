//! macOS: hardware H.264 / H.265 encoding with VideoToolbox.
//!
//! Frames come from the encoder's own pool of IOSurface-backed BGRA pixel
//! buffers (`frame`), which the GPU compositor can render into without a
//! copy, or which can be filled from memory. Encoded frames come back in
//! order (no B-frames), each with its keyframe flag; the codec's
//! configuration box (`avcC` / `hvcC`) comes from VideoToolbox itself.

use super::{EncodeSettings, Packet};
use crate::export::mp4_writer::CodecConfig;
use crate::export::encode::Format;
use anyhow::{anyhow, bail, Result};
use objc2_core_foundation::{kCFBooleanFalse, kCFBooleanTrue, CFArray, CFBoolean, CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms, kCMSampleAttachmentKey_NotSync, CMSampleBuffer, CMTime};
use objc2_core_video::{
    kCVImageBufferColorPrimaries_ITU_R_709_2, kCVImageBufferTransferFunction_ITU_R_709_2, kCVImageBufferYCbCrMatrix_ITU_R_709_2, kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey, kCVPixelBufferPixelFormatTypeKey,
    kCVPixelBufferWidthKey, kCVPixelFormatType_32BGRA, CVPixelBuffer, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferPool, CVPixelBufferUnlockBaseAddress,
};
use objc2_video_toolbox::{
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_AverageBitRate, kVTCompressionPropertyKey_ColorPrimaries,
    kVTCompressionPropertyKey_ExpectedFrameRate, kVTCompressionPropertyKey_TransferFunction, kVTCompressionPropertyKey_YCbCrMatrix,
    kVTCompressionPropertyKey_MaxKeyFrameInterval, kVTCompressionPropertyKey_ProfileLevel, kVTCompressionPropertyKey_RealTime,
    kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
    kVTProfileLevel_H264_High_AutoLevel, kVTProfileLevel_HEVC_Main_AutoLevel, kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder,
    VTCompressionSession, VTEncodeInfoFlags, VTSessionCopyProperty, VTSessionSetProperty,
};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::sync::Mutex;

/// What the output callback hands back.
#[derive(Default)]
struct Output {
    packets: VecDeque<Packet>,
    config: Option<CodecConfig>,
    error: Option<i32>,
}

/// A frame to encode: one of the encoder's pixel buffers.
pub struct Frame {
    buffer: CFRetained<CVPixelBuffer>,
}

// Pixel buffers are thread-safe to hand between threads.
unsafe impl Send for Frame {}

impl Frame {
    pub fn pixel_buffer(&self) -> &CVPixelBuffer {
        &self.buffer
    }

    /// Fills the frame from memory (BGRA rows of `width * 4` bytes).
    pub fn fill_bgra(&mut self, pixels: &[u8], width: usize, height: usize) -> Result<()> {
        let buf: &CVPixelBuffer = &self.buffer;
        unsafe {
            if CVPixelBufferLockBaseAddress(buf, CVPixelBufferLockFlags(0)) != 0 {
                bail!("could not lock a frame for writing");
            }
            let base = CVPixelBufferGetBaseAddress(buf) as *mut u8;
            let stride = CVPixelBufferGetBytesPerRow(buf);
            if !base.is_null() {
                for row in 0..height {
                    ptr::copy_nonoverlapping(pixels.as_ptr().add(row * width * 4), base.add(row * stride), width * 4);
                }
            }
            CVPixelBufferUnlockBaseAddress(buf, CVPixelBufferLockFlags(0));
            if base.is_null() {
                bail!("a frame had no memory to write to");
            }
        }
        Ok(())
    }
}

impl super::FrameSink for Encoder {
    fn name(&self) -> String {
        if self.hardware() { "VideoToolbox (hardware)".into() } else { "VideoToolbox (software)".into() }
    }

    fn push_bgra(&mut self, bgra: &[u8], pts: i64, duration: i64) -> Result<()> {
        let mut frame = self.frame()?;
        let width = objc2_core_video::CVPixelBufferGetWidth(frame.pixel_buffer());
        let height = objc2_core_video::CVPixelBufferGetHeight(frame.pixel_buffer());
        frame.fill_bgra(bgra, width, height)?;
        self.encode(&frame, pts, duration)
    }

    fn take(&mut self) -> Vec<Packet> {
        Encoder::take(self)
    }

    fn finish(self: Box<Self>) -> Result<super::Finished> {
        let (rest, config) = Encoder::finish(*self)?;
        Ok(super::Finished::Packets(rest, config))
    }
}

impl Frame {
    /// One BGRA pixel (tests: what was drawn into the frame).
    #[cfg(test)]
    pub fn pixel(&self, x: usize, y: usize) -> [u8; 4] {
        let buf: &CVPixelBuffer = &self.buffer;
        unsafe {
            CVPixelBufferLockBaseAddress(buf, CVPixelBufferLockFlags(1));
            let base = CVPixelBufferGetBaseAddress(buf) as *const u8;
            let stride = CVPixelBufferGetBytesPerRow(buf);
            let p = base.add(y * stride + x * 4);
            let px = [*p, *p.add(1), *p.add(2), *p.add(3)];
            CVPixelBufferUnlockBaseAddress(buf, CVPixelBufferLockFlags(1));
            px
        }
    }
}

unsafe extern "C-unwind" fn on_encoded(refcon: *mut c_void, _source: *mut c_void, status: i32, _flags: VTEncodeInfoFlags, sample: *mut CMSampleBuffer) {
    // SAFETY: refcon is the Encoder's boxed Output, which outlives the session.
    let out = unsafe { &*(refcon as *const Mutex<Output>) };
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    if status != 0 {
        out.error = Some(status);
        return;
    }
    let Some(sample) = NonNull::new(sample) else { return };
    // SAFETY: the sample buffer is valid for the callback's duration.
    let sample: &CMSampleBuffer = unsafe { sample.as_ref() };
    unsafe {
        if out.config.is_none() {
            out.config = sample.format_description().and_then(|fd| codec_config(&fd));
        }
        let Some(block) = sample.data_buffer() else { return };
        let len = block.data_length();
        let mut data = vec![0u8; len];
        if block.copy_data_bytes(0, len, NonNull::new(data.as_mut_ptr().cast()).unwrap()) != 0 {
            out.error = Some(-1);
            return;
        }
        let pts = sample.presentation_time_stamp();
        out.packets.push_back(Packet { data, pts: pts.value, sync: is_sync(sample) });
    }
}

/// A sample is a keyframe unless its attachments say NotSync.
unsafe fn is_sync(sample: &CMSampleBuffer) -> bool {
    let Some(list) = (unsafe { sample.sample_attachments_array(false) }) else { return true };
    let list: CFRetained<CFArray<CFDictionary<CFString, CFType>>> = unsafe { CFRetained::cast_unchecked(list) };
    let Some(first) = list.get(0) else { return true };
    match first.get(unsafe { kCMSampleAttachmentKey_NotSync }) {
        Some(v) => v.downcast::<CFBoolean>().map(|b| !b.as_bool()).unwrap_or(true),
        None => true,
    }
}

/// Whether VideoToolbox encodes `format`, and on the media engine: a small
/// session, started and dropped. (No Apple chip encodes AV1 so far.)
pub fn probe(format: Format) -> super::Support {
    let settings = EncodeSettings { codec: format, width: 1280, height: 720, fps: 36.0, timescale: 36_000, bitrate: 4_000_000, fast: true };
    match Encoder::new(&settings) {
        Ok(e) if e.hardware() => super::Support::Hardware,
        Ok(_) => super::Support::Software,
        Err(_) => super::Support::No,
    }
}

/// The `avcC` / `hvcC` / `av1C` box VideoToolbox puts in the format
/// description.
unsafe fn codec_config(fd: &objc2_core_media::CMFormatDescription) -> Option<CodecConfig> {
    let atoms = unsafe { fd.extension(kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) }?;
    let atoms: CFRetained<CFDictionary<CFString, CFType>> = unsafe { CFRetained::cast_unchecked(atoms.downcast::<CFDictionary>().ok()?) };
    for (name, entry) in [("avcC", *b"avc1"), ("hvcC", *b"hvc1"), ("av1C", *b"av01")] {
        if let Some(data) = atoms.get(&CFString::from_str(name)).and_then(|v| v.downcast::<CFData>().ok()) {
            let mut config_box = [0u8; 4];
            config_box.copy_from_slice(name.as_bytes());
            return Some(CodecConfig { entry, config_box, config: data.to_vec() });
        }
    }
    None
}

pub struct Encoder {
    session: CFRetained<VTCompressionSession>,
    pool: CFRetained<CVPixelBufferPool>,
    output: Box<Mutex<Output>>,
    timescale: i32,
}

// The session is used from the export's encoding thread only.
unsafe impl Send for Encoder {}

// Stops the callbacks before `output` goes (a cancelled export, a probe).
impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe { self.session.invalidate() };
    }
}

fn set(session: &VTCompressionSession, key: &CFString, value: &CFType) -> Result<()> {
    let status = unsafe { VTSessionSetProperty(session.as_ref(), key, Some(value)) };
    if status != 0 {
        bail!("the encoder rejected a setting (VideoToolbox error {status})");
    }
    Ok(())
}

impl Encoder {
    pub fn new(s: &EncodeSettings) -> Result<Self> {
        let yes: &CFBoolean = unsafe { kCFBooleanTrue }.ok_or_else(|| anyhow!("CoreFoundation is missing kCFBooleanTrue"))?;
        let no: &CFBoolean = unsafe { kCFBooleanFalse }.ok_or_else(|| anyhow!("CoreFoundation is missing kCFBooleanFalse"))?;
        let spec = unsafe { CFDictionary::<CFString, CFType>::from_slices(&[kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder], &[yes.as_ref()]) };
        let io_surface = CFDictionary::<CFString, CFType>::from_slices(&[], &[]);
        let attrs = unsafe {
            CFDictionary::<CFString, CFType>::from_slices(
                &[kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey],
                &[
                    CFNumber::new_i32(kCVPixelFormatType_32BGRA as i32).as_ref(),
                    CFNumber::new_i32(s.width as i32).as_ref(),
                    CFNumber::new_i32(s.height as i32).as_ref(),
                    (*io_surface).as_ref(),
                    yes.as_ref(),
                ],
            )
        };
        let codec_type = match s.codec {
            Format::H264 => u32::from_be_bytes(*b"avc1"),
            Format::Hevc => u32::from_be_bytes(*b"hvc1"),
            Format::Av1 => u32::from_be_bytes(*b"av01"),
        };
        let output: Box<Mutex<Output>> = Box::default();
        let mut session: *mut VTCompressionSession = ptr::null_mut();
        let status = unsafe {
            VTCompressionSession::create(
                None,
                s.width as i32,
                s.height as i32,
                codec_type,
                Some((*spec).as_ref()),
                Some((*attrs).as_ref()),
                None,
                Some(on_encoded),
                &*output as *const Mutex<Output> as *mut c_void,
                NonNull::from(&mut session),
            )
        };
        if status != 0 || session.is_null() {
            bail!("could not start the hardware video encoder (VideoToolbox error {status})");
        }
        let session = unsafe { CFRetained::from_raw(NonNull::new(session).unwrap()) };
        let profile = match s.codec {
            Format::H264 => Some(unsafe { kVTProfileLevel_H264_High_AutoLevel }),
            Format::Hevc => Some(unsafe { kVTProfileLevel_HEVC_Main_AutoLevel }),
            Format::Av1 => None,
        };
        unsafe {
            set(&session, kVTCompressionPropertyKey_RealTime, no.as_ref())?;
            set(&session, kVTCompressionPropertyKey_AllowFrameReordering, no.as_ref())?;
            if let Some(profile) = profile {
                set(&session, kVTCompressionPropertyKey_ProfileLevel, profile.as_ref())?;
            }
            set(&session, kVTCompressionPropertyKey_AverageBitRate, CFNumber::new_i64(s.bitrate as i64).as_ref())?;
            set(&session, kVTCompressionPropertyKey_ExpectedFrameRate, CFNumber::new_f64(s.fps).as_ref())?;
            set(&session, kVTCompressionPropertyKey_MaxKeyFrameInterval, CFNumber::new_i32((s.fps * 2.0).round() as i32).as_ref())?;
            // BT.709, as Tesla records and players assume for HD: tagged in
            // the file, and the frames' RGB turned into YCbCr by that matrix.
            set(&session, kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2.as_ref())?;
            set(&session, kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2.as_ref())?;
            set(&session, kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2.as_ref())?;
            if s.fast {
                // Not every encoder has it (older macOS): optional.
                let _ = set(&session, kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, yes.as_ref());
            }
            session.prepare_to_encode_frames();
        }
        let pool = unsafe { session.pixel_buffer_pool() }.ok_or_else(|| anyhow!("the encoder gave no frame pool"))?;
        Ok(Encoder { session, pool, output, timescale: s.timescale as i32 })
    }

    /// Whether the GPU's media engine is doing the encoding (the software
    /// encoder is far slower).
    pub fn hardware(&self) -> bool {
        let mut value: *const CFType = ptr::null();
        let status = unsafe {
            let session: &objc2_video_toolbox::VTSession = self.session.as_ref();
            VTSessionCopyProperty(session, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, None, (&mut value as *mut *const CFType).cast())
        };
        if status != 0 || value.is_null() {
            return false;
        }
        let value = unsafe { CFRetained::from_raw(NonNull::new(value as *mut CFType).unwrap()) };
        value.downcast::<CFBoolean>().map(|b| b.as_bool()).unwrap_or(false)
    }

    /// A frame to draw into and then `encode`.
    pub fn frame(&self) -> Result<Frame> {
        let mut buffer: *mut CVPixelBuffer = ptr::null_mut();
        let status = unsafe { CVPixelBufferPool::create_pixel_buffer(None, &self.pool, NonNull::from(&mut buffer)) };
        if status != 0 || buffer.is_null() {
            bail!("could not get a frame to encode (CoreVideo error {status})");
        }
        Ok(Frame { buffer: unsafe { CFRetained::from_raw(NonNull::new(buffer).unwrap()) } })
    }

    /// Encodes a frame shown at `pts` for `duration` (timescale units).
    pub fn encode(&mut self, frame: &Frame, pts: i64, duration: i64) -> Result<()> {
        let status = unsafe {
            self.session.encode_frame(
                frame.pixel_buffer().as_ref(),
                CMTime::new(pts, self.timescale),
                CMTime::new(duration, self.timescale),
                None,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if status != 0 {
            bail!("the encoder refused a frame (VideoToolbox error {status})");
        }
        self.check()
    }

    fn check(&self) -> Result<()> {
        match self.output.lock().unwrap_or_else(|e| e.into_inner()).error {
            Some(e) => bail!("encoding failed (VideoToolbox error {e})"),
            None => Ok(()),
        }
    }

    /// Encoded frames so far, in order.
    pub fn take(&mut self) -> Vec<Packet> {
        self.output.lock().unwrap_or_else(|e| e.into_inner()).packets.drain(..).collect()
    }

    /// Waits for every frame, then returns the last ones and the codec's
    /// configuration.
    pub fn finish(mut self) -> Result<(Vec<Packet>, CodecConfig)> {
        unsafe {
            self.session.complete_frames(CMTime { value: 0, timescale: 0, flags: objc2_core_media::CMTimeFlags(0), epoch: 0 });
        }
        self.check()?;
        let rest = self.take();
        let config = self.output.lock().unwrap_or_else(|e| e.into_inner()).config.clone().ok_or_else(|| anyhow!("the encoder gave no codec settings"))?;
        unsafe { self.session.invalidate() };
        Ok((rest, config))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::mp4_writer::Mp4Writer;

    /// How fast the hardware encoder takes a six-camera grid's frames
    /// (cargo test encoder_speed -- --ignored --nocapture).
    #[test]
    #[ignore]
    fn encoder_speed() {
        for (codec, w, h, fast) in [(Format::H264, 4344, 1876, false), (Format::H264, 4344, 1876, true), (Format::H264, 4096, 1768, true), (Format::H264, 3840, 1658, true), (Format::Hevc, 4344, 1876, false), (Format::Hevc, 4344, 1876, true)] {
            let n = 180usize;
            let settings = EncodeSettings { codec, width: w as u32, height: h as u32, fps: 36.0, timescale: 36_000, bitrate: 40_000_000, fast };
            let mut enc = Encoder::new(&settings).unwrap();
            let hardware = enc.hardware();
            let frames: Vec<Frame> = (0..4)
                .map(|k| {
                    let pixels: Vec<u8> = (0..w * h).flat_map(|p| [((p % w + k * 40) % 256) as u8, ((p / w) % 256) as u8, 90, 255]).collect();
                    let mut f = enc.frame().unwrap();
                    f.fill_bgra(&pixels, w, h).unwrap();
                    f
                })
                .collect();
            let started = std::time::Instant::now();
            let mut bytes = 0;
            for i in 0..n {
                enc.encode(&frames[i % 4], i as i64 * 1000, 1000).unwrap();
                bytes += enc.take().iter().map(|p| p.data.len()).sum::<usize>();
            }
            let (rest, _) = enc.finish().unwrap();
            bytes += rest.iter().map(|p| p.data.len()).sum::<usize>();
            let secs = started.elapsed().as_secs_f64();
            println!("{codec:?} {w}x{h} fast={fast} hardware={hardware}: {n} frames in {secs:.2} s = {:.0} fps ({:.1}x real time at 36 fps), {} MB", n as f64 / secs, n as f64 / secs / 36.0, bytes >> 20);
        }
    }

    /// Several encoder sessions at once, each on its own thread: does the
    /// media engine give more frames per second in total than one session
    /// (cargo test --release parallel_sessions -- --ignored --nocapture)?
    #[test]
    #[ignore]
    fn parallel_sessions() {
        for (codec, w, h) in [(Format::H264, 3264usize, 1408usize), (Format::H264, 4096, 1776), (Format::Hevc, 3264, 1408), (Format::Hevc, 4352, 1888)] {
            for sessions in [1usize, 2, 3, 4] {
                let n = 360 / sessions;
                let started = std::time::Instant::now();
                let threads: Vec<_> = (0..sessions)
                    .map(|_| {
                        std::thread::spawn(move || {
                            let settings = EncodeSettings { codec, width: w as u32, height: h as u32, fps: 36.0, timescale: 36_000, bitrate: 8_000_000, fast: true };
                            let mut enc = Encoder::new(&settings).unwrap();
                            let frames: Vec<Frame> = (0..4)
                                .map(|k| {
                                    let pixels: Vec<u8> = (0..w * h).flat_map(|p| [((p % w + k * 40) % 256) as u8, ((p / w * 3 + k) % 256) as u8, 90, 255]).collect();
                                    let mut f = enc.frame().unwrap();
                                    f.fill_bgra(&pixels, w, h).unwrap();
                                    f
                                })
                                .collect();
                            let t = std::time::Instant::now();
                            for i in 0..n {
                                enc.encode(&frames[i % 4], i as i64 * 1000, 1000).unwrap();
                                enc.take();
                            }
                            enc.finish().unwrap();
                            t.elapsed()
                        })
                    })
                    .collect();
                let slowest = threads.into_iter().map(|t| t.join().unwrap()).max().unwrap().as_secs_f64();
                let _ = started;
                println!("{codec:?} {w}x{h}, {sessions} session(s): {:.0} fps in total", (n * sessions) as f64 / slowest);
            }
        }
    }

    /// Generated frames through the hardware encoder into an MP4, then back
    /// through the playback decoder: sizes, keyframes and pictures survive.
    #[test]
    fn encoded_files_decode() {
        let (w, h, n) = (640usize, 368usize, 48usize);
        let settings = EncodeSettings { codec: Format::H264, width: w as u32, height: h as u32, fps: 24.0, timescale: 24_000, bitrate: 4_000_000, fast: false };
        let mut enc = Encoder::new(&settings).unwrap();
        let path = std::env::temp_dir().join(format!("sentry-studio-vtenc-{}.mp4", std::process::id()));
        let mut mp4 = Mp4Writer::create(&path, w as u32, h as u32, 24_000).unwrap();
        let mut packets = Vec::new();
        for i in 0..n {
            // A gradient that moves, so frames differ.
            let pixels: Vec<u8> = (0..w * h).flat_map(|p| {
                let (x, y) = (p % w, p / w);
                [((x + i * 8) % 256) as u8, (y % 256) as u8, 128, 255]
            }).collect();
            let mut f = enc.frame().unwrap();
            f.fill_bgra(&pixels, w, h).unwrap();
            enc.encode(&f, i as i64 * 1000, 1000).unwrap();
            packets.extend(enc.take());
        }
        let (rest, config) = enc.finish().unwrap();
        packets.extend(rest);
        assert_eq!(packets.len(), n);
        assert!(packets[0].sync);
        for p in &packets {
            mp4.write_sample(&p.data, 1000, p.sync, 0).unwrap();
        }
        mp4.finish(&config).unwrap();

        let file = std::fs::File::open(&path).unwrap();
        let track = crate::mp4::read_video_track(&file).unwrap();
        assert_eq!((track.width, track.height, track.samples.len()), (w as u32, h as u32, n));
        let mut dec = crate::decode::Decoder::new(&track).unwrap();
        let mut decoded = 0;
        for s in &track.samples {
            let mut buf = vec![0u8; s.size as usize];
            crate::mp4::read_at(&file, &mut buf, s.offset).unwrap();
            if let Some(frame) = dec.decode(&buf).unwrap() {
                assert_eq!((frame.width(), frame.height()), (w as u32, h as u32));
                decoded += 1;
            }
        }
        decoded += dec.drain().len();
        assert_eq!(decoded, n);
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod decode_speed {
    use super::*;
    use crate::export::mp4_writer::Mp4Writer;

    /// Writes a 36 fps H.264 clip of `n` frames that change every frame.
    fn clip(path: &std::path::Path, w: usize, h: usize, n: usize) {
        let settings = EncodeSettings { codec: Format::H264, width: w as u32, height: h as u32, fps: 36.0, timescale: 36_000, bitrate: 12_000_000, fast: true };
        let mut enc = Encoder::new(&settings).unwrap();
        let mut mp4 = Mp4Writer::create(path, w as u32, h as u32, 36_000).unwrap();
        let mut seed = 1u32;
        for i in 0..n {
            // Noise, so the decoder has real work (like dashcam detail).
            let pixels: Vec<u8> = (0..w * h * 4)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    (seed >> 24) as u8
                })
                .collect();
            let mut f = enc.frame().unwrap();
            f.fill_bgra(&pixels, w, h).unwrap();
            enc.encode(&f, i as i64 * 1000, 1000).unwrap();
            for p in enc.take() {
                mp4.write_sample(&p.data, 1000, p.sync, 0).unwrap();
            }
        }
        let (rest, config) = enc.finish().unwrap();
        for p in rest {
            mp4.write_sample(&p.data, 1000, p.sync, 0).unwrap();
        }
        mp4.finish(&config).unwrap();
    }

    /// Six cameras' worth of clips decoded at once, as an export would
    /// (cargo test --release six_camera_decode_speed -- --ignored --nocapture).
    #[test]
    #[ignore]
    fn six_camera_decode_speed() {
        let n = 180;
        let dir = std::env::temp_dir().join(format!("sentry-studio-decspeed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sizes = [(2896, 1876), (1448, 938), (1448, 938), (1448, 938), (1448, 938), (1448, 938)];
        let paths: Vec<_> = sizes.iter().enumerate().map(|(i, (w, h))| {
            let p = dir.join(format!("cam{i}.mp4"));
            clip(&p, *w, *h, n);
            p
        }).collect();
        let started = std::time::Instant::now();
        let threads: Vec<_> = paths.iter().cloned().map(|p| std::thread::spawn(move || {
            let file = std::fs::File::open(&p).unwrap();
            let track = crate::mp4::read_video_track(&file).unwrap();
            let mut dec = crate::decode::Decoder::new(&track).unwrap();
            let mut count = 0;
            for s in &track.samples {
                let mut buf = vec![0u8; s.size as usize];
                crate::mp4::read_at(&file, &mut buf, s.offset).unwrap();
                count += dec.decode(&buf).unwrap().is_some() as usize;
            }
            count + dec.drain().len()
        })).collect();
        let decoded: usize = threads.into_iter().map(|t| t.join().unwrap()).sum();
        let secs = started.elapsed().as_secs_f64();
        println!("six cameras, {n} frames each ({decoded} pictures): {secs:.2} s = {:.0} grid frames/s ({:.1}x real time at 36 fps)", n as f64 / secs, n as f64 / secs / 36.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
