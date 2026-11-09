//! One camera's pictures for an export: its clips opened minute by minute
//! and decoded in order, handing back the picture shown at each output
//! time. A minute without this camera's clip, or a clip that can't be
//! read, gives no picture (a black tile) for that minute only, so the
//! camera stays in step with the others. A clip that starts before its
//! first keyframe (Tesla's sometimes do), or a frame the decoder rejects,
//! skips to the next keyframe; until then the camera's last picture stays.

use crate::decode::{Decoder, Frame};
use crate::library::{Camera, Segment};
use crate::mp4::{read_video_track, VideoTrack};
use crate::reader::WindowReader;
use anyhow::Result;
use std::sync::Arc;

/// An open clip, decoded up to `next`.
struct Clip {
    track: VideoTrack,
    decoder: Decoder,
    reader: WindowReader,
    /// The next sample to decode.
    next: usize,
    /// For each decode position, the earliest display time from there on
    /// (ticks), so decoding stops once nothing left is due yet.
    earliest: Vec<i64>,
    /// Pictures decoded but not yet shown, oldest first, with their time.
    pending: Vec<(f64, Arc<Frame>)>,
    shown: Option<Arc<Frame>>,
    /// Frames the decoder rejected (each skips to the next keyframe).
    errors: u32,
    /// Seconds the clip starts after the minute's front clip (see
    /// crate::sync): its pictures are shown that much later.
    offset: f64,
}

pub struct Source {
    camera: Camera,
    segment: Option<usize>,
    clip: Option<Clip>,
    /// The last picture shown, held while a new minute's clip has none yet
    /// (it starts before its first keyframe).
    last: Option<Arc<Frame>>,
    /// Samples decoded, for the log.
    pub decoded: u64,
}

impl Source {
    pub fn new(camera: Camera) -> Self {
        Source { camera, segment: None, clip: None, last: None, decoded: 0 }
    }

    /// The picture shown `t` seconds into `segments[segment]`. Times must
    /// not go backwards.
    pub fn frame_at(&mut self, segments: &[Segment], segment: usize, t: f64) -> Option<Arc<Frame>> {
        if self.segment != Some(segment) {
            self.segment = Some(segment);
            let reference = segments.get(segment).and_then(|s| crate::sync::reference(&s.files)).cloned();
            self.clip = segments.get(segment).and_then(|s| s.files.get(&self.camera)).and_then(|path| match open(path) {
                Ok(mut c) => {
                    // Lined up with the minute's front clip.
                    let own = crate::sync::start_of(path, || crate::sync::start_from(&c.track, |o, n| c.reader.read(o, n).ok().map(<[u8]>::to_vec)));
                    let front = match reference.as_ref() {
                        Some(r) if r != path => crate::sync::start(r),
                        _ => own,
                    };
                    let ref_camera = reference.as_deref().and_then(crate::sync::camera_of).unwrap_or(crate::library::Camera::Front);
                    c.offset = crate::sync::offset(path, own, front, self.camera, ref_camera);
                    // A camera whose counter can't be compared (an HW3
                    // car's back camera): by the telemetry's timing.
                    if let Some(r) = reference.as_ref().filter(|r| *r != path && crate::sync::counted(own, front) && !crate::sync::comparable(own, front, self.camera, ref_camera)) {
                        if let Some(o) = crate::sync::time_offset_now(path, r) {
                            c.offset = o;
                        }
                    }
                    Some(c)
                }
                Err(e) => {
                    log::warn!("export: {:?} clip {} skipped (a black tile for that minute): {e:#}", self.camera, path.display());
                    None
                }
            });
        }
        let Some(clip) = self.clip.as_mut() else {
            self.last = None;
            return None;
        };
        let errors = clip.errors;
        // Its own time (before its first picture is due, the last picture
        // from before carries on).
        let shown = match clip.advance(t - clip.offset, &mut self.decoded) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("export: {:?} stopped decoding at {t:.2} s of minute {segment} (black for the rest of it): {e:#}", self.camera);
                self.clip = None;
                self.last = None;
                return None;
            }
        };
        if let Some(clip) = self.clip.as_ref().filter(|c| c.errors > errors) {
            log::warn!("export: {:?} skipped {} undecodable frame(s) to the next keyframe at {t:.2} s of minute {segment}", self.camera, clip.errors - errors);
        }
        // Nothing yet in this minute (before its first keyframe): the
        // picture from just before carries on.
        match shown {
            Some(f) => {
                self.last = Some(f.clone());
                Some(f)
            }
            None => self.last.clone(),
        }
    }
}

