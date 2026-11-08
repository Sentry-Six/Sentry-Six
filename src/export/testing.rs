//! Test helpers: stand-in camera clips made with the hardware encoder
//! (there is no footage in the repository).

use crate::export::encode::{EncodeSettings, Encoder};
use crate::export::mp4_writer::Mp4Writer;
use crate::export::encode::Format;
use std::path::Path;

/// A Tesla telemetry SEI NAL unit (as the car writes it) for `m`.
pub fn sei_nal(m: &crate::sei::SeiMetadata) -> Vec<u8> {
    let mut pb = Vec::new();
    let varint = |pb: &mut Vec<u8>, mut v: u64| loop {
        if v < 0x80 {
            pb.push(v as u8);
            break;
        }
        pb.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    };
    let tag = |pb: &mut Vec<u8>, field: u64, wire: u64| varint(pb, field << 3 | wire);
    for (f, v) in [(1, m.version as u64), (2, m.gear_state as u64), (3, m.frame_seq_no as u64), (7, m.blinker_on_left as u64), (8, m.blinker_on_right as u64), (9, m.brake_applied as u64), (10, m.autopilot_state as u64)] {
        tag(&mut pb, f, 0);
        varint(&mut pb, v);
    }
    for (f, v) in [(4, m.vehicle_speed_mps), (5, m.accelerator_pedal_position), (6, m.steering_wheel_angle)] {
        tag(&mut pb, f, 5);
        pb.extend_from_slice(&(v as f32).to_le_bytes());
    }
    for (f, v) in [(11, m.latitude_deg), (12, m.longitude_deg), (13, m.heading_deg)] {
        tag(&mut pb, f, 1);
        pb.extend_from_slice(&v.to_le_bytes());
    }
    // Payload: 0x42 bytes, 0x69, the protobuf.
    let mut payload = vec![0x42, 0x42, 0x42, 0x69];
    payload.extend_from_slice(&pb);
    let mut rbsp = vec![5u8];
    let mut size = payload.len();
    while size >= 255 {
        rbsp.push(255);
        size -= 255;
    }
    rbsp.push(size as u8);
    rbsp.extend_from_slice(&payload);
    // Emulation prevention, then the trailing bits.
    let mut nal = vec![0x06];
    let mut zeros = 0;
    for b in rbsp {
        if zeros >= 2 && b <= 3 {
            nal.push(3);
            zeros = 0;
        }
        nal.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    nal.push(0x80);
    nal
}

/// Writes a 36 fps H.264 clip of `n` frames; `pixel(frame, x, y)` gives
/// each BGRA pixel.
pub fn clip(path: &Path, w: usize, h: usize, n: usize, pixel: impl Fn(usize, usize, usize) -> [u8; 4]) {
    clip_with_telemetry(path, w, h, n, pixel, |_| None);
}

/// As `clip`, with telemetry in front of each frame's picture, as Tesla
/// stores it.
pub fn clip_with_telemetry(path: &Path, w: usize, h: usize, n: usize, pixel: impl Fn(usize, usize, usize) -> [u8; 4], telemetry: impl Fn(usize) -> Option<crate::sei::SeiMetadata>) {
    let settings = EncodeSettings { codec: Format::H264, width: w as u32, height: h as u32, fps: 36.0, timescale: 36_000, bitrate: 12_000_000, fast: true };
    let mut enc = Encoder::new(&settings).unwrap();
    let mut mp4 = Mp4Writer::create(path, w as u32, h as u32, 36_000).unwrap();
    for i in 0..n {
        let pixels: Vec<u8> = (0..w * h).flat_map(|p| pixel(i, p % w, p / w)).collect();
        let mut f = enc.frame().unwrap();
        f.fill_bgra(&pixels, w, h).unwrap();
        enc.encode(&f, i as i64 * 1000, 1000).unwrap();
        for p in enc.take() {
            let k = (p.pts / 1000) as usize;
            mp4.write_frame(&with_sei(telemetry(k), p.data), 1000, p.sync, p.pts).unwrap();
        }
    }
    let (rest, config) = enc.finish().unwrap();
    for p in rest {
        let k = (p.pts / 1000) as usize;
        mp4.write_frame(&with_sei(telemetry(k), p.data), 1000, p.sync, p.pts).unwrap();
    }
    mp4.finish(&config).unwrap();
}

fn with_sei(m: Option<crate::sei::SeiMetadata>, data: Vec<u8>) -> Vec<u8> {
    let Some(m) = m else { return data };
    let nal = sei_nal(&m);
    let mut out = (nal.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&nal);
    out.extend_from_slice(&data);
    out
}

#[test]
fn sei_round_trips() {
    let m = crate::sei::SeiMetadata { version: 1, gear_state: 1, vehicle_speed_mps: 26.8, accelerator_pedal_position: 0.42, steering_wheel_angle: -12.5, blinker_on_left: true, autopilot_state: 2, latitude_deg: 49.25, longitude_deg: -123.1, heading_deg: 90.0, ..Default::default() };
    let got = crate::sei::decode_sei(&sei_nal(&m)).unwrap();
    assert_eq!(got.gear_state, 1);
    assert!((got.vehicle_speed_mps - 26.8).abs() < 1e-4 && (got.steering_wheel_angle + 12.5).abs() < 1e-4);
    assert!(got.blinker_on_left && !got.blinker_on_right && got.autopilot_state == 2);
    assert_eq!((got.latitude_deg, got.longitude_deg), (49.25, -123.1));
}
