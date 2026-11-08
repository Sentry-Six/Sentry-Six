//! Linux: H.264 and H.265 decoding through GStreamer, loaded at run time.
//!
//! GStreamer 1.x is on every desktop distribution and its C interface has
//! been stable for over a decade, so loading it with dlopen (instead of
//! linking it at build time) gives one binary that runs anywhere, builds
//! without GStreamer's development files, and can say plainly what is
//! missing. It also picks the best decoder the machine has: VA-API (Intel,
//! AMD), NVDEC (NVIDIA), V4L2 (ARM boards), then FFmpeg's software decoder.
//!
//! Each `Decoder` runs a small pipeline:
//!   appsrc (Annex B access units) ! parser ! decoder ! videoconvert
//!     ! NV12 ! appsink
//! Every input buffer carries its sample's timestamp and every picture
//! comes back with it, so a decoder that holds pictures a little (some
//! do) still lines each one up with the right moment; `drain` collects
//! what is left at the end of a clip. `SENTRY_STUDIO_GST_DECODER` forces
//! one decoder element (for comparing).
//!
//! The module builds on every Unix so it can be tested on macOS against
//! Homebrew's GStreamer (`--gst-check`); only Linux uses it for playback.

use super::Plane;
use crate::mp4::{Codec, VideoTrack};
use anyhow::{anyhow, bail, Context, Result};
use std::collections::VecDeque;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

type Ptr = *mut c_void;

// Public GStreamer structures read or written here (stable ABI).
#[repr(C)]
pub(crate) struct MiniObject {
    type_: usize,
    refcount: c_int,
    lockstate: c_int,
    pub(crate) flags: u32,
    copy: Ptr,
    dispose: Ptr,
    free: Ptr,
    priv_uint: u32,
    priv_pointer: Ptr,
}

#[repr(C)]
pub(crate) struct Buffer {
    pub(crate) mini_object: MiniObject,
    pool: Ptr,
    pub(crate) pts: u64,
    pub(crate) dts: u64,
    pub(crate) duration: u64,
    offset: u64,
    offset_end: u64,
}

#[repr(C)]
pub(crate) struct MapInfo {
    memory: Ptr,
    flags: u32,
    pub(crate) data: *mut u8,
    pub(crate) size: usize,
    maxsize: usize,
    user_data: [Ptr; 4],
    reserved: [Ptr; 4],
}

#[repr(C)]
struct VideoMeta {
    meta_flags: u32,
    meta_info: Ptr,
    buffer: Ptr,
    flags: u32,
    format: u32,
    id: c_int,
    width: u32,
    height: u32,
    n_planes: u32,
    offset: [usize; 4],
    stride: [c_int; 4],
}

#[repr(C)]
pub(crate) struct GError {
    domain: u32,
    code: c_int,
    message: *mut c_char,
}

pub(crate) const STATE_NULL: c_int = 1;
pub(crate) const STATE_PLAYING: c_int = 4;
pub(crate) const MAP_READ: u32 = 1;
pub(crate) const MESSAGE_ERROR: u32 = 1 << 1;
pub(crate) const MESSAGE_EOS: u32 = 1 << 0;
const CLOCK_TIME_NONE: u64 = u64::MAX;
/// GST_BUFFER_FLAG_DELTA_UNIT: not a keyframe.
pub(crate) const BUFFER_FLAG_DELTA_UNIT: u32 = 1 << 13;

