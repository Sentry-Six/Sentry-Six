//! Placeholder for systems without a decoder here (not macOS, Windows or
//! Linux), so the rest of the app builds everywhere.

use super::Plane;
use crate::mp4::VideoTrack;
use anyhow::{bail, Result};

pub struct Decoder;

impl Decoder {
    pub fn new(_track: &VideoTrack) -> Result<Self> {
        bail!("video decoding is not available on this OS")
    }

    pub fn reset(&mut self) {}

    pub fn decode(&mut self, _data: &[u8]) -> Result<Option<Frame>> {
        bail!("video decoding is not available on this OS")
    }

    pub fn decode_at(&mut self, data: &[u8], _pts: f64) -> Result<Option<Frame>> {
        self.decode(data)
    }

    pub fn drain(&mut self) -> Vec<Frame> {
        Vec::new()
    }
}

pub struct Frame;

impl Frame {
    pub fn width(&self) -> u32 {
        0
    }
    pub fn height(&self) -> u32 {
        0
    }
    pub fn pts(&self) -> Option<f64> {
        None
    }
    pub fn with_planes<R>(&self, _f: impl FnOnce(Plane<'_>, Plane<'_>) -> R) -> Option<R> {
        None
    }
}