fn open(path: &std::path::Path) -> Result<Clip> {
    let file = std::fs::File::open(path)?;
    let track = read_video_track(&file)?;
    let decoder = Decoder::new(&track)?;
    let mut reader = WindowReader::new(file)?;
    if track.duration > 0.0 {
        let bytes: u64 = track.samples.iter().map(|s| s.size as u64).sum();
        reader.set_rate(bytes as f64 / track.duration);
    }
    let earliest = track.earliest_from();
    // A clip that starts mid-GOP: decoding begins at its first keyframe.
    let next = track.samples.iter().position(|s| s.sync).unwrap_or(0);
    Ok(Clip { track, decoder, reader, next, earliest, pending: Vec::new(), shown: None, errors: 0, offset: 0.0 })
}

impl Clip {
    const MAX_ERRORS: u32 = 30;
    /// Frames decoded past t at most, waiting for a late decoder.
    const LOOKAHEAD: usize = 32;

    fn advance(&mut self, t: f64, decoded: &mut u64) -> Result<Option<Arc<Frame>>> {
        let n = self.track.samples.len();
        if n == 0 {
            return Ok(None);
        }
        let scale = self.track.timescale as f64;
        // A keyframe between here and the frame wanted: start from it and
        // skip decoding what comes before (a big time-lapse step, or the
        // start of the range). Only without reordering, where a keyframe
        // needs nothing before it.
        let target = self.track.sample_at(t);
        if !self.track.reordered() {
            let key = self.track.sync_at_or_before(target);
            if key > self.next {
                self.next = key;
                self.pending.clear();
                self.decoder.reset();
            }
        }
        // Decode while something from here on is due at or before t, and
        // then on until a picture after t has come out: decoders that hand
        // pictures back a few frames late (GStreamer's, Media Foundation's)
        // have then given up the one for t too. Without this a preview (one
        // frame) stays black and each camera of an export runs late.
        let due = (t * scale).floor() as i64;
        let limit = t + 0.5 / scale;
        let mut ahead = 0;
        while self.next < n {
            if self.earliest[self.next] > due {
                if ahead >= Self::LOOKAHEAD || self.pending.iter().any(|(at, _)| *at > limit) {
                    break;
                }
                ahead += 1;
            }
            let s = self.track.samples[self.next];
            let pts = s.pts as f64 / scale;
            let data = self.reader.read(s.offset, s.size as usize)?;
            match self.decoder.decode_at(data, pts) {
                Ok(Some(f)) => {
                    let at = f.pts().unwrap_or(pts);
                    self.pending.push((at, Arc::new(f)));
                }
                Ok(None) => {}
                // A frame the decoder rejects: start again at the next
                // keyframe. Many in one clip means it can't be read.
                Err(e) if self.errors < Self::MAX_ERRORS => {
                    self.errors += 1;
                    self.decoder.reset();
                    let skip = self.track.samples[self.next + 1..].iter().position(|s| s.sync);
                    *decoded += 1;
                    match skip {
                        Some(k) => {
                            self.next += 1 + k;
                            continue;
                        }
                        None => {
                            self.next = n;
                            log::debug!("export: no keyframe after a bad frame: {e:#}");
                            break;
                        }
                    }
                }
                Err(e) => return Err(e),
            }
            self.next += 1;
            *decoded += 1;
            if self.next == n {
                for f in self.decoder.drain() {
                    let at = f.pts().unwrap_or(f64::MAX);
                    self.pending.push((at, Arc::new(f)));
                }
            }
        }
        // The latest picture due by t is shown; older ones are done with.
        self.pending.sort_by(|a, b| a.0.total_cmp(&b.0));
        if let Some(last_due) = self.pending.iter().rposition(|(at, _)| *at <= limit) {
            self.shown = Some(self.pending[last_due].1.clone());
            self.pending.drain(..=last_due);
        } else if self.shown.is_none() {
            // Before the clip's first picture: show that one.
            self.shown = self.pending.first().map(|(_, f)| f.clone());
        }
        Ok(self.shown.clone())
    }
}

/// Each output frame's telemetry, from the front camera's clip (or the
/// first one there is): the SEI in the sample shown at that time. Only
/// the start of each sample is read (the SEI comes before the picture).
/// A frame without any holds the last one for up to 3 s, as earlier
/// versions did; after that there is none (PARKED).
pub struct Telemetry {
    segment: Option<usize>,
    clip: Option<(std::fs::File, VideoTrack)>,
    last: Option<(f64, crate::sei::SeiMetadata)>,
    buf: Vec<u8>,
}