/// The GStreamer functions used, looked up once (the export's encoder
/// uses them too).
pub(crate) struct Gst {
    _libs: Vec<libloading::Library>,
    init_check: unsafe extern "C" fn(*mut c_int, *mut *mut *mut c_char, *mut *mut GError) -> c_int,
    pub(crate) parse_launch: unsafe extern "C" fn(*const c_char, *mut *mut GError) -> Ptr,
    pub(crate) bin_get_by_name: unsafe extern "C" fn(Ptr, *const c_char) -> Ptr,
    pub(crate) element_set_state: unsafe extern "C" fn(Ptr, c_int) -> c_int,
    pub(crate) element_get_bus: unsafe extern "C" fn(Ptr) -> Ptr,
    element_factory_find: unsafe extern "C" fn(*const c_char) -> Ptr,
    pub(crate) object_unref: unsafe extern "C" fn(Ptr),
    pub(crate) buffer_new_allocate: unsafe extern "C" fn(Ptr, usize, Ptr) -> *mut Buffer,
    pub(crate) buffer_fill: unsafe extern "C" fn(*mut Buffer, usize, *const c_void, usize) -> usize,
    pub(crate) buffer_map: unsafe extern "C" fn(*mut Buffer, *mut MapInfo, u32) -> c_int,
    pub(crate) buffer_unmap: unsafe extern "C" fn(*mut Buffer, *mut MapInfo),
    buffer_get_meta: unsafe extern "C" fn(*mut Buffer, usize) -> Ptr,
    pub(crate) sample_get_buffer: unsafe extern "C" fn(Ptr) -> *mut Buffer,
    pub(crate) sample_get_caps: unsafe extern "C" fn(Ptr) -> Ptr,
    pub(crate) caps_get_structure: unsafe extern "C" fn(Ptr, u32) -> Ptr,
    structure_get_int: unsafe extern "C" fn(Ptr, *const c_char, *mut c_int) -> c_int,
    pub(crate) structure_get_value: unsafe extern "C" fn(Ptr, *const c_char) -> Ptr,
    /// g_value_get_boxed (gst_value_get_buffer is a macro over it).
    pub(crate) value_get_buffer: unsafe extern "C" fn(Ptr) -> *mut Buffer,
    pub(crate) mini_object_unref: unsafe extern "C" fn(Ptr),
    pub(crate) bus_pop_filtered: unsafe extern "C" fn(Ptr, u32) -> Ptr,
    pub(crate) message_parse_error: unsafe extern "C" fn(Ptr, *mut *mut GError, *mut *mut c_char),
    pub(crate) app_src_push_buffer: unsafe extern "C" fn(Ptr, *mut Buffer) -> c_int,
    pub(crate) app_src_end_of_stream: unsafe extern "C" fn(Ptr) -> c_int,
    pub(crate) app_sink_try_pull_sample: unsafe extern "C" fn(Ptr, u64) -> Ptr,
    video_meta_api_get_type: unsafe extern "C" fn() -> usize,
    error_free: unsafe extern "C" fn(*mut GError),
    pub(crate) g_free: unsafe extern "C" fn(Ptr),
}

// The function pointers are plain C entry points, callable from any thread.
unsafe impl Send for Gst {}
unsafe impl Sync for Gst {}

fn open_lib(names: &[&str]) -> Result<libloading::Library> {
    let mut last = None;
    for name in names {
        match unsafe { libloading::Library::new(name) } {
            Ok(lib) => return Ok(lib),
            Err(e) => last = Some(e),
        }
    }
    Err(anyhow!("{} ({})", names[0], last.map(|e| e.to_string()).unwrap_or_default()))
}

fn candidates(base: &str) -> Vec<String> {
    let mut v = vec![format!("lib{base}.so.0"), format!("lib{base}.so")];
    if cfg!(target_os = "macos") {
        for dir in ["/opt/homebrew/lib", "/usr/local/lib", "/Library/Frameworks/GStreamer.framework/Libraries"] {
            v.push(format!("{dir}/lib{base}.dylib"));
            v.push(format!("{dir}/lib{base}.0.dylib"));
        }
    }
    v
}

