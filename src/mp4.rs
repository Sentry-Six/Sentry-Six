//! MP4 index for playback: reads only the box headers and the `moov` index
//! (a few hundred KB) of a clip, never the media data. Frames are then read
//! one sample at a time by offset (see `reader.rs`).


use anyhow::{anyhow, bail, Context, Result};
use std::fs::File;

/// Parameter sets (SPS, PPS or VPS), each without a start code.
type Sets = Vec<Vec<u8>>;

/// One coded frame in decode order.
#[derive(Debug, Clone, Copy)]
pub struct Sample {
    pub offset: u64,
    pub size: u32,
    /// Presentation time in track timescale units.
    pub pts: i64,
    pub sync: bool,
}

/// The video codec: H.264 (Tesla) or H.265 (clips converted by earlier
/// versions of Sentry Studio, some other dashcams).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
    H265,
}

#[derive(Debug, Clone)]
pub struct VideoTrack {
    pub codec: Codec,
    /// H.265 only: its video parameter sets.
    pub vps: Vec<Vec<u8>>,
    pub timescale: u32,
    pub width: u32,
    pub height: u32,
    /// Bytes in each NAL unit's length prefix (from avcC).
    pub nal_length_size: u8,
    pub sps: Vec<Vec<u8>>,
    pub pps: Vec<Vec<u8>>,
    pub samples: Vec<Sample>,
    /// Seconds, end of the last frame.
    pub duration: f64,
}

impl VideoTrack {
    pub fn pts_secs(&self, i: usize) -> f64 {
        self.samples[i].pts as f64 / self.timescale as f64
    }

    /// Whether frames are stored out of display order (B-frames, as in
    /// H.265 from converters; Tesla clips have none).
    pub fn reordered(&self) -> bool {
        self.samples.windows(2).any(|w| w[1].pts < w[0].pts)
    }

    /// For each decode position, the earliest display time of that frame
    /// or any after it: frames shown before this are safe to release.
    pub fn earliest_from(&self) -> Vec<i64> {
        let mut out = vec![i64::MAX; self.samples.len() + 1];
        for i in (0..self.samples.len()).rev() {
            out[i] = out[i + 1].min(self.samples[i].pts);
        }
        out
    }

    /// Index of the last frame shown at or before `t` seconds (0 if `t` is
    /// before the first frame).
    pub fn sample_at(&self, t: f64) -> usize {
        let target = (t * self.timescale as f64).floor() as i64;
        if self.reordered() {
            // Display order differs from decode order: the frame with the
            // latest display time not after `t`.
            return (0..self.samples.len())
                .filter(|&i| self.samples[i].pts <= target)
                .max_by_key(|&i| self.samples[i].pts)
                .unwrap_or(0);
        }
        // Tesla clips have no B-frames: display order is decode order.
        match self.samples.binary_search_by(|s| s.pts.cmp(&target)) {
            Ok(i) => i,
            Err(0) => 0,
            Err(i) => i - 1,
        }
    }

    /// The closest sync frame (keyframe) at or before sample `i`.
    pub fn sync_at_or_before(&self, i: usize) -> usize {
        (0..=i.min(self.samples.len().saturating_sub(1)))
            .rev()
            .find(|&k| self.samples[k].sync)
            .unwrap_or(0)
    }
}

pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_exact_at(buf, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0usize;
        while done < buf.len() {
            let n = file.seek_read(&mut buf[done..], offset + done as u64)?;
            if n == 0 {
                return Err(std::io::ErrorKind::UnexpectedEof.into());
            }
            done += n;
        }
        Ok(())
    }
}

