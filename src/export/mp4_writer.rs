//! Writes an MP4 with one video track, for export (and the converter):
//! encoded samples go straight into `mdat` as they come, and the index
//! (`moov`) is written last, with 64-bit offsets so files past 4 GB work.
//!
//! When the number of frames is known up front, space for the index is
//! kept before `mdat` (a `free` box) and the index goes there, so players
//! and web pages can start before the whole file has arrived ("fast
//! start") without rewriting the file afterwards.
//!
//! The codec's configuration box comes from the encoder (`avcC` built from
//! its SPS and PPS by `avcc`, or an `hvcC` the encoder hands over), with the
//! sample entry it belongs to (`avc1` / `hvc1`).

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// The codec, as the sample entry declares it.
#[derive(Debug, Clone)]
pub struct CodecConfig {
    /// `avc1` or `hvc1`.
    pub entry: [u8; 4],
    /// `avcC` or `hvcC`, with its contents.
    pub config_box: [u8; 4],
    pub config: Vec<u8>,
}

/// An `avcC` (AVCDecoderConfigurationRecord) from H.264 parameter sets
/// (without start codes), with 4-byte NAL lengths (the tests' clips).
#[cfg(test)]
pub fn avcc(sps: &[Vec<u8>], pps: &[Vec<u8>]) -> CodecConfig {
    let first = sps.first().map(Vec::as_slice).unwrap_or(&[]);
    let at = |i: usize| first.get(i).copied().unwrap_or(0);
    let mut c = vec![1, at(1), at(2), at(3), 0xFF, 0xE0 | sps.len().min(31) as u8];
    for s in sps.iter().take(31) {
        c.extend_from_slice(&(s.len() as u16).to_be_bytes());
        c.extend_from_slice(s);
    }
    c.push(pps.len().min(255) as u8);
    for p in pps.iter().take(255) {
        c.extend_from_slice(&(p.len() as u16).to_be_bytes());
        c.extend_from_slice(p);
    }
    CodecConfig { entry: *b"avc1", config_box: *b"avcC", config: c }
}

struct Sample {
    offset: u64,
    size: u32,
    duration: u32,
    sync: bool,
    /// Presentation minus decode time (0 without B-frames).
    cts: i32,
}

pub struct Mp4Writer {
    out: BufWriter<File>,
    /// Where the space kept for the index starts, and its size (0: none).
    index_at: u64,
    index_space: u64,
    mdat_start: u64,
    pos: u64,
    samples: Vec<Sample>,
    /// The next sample's decode time (its durations so far).
    decode_time: i64,
    /// The first frame's display time as the encoder gave it: times count
    /// from there (GStreamer's software encoders add hours to them).
    pts_base: Option<i64>,
    timescale: u32,
    width: u32,
    height: u32,
}

fn bx(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(8 + body.len());
    b.extend_from_slice(&((8 + body.len()) as u32).to_be_bytes());
    b.extend_from_slice(name);
    b.extend_from_slice(body);
    b
}

/// A full box: version and flags first.
fn fbx(name: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + body.len());
    v.push(version);
    v.extend_from_slice(&flags.to_be_bytes()[1..]);
    v.extend_from_slice(body);
    bx(name, &v)
}

fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
    parts.concat()
}

const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

impl Mp4Writer {
    /// Starts the file: `timescale` ticks per second for sample durations.
    /// The index goes at the end (the tests' clips).
    #[cfg(test)]
    pub fn create(path: &Path, width: u32, height: u32, timescale: u32) -> std::io::Result<Self> {
        Self::create_with_index_space(path, width, height, timescale, 0)
    }

