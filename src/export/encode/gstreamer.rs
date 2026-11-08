//! Exporting on Linux: GStreamer's encoders, through the same run-time
//! loaded GStreamer as playback (see decode/gstreamer.rs).
//!
//!   appsrc (BGRA frames) ! videoconvert ! NV12 ! encoder ! parser
//!     ! length-prefixed access units ! appsink
//!
//! The encoder is the best one the machine has: VA-API (Intel, AMD), NVENC,
//! Quick Sync, V4L2 (ARM boards), then x264 or OpenH264 in software (AV1:
//! the GPU's only). Its
//! frames go into our own MP4 writer, like VideoToolbox's on macOS.
//! `SENTRY_STUDIO_GST_ENCODER` forces one element (for comparing).

use super::{EncodeSettings, FrameSink, Packet};
use crate::decode::gstreamer::{self as g, Gst, MapInfo, BUFFER_FLAG_DELTA_UNIT, MAP_READ, MESSAGE_ERROR, STATE_NULL, STATE_PLAYING};
use crate::export::mp4_writer::CodecConfig;
use crate::export::encode::Format;
use anyhow::{anyhow, bail, Result};
use std::ffi::{c_char, c_void, CString};

type Ptr = *mut c_void;

/// Encoder elements by preference, with their settings for a bitrate
/// (kbit/s) and keyframe interval (frames). No B-frames: the MP4 writer
/// keeps frames in the order they come.
fn encoders(codec: Format, kbps: u64, gop: u32) -> Vec<(&'static str, String)> {
    match codec {
        Format::H264 => vec![
            ("vah264enc", format!("vah264enc bitrate={kbps} key-int-max={gop} b-frames=0")),
            ("vah264lpenc", format!("vah264lpenc bitrate={kbps} key-int-max={gop} b-frames=0")),
            ("nvh264enc", format!("nvh264enc bitrate={kbps} gop-size={gop} bframes=0")),
            ("vaapih264enc", format!("vaapih264enc bitrate={kbps} keyframe-period={gop} max-bframes=0")),
            ("qsvh264enc", format!("qsvh264enc bitrate={kbps} gop-size={gop} b-frames=0")),
            ("v4l2h264enc", "v4l2h264enc".to_string()),
            ("vtenc_h264_hw", format!("vtenc_h264_hw bitrate={kbps} max-keyframe-interval={gop} allow-frame-reordering=false realtime=false")),
            ("x264enc", format!("x264enc bitrate={kbps} key-int-max={gop} bframes=0 speed-preset=veryfast")),
            ("openh264enc", format!("openh264enc bitrate={} gop-size={gop}", kbps * 1000)),
        ],
        Format::Hevc => vec![
            ("vah265enc", format!("vah265enc bitrate={kbps} key-int-max={gop} b-frames=0")),
            ("vah265lpenc", format!("vah265lpenc bitrate={kbps} key-int-max={gop} b-frames=0")),
            ("nvh265enc", format!("nvh265enc bitrate={kbps} gop-size={gop} bframes=0")),
            ("vaapih265enc", format!("vaapih265enc bitrate={kbps} keyframe-period={gop} max-bframes=0")),
            ("qsvh265enc", format!("qsvh265enc bitrate={kbps} gop-size={gop} b-frames=0")),
            ("vtenc_h265_hw", format!("vtenc_h265_hw bitrate={kbps} max-keyframe-interval={gop} allow-frame-reordering=false realtime=false")),
            ("x265enc", format!("x265enc bitrate={kbps} key-int-max={gop} speed-preset=veryfast option-string=bframes=0")),
        ],
        // AV1 on the GPU only (Intel Arc and Core Ultra, AMD RX 7000,
        // NVIDIA RTX 40); the software ones are far too slow at these
        // sizes and are only used when forced (for testing).
        Format::Av1 => vec![
            ("vaav1enc", format!("vaav1enc bitrate={kbps} key-int-max={gop}")),
            ("vaav1lpenc", format!("vaav1lpenc bitrate={kbps} key-int-max={gop}")),
            ("nvav1enc", format!("nvav1enc bitrate={kbps} gop-size={gop}")),
            ("qsvav1enc", format!("qsvav1enc bitrate={kbps} gop-size={gop}")),
            ("svtav1enc", format!("svtav1enc target-bitrate={kbps} intra-period-length={gop} preset=10")),
            ("rav1enc", format!("rav1enc bitrate={} max-key-frame-interval={gop} speed-preset=10 low-latency=true", kbps * 1000)),
            ("av1enc", format!("av1enc target-bitrate={kbps} keyframe-max-dist={gop} cpu-used=8 usage-profile=realtime end-usage=cbr lag-in-frames=0")),
        ],
    }
}