impl Gst {
    fn load() -> Result<Gst> {
        let names = |base: &str| candidates(base);
        let lib = |base: &str| -> Result<libloading::Library> {
            let list = names(base);
            open_lib(&list.iter().map(String::as_str).collect::<Vec<_>>())
        };
        let glib = lib("glib-2.0")?;
        let gobject = lib("gobject-2.0")?;
        let core = lib("gstreamer-1.0")?;
        let app = lib("gstapp-1.0")?;
        let video = lib("gstvideo-1.0")?;
        macro_rules! sym {
            ($lib:expr, $name:literal) => {
                *unsafe { $lib.get($name) }.with_context(|| format!("GStreamer is missing {}", String::from_utf8_lossy(&$name[..$name.len() - 1])))?
            };
        }
        let gst = Gst {
            init_check: sym!(core, b"gst_init_check\0"),
            parse_launch: sym!(core, b"gst_parse_launch\0"),
            bin_get_by_name: sym!(core, b"gst_bin_get_by_name\0"),
            element_set_state: sym!(core, b"gst_element_set_state\0"),
            element_get_bus: sym!(core, b"gst_element_get_bus\0"),
            element_factory_find: sym!(core, b"gst_element_factory_find\0"),
            object_unref: sym!(core, b"gst_object_unref\0"),
            buffer_new_allocate: sym!(core, b"gst_buffer_new_allocate\0"),
            buffer_fill: sym!(core, b"gst_buffer_fill\0"),
            buffer_map: sym!(core, b"gst_buffer_map\0"),
            buffer_unmap: sym!(core, b"gst_buffer_unmap\0"),
            buffer_get_meta: sym!(core, b"gst_buffer_get_meta\0"),
            sample_get_buffer: sym!(core, b"gst_sample_get_buffer\0"),
            sample_get_caps: sym!(core, b"gst_sample_get_caps\0"),
            caps_get_structure: sym!(core, b"gst_caps_get_structure\0"),
            structure_get_int: sym!(core, b"gst_structure_get_int\0"),
            structure_get_value: sym!(core, b"gst_structure_get_value\0"),
            value_get_buffer: sym!(gobject, b"g_value_get_boxed\0"),
            mini_object_unref: sym!(core, b"gst_mini_object_unref\0"),
            bus_pop_filtered: sym!(core, b"gst_bus_pop_filtered\0"),
            message_parse_error: sym!(core, b"gst_message_parse_error\0"),
            app_src_push_buffer: sym!(app, b"gst_app_src_push_buffer\0"),
            app_src_end_of_stream: sym!(app, b"gst_app_src_end_of_stream\0"),
            app_sink_try_pull_sample: sym!(app, b"gst_app_sink_try_pull_sample\0"),
            video_meta_api_get_type: sym!(video, b"gst_video_meta_api_get_type\0"),
            error_free: sym!(glib, b"g_error_free\0"),
            g_free: sym!(glib, b"g_free\0"),
            _libs: vec![glib, gobject, core, app, video],
        };
        let mut err: *mut GError = std::ptr::null_mut();
        if unsafe { (gst.init_check)(std::ptr::null_mut(), std::ptr::null_mut(), &mut err) } == 0 {
            bail!("GStreamer failed to start: {}", unsafe { gst.take_error(err) });
        }
        Ok(gst)
    }

    pub(crate) unsafe fn take_error(&self, err: *mut GError) -> String {
        if err.is_null() {
            return "unknown error".into();
        }
        let msg = unsafe { (*err).message };
        let text = if msg.is_null() { "unknown error".into() } else { unsafe { CStr::from_ptr(msg) }.to_string_lossy().into_owned() };
        unsafe { (self.error_free)(err) };
        text
    }

    pub(crate) fn has_element(&self, name: &str) -> bool {
        let Ok(c) = CString::new(name) else { return false };
        let factory = unsafe { (self.element_factory_find)(c.as_ptr()) };
        if factory.is_null() {
            return false;
        }
        unsafe { (self.object_unref)(factory) };
        true
    }
}

static GST: OnceLock<Result<Gst, String>> = OnceLock::new();

pub(crate) fn gst() -> Result<&'static Gst> {
    GST.get_or_init(|| Gst::load().map_err(|e| format!("{e:#}")))
        .as_ref()
        .map_err(|e| anyhow!("video decoding needs GStreamer 1.x with its base, good and libav plugins ({e})"))
}

/// Decoder elements by preference: hardware first, then software.
fn decoder_elements(codec: Codec) -> &'static [&'static str] {
    match codec {
        Codec::H264 => &["vah264dec", "nvh264dec", "vaapih264dec", "v4l2slh264dec", "v4l2h264dec", "avdec_h264", "openh264dec"],
        Codec::H265 => &["vah265dec", "nvh265dec", "vaapih265dec", "v4l2slh265dec", "v4l2h265dec", "avdec_h265"],
    }
}

