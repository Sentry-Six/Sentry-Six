//! Windows: H.264 and H.265 decoding with Media Foundation's decoders
//! (Microsoft's H.264 Video Decoder MFT, part of Windows, and its H.265 one,
//! which comes with the HEVC Video Extensions).
//!
//! `decode_at` hands the MFT one sample and returns a picture if one is
//! ready (low-latency mode gives back each picture as soon as its sample
//! is in; with B-frames it can be an earlier sample's), and `drain` takes
//! what's left at the end of a clip. The decoder wants Annex B input, so each sample's
//! length-prefixed NAL units get start codes, and keyframes carry the SPS
//! and PPS in front (so a seek to any keyframe decodes on its own).
//!
//! Decoding runs on the GPU: the decoders share one Direct3D 11 device
//! (through a DXGI device manager), and each picture is copied from the
//! decoder's texture into a CPU-readable one and out as NV12, at full size
//! (only a picture wider than MAX_OUTPUT_WIDTH is halved while copying).
//! Without a usable GPU, or with SENTRY_STUDIO_SOFTWARE_DECODE set, the
//! same decoders run on the CPU.

use super::{half_nv12, Plane, MAX_OUTPUT_WIDTH};
use crate::mp4::{Codec, VideoTrack};
use anyhow::{anyhow, bail, Context, Result};
use std::mem::ManuallyDrop;
use std::sync::{Once, OnceLock};
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

/// MF_VERSION (MF_SDK_VERSION << 16 | MF_API_VERSION).
const MF_VERSION: u32 = 0x0002_0070;

static STARTUP: Once = Once::new();

/// The Direct3D 11 device every decoder shares. Multithread protection is
/// on, so the decoders (each on its own thread) and the picture copies can
/// use it at once.
struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    manager: IMFDXGIDeviceManager,
}

// Direct3D 11 devices are free-threaded, the immediate context is guarded
// by multithread protection, and the DXGI device manager is thread-safe.
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

static GPU: OnceLock<Option<Gpu>> = OnceLock::new();

fn gpu() -> Option<&'static Gpu> {
    GPU.get_or_init(|| {
        if std::env::var_os("SENTRY_STUDIO_SOFTWARE_DECODE").is_some() {
            log::info!("video decoding on the CPU: SENTRY_STUDIO_SOFTWARE_DECODE is set");
            return None;
        }
        match unsafe { create_gpu() } {
            Ok(gpu) => Some(gpu),
            Err(e) => {
                log::warn!("video decoding falls back to the CPU: no usable GPU ({e:#})");
                None
            }
        }
    })
    .as_ref()
}

unsafe fn create_gpu() -> Result<Gpu> {
    let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0];
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|e| hr(e, "Direct3D 11 has no hardware device with video support"))?;
    }
    let device = device.context("Direct3D 11 gave no device")?;
    let context = context.context("Direct3D 11 gave no device context")?;
    let protect = context.cast::<ID3D11Multithread>().map_err(|e| hr(e, "Direct3D 11 has no multithread protection"))?;
    let _ = unsafe { protect.SetMultithreadProtected(true) };
    let mut token = 0u32;
    let mut manager = None;
    unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager) }.map_err(|e| hr(e, "Media Foundation has no DXGI device manager"))?;
    let manager = manager.context("Media Foundation gave no DXGI device manager")?;
    unsafe { manager.ResetDevice(&device, token) }.map_err(|e| hr(e, "the DXGI device manager refused the device"))?;
    Ok(Gpu { device, context, manager })
}

/// A decoded picture: NV12 copied out of the decoder's buffer.
pub struct Frame {
    width: u32,
    height: u32,
    /// Y rows (width bytes each), then CbCr rows (width bytes, height / 2).
    data: Vec<u8>,
    /// The moment (seconds) of the sample this picture was decoded from.
    pts: Option<f64>,
}

impl Frame {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// The moment (seconds) of the sample this picture was decoded from:
    /// the decoder can hand pictures back in display order, a little after
    /// their samples went in, when a clip reorders frames.
    pub fn pts(&self) -> Option<f64> {
        self.pts
    }