/// H.264's avcC: SPS, PPS and the NAL length size.
fn parse_avcc(avcc: &[u8]) -> Result<(Sets, Sets, u8)> {
    let nal_length_size = (avcc.get(4).ok_or_else(|| anyhow!("truncated avcC"))? & 3) + 1;
    let mut p = 5usize;
    let read_sets = |count: usize, p: &mut usize| -> Result<Vec<Vec<u8>>> {
        let mut v = Vec::with_capacity(count);
        for _ in 0..count {
            let n = be16(avcc, *p)? as usize;
            let set = avcc.get(*p + 2..*p + 2 + n).ok_or_else(|| anyhow!("truncated avcC parameter set"))?;
            v.push(set.to_vec());
            *p += 2 + n;
        }
        Ok(v)
    };
    let sps_count = (avcc.get(p).ok_or_else(|| anyhow!("truncated avcC"))? & 31) as usize;
    p += 1;
    let sps = read_sets(sps_count, &mut p)?;
    let pps_count = *avcc.get(p).ok_or_else(|| anyhow!("truncated avcC"))? as usize;
    p += 1;
    let pps = read_sets(pps_count, &mut p)?;
    Ok((sps, pps, nal_length_size))
}

/// H.265's hvcC (ISO/IEC 14496-15): the NAL length size and the VPS, SPS
/// and PPS from its NAL arrays (types 32, 33, 34).
fn parse_hvcc(hvcc: &[u8]) -> Result<(u8, Sets, Sets, Sets)> {
    let nal_length_size = (hvcc.get(21).ok_or_else(|| anyhow!("truncated hvcC"))? & 3) + 1;
    let arrays = *hvcc.get(22).ok_or_else(|| anyhow!("truncated hvcC"))? as usize;
    let (mut vps, mut sps, mut pps) = (Vec::new(), Vec::new(), Vec::new());
    let mut p = 23usize;
    for _ in 0..arrays {
        let kind = hvcc.get(p).ok_or_else(|| anyhow!("truncated hvcC array"))? & 0x3f;
        let count = be16(hvcc, p + 1)? as usize;
        p += 3;
        for _ in 0..count {
            let n = be16(hvcc, p)? as usize;
            let nal = hvcc.get(p + 2..p + 2 + n).ok_or_else(|| anyhow!("truncated hvcC NAL"))?.to_vec();
            p += 2 + n;
            match kind {
                32 => vps.push(nal),
                33 => sps.push(nal),
                34 => pps.push(nal),
                _ => {}
            }
        }
    }
    Ok((nal_length_size, vps, sps, pps))
}

/// Bytes read at once while walking the top-level boxes. Tesla clips are
/// ftyp, free, mdat, then moov at the end (about 27 KB a minute), so the
/// first chunk holds the leading headers and the one read at the moov
/// header holds the whole index: two reads in all, which matters on a
/// network share where every read is a round trip.
const WALK_CHUNK: u64 = 64 << 10;