impl Default for Telemetry {
    fn default() -> Self {
        Self::new()
    }
}

impl Telemetry {
    const HOLD: f64 = 3.0;
    const READ: usize = 4096;

    pub fn new() -> Self {
        Telemetry { segment: None, clip: None, last: None, buf: Vec::new() }
    }

    /// `segment_start`: the minute's start (seconds), so the hold carries
    /// across minutes.
    pub fn at(&mut self, segments: &[Segment], segment: usize, t: f64) -> Option<crate::sei::SeiMetadata> {
        let now = segments.get(segment).map(|s| s.start as f64).unwrap_or(0.0) + t;
        if self.segment != Some(segment) {
            self.segment = Some(segment);
            let path = segments.get(segment).and_then(|s| s.files.get(&Camera::Front).or_else(|| s.files.values().next()));
            self.clip = path.and_then(|p| {
                let f = std::fs::File::open(p).ok()?;
                let track = read_video_track(&f).ok()?;
                Some((f, track))
            });
        }
        if let Some((file, track)) = &self.clip {
            if !track.samples.is_empty() {
                let s = track.samples[track.sample_at(t)];
                let n = (s.size as usize).min(Self::READ);
                self.buf.resize(n, 0);
                if crate::mp4::read_at(file, &mut self.buf, s.offset).is_ok() {
                    if let Some(m) = crate::telemetry::sample_telemetry(&self.buf, track.nal_length_size as usize, track.codec) {
                        self.last = Some((now, m));
                    }
                }
            }
        }
        self.last.as_ref().filter(|(at, _)| (now - at).abs() <= Self::HOLD).map(|(_, m)| m.clone())
    }
}

#[cfg(test)]
mod tests {
    /// Flat grey BGRA frames through the encoder and back: the luma
    /// VideoToolbox gives each grey (BT.709 video range: 16 + 219 v / 255).
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn encoder_levels() {
        let dir = std::env::temp_dir().join(format!("sentry-levels-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for v in [0u8, 30, 128, 200, 255] {
            let path = dir.join(format!("g{v}.mp4"));
            crate::export::testing::clip(&path, 320, 240, 4, move |_, _, _| [v, v, v, 255]);
            let file = std::fs::File::open(&path).unwrap();
            let track = crate::mp4::read_video_track(&file).unwrap();
            let mut dec = crate::decode::Decoder::new(&track).unwrap();
            let s = track.samples[0];
            let mut buf = vec![0u8; s.size as usize];
            crate::mp4::read_at(&file, &mut buf, s.offset).unwrap();
            let f = dec.decode(&buf).unwrap().unwrap();
            let y = f.with_planes(|y, _| y.data[120 * y.stride + 160]).unwrap();
            println!("grey {v}: luma {y}, expected {:.1}", 16.0 + 219.0 * v as f64 / 255.0);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The mean luma of some decoded frames of SENTRY_LEVELS_CLIP, as the
    /// decoder hands them over (cargo test --release decoded_levels --
    /// --ignored --nocapture).
    #[test]
    #[ignore]
    fn decoded_levels() {
        let Some(path) = std::env::var_os("SENTRY_LEVELS_CLIP") else { return };
        let file = std::fs::File::open(&path).unwrap();
        let track = crate::mp4::read_video_track(&file).unwrap();
        let mut dec = crate::decode::Decoder::new(&track).unwrap();
        let mut reader = crate::reader::WindowReader::new(file).unwrap();
        let mut means = Vec::new();
        for s in &track.samples {
            let data = reader.read(s.offset, s.size as usize).unwrap().to_vec();
            if let Some(f) = dec.decode_at(&data, s.pts as f64 / track.timescale as f64).unwrap() {
                let m = f.with_planes(|y, _| y.data.iter().take(y.stride * 4).map(|&v| v as u64).sum::<u64>() as f64 / (y.stride * 4) as f64).unwrap();
                means.push((s.pts, m.round() as i64));
            }
        }
        #[cfg(target_os = "macos")]
        {
            use objc2_core_video::CVPixelBufferGetPixelFormatType;
            let f = dec.decode_at(reader.read(track.samples[0].offset, track.samples[0].size as usize).unwrap(), 0.0).unwrap();
            if let Some(f) = f {
                let fmt = CVPixelBufferGetPixelFormatType(f.pixel_buffer());
                println!("pixel format {:?}", std::str::from_utf8(&fmt.to_be_bytes()).unwrap_or("?"));
            }
        }
        means.sort();
        println!("{:?}", &means[..means.len().min(16)]);
    }
}
