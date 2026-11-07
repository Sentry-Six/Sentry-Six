//! Telemetry straight from the frames being played. Tesla stores each
//! frame's telemetry as an SEI NAL unit in the same MP4 sample as the
//! picture, so the decoder thread picks it out of bytes it already read:
//! no second pass over the clip, and the dashboard is always in step with
//! the picture on screen.
//!
//! The protobuf decoding is in `sei.rs`.

pub use crate::sei::SeiMetadata;

/// The telemetry in one H.264 or H.265 sample (length-prefixed NAL units),
/// if any.
pub fn sample_telemetry(data: &[u8], length_size: usize, codec: crate::mp4::Codec) -> Option<SeiMetadata> {
    let mut found = None;
    let mut p = 0usize;
    while p + length_size <= data.len() {
        let mut n = 0usize;
        for k in 0..length_size {
            n = (n << 8) | data[p + k] as usize;
        }
        p += length_size;
        if n == 0 || p + n > data.len() {
            break;
        }
        let nal = &data[p..p + n];
        match codec {
            crate::mp4::Codec::H264 if nal[0] & 31 == 6 => {
                if let Some(sei) = crate::sei::decode_sei(nal) {
                    found = Some(sei);
                }
            }
            // Clips converted by earlier versions of Sentry Studio keep the
            // Tesla message in an H.265 prefix SEI (type 39) tagged
            // "Sentry-Six-Tesla".
            crate::mp4::Codec::H265 if (nal[0] >> 1) & 0x3f == 39 => {
                if let Some(sei) = converted_sei(nal) {
                    found = Some(sei);
                }
            }
            _ => {}
        }
        p += n;
    }
    found
}

/// The Tesla SEI inside a converted clip's H.265 prefix SEI: payload type
/// 5 (user data unregistered) starting "Sentry-Six-Tesla", then the
/// original H.264 SEI NAL, as the footage converter in earlier versions
/// of Sentry Studio wrote it.
fn converted_sei(nal: &[u8]) -> Option<SeiMetadata> {
    const TAG: &[u8] = b"Sentry-Six-Tesla";
    let rbsp = crate::sei::strip_emulation(nal.get(2..)?);
    let mut p = 0usize;
    let mut field = || -> Option<usize> {
        let mut v = 0usize;
        loop {
            let b = *rbsp.get(p)?;
            p += 1;
            v += b as usize;
            if b != 0xff {
                return Some(v);
            }
        }
    };
    let kind = field()?;
    let size = field()?;
    if kind != 5 {
        return None;
    }
    let payload = rbsp.get(p..p + size)?;
    let inner = payload.strip_prefix(TAG)?;
    crate::sei::decode_sei(inner)
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A Tesla H.264 SEI NAL carrying a speed of 12.5 m/s.
    fn tesla_sei() -> Vec<u8> {
        let mut pb = vec![0x25]; // field 4 (speed), 32-bit float
        pb.extend_from_slice(&12.5f32.to_le_bytes());
        let mut payload = vec![0x42, 0x42, 0x42, 0x69];
        payload.extend_from_slice(&pb);
        let mut nal = vec![0x06, 5, payload.len() as u8];
        nal.extend_from_slice(&payload);
        nal.push(0x80);
        nal
    }

    #[test]
    fn telemetry_from_converted_h265() {
        let h264 = tesla_sei();
        assert_eq!(crate::sei::decode_sei(&h264).map(|m| m.vehicle_speed_mps), Some(12.5));
        // A converted clip: an H.265 prefix SEI (4e 01), user data
        // unregistered (type 5) starting "Sentry-Six-Tesla", then the H.264 SEI.
        let mut user_data = b"Sentry-Six-Tesla".to_vec();
        user_data.extend_from_slice(&h264);
        let mut nal = vec![0x4e, 0x01, 5, user_data.len() as u8];
        nal.extend_from_slice(&user_data);
        nal.push(0x80);
        let mut sample = (nal.len() as u32).to_be_bytes().to_vec();
        sample.extend_from_slice(&nal);
        let sei = sample_telemetry(&sample, 4, crate::mp4::Codec::H265).expect("telemetry");
        assert_eq!(sei.vehicle_speed_mps, 12.5);
        // Without the tag it is someone else's data.
        let mut other = nal.clone();
        other[4] = b'X';
        let mut sample = (other.len() as u32).to_be_bytes().to_vec();
        sample.extend_from_slice(&other);
        assert!(sample_telemetry(&sample, 4, crate::mp4::Codec::H265).is_none());
    }

    #[test]
    fn no_sei_in_a_plain_sample() {
        // One 5-byte non-SEI NAL (type 1) with a 4-byte length prefix.
        let sample = [0, 0, 0, 5, 0x41, 1, 2, 3, 4];
        assert!(sample_telemetry(&sample, 4, crate::mp4::Codec::H264).is_none());
        // Truncated length prefix: stops without panicking.
        assert!(sample_telemetry(&[0, 0, 9, 9, 0x06], 4, crate::mp4::Codec::H264).is_none());
    }
}