    pub fn with_planes<R>(&self, f: impl FnOnce(Plane<'_>, Plane<'_>) -> R) -> Option<R> {
        let w = self.width as usize;
        let h = self.height as usize;
        let (y, uv) = self.data.split_at(w * h);
        Some(f(
            Plane { data: y, stride: w, width: self.width, height: self.height },
            Plane { data: uv, stride: w, width: self.width / 2, height: self.height.div_ceil(2) },
        ))
    }
}

pub struct Decoder {
    transform: IMFTransform,
    /// The parameter sets (VPS for H.265, SPS, PPS) with start codes, put in
    /// front of keyframes.
    parameter_sets: Vec<u8>,
    nal_length_size: usize,
    codec: Codec,
    /// The picture size to show (the coded size can be a little larger).
    width: u32,
    height: u32,
    /// Coded picture height, from the output type (the CbCr plane starts
    /// after this many Y rows).
    coded_height: u32,
    /// Bytes per row in the decoder's output, from the output type. The
    /// decoder pads rows to whole macroblocks (16 px), so a 1448 px HW4
    /// side camera comes out in 1456 px rows; buffers without their own
    /// pitch (plain, not 2D) are laid out this way.
    stride: u32,
    /// The moment `decode` (no timestamp given) made up last, 100 ns units.
    timestamp: i64,
    /// Pictures out of the decoder, not handed back yet.
    ready: std::collections::VecDeque<Frame>,
    /// Decoding on the GPU (the decoder has the shared device).
    hardware: bool,
    /// The CPU-readable copy of the decoder's texture, made at its size.
    staging: Option<(ID3D11Texture2D, u32, u32)>,
}

// The MFT is created in the multithreaded apartment and only used from
// the worker thread that owns the decoder.
unsafe impl Send for Decoder {}

/// Says once which way video is decoded (the log, and diagnostics): what
/// the first decoder actually got, since one can fall back to the CPU even
/// with a GPU.
fn announce(hardware: bool) {
    static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
        let what = if hardware { "GPU (Media Foundation, Direct3D 11)" } else { "CPU (Media Foundation)" };
        log::info!("video decoding: {what}");
        crate::applog::set_decoder(what.to_string());
    }
}

fn hr(e: windows::core::Error, what: &str) -> anyhow::Error {
    anyhow!("{what} (Media Foundation error {:#010x})", e.code().0 as u32)
}

