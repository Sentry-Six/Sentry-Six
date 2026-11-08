//! Hardware video decoding through each OS's own decoder: VideoToolbox on
//! macOS, Media Foundation on Windows, GStreamer on Linux (VA-API, NVDEC
//! or software, whichever the machine has).
//!
//! A `Decoder` turns one coded H.264 or H.265 frame (length-prefixed NAL
//! units, as stored in MP4) into a `Frame`: an NV12 picture (a full-size Y plane and
//! a half-size interleaved CbCr plane) the renderer uploads to the GPU.

#[cfg(target_os = "macos")]
mod videotoolbox;
#[cfg(target_os = "macos")]
pub use videotoolbox::{Decoder, Frame};

#[cfg(target_os = "windows")]
mod media_foundation;
#[cfg(target_os = "windows")]
pub use media_foundation::{Decoder, Frame};

// Built on every Unix so macOS can test it (--gst-check); Linux plays with it.
#[cfg(unix)]
pub mod gstreamer;
#[cfg(target_os = "linux")]
pub use gstreamer::{Decoder, Frame};

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub use unsupported::{Decoder, Frame};

/// One plane of a decoded picture, borrowed while the frame is locked.
pub struct Plane<'a> {
    pub data: &'a [u8],
    pub stride: usize,
    pub width: u32,
    pub height: u32,
}

/// Largest picture width the decoder outputs; wider clips are scaled down.
/// Every Tesla camera fits (the HW4 front camera is 2896 px), so footage
/// plays at full resolution; this only guards against unusually huge files.
pub const MAX_OUTPUT_WIDTH: u32 = 4096;

/// The track's parameter sets (VPS, SPS, PPS), each with a start code.
pub(crate) fn parameter_sets(track: &crate::mp4::VideoTrack) -> Vec<u8> {
    let mut out = Vec::new();
    for set in track.vps.iter().chain(track.sps.iter()).chain(track.pps.iter()) {
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(set);
    }
    out
}

/// A sample as Annex B: start codes instead of length prefixes, with the
/// parameter sets in front of a keyframe (so a seek to any keyframe
/// decodes on its own). For decoders that want a byte stream.
pub(crate) fn annex_b(data: &[u8], nal_length_size: usize, codec: crate::mp4::Codec, parameter_sets: &[u8]) -> anyhow::Result<Vec<u8>> {
    use anyhow::Context;
    let n = nal_length_size;
    let mut body = Vec::with_capacity(data.len() + 16);
    let mut keyframe = false;
    let mut pos = 0;
    while pos + n <= data.len() {
        let len = data[pos..pos + n].iter().fold(0usize, |a, &b| (a << 8) | b as usize);
        pos += n;
        let end = pos.checked_add(len).filter(|&e| e <= data.len()).context("a frame's data is cut short")?;
        // An IDR picture (H.264 type 5; H.265 IRAP types 16-21).
        if len > 0 {
            keyframe |= match codec {
                crate::mp4::Codec::H264 => data[pos] & 0x1f == 5,
                crate::mp4::Codec::H265 => (16..=21).contains(&((data[pos] >> 1) & 0x3f)),
            };
        }
        body.extend_from_slice(&[0, 0, 0, 1]);
        body.extend_from_slice(&data[pos..end]);
        pos = end;
    }
    if !keyframe {
        return Ok(body);
    }
    let mut out = Vec::with_capacity(parameter_sets.len() + body.len());
    out.extend_from_slice(parameter_sets);
    out.extend_from_slice(&body);
    Ok(out)
}

/// Halves a packed NV12 picture (each output sample is the average of a
/// 2x2 block), keeping both sizes even.
pub(crate) fn half_nv12(src: &[u8], w: usize, h: usize) -> (Vec<u8>, u32, u32) {
    let (w2, h2) = ((w / 2) & !1, (h / 2) & !1);
    let mut out = vec![0u8; w2 * h2 + w2 * h2 / 2];
    let avg = |a: u8, b: u8, c: u8, d: u8| ((a as u16 + b as u16 + c as u16 + d as u16 + 2) / 4) as u8;
    for y in 0..h2 {
        let (r0, r1) = (&src[2 * y * w..], &src[(2 * y + 1) * w..]);
        for x in 0..w2 {
            out[y * w2 + x] = avg(r0[2 * x], r0[2 * x + 1], r1[2 * x], r1[2 * x + 1]);
        }
    }
    // CbCr: rows of w bytes (w / 2 pairs) in, rows of w2 bytes out.
    let uv_in = &src[w * h..];
    let uv_out = w2 * h2;
    for y in 0..h2 / 2 {
        let (r0, r1) = (&uv_in[2 * y * w..], &uv_in[(2 * y + 1) * w..]);
        for p in 0..w2 / 2 {
            for c in 0..2 {
                let (a, b) = (4 * p + c, 4 * p + 2 + c);
                out[uv_out + y * w2 + 2 * p + c] = avg(r0[a], r0[b], r1[a], r1[b]);
            }
        }
    }
    (out, w2 as u32, h2 as u32)
}

#[cfg(test)]
mod tests {
    use super::half_nv12;

    #[test]
    fn halves_nv12_by_averaging() {
        let (w, h) = (4, 4);
        let mut src: Vec<u8> = (0..16).map(|i| (i * 10) as u8).collect();
        src.extend_from_slice(&[100, 50, 110, 60, 120, 70, 130, 80]);
        let (out, w2, h2) = half_nv12(&src, w, h);
        assert_eq!((w2, h2), (2, 2));
        // Y: top-left block 0,10,40,50 -> 25; top-right 20,30,60,70 -> 45.
        assert_eq!(&out[..4], &[25, 45, 105, 125]);
        // CbCr: one pair from the 2x2 pairs block: Cb (100,110,120,130), Cr (50,60,70,80).
        assert_eq!(&out[4..], &[115, 65]);
    }
}