/// Encoders that run on the CPU.
fn software(element: &str) -> bool {
    matches!(element, "x264enc" | "openh264enc" | "x265enc" | "svtav1enc" | "rav1enc" | "av1enc")
}

/// Whether GStreamer here has an encoder for `format`, and a GPU one.
pub fn probe(format: Format) -> super::Support {
    let Ok(gst) = g::gst() else { return super::Support::No };
    let mut found = super::Support::No;
    for (element, _) in encoders(format, 4000, 72) {
        if !gst.has_element(element) {
            continue;
        }
        if !software(element) {
            return super::Support::Hardware;
        }
        if format != Format::Av1 {
            found = super::Support::Software;
        }
    }
    found
}

pub struct Encoder {
    gst: &'static Gst,
    element: String,
    codec: Format,
    pipeline: Ptr,
    src: Ptr,
    sink: Ptr,
    bus: Ptr,
    width: u32,
    height: u32,
    timescale: u32,
    ready: Vec<Packet>,
    config: Option<Vec<u8>>,
}

// Used from the export's thread only; GStreamer objects may move between threads.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new(s: &EncodeSettings) -> Result<Self> {
        let gst = g::gst()?;
        let kbps = (s.bitrate / 1000).max(100);
        let gop = (s.fps * 2.0).round() as u32;
        let forced = std::env::var("SENTRY_STUDIO_GST_ENCODER").ok();
        let mut tried = Vec::new();
        for (element, description) in encoders(s.codec, kbps, gop) {
            if forced.as_deref().is_some_and(|f| f != element) || !gst.has_element(element) {
                continue;
            }
            if s.codec == Format::Av1 && software(element) && forced.is_none() {
                continue;
            }
            match Self::start(gst, s, element, &description) {
                Ok(enc) => {
                    log::info!("export: encoding with GStreamer's {element}");
                    return Ok(enc);
                }
                Err(e) => tried.push(format!("{element}: {e:#}")),
            }
        }
        if tried.is_empty() {
            match s.codec {
                Format::Av1 => bail!("this computer has no AV1 encoder (it needs a GPU that encodes AV1, with GStreamer's VA-API or NVIDIA plugins)"),
                _ => bail!("no {} encoder in GStreamer (install the VA-API plugins, or gst-plugins-ugly for x264)", s.codec.label()),
            }
        }
        bail!("GStreamer's encoders failed: {}", tried.join("; "))
    }

    fn start(gst: &'static Gst, s: &EncodeSettings, element: &str, encoder: &str) -> Result<Self> {
        let fps = s.fps.round() as u32;
        let (parser, caps) = match s.codec {
            Format::H264 => ("h264parse", "video/x-h264,stream-format=avc,alignment=au"),
            Format::Hevc => ("h265parse", "video/x-h265,stream-format=hvc1,alignment=au"),
            Format::Av1 => ("av1parse", "video/x-av1,stream-format=obu-stream,alignment=tu"),
        };
        // 4:2:0, what players expect: NV12 for GPU encoders, I420 for
        // software ones (aom's AV1 takes no NV12).
        let raw = if software(element) { "video/x-raw,format=I420 ! " } else { "video/x-raw,format=NV12 ! " };
        let description = format!(
            "appsrc name=src format=time block=true max-bytes={queue} caps=\"video/x-raw,format=BGRA,width={w},height={h},framerate={fps}/1\" ! videoconvert ! {raw}\
             {encoder} ! {parser} ! {caps} ! appsink name=sink sync=false",
            w = s.width,
            h = s.height,
            // A few frames waiting at most: pushing waits for the encoder
            // instead of piling frames up in memory.
            queue = s.width as u64 * s.height as u64 * 4 * 4
        );
        let c = CString::new(description)?;
        let mut err: *mut g::GError = std::ptr::null_mut();
        let pipeline = unsafe { (gst.parse_launch)(c.as_ptr(), &mut err) };
        if pipeline.is_null() {
            bail!("could not build the pipeline: {}", unsafe { gst.take_error(err) });
        }
        if !err.is_null() {
            unsafe { gst.take_error(err) };
        }
        let src = unsafe { (gst.bin_get_by_name)(pipeline, c"src".as_ptr()) };
        let sink = unsafe { (gst.bin_get_by_name)(pipeline, c"sink".as_ptr()) };
        let bus = unsafe { (gst.element_get_bus)(pipeline) };
        let me = Encoder {
            gst,
            element: element.to_string(),
            codec: s.codec,
            pipeline,
            src,
            sink,
            bus,
            width: s.width,
            height: s.height,
            timescale: s.timescale,
            ready: Vec::new(),
            config: None,
        };
        if src.is_null() || sink.is_null() || bus.is_null() {
            bail!("the pipeline is incomplete");
        }
        if unsafe { (gst.element_set_state)(pipeline, STATE_PLAYING) } == 0 {
            bail!("could not start: {}", me.error().unwrap_or_default());
        }
        Ok(me)
    }

    fn error(&self) -> Option<String> {
        let gst = self.gst;
        let msg = unsafe { (gst.bus_pop_filtered)(self.bus, MESSAGE_ERROR) };
        if msg.is_null() {
            return None;
        }
        let mut err: *mut g::GError = std::ptr::null_mut();
        let mut debug: *mut c_char = std::ptr::null_mut();
        unsafe { (gst.message_parse_error)(msg, &mut err, &mut debug) };
        let text = unsafe { gst.take_error(err) };
        unsafe {
            if !debug.is_null() {
                (gst.g_free)(debug as Ptr);
            }
            (gst.mini_object_unref)(msg);
        }
        Some(text)
    }

    /// Takes what the encoder has finished, waiting up to `wait_ns` for
    /// the first one.
    fn pull(&mut self, mut wait_ns: u64) -> Result<bool> {
        let gst = self.gst;
        let mut got = false;
        loop {
            let sample = unsafe { (gst.app_sink_try_pull_sample)(self.sink, wait_ns) };
            if sample.is_null() {
                break;
            }
            wait_ns = 0;
            got = true;
            unsafe {
                if self.config.is_none() {
                    self.config = codec_data(gst, sample);
                }
                let buffer = (gst.sample_get_buffer)(sample);
                if !buffer.is_null() {
                    let mut map: MapInfo = std::mem::zeroed();
                    if (gst.buffer_map)(buffer, &mut map, MAP_READ) != 0 {
                        let mut data = std::slice::from_raw_parts(map.data, map.size).to_vec();
                        let pts_ns = (*buffer).pts;
                        let pts = if pts_ns == u64::MAX { 0 } else { (pts_ns as u128 * self.timescale as u128 / 1_000_000_000) as i64 };
                        let sync = (*buffer).mini_object.flags & BUFFER_FLAG_DELTA_UNIT == 0;
                        (gst.buffer_unmap)(buffer, &mut map);
                        if self.codec == Format::Av1 {
                            data = crate::export::av1::sample(&data);
                            // av1parse may give no codec_data: the first
                            // keyframe's sequence header makes the av1C.
                            if sync && self.config.as_ref().is_none_or(|c| c.first() != Some(&0x81)) {
                                self.config = crate::export::av1::av1c(&data).or(self.config.take());
                            }
                        }
                        self.ready.push(Packet { data, pts, sync });
                    }
                }
                (gst.mini_object_unref)(sample);
            }
        }
        if let Some(e) = self.error() {
            bail!("{} stopped: {e}", self.element);
        }
        Ok(got)
    }
}