/// Decoder elements that failed on this machine (a driver that can't
/// start, say): skipped from then on.
static FAILED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Decoder elements that have produced a picture on this machine.
static WORKED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// How many pictures each decoder element was seen to hold back; the
/// decoder only waits for a picture when more than this are in flight.
static LATENCY: Mutex<Vec<(String, usize)>> = Mutex::new(Vec::new());

fn latency_of(element: &str) -> usize {
    LATENCY.lock().unwrap().iter().find(|(e, _)| e == element).map_or(0, |e| e.1)
}

fn raise_latency(element: &str, to: usize) {
    let mut list = LATENCY.lock().unwrap();
    match list.iter_mut().find(|(e, _)| e == element) {
        Some(e) => e.1 = e.1.max(to),
        None => list.push((element.to_string(), to)),
    }
}

/// Longest wait for a picture the decoder should have by now (decoding
/// one takes a few milliseconds, even in software).
const WAIT: Duration = Duration::from_millis(40);
/// Longest wait for a fresh pipeline's first picture (the decoder starts).
const FIRST_WAIT: Duration = Duration::from_secs(1);

struct Pipeline {
    gst: &'static Gst,
    pipeline: Ptr,
    src: Ptr,
    sink: Ptr,
    bus: Ptr,
}

impl Pipeline {
    fn new(gst: &'static Gst, codec: Codec, element: &str) -> Result<Self> {
        let (caps, parser) = match codec {
            Codec::H264 => ("video/x-h264,stream-format=byte-stream,alignment=au", "h264parse"),
            Codec::H265 => ("video/x-h265,stream-format=byte-stream,alignment=au", "h265parse"),
        };
        // Live: decoders built on GStreamer's codec base classes (VA,
        // NVDEC, V4L2) and FFmpeg's then hand pictures back as soon as
        // they can instead of filling their reorder buffers first.
        let description = format!(
            "appsrc name=src is-live=true format=time caps=\"{caps}\" ! {parser} ! {element} ! videoconvert ! \
             video/x-raw,format=NV12 ! appsink name=sink sync=false max-buffers=64"
        );
        let c = CString::new(description)?;
        let mut err: *mut GError = std::ptr::null_mut();
        let pipeline = unsafe { (gst.parse_launch)(c.as_ptr(), &mut err) };
        if pipeline.is_null() {
            bail!("GStreamer could not build a {element} pipeline: {}", unsafe { gst.take_error(err) });
        }
        if !err.is_null() {
            // A warning (a missing optional property, say): carry on.
            unsafe { gst.take_error(err) };
        }
        let src = unsafe { (gst.bin_get_by_name)(pipeline, c"src".as_ptr()) };
        let sink = unsafe { (gst.bin_get_by_name)(pipeline, c"sink".as_ptr()) };
        let bus = unsafe { (gst.element_get_bus)(pipeline) };
        // From here on, dropping `me` releases whatever was made.
        let me = Pipeline { gst, pipeline, src, sink, bus };
        if src.is_null() || sink.is_null() || bus.is_null() {
            bail!("GStreamer's {element} pipeline is incomplete");
        }
        // Live pipelines report "no preroll" here; only a failure matters.
        if unsafe { (gst.element_set_state)(pipeline, STATE_PLAYING) } == 0 {
            bail!("GStreamer could not start {element}: {}", me.error(gst).unwrap_or_default());
        }
        Ok(me)
    }

