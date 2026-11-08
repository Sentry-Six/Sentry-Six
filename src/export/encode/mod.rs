//! Hardware video encoders: VideoToolbox on macOS, GStreamer on Linux
//! (VA-API, NVENC, Quick Sync, V4L2, or x264), Media Foundation on
//! Windows. On macOS the compositor draws straight into VideoToolbox's
//! frames; elsewhere frames come from memory through `FrameSink`.

/// The video format to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    /// Plays everywhere.
    H264,
    /// About a third smaller for the same picture; most devices play it.
    Hevc,
    /// Smaller again; newer devices only, and only GPUs from about 2022
    /// encode it.
    Av1,
}

impl Format {
    pub const ALL: [Format; 3] = [Format::H264, Format::Hevc, Format::Av1];

    pub fn key(self) -> &'static str {
        match self {
            Format::H264 => "h264",
            Format::Hevc => "hevc",
            Format::Av1 => "av1",
        }
    }

    pub fn from_key(k: &str) -> Option<Format> {
        Format::ALL.into_iter().find(|f| f.key() == k)
    }

    pub fn label(self) -> &'static str {
        match self {
            Format::H264 => "H.264",
            Format::Hevc => "HEVC",
            Format::Av1 => "AV1",
        }
    }

    /// The widest (or tallest) frame its encoders take: H.264's stop at
    /// 4096.
    pub fn max_side(self) -> u32 {
        match self {
            Format::H264 => 4096,
            Format::Hevc | Format::Av1 => 8192,
        }
    }

    /// Its bitrate for about the same picture as H.264 at 1.
    pub fn rate_share(self) -> f64 {
        match self {
            Format::H264 => 1.0,
            Format::Hevc => 0.65,
            Format::Av1 => 0.55,
        }
    }
}

/// How this computer encodes a format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    Hardware,
    /// In software: slower, but it works.
    Software,
    No,
}

/// What this computer can encode, each format looked up once (it starts
/// an encoder, so call it off the UI thread).
pub fn support(format: Format) -> Support {
    use std::sync::OnceLock;
    static FOUND: OnceLock<[Support; 3]> = OnceLock::new();
    let found = FOUND.get_or_init(|| {
        let all = Format::ALL.map(probe);
        log::info!("export: formats this computer encodes: {}", Format::ALL.iter().zip(all).map(|(f, s)| format!("{} {s:?}", f.label())).collect::<Vec<_>>().join(", "));
        all
    });
    found[Format::ALL.iter().position(|f| *f == format).unwrap_or(0)]
}

fn probe(format: Format) -> Support {
    #[cfg(target_os = "macos")]
    {
        if std::env::var_os("SENTRY_EXPORT_GST").is_some() {
            return gstreamer::probe(format);
        }
        videotoolbox::probe(format)
    }
    #[cfg(target_os = "linux")]
    {
        gstreamer::probe(format)
    }
    #[cfg(windows)]
    {
        media_foundation::probe(format)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = format;
        Support::No
    }
}

#[cfg(target_os = "macos")]
pub mod videotoolbox;
// Built on every Unix so it can be tried on macOS with Homebrew's GStreamer.
#[cfg(unix)]
pub mod gstreamer;
#[cfg(windows)]
pub mod media_foundation;
// Used once the export pipeline lands (see export/mod.rs).
#[cfg(target_os = "macos")]
#[allow(unused_imports)]
pub use videotoolbox::{Encoder, Frame};

/// What to encode.
#[derive(Debug, Clone)]
pub struct EncodeSettings {
    pub codec: Format,
    pub width: u32,
    pub height: u32,
    /// Frames per second (the keyframe interval is two seconds of them).
    pub fps: f64,
    /// Ticks per second for timestamps (as in the MP4 written).
    pub timescale: u32,
    /// Average bits per second.
    pub bitrate: u64,
    /// Encoding speed over quality (where the encoder offers the choice).
    pub fast: bool,
}

/// One encoded frame: length-prefixed NAL units (H.264, HEVC), or the
/// OBUs of one temporal unit (AV1).
#[derive(Debug, Clone)]
pub struct Packet {
    pub data: Vec<u8>,
    /// Presentation time, in timescale units.
    pub pts: i64,
    pub sync: bool,
}

/// An encoder fed BGRA frames from memory (`width * 4` bytes a row), one
/// every `duration` ticks.
pub trait FrameSink {
    /// The encoder in use, for the log.
    fn name(&self) -> String;
    fn push_bgra(&mut self, bgra: &[u8], pts: i64, duration: i64) -> anyhow::Result<()>;
    /// Encoded frames ready so far, in decode order.
    fn take(&mut self) -> Vec<Packet>;
    /// Flushes the encoder.
    fn finish(self: Box<Self>) -> anyhow::Result<Finished>;
    /// Whether it writes the MP4 itself (Media Foundation's), instead of
    /// handing frames to our writer.
    fn writes_file(&self) -> bool {
        false
    }
}

/// What a finished encoder leaves.
pub enum Finished {
    /// The last frames, and the codec's configuration for our MP4 writer.
    Packets(Vec<Packet>, super::mp4_writer::CodecConfig),
    /// It wrote the file itself.
    File,
}

/// The encoder for frames from memory on this system (`output`: for one
/// that writes the file itself).
pub fn frame_sink(s: &EncodeSettings, output: &std::path::Path) -> anyhow::Result<Box<dyn FrameSink>> {
    let _ = output;
    // macOS: GStreamer's when asked (to try the Linux path), else VideoToolbox.
    #[cfg(target_os = "macos")]
    {
        if std::env::var_os("SENTRY_EXPORT_GST").is_some() {
            return Ok(Box::new(gstreamer::Encoder::new(s)?));
        }
        Ok(Box::new(videotoolbox::Encoder::new(s)?))
    }
    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(gstreamer::Encoder::new(s)?))
    }
    #[cfg(windows)]
    {
        Ok(Box::new(media_foundation::Encoder::new(s, output)?))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = s;
        anyhow::bail!("Exporting isn't available on this system.")
    }
}
