//! macOS: decoded pictures shown without copying. VideoToolbox decodes
//! into IOSurface-backed pixel buffers; CVMetalTextureCache makes Metal
//! textures that share that memory (the Y plane as R8, CbCr as RG8), and
//! wgpu takes them through its Metal backend. Browsers do the same; it uses
//! less CPU than copying each picture.
//!
//! The pixel buffer and its CoreVideo textures are kept for a few frames
//! after they are replaced: the decoder's buffer pool must not reuse the
//! memory while the GPU may still be reading it.

use crate::decode::Frame;
use metal::foreign_types::ForeignTypeRef;
use iced::wgpu;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_core_foundation::CFRetained;
use objc2_core_video::{
    kCVReturnSuccess, CVMetalTexture, CVMetalTextureCache, CVMetalTextureGetTexture, CVPixelBufferGetHeightOfPlane,
    CVPixelBufferGetWidthOfPlane,
};
use objc2_metal::{MTLDevice, MTLPixelFormat};
use std::ptr::NonNull;
use std::sync::Arc;

type Metal = wgpu::hal::api::Metal;

pub struct Cache(CFRetained<CVMetalTextureCache>);

// The cache is only used from the render thread; CoreVideo objects may be
// passed between threads.
unsafe impl Send for Cache {}
unsafe impl Sync for Cache {}

/// One picture's planes as wgpu textures, and what must outlive them.
pub struct Imported {
    pub y: wgpu::Texture,
    pub uv: wgpu::Texture,
    _planes: [CFRetained<CVMetalTexture>; 2],
    _frame: Arc<Frame>,
}

unsafe impl Send for Imported {}
unsafe impl Sync for Imported {}

impl Cache {
    /// None if the Metal texture cache can't be made (then each picture is
    /// copied instead).
    pub fn new(device: &wgpu::Device) -> Option<Self> {
        // SAFETY: the hal device is only read here, to get the MTLDevice
        // wgpu renders with.
        let hal = unsafe { device.as_hal::<Metal>() }?;
        let raw = hal.raw_device().lock();
        let ptr = metal::foreign_types::ForeignType::as_ptr(&*raw) as *const ProtocolObject<dyn MTLDevice>;
        // SAFETY: metal::Device wraps an id<MTLDevice>, alive while `raw` is.
        let mtl_device = unsafe { &*ptr };
        let mut out: *mut CVMetalTextureCache = std::ptr::null_mut();
        // SAFETY: valid device and out pointer.
        let status = unsafe { CVMetalTextureCache::create(None, None, mtl_device, None, NonNull::from(&mut out)) };
        if status != kCVReturnSuccess {
            return None;
        }
        // SAFETY: created with a +1 retain count.
        Some(Self(unsafe { CFRetained::from_raw(NonNull::new(out)?) }))
    }

    /// The picture's two planes as textures, or None (then it is copied).
    pub fn import(&self, device: &wgpu::Device, frame: &Arc<Frame>) -> Option<Imported> {
        let (y, y_cv) = self.plane(device, frame, 0, MTLPixelFormat::R8Unorm, wgpu::TextureFormat::R8Unorm)?;
        let (uv, uv_cv) = self.plane(device, frame, 1, MTLPixelFormat::RG8Unorm, wgpu::TextureFormat::Rg8Unorm)?;
        Some(Imported { y, uv, _planes: [y_cv, uv_cv], _frame: frame.clone() })
    }

    fn plane(
        &self,
        device: &wgpu::Device,
        frame: &Frame,
        index: usize,
        mtl_format: MTLPixelFormat,
        format: wgpu::TextureFormat,
    ) -> Option<(wgpu::Texture, CFRetained<CVMetalTexture>)> {
        let buffer = frame.pixel_buffer();
        let width = CVPixelBufferGetWidthOfPlane(buffer, index);
        let height = CVPixelBufferGetHeightOfPlane(buffer, index);
        if width == 0 || height == 0 {
            return None;
        }
        let mut out: *mut CVMetalTexture = std::ptr::null_mut();
        // SAFETY: a valid cache, picture and out pointer.
        let status = unsafe {
            CVMetalTextureCache::create_texture_from_image(
                None,
                &self.0,
                buffer,
                None,
                mtl_format,
                width,
                height,
                index,
                NonNull::from(&mut out),
            )
        };
        if status != kCVReturnSuccess {
            return None;
        }
        // SAFETY: created with a +1 retain count.
        let cv_texture = unsafe { CFRetained::from_raw(NonNull::new(out)?) };
        let mtl: Retained<ProtocolObject<dyn objc2_metal::MTLTexture>> = CVMetalTextureGetTexture(&cv_texture)?;
        // SAFETY: the same id<MTLTexture>; to_owned takes its own retain.
        let raw = unsafe { metal::TextureRef::from_ptr(Retained::as_ptr(&mtl) as *mut metal::MTLTexture) }.to_owned();
        let (w, h) = (width as u32, height as u32);
        // SAFETY: a 2D, single-layer, single-mip texture of this format and size.
        let hal_texture = unsafe {
            wgpu::hal::metal::Device::texture_from_raw(
                raw,
                format,
                metal::MTLTextureType::D2,
                1,
                1,
                wgpu::hal::CopyExtent { width: w, height: h, depth: 1 },
            )
        };
        let texture = unsafe {
            device.create_texture_from_hal::<Metal>(
                hal_texture,
                &wgpu::TextureDescriptor {
                    label: Some("video plane (decoder)"),
                    size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
            )
        };
        Some((texture, cv_texture))
    }
}