    /// The first error the pipeline posted, if any.
    fn error(&self, gst: &Gst) -> Option<String> {
        let msg = unsafe { (gst.bus_pop_filtered)(self.bus, MESSAGE_ERROR) };
        if msg.is_null() {
            return None;
        }
        let mut err: *mut GError = std::ptr::null_mut();
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

    fn eos(&self, gst: &Gst) -> bool {
        let msg = unsafe { (gst.bus_pop_filtered)(self.bus, MESSAGE_EOS) };
        if msg.is_null() {
            return false;
        }
        unsafe { (gst.mini_object_unref)(msg) };
        true
    }

    /// Stops the pipeline and releases it (also done on drop).
    fn close(&mut self) {
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
        self.pipeline = std::ptr::null_mut();
        self.src = std::ptr::null_mut();
        self.sink = std::ptr::null_mut();
        self.bus = std::ptr::null_mut();
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        self.close();
    }
}

pub struct Decoder {
    gst: &'static Gst,
    codec: Codec,
    element: String,
    pipeline: Pipeline,
    parameter_sets: Vec<u8>,
    nal_length_size: usize,
    width: u32,
    height: u32,
    /// Moments (ns) of the samples fed in whose pictures aren't back. A
    /// decoder hands pictures back in display order, so when one comes
    /// back, any earlier moment still here was dropped (an open GOP's
    /// leading pictures after a seek, say) and is forgotten.
    pending: Vec<u64>,
    /// Pictures back from the decoder, not yet handed out.
    ready: VecDeque<Frame>,
    /// Pictures handed back so far (none yet: the first can take longer).
    returned: usize,
    /// The last moment `decode` (no timestamp given) made up.
    next_moment: f64,
}

// The pipeline is only used from the thread that owns the decoder;
// GStreamer objects are thread-safe to hand between threads.
unsafe impl Send for Decoder {}

impl Decoder {
    pub fn new(track: &VideoTrack) -> Result<Self> {
        let gst = gst()?;
        let forced = std::env::var("SENTRY_STUDIO_GST_DECODER").ok();
        let mut tried = Vec::new();
        let list: Vec<String> = match &forced {
            Some(name) => vec![name.clone()],
            None => decoder_elements(track.codec).iter().map(|s| s.to_string()).collect(),
        };
        for element in list {
            if forced.is_none() && FAILED.lock().unwrap().contains(&element) {
                continue;
            }
            if !gst.has_element(&element) {
                continue;
            }
            match Pipeline::new(gst, track.codec, &element) {
                Ok(pipeline) => {
                    announce(&element);
                    return Ok(Self {
                        gst,
                        codec: track.codec,
                        element,
                        pipeline,
                        parameter_sets: super::parameter_sets(track),
                        nal_length_size: track.nal_length_size as usize,
                        width: track.width & !1,
                        height: track.height & !1,
                        pending: Vec::new(),
                        ready: VecDeque::new(),
                        returned: 0,
                        next_moment: 0.0,
                    });
                }
                Err(e) => {
                    tried.push(format!("{element}: {e:#}"));
                    FAILED.lock().unwrap().push(element);
                }
            }
        }
        match track.codec {
            Codec::H264 if tried.is_empty() => bail!("no H.264 decoder in GStreamer (install gst-libav or the VA-API plugins)"),
            Codec::H265 if tried.is_empty() => bail!("no H.265 decoder in GStreamer (install gst-libav or the VA-API plugins)"),
            _ => bail!("GStreamer's decoders failed: {}", tried.join("; ")),
        }
    }

