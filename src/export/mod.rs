//! Video export, without FFmpeg: the clips are decoded by the system's
//! decoders (as for playback), composited on the GPU, encoded by the
//! system's hardware encoders and written by our own MP4 writer.
//!
//! Being built: the pieces land one by one, so until the export dialog
//! uses them some are only exercised by their tests.
#![allow(dead_code)]

pub mod av1;
pub mod blur;
pub mod compose;
pub mod encode;
pub mod job;
pub mod mp4_writer;
pub mod overlay;
pub mod source;
pub mod tesla_mobile;
#[cfg(all(test, target_os = "macos"))]
pub mod testing;