    /// Starts the file with room for the index of about `samples` frames
    /// in front of the pictures (if more arrive, the index goes at the end).
    pub fn create_with_index_space(path: &Path, width: u32, height: u32, timescale: u32, samples: usize) -> std::io::Result<Self> {
        let mut out = BufWriter::with_capacity(4 << 20, File::create(path)?);
        let ftyp = bx(b"ftyp", &[b"isom".as_slice(), &512u32.to_be_bytes(), b"isom", b"iso2", b"avc1", b"mp41"].concat());
        out.write_all(&ftyp)?;
        let index_at = ftyp.len() as u64;
        // Per sample: a size (4), an offset (8), perhaps a keyframe entry
        // (4) and a display-time entry (8, with B-frames); the rest of the
        // index fits in 4 KB.
        let index_space = if samples > 0 { 4096 + 24 * samples as u64 } else { 0 };
        if index_space > 0 {
            out.write_all(&(index_space as u32).to_be_bytes())?;
            out.write_all(b"free")?;
            std::io::copy(&mut std::io::repeat(0).take(index_space - 8), &mut out)?;
        }
        // mdat with a 64-bit size, filled in by finish.
        let mdat_start = index_at + index_space;
        out.write_all(&1u32.to_be_bytes())?;
        out.write_all(b"mdat")?;
        out.write_all(&0u64.to_be_bytes())?;
        Ok(Mp4Writer { out, index_at, index_space, mdat_start, pos: mdat_start + 16, samples: Vec::new(), decode_time: 0, pts_base: None, timescale, width, height })
    }

    /// Adds one encoded frame (length-prefixed NAL units), in decode order.
    pub fn write_sample(&mut self, data: &[u8], duration: u32, sync: bool, cts: i32) -> std::io::Result<()> {
        self.out.write_all(data)?;
        self.samples.push(Sample { offset: self.pos, size: data.len() as u32, duration, sync, cts });
        self.pos += data.len() as u64;
        self.decode_time += duration as i64;
        Ok(())
    }

    /// Adds one encoded frame in decode order, shown at `pts` (in ticks,
    /// from any starting point: the first frame, a keyframe shown first,
    /// is 0): with B-frames that differs from its decode time.
    pub fn write_frame(&mut self, data: &[u8], duration: u32, sync: bool, pts: i64) -> std::io::Result<()> {
        let pts = pts - *self.pts_base.get_or_insert(pts);
        // In whole frames (B-frames move by whole frames; a tick off from
        // rounding through nanoseconds is no move at all).
        let d = duration.max(1) as i64;
        let frames = ((pts - self.decode_time) as f64 / d as f64).round() as i64;
        let cts = (frames * d) as i32;
        self.write_sample(data, duration, sync, cts)
    }

    pub fn samples(&self) -> usize {
        self.samples.len()
    }

    /// Writes the index and closes the file.
    pub fn finish(mut self, codec: &CodecConfig) -> std::io::Result<()> {
        let moov = self.moov(codec);
        let len = moov.len() as u64;
        // In the space kept for it, with what's left as a smaller free box.
        let in_front = self.index_space > 0 && (len == self.index_space || len + 8 <= self.index_space);
        if !in_front {
            self.out.write_all(&moov)?;
        }
        self.out.flush()?;
        let mut f = self.out.into_inner().map_err(|e| e.into_error())?;
        let mdat_size = self.pos - self.mdat_start;
        f.seek(SeekFrom::Start(self.mdat_start + 8))?;
        f.write_all(&mdat_size.to_be_bytes())?;
        if in_front {
            f.seek(SeekFrom::Start(self.index_at))?;
            f.write_all(&moov)?;
            if len < self.index_space {
                f.write_all(&((self.index_space - len) as u32).to_be_bytes())?;
                f.write_all(b"free")?;
            }
        }
        f.sync_all()
    }