    /// Forgets pictures in flight (after a seek): a fresh pipeline, which
    /// is quicker and surer than flushing one.
    pub fn reset(&mut self) {
        self.ready.clear();
        self.pending.clear();
        self.returned = 0;
        // The old one goes first: hardware decoders have few contexts.
        self.pipeline.close();
        match Pipeline::new(self.gst, self.codec, &self.element) {
            Ok(p) => self.pipeline = p,
            Err(e) => log::warn!("video decoder restart failed: {e:#}"),
        }
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn decode(&mut self, data: &[u8]) -> Result<Option<Frame>> {
        // Moments one frame apart (36 fps), so pictures still pair up.
        self.next_moment += 1.0 / 36.0;
        self.decode_at(data, self.next_moment)
    }

    /// Decodes one sample shown at `pts` seconds. The picture handed back
    /// may be an earlier sample's (see `Frame::pts`).
    pub fn decode_at(&mut self, data: &[u8], pts: f64) -> Result<Option<Frame>> {
        let gst = self.gst;
        if self.pipeline.pipeline.is_null() {
            bail!("the video decoder is not running");
        }
        let bytes = super::annex_b(data, self.nal_length_size, self.codec, &self.parameter_sets)?;
        unsafe {
            let buffer = (gst.buffer_new_allocate)(std::ptr::null_mut(), bytes.len(), std::ptr::null_mut());
            if buffer.is_null() {
                bail!("GStreamer could not allocate a buffer");
            }
            (gst.buffer_fill)(buffer, 0, bytes.as_ptr() as *const c_void, bytes.len());
            let ns = (pts.max(0.0) * 1e9).round() as u64;
            self.pending.push(ns);
            (*buffer).pts = ns;
            (*buffer).dts = CLOCK_TIME_NONE;
            (*buffer).duration = CLOCK_TIME_NONE;
            // Takes the buffer.
            let flow = (gst.app_src_push_buffer)(self.pipeline.src, buffer);
            if flow != 0 {
                bail!("the {} decoder stopped taking frames ({})", self.element, self.pipeline.error(gst).unwrap_or_else(|| format!("flow {flow}")));
            }
        }
        self.collect()?;
        Ok(self.ready.pop_front())
    }

    /// Ends the clip: every picture still inside the decoder.
    pub fn drain(&mut self) -> Vec<Frame> {
        let gst = self.gst;
        if self.pipeline.pipeline.is_null() {
            return Vec::new();
        }
        unsafe { (gst.app_src_end_of_stream)(self.pipeline.src) };
        let deadline = Instant::now() + Duration::from_secs(2);
        while !self.pending.is_empty() && Instant::now() < deadline && !self.pipeline.eos(gst) {
            match self.pull(Duration::from_millis(50)) {
                Ok(Some(frame)) => self.ready.push_back(frame),
                Ok(None) => {}
                Err(_) => break,
            }
        }
        // The pipeline has had its end of stream: start a fresh one in
        // case more of this clip is asked for (a seek back).
        let out: Vec<Frame> = self.ready.drain(..).collect();
        self.reset();
        out
    }

    /// Moves finished pictures into `ready`, waiting only when the
    /// decoder holds more pictures than it has been seen to.
    fn collect(&mut self) -> Result<()> {
        // Whatever is already there.
        while let Some(frame) = self.pull(Duration::ZERO)? {
            self.ready.push_back(frame);
        }
        let held = latency_of(&self.element);
        if self.pending.len() <= held {
            return Ok(());
        }
        // A fresh pipeline's first picture can take a while (the decoder
        // starts up); later ones come within a few milliseconds.
        let wait = if self.returned == 0 && held == 0 { FIRST_WAIT } else { WAIT };
        match self.pull(wait)? {
            Some(frame) => self.ready.push_back(frame),
            // It holds this many back: from now on, don't wait for them.
            None => raise_latency(&self.element, self.pending.len().min(16)),
        }
        Ok(())
    }

    fn pull(&mut self, wait: Duration) -> Result<Option<Frame>> {
        let gst = self.gst;
        let sample = unsafe { (gst.app_sink_try_pull_sample)(self.pipeline.sink, wait.as_nanos() as u64) };
        if sample.is_null() {
            if let Some(e) = self.pipeline.error(gst) {
                let element = self.element.clone();
                if self.returned == 0 && !WORKED.lock().unwrap().contains(&element) {
                    // It has never produced a picture on this machine (a
                    // driver that can't start, say): don't use it again. One
                    // that has worked is only having trouble with a frame.
                    FAILED.lock().unwrap().push(element.clone());
                }
                bail!("the {element} decoder failed: {e}");
            }
            return Ok(None);
        }
        let frame = unsafe { self.copy_sample(sample) };
        unsafe { (gst.mini_object_unref)(sample) };
        if self.returned == 0 {
            let mut worked = WORKED.lock().unwrap();
            if !worked.contains(&self.element) {
                worked.push(self.element.clone());
            }
        }
        self.returned += 1;
        // This moment and any earlier one are no longer in flight.
        match frame.as_ref().ok().and_then(|f| f.pts) {
            Some(at) => {
                let ns = (at * 1e9).round() as u64;
                self.pending.retain(|&p| p > ns);
            }
            None => {
                if !self.pending.is_empty() {
                    self.pending.remove(0);
                }
            }
        }
        frame.map(Some)
    }

    unsafe fn copy_sample(&self, sample: Ptr) -> Result<Frame> {
        let gst = self.gst;
        let buffer = unsafe { (gst.sample_get_buffer)(sample) };
        if buffer.is_null() {
            bail!("a decoded picture has no data");
        }
        let caps = unsafe { (gst.sample_get_caps)(sample) };
        let (mut cw, mut ch) = (self.width as c_int, self.height as c_int);
        if !caps.is_null() {
            let s = unsafe { (gst.caps_get_structure)(caps, 0) };
            if !s.is_null() {
                unsafe {
                    (gst.structure_get_int)(s, c"width".as_ptr(), &mut cw);
                    (gst.structure_get_int)(s, c"height".as_ptr(), &mut ch);
                }
            }
        }
        let (w, h) = ((cw.max(2) as u32 & !1) as usize, (ch.max(2) as u32 & !1) as usize);
        // Plane layout: the video meta's when there is one, else the
        // default (rows rounded up to 4 bytes, CbCr after the Y rows).
        let meta = unsafe { (gst.buffer_get_meta)(buffer, (gst.video_meta_api_get_type)()) } as *const VideoMeta;
        let (y_off, y_stride, uv_off, uv_stride) = if !meta.is_null() && unsafe { (*meta).n_planes } >= 2 {
            let m = unsafe { &*meta };
            (m.offset[0], m.stride[0] as usize, m.offset[1], m.stride[1] as usize)
        } else {
            let stride = (cw as usize + 3) & !3;
            let rows = (ch as usize + 1) & !1;
            (0, stride, stride * rows, stride)
        };
        let pts = unsafe { (*buffer).pts };
        let mut map: MapInfo = unsafe { std::mem::zeroed() };
        if unsafe { (gst.buffer_map)(buffer, &mut map, MAP_READ) } == 0 {
            bail!("a decoded picture could not be read");
        }
        let src = unsafe { std::slice::from_raw_parts(map.data, map.size) };
        let need_y = y_off + y_stride * (h - 1) + w;
        let need_uv = uv_off + uv_stride * (h / 2 - 1) + w;
        let result = if src.len() < need_y.max(need_uv) || y_stride < w || uv_stride < w {
            Err(anyhow!("a decoded picture is smaller than its size says"))
        } else {
            let mut data = vec![0u8; w * h + w * (h / 2)];
            for row in 0..h {
                data[row * w..row * w + w].copy_from_slice(&src[y_off + row * y_stride..][..w]);
            }
            for row in 0..h / 2 {
                let at = w * h + row * w;
                data[at..at + w].copy_from_slice(&src[uv_off + row * uv_stride..][..w]);
            }
            let pts = (pts != CLOCK_TIME_NONE).then(|| pts as f64 / 1e9);
            if w as u32 > super::MAX_OUTPUT_WIDTH {
                let (data, width, height) = super::half_nv12(&data, w, h);
                Ok(Frame { width, height, data, pts })
            } else {
                Ok(Frame { width: w as u32, height: h as u32, data, pts })
            }
        };
        unsafe { (gst.buffer_unmap)(buffer, &mut map) };
        result
    }
}

/// Says once per decoder element which is in use (the log, and
/// diagnostics), like the Windows build.
fn announce(element: &str) {
    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    if !seen.iter().any(|e| e == element) {
        let kind = if element.starts_with("avdec") || element.starts_with("openh264") { "CPU" } else { "GPU" };
        log::info!("video decoding: {kind} (GStreamer {element})");
        seen.push(element.to_string());
        crate::applog::set_decoder(format!("{kind} (GStreamer {})", seen.join(", ")));
    }
}

/// A decoded NV12 picture: Y rows then CbCr rows, packed.
pub struct Frame {
    width: u32,
    height: u32,
    data: Vec<u8>,
    pts: Option<f64>,
}

impl Frame {
    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// The moment (seconds) of the sample this picture was decoded from.
    pub fn pts(&self) -> Option<f64> {
        self.pts
    }

    pub fn with_planes<R>(&self, f: impl FnOnce(Plane<'_>, Plane<'_>) -> R) -> Option<R> {
        let w = self.width as usize;
        let h = self.height as usize;
        let (y, uv) = self.data.split_at(w * h);
        Some(f(
            Plane { data: y, stride: w, width: self.width, height: self.height },
            Plane { data: uv, stride: w, width: self.width / 2, height: self.height / 2 },
        ))
    }
}