/// The `codec_data` in a sample's caps (avcC or hvcC).
unsafe fn codec_data(gst: &Gst, sample: Ptr) -> Option<Vec<u8>> {
    let caps = unsafe { (gst.sample_get_caps)(sample) };
    if caps.is_null() {
        return None;
    }
    let structure = unsafe { (gst.caps_get_structure)(caps, 0) };
    if structure.is_null() {
        return None;
    }
    let value = unsafe { (gst.structure_get_value)(structure, c"codec_data".as_ptr()) };
    if value.is_null() {
        return None;
    }
    let buffer = unsafe { (gst.value_get_buffer)(value) };
    if buffer.is_null() {
        return None;
    }
    let mut map: MapInfo = unsafe { std::mem::zeroed() };
    if unsafe { (gst.buffer_map)(buffer, &mut map, MAP_READ) } == 0 {
        return None;
    }
    let data = unsafe { std::slice::from_raw_parts(map.data, map.size) }.to_vec();
    unsafe { (gst.buffer_unmap)(buffer, &mut map) };
    Some(data)
}

impl FrameSink for Encoder {
    fn name(&self) -> String {
        format!("GStreamer {}", self.element)
    }

    fn push_bgra(&mut self, bgra: &[u8], pts: i64, duration: i64) -> Result<()> {
        let gst = self.gst;
        let size = self.width as usize * self.height as usize * 4;
        if bgra.len() < size {
            bail!("a frame was {} bytes, not {size}", bgra.len());
        }
        let to_ns = |t: i64| (t.max(0) as u128 * 1_000_000_000 / self.timescale as u128) as u64;
        unsafe {
            let buffer = (gst.buffer_new_allocate)(std::ptr::null_mut(), size, std::ptr::null_mut());
            if buffer.is_null() {
                bail!("GStreamer could not allocate a frame");
            }
            (gst.buffer_fill)(buffer, 0, bgra.as_ptr() as *const c_void, size);
            (*buffer).pts = to_ns(pts);
            (*buffer).duration = to_ns(duration);
            // push_buffer takes the buffer over.
            if (gst.app_src_push_buffer)(self.src, buffer) != 0 {
                return Err(anyhow!("{} refused a frame: {}", self.element, self.error().unwrap_or_default()));
            }
        }
        // Collect what is done, without waiting.
        self.pull(0)?;
        Ok(())
    }