/// Finds the `moov` box at the top level and parses its first video track.
pub fn read_video_track(file: &File) -> Result<VideoTrack> {
    let len = file.metadata()?.len();
    let mut pos = 0u64;
    let mut mdat_ranges: Vec<(u64, u64)> = Vec::new();
    let mut moov: Option<Vec<u8>> = None;
    // The last chunk read: (file offset, bytes).
    let mut chunk: (u64, Vec<u8>) = (0, Vec::new());
    let in_chunk = |chunk: &(u64, Vec<u8>), at: u64, n: u64| at >= chunk.0 && at + n <= chunk.0 + chunk.1.len() as u64;
    while pos + 8 <= len {
        let mut head = [0u8; 16];
        let n = (len - pos).min(16) as usize;
        if !in_chunk(&chunk, pos, n as u64) {
            // At the start a few headers come first (ftyp, free, mdat);
            // later on, a moov header comes with its body.
            let want = (len - pos).min(if pos == 0 { 4 << 10 } else { WALK_CHUNK }) as usize;
            let mut buf = vec![0u8; want];
            read_at(file, &mut buf, pos).context("reading MP4 box header")?;
            chunk = (pos, buf);
        }
        let at = (pos - chunk.0) as usize;
        head[..n].copy_from_slice(&chunk.1[at..at + n]);
        let size32 = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as u64;
        let typ = [head[4], head[5], head[6], head[7]];
        let (size, header) = match size32 {
            1 => {
                if n < 16 {
                    bail!("truncated MP4 box header");
                }
                (u64::from_be_bytes(head[8..16].try_into().unwrap()), 16)
            }
            0 => (len - pos, 8),
            s => (s, 8),
        };
        // (checked_add: a damaged 64-bit size must not wrap around.)
        if size < header || pos.checked_add(size).is_none_or(|end| end > len) {
            // A clip cut off mid-write: keep what is complete.
            if &typ == b"mdat" {
                mdat_ranges.push((pos + header, len));
            }
            break;
        }
        match &typ {
            b"moov" => {
                let body = (size - header) as usize;
                if body > 64 << 20 {
                    bail!("MP4 index is too large ({body} bytes)");
                }
                if in_chunk(&chunk, pos + header, body as u64) {
                    let at = (pos + header - chunk.0) as usize;
                    moov = Some(chunk.1[at..at + body].to_vec());
                } else {
                    let mut buf = vec![0u8; body];
                    read_at(file, &mut buf, pos + header).context("reading MP4 index")?;
                    moov = Some(buf);
                }
            }
            b"mdat" => mdat_ranges.push((pos + header, pos + size)),
            _ => {}
        }
        pos += size;
    }
    let moov = moov.ok_or_else(|| anyhow!("no MP4 index (moov) in this file"))?;
    let track = parse_moov(&moov)?;
    for s in &track.samples {
        let Some(end) = s.offset.checked_add(s.size as u64) else { bail!("frame data lies outside the media data") };
        if !mdat_ranges.iter().any(|&(a, b)| s.offset >= a && end <= b) {
            bail!("frame data lies outside the media data");
        }
    }
    Ok(track)
}

struct Bx<'a> {
    typ: [u8; 4],
    body: &'a [u8],
}

fn children(data: &[u8]) -> Result<Vec<Bx<'_>>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size32 = be32(data, pos)? as usize;
        let typ = [data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]];
        let (size, header) = match size32 {
            1 => (be64(data, pos + 8)? as usize, 16),
            0 => (data.len() - pos, 8),
            s => (s, 8),
        };
        if size < header || pos.checked_add(size).is_none_or(|end| end > data.len()) {
            bail!("invalid {} box", String::from_utf8_lossy(&typ));
        }
        out.push(Bx { typ, body: &data[pos + header..pos + size] });
        pos += size;
    }
    Ok(out)
}

fn child<'a>(data: &'a [u8], name: &[u8; 4]) -> Result<&'a [u8]> {
    children(data)?
        .into_iter()
        .find(|b| &b.typ == name)
        .map(|b| b.body)
        .ok_or_else(|| anyhow!("missing {} box", String::from_utf8_lossy(name)))
}

fn opt_child<'a>(data: &'a [u8], name: &[u8; 4]) -> Result<Option<&'a [u8]>> {
    Ok(children(data)?.into_iter().find(|b| &b.typ == name).map(|b| b.body))
}

fn be16(d: &[u8], p: usize) -> Result<u16> {
    d.get(p..p + 2).map(|b| u16::from_be_bytes([b[0], b[1]])).ok_or_else(|| anyhow!("truncated MP4 table"))
}
fn be32(d: &[u8], p: usize) -> Result<u32> {
    d.get(p..p + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| anyhow!("truncated MP4 table"))
}
fn be64(d: &[u8], p: usize) -> Result<u64> {
    d.get(p..p + 8).map(|b| u64::from_be_bytes(b.try_into().unwrap())).ok_or_else(|| anyhow!("truncated MP4 table"))
}