impl Decoder {
    pub fn new(track: &VideoTrack) -> Result<Self> {
        unsafe {
            // Each decode thread joins the multithreaded apartment; the
            // result is ignored when the thread already has one.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            STARTUP.call_once(|| {
                let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
            });
        }
        let (clsid, subtype) = match track.codec {
            Codec::H264 => (CLSID_MSH264DecoderMFT, MFVideoFormat_H264),
            Codec::H265 => (CLSID_MSH265DecoderMFT, MFVideoFormat_HEVC),
        };
        let transform: IMFTransform = unsafe { CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER) }.map_err(|e| match track.codec {
            Codec::H264 => hr(e, "could not start the Windows H.264 decoder"),
            Codec::H265 => hr(e, "H.265 video needs Microsoft's HEVC Video Extensions (Microsoft Store)"),
        })?;

        let mut hardware = false;
        unsafe {
            if let Ok(attributes) = transform.GetAttributes() {
                let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);
                // GPU decoding, when the decoder can use a Direct3D 11 device.
                if let Some(gpu) = gpu() {
                    if attributes.GetUINT32(&MF_SA_D3D11_AWARE).unwrap_or(0) != 0 {
                        hardware = transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, gpu.manager.as_raw() as usize).is_ok();
                    }
                }
            }
            let input = MFCreateMediaType().map_err(|e| hr(e, "Media Foundation is not available"))?;
            input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            input.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
            input.SetUINT64(&MF_MT_FRAME_SIZE, ((track.width as u64) << 32) | track.height as u64)?;
            input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            if let Err(e) = transform.SetInputType(0, &input, 0) {
                if !hardware {
                    return Err(hr(e, "the clip's video settings were rejected"));
                }
                // The GPU can't take this clip (its size, say): decode it
                // on the CPU instead.
                let _ = transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, 0);
                hardware = false;
                transform.SetInputType(0, &input, 0).map_err(|e| hr(e, "the clip's video settings were rejected"))?;
            }
        }

        let parameter_sets = super::parameter_sets(track);
        let mut decoder = Self {
            transform,
            parameter_sets,
            nal_length_size: track.nal_length_size as usize,
            codec: track.codec,
            width: track.width & !1,
            height: track.height & !1,
            coded_height: track.height,
            stride: track.width,
            timestamp: 0,
            ready: std::collections::VecDeque::new(),
            hardware,
            staging: None,
        };
        decoder.choose_output()?;
        announce(decoder.hardware);
        unsafe {
            let _ = decoder.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
            let _ = decoder.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);
        }
        Ok(decoder)
    }

    /// Picks NV12 output and notes the coded size it comes in.
    fn choose_output(&mut self) -> Result<()> {
        for i in 0.. {
            let t = match unsafe { self.transform.GetOutputAvailableType(0, i) } {
                Ok(t) => t,
                Err(_) => break,
            };
            if unsafe { t.GetGUID(&MF_MT_SUBTYPE) }.ok() == Some(MFVideoFormat_NV12) {
                unsafe { self.transform.SetOutputType(0, &t, 0) }.map_err(|e| hr(e, "the decoder refused NV12 output"))?;
                let mut coded_w = self.width;
                if let Ok(size) = unsafe { t.GetUINT64(&MF_MT_FRAME_SIZE) } {
                    let coded_h = size as u32;
                    if coded_h >= self.height {
                        self.coded_height = coded_h;
                    }
                    coded_w = coded_w.max((size >> 32) as u32);
                }
                // The default stride is the row pitch when given (negative
                // means bottom-up, which NV12 never is); else the coded width.
                self.stride = match unsafe { t.GetUINT32(&MF_MT_DEFAULT_STRIDE) } {
                    Ok(stride) if (stride as i32).unsigned_abs() >= self.width => (stride as i32).unsigned_abs(),
                    _ => coded_w,
                };
                return Ok(());
            }
        }
        bail!("the Windows video decoder offers no NV12 output")
    }

    /// Forgets pictures in flight (after a seek).
    pub fn reset(&mut self) {
        self.ready.clear();
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
        }
    }

    /// Pictures still inside the decoder at the end of a clip.
    pub fn drain(&mut self) -> Vec<Frame> {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);
        }
        // Each call hands back one picture until NEED_MORE_INPUT says the
        // decoder is empty (bounded, in case it never says so).
        for _ in 0..64 {
            match self.take_output() {
                Ok(Some(frame)) => self.ready.push_back(frame),
                _ => break,
            }
        }
        self.ready.drain(..).collect()
    }

    /// Decodes one sample (made-up moments one frame apart).
    pub fn decode(&mut self, data: &[u8]) -> Result<Option<Frame>> {
        self.timestamp += 277_778;
        self.decode_at(data, self.timestamp as f64 / 1e7)
    }

    /// Decodes one sample shown at `pts` seconds. The picture handed back
    /// may be an earlier sample's (see `Frame::pts`).
    pub fn decode_at(&mut self, data: &[u8], pts: f64) -> Result<Option<Frame>> {
        let bytes = super::annex_b(data, self.nal_length_size, self.codec, &self.parameter_sets)?;
        let sample = unsafe {
            let buffer = MFCreateMemoryBuffer(bytes.len() as u32)?;
            let mut ptr = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(bytes.len() as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            // 100 ns units. The decoder copies it to the picture, which is
            // how a late picture finds its sample (Frame::pts).
            sample.SetSampleTime((pts.max(0.0) * 1e7).round() as i64)?;
            sample.SetSampleDuration(277_778)?;
            sample
        };
        match unsafe { self.transform.ProcessInput(0, &sample, 0) } {
            Ok(()) => {}
            Err(e) if e.code() == MF_E_NOTACCEPTING => {
                // Pictures are waiting: take them, then give the sample again.
                self.take_all()?;
                unsafe { self.transform.ProcessInput(0, &sample, 0) }.map_err(|e| hr(e, "the decoder rejected a frame"))?;
            }
            Err(e) => return Err(hr(e, "the decoder rejected a frame")),
        }
        self.take_all()?;
        Ok(self.ready.pop_front())
    }

    /// Moves every picture the decoder has ready into `ready`.
    fn take_all(&mut self) -> Result<()> {
        for _ in 0..16 {
            match self.take_output()? {
                Some(frame) => self.ready.push_back(frame),
                None => break,
            }
        }
        Ok(())
    }

    /// The next decoded picture, if the decoder has one.
    fn take_output(&mut self) -> Result<Option<Frame>> {
        for _ in 0..3 {
            let info = unsafe { self.transform.GetOutputStreamInfo(0) }.map_err(|e| hr(e, "the decoder failed"))?;
            let provides = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32) != 0;
            let given = if provides {
                None
            } else {
                unsafe {
                    let sample = MFCreateSample()?;
                    let buffer = MFCreateMemoryBuffer(info.cbSize)?;
                    sample.AddBuffer(&buffer)?;
                    Some(sample)
                }
            };
            let mut out = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: 0,
                pSample: ManuallyDrop::new(given),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            }];
            let mut status = 0u32;
            let result = unsafe { self.transform.ProcessOutput(0, &mut out, &mut status) };
            let sample = unsafe { ManuallyDrop::take(&mut out[0].pSample) };
            unsafe { ManuallyDrop::drop(&mut out[0].pEvents) };
            match result {
                Ok(()) => {
                    let Some(sample) = sample else { return Ok(None) };
                    return self.copy_out(&sample).map(Some);
                }
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(None),
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    // The decoder has read the stream's real size: set the
                    // output type again and ask once more.
                    self.choose_output()?;
                }
                Err(e) => return Err(hr(e, "the decoder failed on a frame")),
            }
        }
        Ok(None)
    }

    fn copy_out(&mut self, sample: &IMFSample) -> Result<Frame> {
        let pts = unsafe { sample.GetSampleTime() }.ok().map(|t| t as f64 / 1e7);
        let (w, h) = (self.width as usize, self.height as usize);
        let mut data = vec![0u8; w * h + w * h.div_ceil(2)];
        // On the GPU: copy the decoder's texture out (falling back to Media
        // Foundation's own copy below if that fails).
        let mut copied = false;
        if self.hardware {
            if let Ok(dxgi) = unsafe { sample.GetBufferByIndex(0) }.and_then(|b| b.cast::<IMFDXGIBuffer>()) {
                match self.copy_texture(&dxgi, w, h, &mut data) {
                    Ok(()) => copied = true,
                    Err(e) => crate::trace::trace!("GPU picture copy failed: {e:#}"),
                }
            }
        }
        if !copied {
            self.copy_buffer(sample, w, h, &mut data)?;
        }
        if self.width > MAX_OUTPUT_WIDTH {
            let (data, width, height) = half_nv12(&data, w, h);
            return Ok(Frame { width, height, data, pts });
        }
        Ok(Frame { width: self.width, height: self.height, data, pts })
    }

    /// Copies the visible part of the decoder's NV12 texture into `data`,
    /// through a CPU-readable texture of the same size.
    fn copy_texture(&mut self, dxgi: &IMFDXGIBuffer, w: usize, h: usize, data: &mut [u8]) -> Result<()> {
        let gpu = gpu().context("no GPU")?;
        unsafe {
            let mut raw = std::ptr::null_mut();
            dxgi.GetResource(&ID3D11Texture2D::IID, &mut raw).map_err(|e| hr(e, "the decoder's picture has no texture"))?;
            let texture = ID3D11Texture2D::from_raw(raw);
            let index = dxgi.GetSubresourceIndex()?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            if desc.Format != DXGI_FORMAT_NV12 || (desc.Width as usize) < w || (desc.Height as usize) < h {
                bail!("the decoder's texture is not NV12 of the clip's size");
            }
            if self.staging.as_ref().is_none_or(|s| s.1 != desc.Width || s.2 != desc.Height) {
                let staging_desc = D3D11_TEXTURE2D_DESC {
                    Width: desc.Width,
                    Height: desc.Height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut staging = None;
                gpu.device.CreateTexture2D(&staging_desc, None, Some(&mut staging)).map_err(|e| hr(e, "could not make a readable texture"))?;
                self.staging = Some((staging.context("Direct3D gave no texture")?, desc.Width, desc.Height));
            }
            let staging = &self.staging.as_ref().unwrap().0;
            gpu.context.CopySubresourceRegion(staging, 0, 0, 0, 0, &texture, index, None);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            gpu.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| hr(e, "could not read the picture back"))?;
            // The CbCr rows follow the texture's full height of Y rows.
            copy_nv12(mapped.pData as *const u8, mapped.RowPitch as usize, desc.Height as usize, w, h, data);
            gpu.context.Unmap(staging, 0);
        }
        Ok(())
    }

    /// Copies a picture in system memory (CPU decoding, or Media
    /// Foundation's copy of a GPU one) into `data`.
    fn copy_buffer(&self, sample: &IMFSample, w: usize, h: usize, data: &mut [u8]) -> Result<()> {
        unsafe {
            let buffer = sample.ConvertToContiguousBuffer()?;
            // A 2D buffer knows its row pitch; a plain one is packed.
            if let Ok(two_d) = buffer.cast::<IMF2DBuffer>() {
                let mut scan0 = std::ptr::null_mut();
                let mut pitch = 0i32;
                let len = two_d.GetContiguousLength().unwrap_or(0) as usize;
                two_d.Lock2D(&mut scan0, &mut pitch)?;
                let pitch = pitch.unsigned_abs() as usize;
                if pitch < w || len < pitch * (self.coded_height as usize + h.div_ceil(2)) {
                    two_d.Unlock2D()?;
                    bail!("the decoder's picture is smaller than expected");
                }
                copy_nv12(scan0, pitch, self.coded_height as usize, w, h, data);
                two_d.Unlock2D()?;
            } else {
                let mut ptr = std::ptr::null_mut();
                let mut len = 0u32;
                buffer.Lock(&mut ptr, None, Some(&mut len))?;
                let pitch = (self.stride as usize).max(w);
                // The CbCr plane follows the coded rows; trust the output
                // type's height when the buffer is big enough for it.
                let coded_h = if len as usize >= pitch * self.coded_height as usize * 3 / 2 {
                    self.coded_height as usize
                } else {
                    (len as usize * 2 / 3 / pitch).max(h)
                };
                if (len as usize) < pitch * (coded_h + h.div_ceil(2)) {
                    buffer.Unlock()?;
                    bail!("the decoder's picture is smaller than expected");
                }
                copy_nv12(ptr, pitch, coded_h, w, h, data);
                buffer.Unlock()?;
            }
        }
        Ok(())
    }
}

/// Copies the visible part of an NV12 picture (Y rows at `src`, CbCr rows
/// after `coded_h` Y rows) into packed rows.
unsafe fn copy_nv12(src: *const u8, pitch: usize, coded_h: usize, w: usize, h: usize, out: &mut [u8]) {
    for row in 0..h {
        let from = unsafe { std::slice::from_raw_parts(src.add(row * pitch), w) };
        out[row * w..row * w + w].copy_from_slice(from);
    }
    let uv = unsafe { src.add(pitch * coded_h) };
    for row in 0..h.div_ceil(2) {
        let from = unsafe { std::slice::from_raw_parts(uv.add(row * pitch), w) };
        let at = w * h + row * w;
        out[at..at + w].copy_from_slice(from);
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
        }
    }
}