    fn moov(&self, codec: &CodecConfig) -> Vec<u8> {
        let duration: u64 = self.samples.iter().map(|s| s.duration as u64).sum();
        let mut mvhd = Vec::new();
        mvhd.extend_from_slice(&[0u8; 16]); // created, modified (64-bit)
        mvhd.extend_from_slice(&self.timescale.to_be_bytes());
        mvhd.extend_from_slice(&duration.to_be_bytes());
        mvhd.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
        mvhd.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
        mvhd.extend_from_slice(&[0u8; 10]);
        for m in MATRIX {
            mvhd.extend_from_slice(&m.to_be_bytes());
        }
        mvhd.extend_from_slice(&[0u8; 24]);
        mvhd.extend_from_slice(&2u32.to_be_bytes()); // next track ID
        let mvhd = fbx(b"mvhd", 1, 0, &mvhd);

        let mut tkhd = Vec::new();
        tkhd.extend_from_slice(&[0u8; 16]);
        tkhd.extend_from_slice(&1u32.to_be_bytes()); // track ID
        tkhd.extend_from_slice(&[0u8; 4]);
        tkhd.extend_from_slice(&duration.to_be_bytes());
        tkhd.extend_from_slice(&[0u8; 8]);
        tkhd.extend_from_slice(&[0u8; 4]); // layer, alternate group
        tkhd.extend_from_slice(&[0u8; 4]); // volume 0, reserved
        for m in MATRIX {
            tkhd.extend_from_slice(&m.to_be_bytes());
        }
        tkhd.extend_from_slice(&(self.width << 16).to_be_bytes());
        tkhd.extend_from_slice(&(self.height << 16).to_be_bytes());
        let tkhd = fbx(b"tkhd", 1, 3, &tkhd); // enabled, in movie

        let mut mdhd = Vec::new();
        mdhd.extend_from_slice(&[0u8; 16]);
        mdhd.extend_from_slice(&self.timescale.to_be_bytes());
        mdhd.extend_from_slice(&duration.to_be_bytes());
        mdhd.extend_from_slice(&0x55C4u16.to_be_bytes()); // language "und"
        mdhd.extend_from_slice(&[0u8; 2]);
        let mdhd = fbx(b"mdhd", 1, 0, &mdhd);
        let hdlr = fbx(b"hdlr", 0, 0, &[&[0u8; 4][..], b"vide", &[0u8; 12], b"VideoHandler\0"].concat());

        let vmhd = fbx(b"vmhd", 0, 1, &[0u8; 8]);
        let dinf = bx(b"dinf", &fbx(b"dref", 0, 0, &[&1u32.to_be_bytes()[..], &fbx(b"url ", 0, 1, &[])].concat()));

        let mut entry = vec![0u8; 6];
        entry.extend_from_slice(&1u16.to_be_bytes()); // data reference index
        entry.extend_from_slice(&[0u8; 16]);
        entry.extend_from_slice(&(self.width as u16).to_be_bytes());
        entry.extend_from_slice(&(self.height as u16).to_be_bytes());
        entry.extend_from_slice(&0x0048_0000u32.to_be_bytes()); // 72 dpi
        entry.extend_from_slice(&0x0048_0000u32.to_be_bytes());
        entry.extend_from_slice(&[0u8; 4]);
        entry.extend_from_slice(&1u16.to_be_bytes()); // frame count
        entry.extend_from_slice(&[0u8; 32]); // compressor name
        entry.extend_from_slice(&0x0018u16.to_be_bytes()); // depth
        entry.extend_from_slice(&(-1i16).to_be_bytes());
        entry.extend_from_slice(&bx(&codec.config_box, &codec.config));
        let stsd = fbx(b"stsd", 0, 0, &[&1u32.to_be_bytes()[..], &bx(&codec.entry, &entry)].concat());

        // Durations, run-length coded.
        let mut runs: Vec<(u32, u32)> = Vec::new();
        for s in &self.samples {
            match runs.last_mut() {
                Some((n, d)) if *d == s.duration => *n += 1,
                _ => runs.push((1, s.duration)),
            }
        }
        let mut stts = (runs.len() as u32).to_be_bytes().to_vec();
        for (n, d) in &runs {
            stts.extend_from_slice(&n.to_be_bytes());
            stts.extend_from_slice(&d.to_be_bytes());
        }
        let stts = fbx(b"stts", 0, 0, &stts);

        // Display times against decode times (B-frames), moved so none is
        // negative; the edit list then starts playing that much in, so the
        // first frame still shows at 0.
        let shift = self.samples.iter().map(|s| -(s.cts as i64)).max().unwrap_or(0).max(0);
        let ctts = if self.samples.iter().any(|s| s.cts != 0) {
            let mut runs: Vec<(u32, i32)> = Vec::new();
            for s in &self.samples {
                let c = (s.cts as i64 + shift) as i32;
                match runs.last_mut() {
                    Some((n, r)) if *r == c => *n += 1,
                    _ => runs.push((1, c)),
                }
            }
            let mut b = (runs.len() as u32).to_be_bytes().to_vec();
            for (n, c) in &runs {
                b.extend_from_slice(&n.to_be_bytes());
                b.extend_from_slice(&c.to_be_bytes());
            }
            fbx(b"ctts", 0, 0, &b)
        } else {
            Vec::new()
        };
        let edts = if shift > 0 {
            let mut e = 1u32.to_be_bytes().to_vec();
            e.extend_from_slice(&(duration as u32).to_be_bytes()); // movie ticks (same timescale)
            e.extend_from_slice(&(shift as u32).to_be_bytes());
            e.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1
            bx(b"edts", &fbx(b"elst", 0, 0, &e))
        } else {
            Vec::new()
        };

        let syncs: Vec<u32> = self.samples.iter().enumerate().filter(|(_, s)| s.sync).map(|(i, _)| i as u32 + 1).collect();
        let stss = if syncs.len() == self.samples.len() {
            Vec::new() // every sample is a sync sample
        } else {
            let mut b = (syncs.len() as u32).to_be_bytes().to_vec();
            for i in syncs {
                b.extend_from_slice(&i.to_be_bytes());
            }
            fbx(b"stss", 0, 0, &b)
        };

        let mut stsz = vec![0u8; 4];
        stsz.extend_from_slice(&(self.samples.len() as u32).to_be_bytes());
        for s in &self.samples {
            stsz.extend_from_slice(&s.size.to_be_bytes());
        }
        let stsz = fbx(b"stsz", 0, 0, &stsz);
        // One sample per chunk: the offsets are the samples'.
        let stsc = fbx(b"stsc", 0, 0, &[&1u32.to_be_bytes()[..], &1u32.to_be_bytes(), &1u32.to_be_bytes(), &1u32.to_be_bytes()].concat());
        let mut co64 = (self.samples.len() as u32).to_be_bytes().to_vec();
        for s in &self.samples {
            co64.extend_from_slice(&s.offset.to_be_bytes());
        }
        let co64 = fbx(b"co64", 0, 0, &co64);

        let stbl = bx(b"stbl", &cat(&[stsd, stts, ctts, stss, stsz, stsc, co64]));
        let minf = bx(b"minf", &cat(&[vmhd, dinf, stbl]));
        let mdia = bx(b"mdia", &cat(&[mdhd, hdlr, minf]));
        let trak = bx(b"trak", &cat(&[tkhd, edts, mdia]));
        bx(b"moov", &cat(&[mvhd, trak]))
    }
}

