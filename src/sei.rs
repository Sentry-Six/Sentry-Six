//! Tesla's SEI telemetry: the protobuf (`SeiMetadata`, from Tesla's
//! dashcam.proto) carried in a user-data-unregistered SEI NAL unit in each
//! frame. `telemetry.rs` finds those units in the frames being played.

use anyhow::{anyhow, bail, Result};

/// Decoded `SeiMetadata`. Every field is always present: proto3 leaves
/// absent fields at 0/false.
#[derive(Debug, Clone, Default, PartialEq)]
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

// ---------------------------------------------------------------------------
// protobuf decoding
// ---------------------------------------------------------------------------

struct PbReader<'a> {
    buf: &'a [u8],
    pos: usize,
    /// Groups being skipped inside each other (bounded, so a malformed
    /// payload can't recurse without end).
    depth: usize,
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
            3 => {
                if self.depth >= 16 {
                    bail!("groups nested too deeply at offset {}", self.pos);
                }
                self.depth += 1;
                loop {
                    let tag = self.uint32()?;
                    let w = tag & 7;
                    if w == 4 {
                        break;
                    }
                    self.skip_type(w)?;
                }
                self.depth -= 1;
            }
            5 => {
                self.fixed(4)?;
            }
            _ => bail!("invalid wire type {wire} at offset {}", self.pos),
        }
        Ok(())
    }
}

/// Fields are read by their schema type regardless of the wire type on the
/// tag, and unknown fields are skipped: the rules of the protobufjs decoder
/// earlier versions used, so the same frames decode the same way.
pub fn decode_sei_metadata(buf: &[u8]) -> Result<SeiMetadata> {
    let mut r = PbReader { buf, pos: 0, depth: 0 };
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

/// Removes H.264/H.265 emulation-prevention bytes (00 00 03 -> 00 00).
pub(crate) fn strip_emulation(data: &[u8]) -> Vec<u8> {
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

/// The protobuf bytes of a Tesla user-data-unregistered SEI.
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

/// Decodes one Tesla telemetry SEI NAL unit.
pub fn decode_sei(nal: &[u8]) -> Option<SeiMetadata> {
    let payload = sei_payload(nal)?;
    decode_sei_metadata(&payload).ok()
}

/// Whether the frame's GPS fix is usable.
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
