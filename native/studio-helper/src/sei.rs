//! Port of `src/renderer/scripts/data/dashcam-mp4.js` (`DashcamMP4.parseFrames`)
//! and `src/renderer/scripts/core/seiExtractor.js` (`extractSeiFromBuffer`).
//!
//! The Electron renderer fetches the whole MP4 over `file://`, walks the box
//! tree and decodes every SEI NAL with protobufjs. Here the same walk runs
//! natively and only the decoded telemetry crosses IPC. The validation rules
//! (which malformed inputs throw) follow the JavaScript line for line so the
//! two builds accept and reject the same files.

use anyhow::{anyhow, bail, Result};
use serde::Serialize;

/// Decoded `SeiMetadata` (src/renderer/proto/dashcam.proto). Field names are
/// snake_case because the renderer parses the proto with `keepCase: true`.
/// Every field is always present: protobufjs exposes proto3 defaults through
/// the message prototype, so the renderer reads 0/false for absent fields
/// either way.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct SeiMetadata {
    pub version: u32,
    pub gear_state: i32,
    pub frame_seq_no: f64,
    pub vehicle_speed_mps: f64,
    pub accelerator_pedal_position: f64,
    pub steering_wheel_angle: f64,
    pub blinker_on_left: bool,
    pub blinker_on_right: bool,
    pub brake_applied: bool,
    pub autopilot_state: i32,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub heading_deg: f64,
    pub linear_acceleration_mps2_x: f64,
    pub linear_acceleration_mps2_y: f64,
    pub linear_acceleration_mps2_z: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeiSample {
    pub timestamp_ms: f64,
    pub sei: SeiMetadata,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapPoint {
    pub lat: f64,
    pub lon: f64,
    pub timestamp_ms: f64,
    pub autopilot: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeiResult {
    pub sei_data: Vec<SeiSample>,
    pub map_path: Vec<MapPoint>,
}

// ---------------------------------------------------------------------------
// protobuf decoding (protobufjs Reader semantics for this schema)
// ---------------------------------------------------------------------------

struct PbReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> PbReader<'a> {
    fn varint64(&mut self) -> Result<u64> {
        let mut result: u64 = 0;
        for i in 0..10 {
            let b = *self.buf.get(self.pos).ok_or_else(|| anyhow!("index out of range"))?;
            self.pos += 1;
            if i < 9 {
                result |= ((b & 0x7f) as u64) << (7 * i);
            } else {
                result |= ((b & 0x01) as u64) << 63;
            }
            if b < 0x80 {
                return Ok(result);
            }
        }
        bail!("invalid varint encoding")
    }
    fn uint32(&mut self) -> Result<u32> {
        Ok(self.varint64()? as u32)
    }
    fn fixed(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.pos + n > self.buf.len() {
            bail!("index out of range");
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn float(&mut self) -> Result<f64> {
        let b = self.fixed(4)?;
        Ok(f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64)
    }
    fn double(&mut self) -> Result<f64> {
        let b = self.fixed(8)?;
        Ok(f64::from_le_bytes(b.try_into().unwrap()))
    }
    fn skip_type(&mut self, wire: u32) -> Result<()> {
        match wire {
            0 => {
                self.varint64()?;
            }
            1 => {
                self.fixed(8)?;
            }
            2 => {
                let len = self.uint32()? as usize;
                self.fixed(len)?;
            }
            3 => loop {
                let tag = self.uint32()?;
                let w = tag & 7;
                if w == 4 {
                    break;
                }
                self.skip_type(w)?;
            },
            5 => {
                self.fixed(4)?;
            }
            _ => bail!("invalid wire type {wire} at offset {}", self.pos),
        }
        Ok(())
    }
}

/// Mirrors the protobufjs generated decoder: fields are read by their schema
/// type regardless of the wire type on the tag; unknown fields are skipped.
pub fn decode_sei_metadata(buf: &[u8]) -> Result<SeiMetadata> {
    let mut r = PbReader { buf, pos: 0 };
    let mut m = SeiMetadata::default();
    while r.pos < buf.len() {
        let tag = r.uint32()?;
        match tag >> 3 {
            1 => m.version = r.uint32()?,
            2 => m.gear_state = r.varint64()? as i32,
            3 => m.frame_seq_no = r.varint64()? as f64,
            4 => m.vehicle_speed_mps = r.float()?,
            5 => m.accelerator_pedal_position = r.float()?,
            6 => m.steering_wheel_angle = r.float()?,
            7 => m.blinker_on_left = r.varint64()? != 0,
            8 => m.blinker_on_right = r.varint64()? != 0,
            9 => m.brake_applied = r.varint64()? != 0,
            10 => m.autopilot_state = r.varint64()? as i32,
            11 => m.latitude_deg = r.double()?,
            12 => m.longitude_deg = r.double()?,
            13 => m.heading_deg = r.double()?,
            14 => m.linear_acceleration_mps2_x = r.double()?,
            15 => m.linear_acceleration_mps2_y = r.double()?,
            16 => m.linear_acceleration_mps2_z = r.double()?,
            _ => r.skip_type(tag & 7)?,
        }
    }
    Ok(m)
}

// ---------------------------------------------------------------------------
// MP4 walking
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct BoxRef {
    typ: [u8; 4],
    start: usize,
    end: usize,
    size: usize,
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    offset: usize,
    size: usize,
    timestamp: f64,
}

#[derive(PartialEq, Clone, Copy)]
enum Entry {
    Avc1,
    Hvc1,
    Av01,
}

struct Mp4<'a> {
    b: &'a [u8],
    mdats: Vec<BoxRef>,
}

fn require(start: usize, size: usize, end: usize, label: &str) -> Result<()> {
    if start > end || size > end - start {
        bail!("Truncated or invalid {label}: exceeds containing range");
    }
    Ok(())
}

impl<'a> Mp4<'a> {
    fn u8(&self, p: usize) -> u8 {
        self.b[p]
    }
    fn u16(&self, p: usize) -> u16 {
        u16::from_be_bytes([self.b[p], self.b[p + 1]])
    }
    fn u32(&self, p: usize) -> u32 {
        u32::from_be_bytes([self.b[p], self.b[p + 1], self.b[p + 2], self.b[p + 3]])
    }
    fn i32(&self, p: usize) -> i32 {
        self.u32(p) as i32
    }
    fn u64(&self, p: usize) -> Result<usize> {
        let v = (self.u32(p) as u64) * 0x1_0000_0000 + self.u32(p + 4) as u64;
        if v > (1u64 << 53) - 1 {
            bail!("Unsupported MP4 size or offset exceeds safe integer range");
        }
        Ok(v as usize)
    }

    fn boxes(&self, start: usize, end: usize) -> Result<Vec<BoxRef>> {
        require(start, end.saturating_sub(start), self.b.len(), "box range")?;
        if end < start {
            bail!("Truncated or invalid box range: exceeds containing range");
        }
        let mut out = Vec::new();
        let mut pos = start;
        while pos < end {
            require(pos, 8, end, "box header")?;
            let mut size = self.u32(pos) as usize;
            let typ = [self.b[pos + 4], self.b[pos + 5], self.b[pos + 6], self.b[pos + 7]];
            let tname = String::from_utf8_lossy(&typ).to_string();
            let header = if size == 1 { 16 } else { 8 };
            require(pos, header, end, &format!("{tname} header"))?;
            if size == 1 {
                size = self.u64(pos + 8)?;
            } else if size == 0 {
                size = end - pos;
            }
            if size < header {
                bail!("Invalid {tname} box size");
            }
            require(pos, size, end, &format!("{tname} box"))?;
            out.push(BoxRef { typ, start: pos + header, end: pos + size, size: size - header });
            pos += size;
        }
        Ok(out)
    }

    fn find(&self, start: usize, end: usize, name: &[u8; 4]) -> Result<BoxRef> {
        self.boxes(start, end)?
            .into_iter()
            .find(|b| &b.typ == name)
            .ok_or_else(|| anyhow!("Box \"{}\" not found", String::from_utf8_lossy(name)))
    }

    fn table_entries(&self, bx: &BoxRef, stride: usize, header: usize) -> Result<usize> {
        require(bx.start, header, bx.end, "table")?;
        let count = self.u32(bx.start + header - 4) as usize;
        let total = count.checked_mul(stride).ok_or_else(|| anyhow!("Truncated or invalid entries"))?;
        require(bx.start + header, total, bx.end, "entries")?;
        Ok(count)
    }

    fn sample_index(&self, stbl: &BoxRef) -> Result<Vec<Sample>> {
        let tables = self.boxes(stbl.start, stbl.end)?;
        let sizes = self.find(stbl.start, stbl.end, b"stsz")?;
        require(sizes.start, 12, sizes.end, "stsz")?;
        let fixed = self.u32(sizes.start + 4) as usize;
        let count = self.u32(sizes.start + 8) as usize;
        let media_bytes: usize = self.mdats.iter().map(|m| m.size).sum();
        if (count as f64) > media_bytes as f64 / (if fixed == 0 { 1 } else { fixed }) as f64 {
            bail!("Invalid sample count exceeds media bytes");
        }
        if fixed == 0 {
            self.table_entries(&sizes, 4, 12)?;
        }
        let offs: Vec<&BoxRef> = tables.iter().filter(|b| &b.typ == b"stco" || &b.typ == b"co64").collect();
        if offs.len() != 1 {
            bail!("Unsupported sample chunk offset tables");
        }
        let ot = offs[0];
        let stride = if &ot.typ == b"co64" { 8 } else { 4 };
        let chunk_count = self.table_entries(ot, stride, 8)?;
        let stsc = self.find(stbl.start, stbl.end, b"stsc")?;
        let entry_count = self.table_entries(&stsc, 12, 8)?;
        let mut runs: Vec<(usize, usize)> = Vec::new();
        for i in 0..entry_count {
            let p = stsc.start + 8 + i * 12;
            let first = self.u32(p) as usize;
            let samples = self.u32(p + 4) as usize;
            if first == 0
                || first > chunk_count
                || (i == 0 && first != 1)
                || (i > 0 && first <= runs[i - 1].0)
                || samples == 0
                || samples > count
                || self.u32(p + 8) != 1
            {
                bail!("Invalid or unsupported sample chunk mapping");
            }
            runs.push((first, samples));
        }
        if chunk_count > 0 && runs.is_empty() {
            bail!("Invalid empty sample chunk mapping");
        }
        let mut samples: Vec<Sample> = Vec::with_capacity(count);
        let mut run = 0usize;
        for chunk in 1..=chunk_count {
            if run + 1 < runs.len() && chunk >= runs[run + 1].0 {
                run += 1;
            }
            let p = ot.start + 8 + (chunk - 1) * stride;
            let mut offset = if stride == 8 { self.u64(p)? } else { self.u32(p) as usize };
            if runs[run].1 > count - samples.len() {
                bail!("Invalid chunk sample count");
            }
            for _ in 0..runs[run].1 {
                let size = if fixed != 0 { fixed } else { self.u32(sizes.start + 12 + samples.len() * 4) as usize };
                if size == 0
                    || !self.mdats.iter().any(|m| offset >= m.start && offset <= m.end && size <= m.end - offset)
                {
                    bail!("Invalid sample extent outside mdat");
                }
                samples.push(Sample { offset, size, timestamp: 0.0 });
                offset += size;
            }
        }
        if samples.len() != count {
            bail!("Invalid sample count does not match chunks");
        }
        let mut ordered: Vec<(usize, usize)> = samples.iter().map(|s| (s.offset, s.size)).collect();
        ordered.sort_by_key(|s| s.0);
        for i in 1..ordered.len() {
            if ordered[i].0 < ordered[i - 1].0 + ordered[i - 1].1 {
                bail!("Invalid overlapping samples");
            }
        }
        Ok(samples)
    }

    fn sample_timing(&self, bx: &BoxRef, sample_count: usize) -> Result<Vec<i64>> {
        let count = self.table_entries(bx, 8, 8)?;
        let version = self.u8(bx.start);
        if version > (if &bx.typ == b"ctts" { 1 } else { 0 }) {
            bail!("Unsupported sample timing version");
        }
        let mut values: Vec<i64> = Vec::with_capacity(sample_count);
        for i in 0..count {
            let pos = bx.start + 8 + i * 8;
            let repeat = self.u32(pos) as usize;
            let value = if version == 1 { self.i32(pos + 4) as i64 } else { self.u32(pos + 4) as i64 };
            if repeat == 0 || repeat > sample_count - values.len() {
                bail!("Invalid sample timing count");
            }
            values.extend(std::iter::repeat(value).take(repeat));
        }
        if values.len() != sample_count {
            bail!("Invalid sample timing count");
        }
        Ok(values)
    }

    fn records(&self, start: usize, end: usize, length_size: usize) -> Result<Vec<&'a [u8]>> {
        let mut out = Vec::new();
        let mut pos = start;
        while pos < end {
            require(pos, length_size, end, "NAL record length")?;
            let mut len = 0usize;
            for _ in 0..length_size {
                len = len * 256 + self.b[pos] as usize;
                pos += 1;
            }
            if len == 0 {
                bail!("Invalid zero-length NAL record");
            }
            require(pos, len, end, "NAL record")?;
            out.push(&self.b[pos..pos + len]);
            pos += len;
        }
        Ok(out)
    }
}

fn is_picture_marker(nal: &[u8]) -> bool {
    nal.len() == 3 && nal[0] == 0x61 && nal[1] == 0x01 && nal[2] == 0x80
}

fn strip_emulation(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut zeros = 0;
    for &byte in data {
        if zeros >= 2 && byte == 0x03 {
            zeros = 0;
            continue;
        }
        out.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    out
}

/// `seiPayload`: the protobuf bytes of a Tesla user-data-unregistered SEI.
fn sei_payload(nal: &[u8]) -> Option<Vec<u8>> {
    if nal.len() < 6 || (nal[0] & 31) != 6 || nal[1] != 5 || nal[nal.len() - 1] != 0x80 {
        return None;
    }
    let rbsp = strip_emulation(&nal[1..]);
    let mut i = 1usize;
    let mut size = 0usize;
    while i < rbsp.len() && rbsp[i] == 255 {
        size += 255;
        i += 1;
    }
    if i >= rbsp.len() {
        return None;
    }
    size += rbsp[i] as usize;
    i += 1;
    if rbsp.len() < i + 1 || size != rbsp.len() - i - 1 {
        return None;
    }
    let prefix = i;
    while i < rbsp.len() && rbsp[i] == 0x42 {
        i += 1;
    }
    if i == prefix || i >= rbsp.len() || rbsp[i] != 0x69 {
        return None;
    }
    i += 1;
    if i >= rbsp.len() - 1 {
        return None;
    }
    Some(rbsp[i..rbsp.len() - 1].to_vec())
}

fn decode_sei(nal: &[u8]) -> Option<SeiMetadata> {
    let payload = sei_payload(nal)?;
    decode_sei_metadata(&payload).ok()
}

/// One frame's telemetry (presentation timestamp + decoded SEI, if any).
pub struct FrameSei {
    pub timestamp: f64,
    pub sei: Option<SeiMetadata>,
}

/// `DashcamMP4.parseFrames(SeiMetadata)` reduced to what telemetry needs.
pub fn parse_frames(b: &[u8]) -> Result<Vec<FrameSei>> {
    let mut mp4 = Mp4 { b, mdats: Vec::new() };
    let len = b.len();
    let top = mp4.boxes(0, len)?;
    let moov = mp4.find(0, len, b"moov")?;
    mp4.mdats = top.iter().filter(|x| &x.typ == b"mdat").copied().collect();
    let tracks: Vec<BoxRef> = mp4.boxes(moov.start, moov.end)?.into_iter().filter(|x| &x.typ == b"trak").collect();
    let mut media = Vec::new();
    for t in &tracks {
        media.push(mp4.find(t.start, t.end, b"mdia")?);
    }
    let mut mdia_idx = None;
    for (i, m) in media.iter().enumerate() {
        let hdlr = mp4.find(m.start, m.end, b"hdlr")?;
        require(hdlr.start, 12, hdlr.end, "hdlr")?;
        if &b[hdlr.start + 8..hdlr.start + 12] == b"vide" {
            mdia_idx = Some(i);
            break;
        }
    }
    let mdia = media[mdia_idx.ok_or_else(|| anyhow!("Unsupported MP4: no video track"))?];
    let minf = mp4.find(mdia.start, mdia.end, b"minf")?;
    let stbl = mp4.find(minf.start, minf.end, b"stbl")?;
    let stsd = mp4.find(stbl.start, stbl.end, b"stsd")?;
    require(stsd.start, 8, stsd.end, "stsd")?;
    let entries = mp4.boxes(stsd.start + 8, stsd.end)?;
    if mp4.u32(stsd.start + 4) != 1 || entries.len() != 1 {
        bail!("Unsupported video sample descriptions");
    }
    let entry = entries[0];
    let (kind, config_name): (Entry, &[u8; 4]) = match &entry.typ {
        b"avc1" => (Entry::Avc1, b"avcC"),
        b"hvc1" => (Entry::Hvc1, b"hvcC"),
        b"av01" => (Entry::Av01, b"av1C"),
        other => bail!("Unsupported video sample entry {}", String::from_utf8_lossy(other)),
    };
    require(entry.start, 78, entry.end, "sample entry")?;
    let desc = mp4.find(entry.start + 78, entry.end, config_name)?;
    let o = desc.start;
    require(o, match kind { Entry::Avc1 => 7, Entry::Hvc1 => 23, Entry::Av01 => 4 }, desc.end, "config")?;
    if mp4.u8(o) != (if kind == Entry::Av01 { 0x81 } else { 1 }) {
        bail!("Unsupported config version");
    }
    let mut length_size = 4usize;
    if kind == Entry::Avc1 {
        length_size = (mp4.u8(o + 4) & 3) as usize + 1;
        // Validate the parameter-set lists exactly like readSets() does.
        let mut p = o + 6;
        let read_sets = |count: usize, p: &mut usize| -> Result<()> {
            for _ in 0..count {
                require(*p, 2, desc.end, "AVC parameter set length")?;
                let l = mp4.u16(*p) as usize;
                *p += 2;
                require(*p, l, desc.end, "AVC parameter set")?;
                *p += l;
            }
            Ok(())
        };
        read_sets((mp4.u8(o + 5) & 31) as usize, &mut p)?;
        require(p, 1, desc.end, "AVC PPS count")?;
        let n = mp4.u8(p) as usize;
        p += 1;
        read_sets(n, &mut p)?;
    } else if kind == Entry::Hvc1 {
        length_size = (mp4.u8(o + 21) & 3) as usize + 1;
    }
    let mdhd = mp4.find(mdia.start, mdia.end, b"mdhd")?;
    require(mdhd.start, 1, mdhd.end, "mdhd")?;
    let mdhd_version = mp4.u8(mdhd.start);
    if mdhd_version > 1 {
        bail!("Unsupported mdhd version");
    }
    let ts_off = mdhd.start + if mdhd_version == 1 { 20 } else { 12 };
    require(ts_off, 4, mdhd.end, "mdhd timescale")?;
    let timescale = mp4.u32(ts_off);
    if timescale == 0 {
        bail!("Invalid media timescale");
    }
    let mut samples = mp4.sample_index(&stbl)?;
    let mut other_samples: Vec<Sample> = Vec::new();
    if kind == Entry::Av01 {
        for (i, other) in media.iter().enumerate() {
            if Some(i) == mdia_idx {
                continue;
            }
            let om = mp4.find(other.start, other.end, b"minf")?;
            let os = mp4.find(om.start, om.end, b"stbl")?;
            other_samples.extend(mp4.sample_index(&os)?);
        }
    }
    let stts = mp4.find(stbl.start, stbl.end, b"stts")?;
    let durations = mp4.sample_timing(&stts, samples.len())?;
    let ctts = mp4.boxes(stbl.start, stbl.end)?.into_iter().find(|x| &x.typ == b"ctts");
    let offsets = match ctts {
        Some(c) => Some(mp4.sample_timing(&c, samples.len())?),
        None => None,
    };
    let mut ticks: i64 = 0;
    for i in 0..samples.len() {
        let off = offsets.as_ref().map(|o| o[i]).unwrap_or(0);
        samples[i].timestamp = ((ticks + off) as f64) * 1000.0 / timescale as f64;
        ticks += durations[i];
        if ticks.abs() > (1i64 << 53) - 1 {
            bail!("Invalid sample timing overflow");
        }
    }

    // AV1: telemetry lives in the converter's first, unreferenced mdat.
    let av1: Option<Vec<Option<SeiMetadata>>> = if kind == Entry::Av01 {
        let carrier = *mp4.mdats.first().ok_or_else(|| anyhow!("Unsupported AV1 telemetry carrier: missing first mdat"))?;
        if mp4.mdats.len() < 2 {
            bail!("Unsupported AV1 telemetry carrier: missing first mdat");
        }
        if samples.iter().chain(other_samples.iter()).any(|s| s.offset < carrier.end) {
            bail!("Invalid AV1 sample references telemetry carrier");
        }
        let mut groups: Vec<Option<SeiMetadata>> = Vec::new();
        let mut pending: Option<SeiMetadata> = None;
        let mut pending_records = false;
        for nal in mp4.records(carrier.start, carrier.end, 4)? {
            if is_picture_marker(nal) {
                if groups.len() >= samples.len() {
                    bail!("Invalid AV1 carrier marker count");
                }
                groups.push(pending.take());
                pending_records = false;
            } else {
                if nal.len() < 2 || nal[0] != 6 || nal[1] != 5 || sei_payload(nal).is_none() {
                    bail!("Invalid AV1 carrier record");
                }
                pending = decode_sei(nal);
                if pending.is_none() {
                    bail!("Invalid AV1 telemetry protobuf");
                }
                pending_records = true;
            }
        }
        if pending_records || groups.len() != samples.len() {
            bail!("Invalid AV1 carrier marker count");
        }
        Some(groups)
    } else {
        None
    };

    let mut frames = Vec::with_capacity(samples.len());
    let mut marker_counts: Vec<u32> = Vec::with_capacity(samples.len());
    let mut has_compat = false;
    for (idx, sample) in samples.iter().enumerate() {
        let mut sei = av1.as_ref().and_then(|g| g[idx].clone());
        let mut has_data = av1.is_some();
        let mut markers = 0u32;
        if av1.is_none() {
            for nal in mp4.records(sample.offset, sample.offset + sample.size, length_size)? {
                if kind == Entry::Avc1 {
                    let t = nal[0] & 31;
                    if t == 6 {
                        if let Some(d) = decode_sei(nal) {
                            sei = Some(d);
                        }
                    } else if t == 5 || t == 1 {
                        has_data = true;
                    }
                } else {
                    if nal.len() < 2 {
                        bail!("Invalid HEVC NAL record header");
                    }
                    let t = (nal[0] >> 1) & 63;
                    if is_picture_marker(nal) {
                        markers += 1;
                    } else if nal[0] == 0x61 && nal[1] == 0x01 {
                        bail!("Invalid HEVC carrier picture marker");
                    } else if nal[0] == 0x66 && nal[1] == 0x01 {
                        let mut original = vec![6u8, 5u8];
                        original.extend_from_slice(&nal[2..]);
                        if sei_payload(&original).is_none() {
                            bail!("Invalid HEVC compatibility record");
                        }
                        sei = decode_sei(&original);
                        if sei.is_none() {
                            bail!("Invalid HEVC telemetry protobuf");
                        }
                        has_compat = true;
                    } else if t <= 31 {
                        has_data = true;
                    }
                }
            }
        }
        if !has_data {
            bail!("Invalid video sample: missing picture");
        }
        marker_counts.push(markers);
        frames.push(FrameSei { timestamp: sample.timestamp, sei });
    }
    if kind == Entry::Hvc1
        && (has_compat || marker_counts.iter().any(|&c| c != 0))
        && marker_counts.iter().any(|&c| c != 1)
    {
        bail!("Invalid HEVC carrier picture marker count");
    }
    Ok(frames)
}

/// `hasValidGps` from seiExtractor.js.
pub fn has_valid_gps(sei: &SeiMetadata) -> bool {
    let (lat, lon) = (sei.latitude_deg, sei.longitude_deg);
    if !lat.is_finite() || !lon.is_finite() {
        return false;
    }
    if lat == 0.0 && lon == 0.0 {
        return false;
    }
    !(lat.abs() > 90.0 || lon.abs() > 180.0)
}

/// `extractSeiFromBuffer`.
pub fn extract_from_bytes(b: &[u8]) -> Result<SeiResult> {
    let frames = parse_frames(b)?;
    let mut out = SeiResult::default();
    for f in frames {
        if let Some(sei) = f.sei {
            if has_valid_gps(&sei) {
                out.map_path.push(MapPoint {
                    lat: sei.latitude_deg,
                    lon: sei.longitude_deg,
                    timestamp_ms: f.timestamp,
                    autopilot: sei.autopilot_state != 0,
                });
            }
            out.sei_data.push(SeiSample { timestamp_ms: f.timestamp, sei });
        }
    }
    // Decode order → presentation order (Array.prototype.sort is stable, so is sort_by).
    out.sei_data.sort_by(|a, b| a.timestamp_ms.partial_cmp(&b.timestamp_ms).unwrap_or(std::cmp::Ordering::Equal));
    out.map_path.sort_by(|a, b| a.timestamp_ms.partial_cmp(&b.timestamp_ms).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

pub fn extract_from_file(path: &std::path::Path) -> Result<SeiResult> {
    let bytes = std::fs::read(path)?;
    extract_from_bytes(&bytes)
}
