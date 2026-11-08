//! AV1 in MP4 (the AV1 Codec ISO Media File Format Binding): each sample
//! is one temporal unit's OBUs, each with its size field, without the
//! temporal delimiter; the `av01` sample entry carries an `av1C` box with
//! the stream's profile, level and the sequence header OBU.

/// One OBU: its type and the whole OBU (header included).
fn obus(data: &[u8]) -> impl Iterator<Item = (u8, &[u8])> {
    let mut at = 0;
    std::iter::from_fn(move || {
        let header = *data.get(at)?;
        let kind = (header >> 3) & 0x0F;
        let extension = header & 0x04 != 0;
        let has_size = header & 0x02 != 0;
        let mut p = at + 1 + extension as usize;
        let end = if has_size {
            let (size, used) = leb128(data.get(p..)?)?;
            p += used;
            p.checked_add(size as usize)?
        } else {
            data.len()
        };
        if end > data.len() {
            return None;
        }
        let obu = &data[at..end];
        at = end;
        Some((kind, obu))
    })
}

fn leb128(b: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for (i, byte) in b.iter().take(8).enumerate() {
        value |= ((byte & 0x7F) as u64) << (i * 7);
        if byte & 0x80 == 0 {
            return Some((value, i + 1));
        }
    }
    None
}

const SEQUENCE_HEADER: u8 = 1;
const TEMPORAL_DELIMITER: u8 = 2;

/// A temporal unit as MP4 stores it: without temporal delimiters.
pub fn sample(tu: &[u8]) -> Vec<u8> {
    obus(tu).filter(|(kind, _)| *kind != TEMPORAL_DELIMITER).flat_map(|(_, o)| o.iter().copied()).collect()
}

struct Bits<'a> {
    data: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    fn read(&mut self, n: u32) -> Option<u32> {
        let mut v = 0u32;
        for _ in 0..n {
            let byte = *self.data.get(self.at / 8)?;
            v = (v << 1) | ((byte >> (7 - self.at % 8)) & 1) as u32;
            self.at += 1;
        }
        Some(v)
    }

    fn uvlc(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.read(1)? == 0 {
            zeros += 1;
            if zeros >= 32 {
                return None;
            }
        }
        Some(self.read(zeros)? + ((1u64 << zeros) - 1) as u32)
    }
}

/// The `av1C` contents for a stream whose first keyframe is `tu`: its
/// sequence header's profile, first level and tier, 8-bit 4:2:0 (what the
/// encoders are given), and the sequence header itself.
pub fn av1c(tu: &[u8]) -> Option<Vec<u8>> {
    let (_, obu) = obus(tu).find(|(kind, _)| *kind == SEQUENCE_HEADER)?;
    // The payload, after the header (and extension) and size.
    let header = obu[0];
    let mut p = 1 + (header & 0x04 != 0) as usize;
    if header & 0x02 != 0 {
        p += leb128(&obu[p..])?.1;
    }
    let mut b = Bits { data: &obu[p..], at: 0 };
    let profile = b.read(3)?;
    let _still = b.read(1)?;
    let reduced = b.read(1)?;
    let (level, tier);
    if reduced == 1 {
        level = b.read(5)?;
        tier = 0;
    } else {
        let mut buffer_delay_bits = 0;
        let timing = b.read(1)?;
        let mut decoder_model = 0;
        if timing == 1 {
            b.read(32)?;
            b.read(32)?;
            if b.read(1)? == 1 {
                b.uvlc()?;
            }
            decoder_model = b.read(1)?;
            if decoder_model == 1 {
                buffer_delay_bits = b.read(5)? + 1;
                b.read(32)?;
                b.read(5)?;
                b.read(5)?;
            }
        }
        let _display_delay = b.read(1)?;
        let _points = b.read(5)?;
        // Operating point 0 is the whole stream.
        b.read(12)?;
        level = b.read(5)?;
        tier = if level > 7 { b.read(1)? } else { 0 };
        let _ = (decoder_model, buffer_delay_bits);
    }
    let mut c = vec![0x81, ((profile << 5) | level) as u8, ((tier << 7) as u8) | 0b0000_1100, 0];
    c.extend_from_slice(obu);
    Some(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temporal delimiter, a sequence header (profile 0, level 8 = 4.0,
    /// no timing info) and a frame OBU.
    fn temporal_unit() -> Vec<u8> {
        // seq_profile 000, still 0, reduced 0, timing 0, display delay 0,
        // points 00000, idc 000000000000, level 01000 -> then padding.
        // Bits: 000 0 0 0 0 00000 000000000000 01000 = 32 bits.
        let payload = [0b0000_0000u8, 0b0000_0000, 0b0000_0000, 0b0100_0000, 0xAA];
        let mut tu = vec![0x12, 0x00];
        tu.extend_from_slice(&[0x0A, payload.len() as u8]);
        tu.extend_from_slice(&payload);
        tu.extend_from_slice(&[0x32, 3, 1, 2, 3]);
        tu
    }

    #[test]
    fn samples_drop_temporal_delimiters() {
        let tu = temporal_unit();
        let s = sample(&tu);
        assert_eq!(s, tu[2..].to_vec());
    }

    #[test]
    fn av1c_from_the_sequence_header() {
        let c = av1c(&temporal_unit()).unwrap();
        assert_eq!(&c[..4], &[0x81, 0x08, 0x0C, 0]);
        assert_eq!(&c[4..], &temporal_unit()[2..9]);
    }
}