/// Moves an MP4's index (`moov`) in front of its pictures (`mdat`), as
/// FFmpeg's +faststart does, for files written by someone else's muxer
/// (Media Foundation's on Windows). The chunk offsets in every track are
/// moved along with it. A file whose index is already first is left as is.
pub fn fast_start(path: &Path) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    let bad = |what: &str| Error::new(ErrorKind::InvalidData, format!("can't move the MP4's index: {what}"));
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    // The top-level boxes: (type, start, size).
    let mut boxes = Vec::new();
    let mut pos = 0u64;
    while pos + 8 <= len {
        let mut head = [0u8; 16];
        file.seek(SeekFrom::Start(pos))?;
        file.read_exact(&mut head[..8])?;
        let mut size = u32::from_be_bytes(head[..4].try_into().unwrap()) as u64;
        let name: [u8; 4] = head[4..8].try_into().unwrap();
        if size == 1 {
            file.read_exact(&mut head[8..16])?;
            size = u64::from_be_bytes(head[8..16].try_into().unwrap());
        } else if size == 0 {
            size = len - pos;
        }
        if size < 8 || pos + size > len {
            return Err(bad("a box runs past the end"));
        }
        boxes.push((name, pos, size));
        pos += size;
    }
    let find = |n: &[u8; 4]| boxes.iter().position(|b| &b.0 == n);
    let (Some(moov_i), Some(mdat_i)) = (find(b"moov"), find(b"mdat")) else { return Err(bad("no moov or mdat")) };
    if moov_i < mdat_i {
        return Ok(());
    }
    let (_, moov_at, moov_len) = boxes[moov_i];
    let mut moov = vec![0u8; moov_len as usize];
    file.seek(SeekFrom::Start(moov_at))?;
    file.read_exact(&mut moov)?;
    // Everything before the first mdat stays first (ftyp), then the moov.
    let first_media = boxes[mdat_i].1;
    let shift = moov_len;
    // stco offsets are 32-bit: if one would overflow, use co64 instead
    // (not needed for the sizes exported here; refuse rather than corrupt).
    shift_offsets(&mut moov[8..], shift).map_err(|e| bad(&e))?;
    // Written beside the video and renamed over it; where a sandbox (the
    // Mac App Store build) only allows the video itself, written in the
    // temporary folder and copied back over it instead.
    let mut tmp = path.with_extension("faststart.tmp");
    let created = match File::create(&tmp) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            tmp = std::env::temp_dir().join(format!("sentry-studio-faststart-{}-{}.mp4", std::process::id(), path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
            File::create(&tmp)?
        }
        Err(e) => return Err(e),
    };
    {
        let mut out = BufWriter::with_capacity(4 << 20, created);
        file.seek(SeekFrom::Start(0))?;
        std::io::copy(&mut (&mut file).take(first_media), &mut out)?;
        out.write_all(&moov)?;
        // The rest, without the old moov.
        for (name, start, size) in &boxes[..] {
            if *start < first_media || (name == b"moov" && *start == moov_at) {
                continue;
            }
            file.seek(SeekFrom::Start(*start))?;
            std::io::copy(&mut (&mut file).take(*size), &mut out)?;
        }
        out.flush()?;
        out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    }
    drop(file);
    if tmp.parent() == path.parent() {
        return std::fs::rename(&tmp, path);
    }
    let copied = std::fs::copy(&tmp, path).map(|_| ());
    let _ = std::fs::remove_file(&tmp);
    copied
}

