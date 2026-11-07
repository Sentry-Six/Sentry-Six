//! Reads frames by offset through one read-ahead window per clip, so the
//! share sees large sequential reads instead of one small read per frame.
//!
//! After a jump (a seek, or a new clip) the first read is small, so the
//! first picture arrives quickly even on a slow share; while playback goes
//! on in order, the read-ahead fetches MAX_WINDOW at a time. Once playback is a
//! quarter of the way into a window, the next one is fetched on a helper
//! thread, so a slow answer from the share is hidden behind the window
//! being decoded instead of stalling playback (the decoder only keeps
//! about 1/6 s of pictures ready); after that, each window taken from the
//! read-ahead starts the next one at once. Not straight away after a seek:
//! six cameras' first reads would otherwise queue behind six read-aheads.
//! Memory per open clip is bounded by two windows.

use crate::mp4::read_at;
use anyhow::{Context, Result};
use std::fs::File;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;

const MIN_WINDOW: usize = 256 << 10;
const MAX_WINDOW: usize = 2 << 20;

/// The next window, being read on a helper thread.
struct Prefetch {
    start: u64,
    len: usize,
    rx: Receiver<std::io::Result<Vec<u8>>>,
}

pub struct WindowReader {
    file: Arc<File>,
    len: u64,
    /// The first read after a jump (MIN_WINDOW, or about half a second of
    /// this clip's data: see `set_rate`).
    jump_window: usize,
    buf: Vec<u8>,
    start: u64,
    filled: usize,
    window: usize,
    next: Option<Prefetch>,
}

impl WindowReader {
    pub fn new(file: File) -> Result<Self> {
        let len = file.metadata()?.len();
        Ok(Self { file: Arc::new(file), len, jump_window: MIN_WINDOW, buf: Vec::new(), start: 0, filled: 0, window: MIN_WINDOW, next: None })
    }

    /// The clip's data rate: the first read after a jump covers about half
    /// a second (a HW4 front clip runs about 1.3 MB/s, so 256 KB would last
    /// a fifth of a second and the read-ahead behind it would rarely be
    /// done in time on a slow share).
    pub fn set_rate(&mut self, bytes_per_sec: f64) {
        if bytes_per_sec.is_finite() && bytes_per_sec > 0.0 {
            self.jump_window = ((bytes_per_sec * 0.5) as usize).clamp(MIN_WINDOW, MAX_WINDOW / 2);
        }
    }

    /// Reads a whole window from `offset` now (getting a clip ready ahead
    /// of time, when there is no hurry for the first frame).
    pub fn warm(&mut self, offset: u64) -> Result<()> {
        self.window = MAX_WINDOW;
        self.jump_window = MAX_WINDOW;
        let first = self.len.saturating_sub(offset).min(1) as usize;
        self.read(offset, first)?;
        Ok(())
    }

