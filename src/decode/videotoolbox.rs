//! macOS: hardware H.264 and H.265 decoding with VideoToolbox.
//!
//! Each frame is decoded synchronously: `decode` hands VideoToolbox one
//! sample and returns its picture (an NV12 CVPixelBuffer, scaled down by the
//! decoder when wider than MAX_OUTPUT_WIDTH). Tesla clips have no B-frames,
//! so every sample produces its picture straight away, in display order.

use super::{Plane, MAX_OUTPUT_WIDTH};
use crate::mp4::{Codec, VideoTrack};
use anyhow::{anyhow, bail, Result};
use objc2_core_foundation::{kCFAllocatorNull, kCFBooleanTrue, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{
    CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMTime,
    CMVideoFormatDescriptionCreateFromH264ParameterSets, CMVideoFormatDescriptionCreateFromHEVCParameterSets,
};
use objc2_core_video::{
    kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, CVImageBuffer, CVPixelBuffer,
    CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane, CVPixelBufferGetHeight,
    CVPixelBufferGetHeightOfPlane, CVPixelBufferGetWidth, CVPixelBufferGetWidthOfPlane,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_video_toolbox::{
    VTDecodeFrameFlags, VTDecodeInfoFlags, VTDecompressionOutputCallbackRecord, VTDecompressionSession,
};
use std::ffi::{c_int, c_void};
use std::ptr::{self, NonNull};

/// A decoded picture. The CVPixelBuffer is only read after decoding, which
/// CoreVideo allows from any thread.
pub struct Frame {
    buffer: CFRetained<CVPixelBuffer>,
}

unsafe impl Send for Frame {}
unsafe impl Sync for Frame {}

impl Frame {
    pub fn width(&self) -> u32 {
        CVPixelBufferGetWidth(&self.buffer) as u32
    }

    pub fn height(&self) -> u32 {
        CVPixelBufferGetHeight(&self.buffer) as u32
    }

    /// The sample this picture came from, when the decoder says so (only
    /// GStreamer's can hand pictures back late; see decode/gstreamer.rs).
    pub fn pts(&self) -> Option<f64> {
        None
    }

    /// The decoder's picture itself (for showing it without copying).
    pub fn pixel_buffer(&self) -> &CVPixelBuffer {
        &self.buffer
    }

    /// Calls `f` with the Y and CbCr planes while the picture is locked.
    pub fn with_planes<R>(&self, f: impl FnOnce(Plane<'_>, Plane<'_>) -> R) -> Option<R> {
        let buf: &CVPixelBuffer = &self.buffer;
        unsafe {
            if CVPixelBufferLockBaseAddress(buf, CVPixelBufferLockFlags::ReadOnly) != 0 {
                return None;
            }
        }
        let plane = |i: usize| -> Option<Plane<'_>> {
            let base = CVPixelBufferGetBaseAddressOfPlane(buf, i) as *const u8;
            if base.is_null() {
                return None;
            }
            let stride = CVPixelBufferGetBytesPerRowOfPlane(buf, i);
            let height = CVPixelBufferGetHeightOfPlane(buf, i);
            let width = CVPixelBufferGetWidthOfPlane(buf, i);
            // SAFETY: the plane is `stride * height` bytes and stays mapped
            // while the buffer is locked (until the unlock below).
            let data = unsafe { std::slice::from_raw_parts(base, stride * height) };
            Some(Plane { data, stride, width: width as u32, height: height as u32 })
        };
        let out = match (plane(0), plane(1)) {
            (Some(y), Some(uv)) => Some(f(y, uv)),
            _ => None,
        };
        unsafe {
            CVPixelBufferUnlockBaseAddress(buf, CVPixelBufferLockFlags::ReadOnly);
        }
        out
    }
}

/// Where the output callback leaves the picture for the decode call that
/// is waiting on it.
struct Slot {
    picture: Option<CFRetained<CVPixelBuffer>>,
    status: i32,
}

unsafe extern "C-unwind" fn on_output(
    refcon: *mut c_void,
    _source_ref: *mut c_void,
    status: i32,
    _flags: VTDecodeInfoFlags,
    image: *mut CVImageBuffer,
    _pts: CMTime,
    _duration: CMTime,
) {
    // SAFETY: refcon is the Decoder's boxed Slot, which outlives the session.
    let slot = unsafe { &mut *(refcon as *mut Slot) };
    slot.status = status;
    if let Some(image) = NonNull::new(image) {
        // The callback does not own the image; retain it to keep it.
        slot.picture = Some(unsafe { CFRetained::retain(image) });
    }
}

pub struct Decoder {
    session: CFRetained<VTDecompressionSession>,
    format: CFRetained<CMFormatDescription>,
    slot: Box<Slot>,
}

// The session is only used from the tile's worker thread that owns it.
unsafe impl Send for Decoder {}

impl Decoder {
    pub fn new(track: &VideoTrack) -> Result<Self> {
        let sets: Vec<&Vec<u8>> = track.vps.iter().chain(track.sps.iter()).chain(track.pps.iter()).collect();
        let pointers: Vec<NonNull<u8>> =
            sets.iter().map(|s| NonNull::new(s.as_ptr() as *mut u8).unwrap()).collect();
        let sizes: Vec<usize> = sets.iter().map(|s| s.len()).collect();
        let mut format: *const CMFormatDescription = ptr::null();
        let pointers_ptr = NonNull::new(pointers.as_ptr() as *mut NonNull<u8>).unwrap();
        let sizes_ptr = NonNull::new(sizes.as_ptr() as *mut usize).unwrap();
        let status = unsafe {
            match track.codec {
                Codec::H264 => CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    None,
                    pointers.len(),
                    pointers_ptr,
                    sizes_ptr,
                    track.nal_length_size as c_int,
                    NonNull::from(&mut format),
                ),
                Codec::H265 => CMVideoFormatDescriptionCreateFromHEVCParameterSets(
                    None,
                    pointers.len(),
                    pointers_ptr,
                    sizes_ptr,
                    track.nal_length_size as c_int,
                    None,
                    NonNull::from(&mut format),
                ),
            }
        };
        if status != 0 || format.is_null() {
            bail!("the clip's video settings were rejected (CoreMedia error {status})");
        }
        // SAFETY: a Create function returns a +1 reference.
        let format = unsafe { CFRetained::from_raw(NonNull::new(format as *mut CMFormatDescription).unwrap()) };

        // NV12 output at the clip's size (scaled down only past MAX_OUTPUT_WIDTH).
        let (mut out_w, mut out_h) = (track.width, track.height);
        if out_w > MAX_OUTPUT_WIDTH {
            out_h = ((out_h as u64 * MAX_OUTPUT_WIDTH as u64 / out_w as u64) as u32 + 1) & !1;
            out_w = MAX_OUTPUT_WIDTH;
        }
        let pixel_format = CFNumber::new_i32(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange as i32);
        let width = CFNumber::new_i32(out_w as i32);
        let height = CFNumber::new_i32(out_h as i32);
        // IOSurface-backed and Metal-compatible, so the renderer can show
        // pictures straight from the decoder without copying them.
        let io_surface = CFDictionary::<CFString, CFType>::from_slices(&[], &[]);
        let yes: &CFBoolean = unsafe { kCFBooleanTrue }.ok_or_else(|| anyhow!("CoreFoundation is missing kCFBooleanTrue"))?;
        let attributes = unsafe {
            CFDictionary::<CFString, CFType>::from_slices(
                &[
                    kCVPixelBufferPixelFormatTypeKey,
                    kCVPixelBufferWidthKey,
                    kCVPixelBufferHeightKey,
                    kCVPixelBufferIOSurfacePropertiesKey,
                    kCVPixelBufferMetalCompatibilityKey,
                ],
                &[pixel_format.as_ref(), width.as_ref(), height.as_ref(), (*io_surface).as_ref(), yes.as_ref()],
            )
        };
        let attributes: &CFDictionary = (*attributes).as_ref();

        let mut slot = Box::new(Slot { picture: None, status: 0 });
        let callback = VTDecompressionOutputCallbackRecord {
            decompressionOutputCallback: Some(on_output),
            decompressionOutputRefCon: &mut *slot as *mut Slot as *mut c_void,
        };
        let mut session: *mut VTDecompressionSession = ptr::null_mut();
        let status = unsafe {
            VTDecompressionSession::create(
                None,
                &format,
                None,
                Some(attributes),
                &callback,
                NonNull::from(&mut session),
            )
        };
        if status != 0 || session.is_null() {
            bail!("could not start the hardware video decoder (VideoToolbox error {status})");
        }
        let session = unsafe { CFRetained::from_raw(NonNull::new(session).unwrap()) };
        Ok(Self { session, format, slot })
    }

    /// Nothing to forget: each frame is decoded to completion.
    pub fn reset(&mut self) {}

    /// Decodes one sample shown at `pts` seconds (this decoder hands back
    /// that sample's own picture, so the time isn't needed).
    pub fn decode_at(&mut self, data: &[u8], _pts: f64) -> Result<Option<Frame>> {
        self.decode(data)
    }

    /// Pictures still inside the decoder at the end of a clip (none: it
    /// hands each one back as it is decoded).
    pub fn drain(&mut self) -> Vec<Frame> {
        Vec::new()
    }

    /// Decodes one MP4 sample. `Ok(None)` means the decoder dropped it.
    pub fn decode(&mut self, data: &[u8]) -> Result<Option<Frame>> {
        // A block buffer over `data` without copying: decoding is synchronous,
        // so `data` outlives every use of it.
        let mut block: *mut CMBlockBuffer = ptr::null_mut();
        let status = unsafe {
            CMBlockBuffer::create_with_memory_block(
                None,
                data.as_ptr() as *mut c_void,
                data.len(),
                kCFAllocatorNull,
                ptr::null(),
                0,
                data.len(),
                0,
                NonNull::from(&mut block),
            )
        };
        if status != 0 || block.is_null() {
            bail!("CoreMedia could not wrap a frame (error {status})");
        }
        let block = unsafe { CFRetained::from_raw(NonNull::new(block).unwrap()) };

        let sizes = [data.len()];
        let mut sample: *mut CMSampleBuffer = ptr::null_mut();
        let status = unsafe {
            CMSampleBuffer::create_ready(
                None,
                Some(&block),
                Some(&self.format),
                1,
                0,
                ptr::null(),
                1,
                sizes.as_ptr(),
                NonNull::from(&mut sample),
            )
        };
        if status != 0 || sample.is_null() {
            bail!("CoreMedia could not wrap a frame (error {status})");
        }
        let sample = unsafe { CFRetained::from_raw(NonNull::new(sample).unwrap()) };

        self.slot.picture = None;
        self.slot.status = 0;
        let mut info = VTDecodeInfoFlags(0);
        let status = unsafe {
            let s = self.session.decode_frame(&sample, VTDecodeFrameFlags(0), ptr::null_mut(), &mut info);
            self.session.wait_for_asynchronous_frames();
            s
        };
        if status != 0 {
            return Err(anyhow!("the hardware decoder rejected a frame (VideoToolbox error {status})"));
        }
        if self.slot.status != 0 {
            return Err(anyhow!("the hardware decoder failed on a frame (VideoToolbox error {})", self.slot.status));
        }
        Ok(self.slot.picture.take().map(|buffer| Frame { buffer }))
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { self.session.invalidate() };
    }
}