/// Adds `by` to every chunk offset (stco / co64) inside these boxes.
fn shift_offsets(data: &mut [u8], by: u64) -> Result<(), String> {
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
        let name: [u8; 4] = data[pos + 4..pos + 8].try_into().unwrap();
        if size < 8 || pos + size > data.len() {
            return Err("a box inside the index runs past its end".into());
        }
        let body = &mut data[pos + 8..pos + size];
        match &name {
            b"trak" | b"mdia" | b"minf" | b"stbl" | b"edts" => shift_offsets(body, by)?,
            b"stco" | b"co64" => {
                let wide = &name == b"co64";
                let count = u32::from_be_bytes(body.get(4..8).ok_or("short chunk table")?.try_into().unwrap()) as usize;
                let step = if wide { 8 } else { 4 };
                if body.len() < 8 + count * step {
                    return Err("short chunk table".into());
                }
                for k in 0..count {
                    let at = 8 + k * step;
                    if wide {
                        let v = u64::from_be_bytes(body[at..at + 8].try_into().unwrap()) + by;
                        body[at..at + 8].copy_from_slice(&v.to_be_bytes());
                    } else {
                        let v = u32::from_be_bytes(body[at..at + 4].try_into().unwrap()) as u64 + by;
                        let v = u32::try_from(v).map_err(|_| "a chunk offset would pass 4 GB")?;
                        body[at..at + 4].copy_from_slice(&v.to_be_bytes());
                    }
                }
            }
            _ => {}
        }
        pos += size;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn written_files_read_back() {
        let path = std::env::temp_dir().join(format!("sentry-studio-mp4w-{}.mp4", std::process::id()));
        // A minimal H.264 SPS/PPS (profile 100, level 4.0) and fake frames.
        let sps = vec![vec![0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9]];
        let pps = vec![vec![0x68, 0xEB, 0xE3, 0xCB]];
        // Index at the end, in the space kept for it, and space kept too
        // small (so at the end after all).
        for space in [0usize, 90, 10] {
            let mut w = Mp4Writer::create_with_index_space(&path, 1920, 1080, 36_000, space).unwrap();
            for i in 0..if space == 10 { 900 } else { 90u32 } {
                let frame: Vec<u8> = [&(5u32 + i % 7).to_be_bytes()[..], &vec![if i % 36 == 0 { 0x65 } else { 0x41 }; 5 + (i % 7) as usize]].concat();
                w.write_sample(&frame, 1000, i % 36 == 0, 0).unwrap();
            }
            w.finish(&avcc(&sps, &pps)).unwrap();
            let file = File::open(&path).unwrap();
            let track = crate::mp4::read_video_track(&file).unwrap();
            assert_eq!((track.width, track.height, track.timescale), (1920, 1080, 36_000));
            let n = if space == 10 { 900 } else { 90 };
            assert_eq!(track.samples.len(), n);
            let bytes = std::fs::read(&path).unwrap();
            let at = |name: &[u8]| bytes.windows(4).position(|w| w == name).unwrap();
            assert_eq!(at(b"moov") < at(b"mdat"), space == 90, "space {space}");
            assert_eq!(track.sps, sps);
            assert_eq!(track.pps, pps);
            assert_eq!(track.nal_length_size, 4);
            assert!((track.duration - n as f64 / 36.0).abs() < 1e-6, "{}", track.duration);
            assert_eq!(track.samples.iter().filter(|s| s.sync).count(), n / 36 + usize::from(n % 36 != 0));
            assert_eq!(track.samples[10].pts, 10_000);
            // Each sample's bytes are where the index says.
            let mut buf = vec![0u8; track.samples[13].size as usize];
            crate::mp4::read_at(&file, &mut buf, track.samples[13].offset).unwrap();
            assert_eq!(&buf[..4], &(5u32 + 13 % 7).to_be_bytes());
            let last = track.samples[n - 1];
            assert_eq!(last.offset + last.size as u64 + if space == 90 { 0 } else { (bytes.len() - at(b"moov") + 4) as u64 }, bytes.len() as u64);
        }
        let _ = std::fs::remove_file(&path);
    }

    /// An index written last, moved to the front: same frames, same bytes.
    #[test]
    fn fast_start_moves_the_index() {
        let path = std::env::temp_dir().join(format!("sentry-studio-faststart-{}.mp4", std::process::id()));
        let sps = vec![vec![0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9]];
        let pps = vec![vec![0x68, 0xEB, 0xE3, 0xCB]];
        let mut w = Mp4Writer::create(&path, 640, 480, 36_000).unwrap();
        let frames: Vec<Vec<u8>> = (0..50u32).map(|i| [&(6u32).to_be_bytes()[..], &[0x41, i as u8, 2, 3, 4, 5]].concat()).collect();
        for (i, f) in frames.iter().enumerate() {
            w.write_sample(f, 1000, i % 36 == 0, 0).unwrap();
        }
        w.finish(&avcc(&sps, &pps)).unwrap();
        let before = std::fs::read(&path).unwrap();
        let at = |b: &[u8], n: &[u8]| b.windows(4).position(|w| w == n).unwrap();
        assert!(at(&before, b"moov") > at(&before, b"mdat"));
        fast_start(&path).unwrap();
        let after = std::fs::read(&path).unwrap();
        assert_eq!(after.len(), before.len());
        assert!(at(&after, b"moov") < at(&after, b"mdat"));
        let file = File::open(&path).unwrap();
        let track = crate::mp4::read_video_track(&file).unwrap();
        assert_eq!(track.samples.len(), 50);
        for (s, f) in track.samples.iter().zip(&frames) {
            let mut buf = vec![0u8; s.size as usize];
            crate::mp4::read_at(&file, &mut buf, s.offset).unwrap();
            assert_eq!(&buf, f);
        }
        // Already first: nothing to do.
        fast_start(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), after);
        let _ = std::fs::remove_file(&path);
    }

    /// An encoder's own starting time (GStreamer's software ones add hours)
    /// doesn't delay the frames; B-frames get their offsets and an edit list.
    #[test]
    fn display_times_count_from_the_first_frame() {
        let boxes = |frames: &[(i64, bool)]| {
            let path = std::env::temp_dir().join(format!("sentry-ctts-{}-{}.mp4", std::process::id(), frames.len()));
            let mut w = Mp4Writer::create(&path, 64, 64, 36000).unwrap();
            for (pts, sync) in frames {
                w.write_frame(&[0, 0, 0, 1, 0x65], 1000, *sync, *pts).unwrap();
            }
            w.finish(&avcc(&[vec![0x67, 0x64, 0, 0x1f]], &[vec![0x68]])).unwrap();
            let bytes = std::fs::read(&path).unwrap();
            let _ = std::fs::remove_file(&path);
            let has = |name: &[u8]| bytes.windows(4).any(|w| w == name);
            (has(b"ctts"), has(b"elst"))
        };
        let hours = 750_981_120;
        // In order, from hours in: no offsets at all.
        assert_eq!(boxes(&[(hours, true), (hours + 1000, false), (hours + 2000, false)]), (false, false));
        // I P B (shown I B P): offsets, and an edit list.
        assert_eq!(boxes(&[(hours, true), (hours + 2000, false), (hours + 1000, false)]), (true, true));
    }
}
