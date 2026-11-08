//! Exporting on Windows: Media Foundation's Sink Writer, which picks the
//! GPU's hardware encoder (NVENC, AMD's or Intel's, through their MFTs)
//! when there is one and Microsoft's software encoder otherwise, turns
//! our BGRA frames into its NV12, and writes the MP4 itself. Its index
//! goes at the end; `fast_start` then moves it to the front.

use super::{EncodeSettings, FrameSink, Finished, Packet};
use crate::export::encode::Format;
use anyhow::{anyhow, Result};
use std::path::Path;
use windows::core::HSTRING;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

static STARTUP: std::sync::Once = std::sync::Once::new();

fn hr(e: windows::core::Error, what: &str) -> anyhow::Error {
    anyhow!("{what} (Media Foundation error {:#010x})", e.code().0 as u32)
}

/// Whether Windows has an encoder for `format`: a GPU one, or Microsoft's
/// own in software (H.264 always; HEVC with the HEVC Video Extensions).
pub fn probe(format: Format) -> super::Support {
    let subtype = match format {
        Format::H264 => MFVideoFormat_H264,
        Format::Hevc => MFVideoFormat_HEVC,
        Format::Av1 => MFVideoFormat_AV1,
    };
    let count = |flags: MFT_ENUM_FLAG| -> u32 {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            STARTUP.call_once(|| {
                let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
            });
            let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: subtype };
            let mut found: *mut Option<IMFActivate> = std::ptr::null_mut();
            let mut n = 0u32;
            if MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, None, Some(&output), &mut found, &mut n).is_err() {
                return 0;
            }
            if !found.is_null() {
                for i in 0..n as usize {
                    std::ptr::drop_in_place(found.add(i));
                }
                windows::Win32::System::Com::CoTaskMemFree(Some(found as *const core::ffi::c_void));
            }
            n
        }
    };
    if count(MFT_ENUM_FLAG(MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0)) > 0 {
        super::Support::Hardware
    } else if format != Format::Av1 && count(MFT_ENUM_FLAG(MFT_ENUM_FLAG_SYNCMFT.0 | MFT_ENUM_FLAG_ASYNCMFT.0 | MFT_ENUM_FLAG_SORTANDFILTER.0)) > 0 {
        super::Support::Software
    } else {
        super::Support::No
    }
}

pub struct Encoder {
    writer: IMFSinkWriter,
    stream: u32,
    width: u32,
    height: u32,
    timescale: u32,
}

impl Encoder {
    pub fn new(s: &EncodeSettings, output: &Path) -> Result<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            STARTUP.call_once(|| {
                let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
            });
        }
        let pair = |a: u32, b: u32| ((a as u64) << 32) | b as u64;
        let fps = s.fps.round() as u32;
        unsafe {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 4).map_err(|e| hr(e, "Media Foundation is not available"))?;
            let attrs = attrs.ok_or_else(|| anyhow!("Media Foundation is not available"))?;
            attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
            attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
            attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)?;
            let url = HSTRING::from(output.as_os_str());
            let writer = MFCreateSinkWriterFromURL(&url, None, &attrs).map_err(|e| hr(e, "could not start writing the video"))?;

            // What to write: H.264 (High) or HEVC, BT.709, video range.
            let out = MFCreateMediaType()?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out.SetGUID(
                &MF_MT_SUBTYPE,
                match s.codec {
                    Format::H264 => &MFVideoFormat_H264,
                    Format::Hevc => &MFVideoFormat_HEVC,
                    Format::Av1 => &MFVideoFormat_AV1,
                },
            )?;
            out.SetUINT32(&MF_MT_AVG_BITRATE, s.bitrate.min(u32::MAX as u64) as u32)?;
            out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, pair(s.width, s.height))?;
            out.SetUINT64(&MF_MT_FRAME_RATE, pair(fps, 1))?;
            out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pair(1, 1))?;
            if s.codec == Format::H264 {
                out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            }
            out.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
            out.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
            out.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            out.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
            let stream = writer.AddStream(&out).map_err(|e| match s.codec {
                Format::H264 => hr(e, "no H.264 encoder for this size"),
                Format::Hevc => hr(e, "no HEVC encoder for this size (it needs Microsoft's HEVC Video Extensions or a GPU that encodes HEVC)"),
                Format::Av1 => hr(e, "no AV1 encoder for this size (it needs a GPU that encodes AV1: NVIDIA RTX 40, AMD RX 7000, Intel Arc or newer)"),
            })?;

            // What we hand over: BGRA (RGB32), top row first.
            let input = MFCreateMediaType()?;
            input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
            input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            input.SetUINT64(&MF_MT_FRAME_SIZE, pair(s.width, s.height))?;
            input.SetUINT64(&MF_MT_FRAME_RATE, pair(fps, 1))?;
            input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pair(1, 1))?;
            input.SetUINT32(&MF_MT_DEFAULT_STRIDE, s.width * 4)?;
            input.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
            input.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
            writer.SetInputMediaType(stream, &input, None).map_err(|e| hr(e, "the encoder won't take our frames"))?;

            writer.BeginWriting().map_err(|e| hr(e, "could not start encoding"))?;
            log::info!("export: Media Foundation {:?} encoder (hardware when the GPU has one)", s.codec);
            Ok(Encoder { writer, stream, width: s.width, height: s.height, timescale: s.timescale })
        }
    }
}

impl FrameSink for Encoder {
    fn name(&self) -> String {
        "Media Foundation".into()
    }

    fn writes_file(&self) -> bool {
        true
    }

    fn push_bgra(&mut self, bgra: &[u8], pts: i64, duration: i64) -> Result<()> {
        let size = self.width as usize * self.height as usize * 4;
        if bgra.len() < size {
            return Err(anyhow!("a frame was {} bytes, not {size}", bgra.len()));
        }
        // 100 ns units.
        let to_hns = |t: i64| (t as i128 * 10_000_000 / self.timescale as i128) as i64;
        unsafe {
            let buffer = MFCreateMemoryBuffer(size as u32)?;
            let mut ptr = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(bgra.as_ptr(), ptr, size);
            buffer.Unlock()?;
            buffer.SetCurrentLength(size as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(to_hns(pts))?;
            sample.SetSampleDuration(to_hns(duration))?;
            self.writer.WriteSample(self.stream, &sample).map_err(|e| hr(e, "the encoder stopped"))?;
        }
        Ok(())
    }

    fn take(&mut self) -> Vec<Packet> {
        Vec::new()
    }

    fn finish(self: Box<Self>) -> Result<Finished> {
        unsafe { self.writer.Finalize() }.map_err(|e| hr(e, "could not finish the video"))?;
        Ok(Finished::File)
    }
}