    fn take(&mut self) -> Vec<Packet> {
        std::mem::take(&mut self.ready)
    }

    fn finish(mut self: Box<Self>) -> Result<super::Finished> {
        let gst = self.gst;
        unsafe { (gst.app_src_end_of_stream)(self.src) };
        // Until the end of the stream comes through, or nothing for 10 s
        // (a software encoder can be far behind).
        let mut deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if self.pull(200_000_000)? {
                deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            } else if self.eos() {
                break;
            }
        }
        let config = self.config.take().ok_or_else(|| anyhow!("{} gave no codec configuration", self.element))?;
        let (entry, config_box) = match self.codec {
            Format::H264 => (*b"avc1", *b"avcC"),
            Format::Hevc => (*b"hvc1", *b"hvcC"),
            Format::Av1 => (*b"av01", *b"av1C"),
        };
        Ok(super::Finished::Packets(std::mem::take(&mut self.ready), CodecConfig { entry, config_box, config }))
    }
}

impl Encoder {
    fn eos(&self) -> bool {
        let msg = unsafe { (self.gst.bus_pop_filtered)(self.bus, g::MESSAGE_EOS) };
        if msg.is_null() {
            return false;
        }
        unsafe { (self.gst.mini_object_unref)(msg) };
        true
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        let gst = self.gst;
        unsafe {
            if !self.pipeline.is_null() {
                (gst.element_set_state)(self.pipeline, STATE_NULL);
            }
            for p in [self.src, self.sink, self.bus, self.pipeline] {
                if !p.is_null() {
                    (gst.object_unref)(p);
                }
            }
        }
    }
}