    /// Bytes `offset .. offset + size`, valid until the next call.
    pub fn read(&mut self, offset: u64, size: usize) -> Result<&[u8]> {
        let end = offset + size as u64;
        let buffered_end = self.start + self.filled as u64;
        if !(offset >= self.start && end <= buffered_end) {
            // Carrying on from the window we have: read ahead further each
            // time. Anywhere else is a jump: start small again.
            let sequential = self.filled > 0 && offset >= self.start && offset <= buffered_end;
            self.window = if sequential { (self.window * 2).min(MAX_WINDOW) } else { self.jump_window };
            let fetched = match self.next.take() {
                // The window read ahead covers it: take it (waiting only
                // for whatever is left of that read).
                // A frame that starts in this window and ends in that one
                // keeps its first part from this window.
                Some(p) if offset >= self.start && offset <= p.start && p.start == buffered_end && end <= p.start + p.len as u64 => {
                    match p.rx.recv() {
                        Ok(Ok(data)) if offset < p.start => {
                            let mut joined = self.buf[(offset - self.start) as usize..self.filled].to_vec();
                            joined.extend_from_slice(&data);
                            Some((offset, joined))
                        }
                        Ok(Ok(data)) => Some((p.start, data)),
                        _ => None,
                    }
                }
                Some(p) if offset >= p.start && end <= p.start + p.len as u64 => match p.rx.recv() {
                    Ok(Ok(data)) => Some((p.start, data)),
                    _ => None,
                },
                // A jump: the read-ahead is of no use (it finishes on its
                // own and is dropped).
                _ => None,
            };
            let from_read_ahead = fetched.is_some();
            let (start, data) = match fetched {
                Some(f) => f,
                None => {
                    let want = self.window.max(size) as u64;
                    let n = want.min(self.len.saturating_sub(offset)) as usize;
                    if (n as u64) < size as u64 {
                        anyhow::bail!("frame runs past the end of the file");
                    }
                    let mut data = std::mem::take(&mut self.buf);
                    // The window is empty until this read succeeds, so a failed
                    // read can't leave a later one looking in a stale window.
                    self.filled = 0;
                    data.resize(n, 0);
                    read_at(&self.file, &mut data, offset).context("reading video data")?;
                    (offset, data)
                }
            };
            if (start + data.len() as u64) < end {
                anyhow::bail!("frame runs past the end of the file");
            }
            self.buf = data;
            self.start = start;
            self.filled = self.buf.len();
            // Playing on in order: keep a whole window in flight, so a
            // share that stops answering for a second or two is ridden out.
            if from_read_ahead {
                self.prefetch();
            }
        }
        if self.next.is_none() && offset >= self.start + self.filled as u64 / 4 {
            self.prefetch();
        }
        let a = (offset - self.start) as usize;
        Ok(&self.buf[a..a + size])
    }

    /// Starts reading the window after this one, if the file goes on.
    fn prefetch(&mut self) {
        let from = self.start + self.filled as u64;
        if from >= self.len {
            return;
        }
        // Always a whole window: a share is slow per request, not per byte.
        let n = (MAX_WINDOW as u64).min(self.len - from) as usize;
        let (tx, rx) = channel();
        let file = self.file.clone();
        let spawned = std::thread::Builder::new().name("read-ahead".into()).spawn(move || {
            let mut data = vec![0u8; n];
            let _ = tx.send(read_at(&file, &mut data, from).map(|()| data));
        });
        if spawned.is_ok() {
            self.next = Some(Prefetch { start: from, len: n, rx });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn window_starts_small_and_grows_while_sequential() {
        let path = std::env::temp_dir().join(format!("sentry-studio-reader-{}.bin", std::process::id()));
        let data: Vec<u8> = (0..(12u32 << 20)).map(|i| (i % 251) as u8).collect();
        std::fs::File::create(&path).unwrap().write_all(&data).unwrap();
        let mut r = WindowReader::new(std::fs::File::open(&path).unwrap()).unwrap();

        assert_eq!(r.read(1000, 10).unwrap(), &data[1000..1010]);
        assert_eq!(r.filled, MIN_WINDOW);
        // Reading on in order (as playback does, frames straddling the
        // window ends): each next window comes from the read-ahead, a whole
        // MAX_WINDOW joined to what was left of the last one.
        let mut pos = 1010u64;
        let mut sizes = Vec::new();
        let mut last_start = r.start;
        while pos < (10 << 20) {
            assert_eq!(r.read(pos, 10_000).unwrap(), &data[pos as usize..pos as usize + 10_000]);
            if r.start != last_start {
                last_start = r.start;
                sizes.push(r.filled);
            }
            pos += 10_000;
        }
        assert!(sizes.iter().all(|s| (MAX_WINDOW..MAX_WINDOW + 10_000).contains(s)), "{sizes:?}");
        // A jump goes back to a small read.
        assert_eq!(r.read(100, 10).unwrap(), &data[100..110]);
        assert_eq!(r.filled, MIN_WINDOW);
        std::fs::remove_file(&path).ok();
    }
}