fn parse_moov(moov: &[u8]) -> Result<VideoTrack> {
    for trak in children(moov)?.into_iter().filter(|b| &b.typ == b"trak") {
        let mdia = child(trak.body, b"mdia")?;
        let hdlr = child(mdia, b"hdlr")?;
        if hdlr.get(8..12) != Some(b"vide") {
            continue;
        }
        return parse_video_trak(mdia);
    }
    bail!("no video track in this clip")
}

fn parse_video_trak(mdia: &[u8]) -> Result<VideoTrack> {
    let mdhd = child(mdia, b"mdhd")?;
    let timescale = if mdhd.first() == Some(&1) { be32(mdhd, 20)? } else { be32(mdhd, 12)? };
    if timescale == 0 {
        bail!("invalid video timescale");
    }
    let stbl = child(child(mdia, b"minf")?, b"stbl")?;

    // Sample description: avc1 + avcC, or hvc1 + hvcC.
    let stsd = child(stbl, b"stsd")?;
    let entries = children(stsd.get(8..).ok_or_else(|| anyhow!("truncated stsd"))?)?;
    let entry = entries.first().ok_or_else(|| anyhow!("empty stsd"))?;
    let codec = match &entry.typ {
        b"avc1" | b"avc3" => Codec::H264,
        b"hvc1" | b"hev1" => Codec::H265,
        other => bail!("unsupported video codec {} (H.264 and H.265 play)", String::from_utf8_lossy(other)),
    };
    let width = be16(entry.body, 24)? as u32;
    let height = be16(entry.body, 26)? as u32;
    let (nal_length_size, vps, sps, pps) = match codec {
        Codec::H264 => {
            let avcc = child(entry.body.get(78..).ok_or_else(|| anyhow!("truncated avc1"))?, b"avcC")?;
            let (sps, pps, n) = parse_avcc(avcc)?;
            (n, Vec::new(), sps, pps)
        }
        Codec::H265 => {
            let hvcc = child(entry.body.get(78..).ok_or_else(|| anyhow!("truncated hvc1"))?, b"hvcC")?;
            parse_hvcc(hvcc)?
        }
    };
    if sps.is_empty() || pps.is_empty() {
        bail!("clip has no parameter sets");
    }

    // Sizes
    let stsz = child(stbl, b"stsz")?;
    let fixed = be32(stsz, 4)?;
    let count = be32(stsz, 8)? as usize;
    // A damaged count must not make the tables below ask for gigabytes:
    // a size table must hold every entry, and no clip has more frames
    // than this (over three days at 36 fps).
    if count > 10_000_000 || (fixed == 0 && count.saturating_mul(4).saturating_add(12) > stsz.len()) {
        bail!("invalid sample size table");
    }
    let sizes: Vec<u32> = if fixed != 0 {
        vec![fixed; count]
    } else {
        (0..count).map(|i| be32(stsz, 12 + i * 4)).collect::<Result<_>>()?
    };

    // Chunk offsets
    let chunk_offsets: Vec<u64> = if let Some(stco) = opt_child(stbl, b"stco")? {
        let n = be32(stco, 4)? as usize;
        (0..n).map(|i| be32(stco, 8 + i * 4).map(u64::from)).collect::<Result<_>>()?
    } else {
        let co64 = child(stbl, b"co64")?;
        let n = be32(co64, 4)? as usize;
        (0..n).map(|i| be64(co64, 8 + i * 8)).collect::<Result<_>>()?
    };

    // Samples per chunk
    let stsc = child(stbl, b"stsc")?;
    let runs_n = be32(stsc, 4)? as usize;
    if runs_n.saturating_mul(12).saturating_add(8) > stsc.len() {
        bail!("invalid sample-to-chunk table");
    }
    let mut runs: Vec<(usize, usize)> = Vec::with_capacity(runs_n);
    for i in 0..runs_n {
        let first = be32(stsc, 8 + i * 12)? as usize;
        let per = be32(stsc, 12 + i * 12)? as usize;
        if first == 0 || per == 0 || runs.last().is_some_and(|&(f, _)| first <= f) {
            bail!("invalid sample-to-chunk table");
        }
        runs.push((first, per));
    }
    let mut offsets: Vec<u64> = Vec::with_capacity(count);
    let mut run = 0usize;
    for (ci, &chunk_start) in chunk_offsets.iter().enumerate() {
        let chunk = ci + 1;
        while run + 1 < runs.len() && chunk >= runs[run + 1].0 {
            run += 1;
        }
        let per = runs.get(run).map(|r| r.1).unwrap_or(0);
        let mut off = chunk_start;
        for _ in 0..per {
            if offsets.len() == count {
                break;
            }
            offsets.push(off);
            off += sizes[offsets.len() - 1] as u64;
        }
    }
    if offsets.len() != count {
        bail!("sample tables disagree ({} offsets for {} frames)", offsets.len(), count);
    }

    // Decode times
    let stts = child(stbl, b"stts")?;
    let mut dts: Vec<i64> = Vec::with_capacity(count);
    let mut deltas: Vec<i64> = Vec::with_capacity(count);
    let mut t = 0i64;
    for i in 0..be32(stts, 4)? as usize {
        if dts.len() == count {
            break;
        }
        let n = be32(stts, 8 + i * 8)? as usize;
        let d = be32(stts, 12 + i * 8)? as i64;
        for _ in 0..n.min(count - dts.len()) {
            dts.push(t);
            deltas.push(d);
            t += d;
        }
    }
    if dts.len() != count {
        bail!("decode-time table does not cover every frame");
    }

    // Composition offsets (optional)
    let mut cts = vec![0i64; count];
    if let Some(ctts) = opt_child(stbl, b"ctts")? {
        let v1 = ctts.first() == Some(&1);
        let mut k = 0usize;
        for i in 0..be32(ctts, 4)? as usize {
            if k == count {
                break;
            }
            let n = be32(ctts, 8 + i * 8)? as usize;
            let raw = be32(ctts, 12 + i * 8)?;
            let off = if v1 { raw as i32 as i64 } else { raw as i64 };
            for _ in 0..n.min(count - k) {
                cts[k] = off;
                k += 1;
            }
        }
    }

    // Sync frames (absent = every frame is a sync frame)
    let mut sync = vec![true; count];
    if let Some(stss) = opt_child(stbl, b"stss")? {
        sync.iter_mut().for_each(|s| *s = false);
        for i in 0..be32(stss, 4)? as usize {
            let n = be32(stss, 8 + i * 4)? as usize;
            if n >= 1 && n <= count {
                sync[n - 1] = true;
            }
        }
    }

    let samples: Vec<Sample> = (0..count)
        .map(|i| Sample { offset: offsets[i], size: sizes[i], pts: dts[i] + cts[i], sync: sync[i] })
        .collect();
    let end = samples
        .iter()
        .zip(&deltas)
        .map(|(s, d)| s.pts + d)
        .max()
        .unwrap_or(0);
    Ok(VideoTrack {
        codec,
        vps,
        timescale,
        width,
        height,
        nal_length_size,
        sps,
        pps,
        samples,
        duration: end as f64 / timescale as f64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn damaged_box_sizes_are_refused() {
        // A 64-bit size near u64::MAX must not wrap the end past the data.
        let mut data = vec![0, 0, 0, 1, b'f', b'r', b'e', b'e'];
        data.extend_from_slice(&u64::MAX.to_be_bytes());
        data.extend_from_slice(&[0; 8]);
        assert!(children(&data).is_err());
        // A box claiming more than there is.
        assert!(children(&[0, 0, 0, 64, b'f', b'r', b'e', b'e']).is_err());
        // A well-formed one.
        let ok = children(&[0, 0, 0, 8, b'f', b'r', b'e', b'e']).unwrap();
        assert_eq!(&ok[0].typ, b"free");
    }
}
