//! The export compositor: each camera's decoded picture drawn into its
//! place in the output frame on the GPU, with playback's colour conversion
//! (BT.709) and smooth downscaling, so an export looks like the app.
//!
//! It has a GPU device of its own (not the window's), so an export runs
//! beside playback. On macOS nothing is copied: decoded pictures are
//! imported as textures (as for playback) and the output is drawn straight
//! into the encoder's IOSurface-backed frame.

use anyhow::{anyhow, Result};
use iced::wgpu;

/// Where a picture goes in the output frame, in pixels.
#[derive(Debug, Clone, Copy)]
pub struct Placement {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Flipped left to right (rear and repeater cameras, as in the mirrors).
    pub mirror: bool,
}

const SHADER: &str = r#"
struct U { mirror: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex_y: texture_2d<f32>;
@group(0) @binding(2) var tex_uv: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
    var corners = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
    let c = corners[i];
    var o: VOut;
    o.pos = vec4<f32>(c, 0.0, 1.0);
    var x = (c.x + 1.0) * 0.5;
    if (u.mirror > 0.5) { x = 1.0 - x; }
    o.uv = vec2<f32>(x, (1.0 - c.y) * 0.5);
    return o;
}

fn sample_one(uv: vec2<f32>) -> vec3<f32> {
    return vec3<f32>(textureSampleLevel(tex_y, samp, uv, 0.0).r, textureSampleLevel(tex_uv, samp, uv, 0.0).rg);
}

// As playback: when the picture is drawn smaller than its size, average up
// to 4x4 bilinear samples over the pixels under this one.
fn sample_yc(uv: vec2<f32>, fp: vec2<f32>) -> vec3<f32> {
    let n = clamp(ceil(fp * 0.5), vec2<f32>(1.0), vec2<f32>(4.0));
    if (n.x * n.y <= 1.0) { return sample_one(uv); }
    let step = fp / n / vec2<f32>(textureDimensions(tex_y));
    var acc = vec3<f32>(0.0);
    for (var j: i32 = 0; j < 4; j = j + 1) {
        if (f32(j) >= n.y) { break; }
        for (var k: i32 = 0; k < 4; k = k + 1) {
            if (f32(k) >= n.x) { break; }
            let off = (vec2<f32>(f32(k), f32(j)) - (n - vec2<f32>(1.0)) * 0.5) * step;
            acc = acc + sample_one(clamp(uv + off, vec2<f32>(0.0), vec2<f32>(1.0)));
        }
    }
    return acc / (n.x * n.y);
}

// BT.709 limited range to gamma-encoded RGB.
fn to_rgb(yc: vec3<f32>) -> vec3<f32> {
    let y = (yc.x - 16.0 / 255.0) * (255.0 / 219.0);
    let c = (yc.yz - vec2<f32>(128.0 / 255.0)) * (255.0 / 224.0);
    return clamp(vec3<f32>(y + 1.5748 * c.y, y - 0.187324 * c.x - 0.468124 * c.y, y + 1.8556 * c.x), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs(i: VOut) -> @location(0) vec4<f32> {
    let fp = (abs(dpdx(i.uv)) + abs(dpdy(i.uv))) * vec2<f32>(textureDimensions(tex_y));
    return vec4<f32>(to_rgb(sample_yc(i.uv, fp)), 1.0);
}
"#;

/// An overlay picture on the GPU (see overlay.rs), drawn over the cameras.
pub struct Overlay {
    texture: wgpu::Texture,
    group: wgpu::BindGroup,
    pub width: u32,
    pub height: u32,
}

// Overlays: premultiplied RGBA, drawn 1:1 and blended over the cameras.
const OVERLAY_SHADER: &str = r#"
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
    var corners = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
    let c = corners[i];
    var o: VOut;
    o.pos = vec4<f32>(c, 0.0, 1.0);
    o.uv = vec2<f32>((c.x + 1.0) * 0.5, (1.0 - c.y) * 0.5);
    return o;
}
@fragment
fn fs(i: VOut) -> @location(0) vec4<f32> {
    return textureSampleLevel(tex, samp, i.uv, 0.0);
}
"#;

// Blur zones: the camera drawn on its own (`scratch`), then into the frame
// blurred where the mask is set and sharp elsewhere. 9 x 9 samples over
// about 48 px: as strong as earlier versions' boxblur=10:10.
const BLUR_SHADER: &str = r#"
struct B { step: vec2<f32>, frost: vec2<f32>, saturate: vec4<f32> };
@group(0) @binding(0) var scratch: texture_2d<f32>;
@group(0) @binding(1) var mask: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> b: B;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
    var corners = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
    let c = corners[i];
    var o: VOut;
    o.pos = vec4<f32>(c, 0.0, 1.0);
    o.uv = vec2<f32>((c.x + 1.0) * 0.5, (1.0 - c.y) * 0.5);
    return o;
}
fn spread(uv: vec2<f32>, step: vec2<f32>) -> vec4<f32> {
    var acc = vec4<f32>(0.0);
    for (var j: i32 = -4; j <= 4; j = j + 1) {
        for (var k: i32 = -4; k <= 4; k = k + 1) {
            acc = acc + textureSampleLevel(scratch, samp, clamp(uv + vec2<f32>(f32(k), f32(j)) * step, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
        }
    }
    return acc / 81.0;
}
// r: blur zones (privacy). g: frosted glass under the dashboard, blurred
// less and saturated, as playback's backdrop-filter.
@fragment
fn fs(i: VOut) -> @location(0) vec4<f32> {
    let m = textureSampleLevel(mask, samp, i.uv, 0.0).rg;
    let sharp = textureSampleLevel(scratch, samp, i.uv, 0.0);
    if (m.r <= 0.0 && m.g <= 0.0) { return sharp; }
    var out = sharp;
    if (m.g > 0.0) {
        let f = spread(i.uv, b.frost);
        let luma = dot(f.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        let vivid = clamp(mix(vec3<f32>(luma), f.rgb, b.saturate.x), vec3<f32>(0.0), vec3<f32>(1.0));
        out = mix(out, vec4<f32>(vivid, f.a), m.g);
    }
    if (m.r > 0.0) {
        out = mix(out, spread(i.uv, b.step), m.r);
    }
    return out;
}
"#;

/// A camera's blur zones on the GPU: the mask, and the picture the camera
/// is drawn into before being blurred into the frame.
pub struct BlurMask {
    scratch: wgpu::TextureView,
    group: wgpu::BindGroup,
    pub width: u32,
    pub height: u32,
}

pub struct Compositor {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    overlay_pipeline: wgpu::RenderPipeline,
    overlay_layout: wgpu::BindGroupLayout,
    nearest: wgpu::Sampler,
    blur_pipeline: wgpu::RenderPipeline,
    blur_layout: wgpu::BindGroupLayout,
    #[cfg(target_os = "macos")]
    cache: crate::video::metal_import::Cache,
    /// macOS: upload pictures from memory instead of importing them (to
    /// try the other systems' path here).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    upload_only: bool,
    uploads: std::sync::Mutex<Vec<Option<Upload>>>,
    readback: std::sync::Mutex<Option<Readback>>,
}

impl Compositor {
    pub fn new() -> Result<Self> {
        let backends = if cfg!(target_os = "macos") { wgpu::Backends::METAL } else { wgpu::Backends::PRIMARY };
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor { backends, ..Default::default() });
        let adapter = iced::futures::executor::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .map_err(|e| anyhow!("no GPU for exporting: {e}"))?;
        let (device, queue) = iced::futures::executor::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("export"), ..Default::default() }))
            .map_err(|e| anyhow!("could not start the GPU for exporting: {e}"))?;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("export compositor"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let texture = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("export compositor"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                texture(1),
                texture(2),
                wgpu::BindGroupLayoutEntry { binding: 3, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("export compositor"), bind_group_layouts: &[&layout], push_constant_ranges: &[] });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("export compositor"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Bgra8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let overlay_module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("export overlay"), source: wgpu::ShaderSource::Wgsl(OVERLAY_SHADER.into()) });
        let overlay_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("export overlay"),
            entries: &[
                texture(0),
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let overlay_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("export overlay"), bind_group_layouts: &[&overlay_layout], push_constant_ranges: &[] });
        let overlay_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("export overlay"),
            layout: Some(&overlay_pipeline_layout),
            vertex: wgpu::VertexState { module: &overlay_module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &overlay_module,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Bgra8Unorm,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        let nearest = device.create_sampler(&wgpu::SamplerDescriptor::default());
        let blur_module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("export blur"), source: wgpu::ShaderSource::Wgsl(BLUR_SHADER.into()) });
        let blur_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("export blur"),
            entries: &[
                texture(0),
                texture(1),
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
            ],
        });
        let blur_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("export blur"), bind_group_layouts: &[&blur_layout], push_constant_ranges: &[] });
        let blur_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("export blur"),
            layout: Some(&blur_pipeline_layout),
            vertex: wgpu::VertexState { module: &blur_module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &blur_module,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Bgra8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        #[cfg(target_os = "macos")]
        let cache = crate::video::metal_import::Cache::new(&device).ok_or_else(|| anyhow!("could not share video memory with the GPU"))?;
        Ok(Compositor {
            device,
            queue,
            pipeline,
            layout,
            sampler,
            overlay_pipeline,
            overlay_layout,
            nearest,
            blur_pipeline,
            blur_layout,
            #[cfg(target_os = "macos")]
            cache,
            upload_only: std::env::var_os("SENTRY_EXPORT_PORTABLE").is_some(),
            uploads: Default::default(),
            readback: Default::default(),
        })
    }

    /// Puts an overlay picture on the GPU, reusing `old`'s texture when the
    /// size is the same.
    pub fn overlay(&self, picture: &super::overlay::Picture, old: Option<Overlay>) -> Overlay {
        let (w, h) = (picture.width.max(1), picture.height.max(1));
        let reuse = old.filter(|o| o.width == w && o.height == h);
        let overlay = reuse.unwrap_or_else(|| {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("export overlay"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("export overlay"),
                layout: &self.overlay_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.nearest) },
                ],
            });
            Overlay { texture, group, width: w, height: h }
        });
        if picture.rgba.len() as u64 == w as u64 * h as u64 * 4 {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &overlay.texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                &picture.rgba,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) },
                wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            );
        }
        overlay
    }

    /// A camera's blur zones: `mask` (one byte a pixel, 255 inside a zone)
    /// at the camera's size in the frame.
    /// A camera's mask for blurring: `privacy` (blur zones) and `frost`
    /// (glass under the dashboard, with its blur's standard deviation in
    /// the camera's pixels), one byte a pixel each; either may be empty.
    pub fn blur_mask(&self, width: u32, height: u32, privacy: &[u8], frost: &[u8], frost_sigma: f32) -> BlurMask {
        let n = width.max(1) as usize * height.max(1) as usize;
        let mut mask = vec![0u8; n * 2];
        for (i, v) in privacy.iter().take(n).enumerate() {
            mask[i * 2] = *v;
        }
        for (i, v) in frost.iter().take(n).enumerate() {
            mask[i * 2 + 1] = *v;
        }
        let (width, height) = (width.max(1), height.max(1));
        let texture = |label, format, usage| {
            self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage,
                view_formats: &[],
            })
        };
        let mask_tex = texture("export blur mask", wgpu::TextureFormat::Rg8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
        if mask.len() as u64 == width as u64 * height as u64 * 2 {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &mask_tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                &mask,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 2), rows_per_image: Some(height) },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
        }
        let scratch_tex = texture("export blur scratch", wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT);
        let scratch = scratch_tex.create_view(&Default::default());
        let mask_view = mask_tex.create_view(&Default::default());
        // Blur zones: samples 6 px apart, in the camera's pixels. Glass: a
        // 9-tap box as wide as a Gaussian of that deviation (3.46 sigma),
        // and playback's 185% saturation.
        let frost_px = (frost_sigma * 3.46 / 9.0).max(0.5);
        let step = [6.0 / width as f32, 6.0 / height as f32, frost_px / width as f32, frost_px / height as f32, 1.85, 0.0, 0.0, 0.0];
        let uniform = wgpu::util::DeviceExt::create_buffer_init(
            &self.device,
            &wgpu::util::BufferInitDescriptor { label: Some("export blur"), contents: bytemuck::cast_slice(&step), usage: wgpu::BufferUsages::UNIFORM },
        );
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("export blur"),
            layout: &self.blur_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&scratch) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&mask_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: uniform.as_entire_binding() },
            ],
        });
        BlurMask { scratch, group, width, height }
    }

    /// Draws the pictures into an encoder frame and waits for the GPU, so
    /// the frame can be encoded straight after.
    #[cfg(target_os = "macos")]
    pub fn draw_into(&self, target: &super::encode::Frame, pictures: &[(std::sync::Arc<crate::decode::Frame>, Placement)]) -> Result<()> {
        self.draw_with_overlays(target, pictures, &[])
    }

    /// As `draw_into`, then each overlay at its top-left corner (pixels).
    #[cfg(target_os = "macos")]
    pub fn draw_with_overlays(&self, target: &super::encode::Frame, pictures: &[(std::sync::Arc<crate::decode::Frame>, Placement)], overlays: &[(&Overlay, f32, f32)]) -> Result<()> {
        self.draw_frame(target, pictures, &[], overlays)
    }

    /// The whole frame, drawn straight into the encoder's frame (no copies):
    /// the pictures (those listed in `blurs` through their blur zones),
    /// then the overlays.
    #[cfg(target_os = "macos")]
    pub fn draw_frame(
        &self,
        target: &super::encode::Frame,
        pictures: &[(std::sync::Arc<crate::decode::Frame>, Placement)],
        blurs: &[(usize, &BlurMask)],
        overlays: &[(&Overlay, f32, f32)],
    ) -> Result<()> {
        let (texture, _cv) = self.cache.import_target(&self.device, target.pixel_buffer()).ok_or_else(|| anyhow!("could not draw into the encoder's frame"))?;
        let view = texture.create_view(&Default::default());
        let (pictures_on_gpu, keep) = self.pictures(pictures);
        let size = (texture.width() as f32, texture.height() as f32);
        let encoder = self.render(&view, size, &pictures_on_gpu, blurs, overlays);
        self.queue.submit([encoder.finish()]);
        self.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| anyhow!("the GPU stopped: {e}"))?;
        drop(keep);
        Ok(())
    }

    /// The whole frame as BGRA bytes (`width * 4` a row), for encoders that
    /// take frames from memory: drawn into a picture of our own and read
    /// back. Pictures are uploaded from memory unless they can be imported.
    pub fn draw_to_bytes(
        &self,
        width: u32,
        height: u32,
        pictures: &[(std::sync::Arc<crate::decode::Frame>, Placement)],
        blurs: &[(usize, &BlurMask)],
        overlays: &[(&Overlay, f32, f32)],
        out: &mut Vec<u8>,
    ) -> Result<()> {
        let mut readback = self.readback.lock().unwrap_or_else(|e| e.into_inner());
        if readback.as_ref().is_none_or(|r| r.width != width || r.height != height) {
            *readback = Some(Readback::new(&self.device, width, height));
        }
        let rb = readback.as_ref().expect("made above");
        let (pictures_on_gpu, keep) = self.pictures(pictures);
        let mut encoder = self.render(&rb.view, (width as f32, height as f32), &pictures_on_gpu, blurs, overlays);
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &rb.texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &rb.buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(rb.row), rows_per_image: Some(height) } },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
        let slice = rb.buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| anyhow!("the GPU stopped: {e}"))?;
        {
            let data = slice.get_mapped_range();
            out.clear();
            out.reserve(width as usize * height as usize * 4);
            for row in data.chunks(rb.row as usize).take(height as usize) {
                out.extend_from_slice(&row[..width as usize * 4]);
            }
        }
        rb.buffer.unmap();
        drop(keep);
        Ok(())
    }

    /// Each picture's bind group (with where it goes), and what must live
    /// until the GPU is done with them.
    fn pictures(&self, pictures: &[(std::sync::Arc<crate::decode::Frame>, Placement)]) -> (Vec<Placed>, Keep) {
        #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
        let mut keep: Keep = Vec::with_capacity(pictures.len());
        let mut groups = Vec::with_capacity(pictures.len());
        let mut uploads = self.uploads.lock().unwrap_or_else(|e| e.into_inner());
        for (index, (frame, place)) in pictures.iter().enumerate() {
            // macOS: the decoder's picture itself, unless told to upload.
            #[cfg(target_os = "macos")]
            let imported = if self.upload_only { None } else { self.cache.import(&self.device, frame) };
            #[cfg(target_os = "macos")]
            let (y, uv) = match imported {
                Some(imported) => {
                    let views = (imported.y.create_view(&Default::default()), imported.uv.create_view(&Default::default()));
                    keep.push(Box::new(imported));
                    views
                }
                None => match upload(&self.device, &self.queue, &mut uploads, index, frame) {
                    Some(v) => v,
                    None => continue,
                },
            };
            #[cfg(not(target_os = "macos"))]
            let Some((y, uv)) = upload(&self.device, &self.queue, &mut uploads, index, frame) else { continue };
            let uniform = wgpu::util::DeviceExt::create_buffer_init(
                &self.device,
                &wgpu::util::BufferInitDescriptor {
                    label: Some("export placement"),
                    contents: bytemuck::cast_slice(&[if place.mirror { 1.0f32 } else { 0.0 }, 0.0, 0.0, 0.0]),
                    usage: wgpu::BufferUsages::UNIFORM,
                },
            );
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("export picture"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&y) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&uv) },
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                ],
            });
            groups.push((index, group, *place));
        }
        (groups, keep)
    }

    /// Records the frame's drawing into `view` (`size` pixels).
    fn render(
        &self,
        view: &wgpu::TextureView,
        size: (f32, f32),
        groups: &[Placed],
        blurs: &[(usize, &BlurMask)],
        overlays: &[(&Overlay, f32, f32)],
    ) -> wgpu::CommandEncoder {
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("export frame") });
        // Cameras with blur zones first go into their own pictures.
        let blurred = |i: usize| blurs.iter().find(|(k, _)| *k == i).map(|(_, b)| *b);
        for (i, group, _) in groups {
            let Some(b) = blurred(*i) else { continue };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("export blur scratch"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &b.scratch,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..4, 0..1);
        }
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("export frame"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            for (i, group, p) in groups {
                if blurred(*i).is_some() {
                    continue;
                }
                pass.set_viewport(p.x, p.y, p.width, p.height, 0.0, 1.0);
                pass.set_bind_group(0, group, &[]);
                pass.draw(0..4, 0..1);
            }
            if !blurs.is_empty() {
                pass.set_pipeline(&self.blur_pipeline);
                for (i, _, p) in groups {
                    let Some(b) = blurred(*i) else { continue };
                    pass.set_viewport(p.x, p.y, p.width, p.height, 0.0, 1.0);
                    pass.set_bind_group(0, &b.group, &[]);
                    pass.draw(0..4, 0..1);
                }
            }
            if !overlays.is_empty() {
                let (fw, fh) = size;
                pass.set_pipeline(&self.overlay_pipeline);
                for (o, x, y) in overlays {
                    // Whole pixels, inside the frame (a viewport can't hang off it).
                    let (x, y) = (x.round().clamp(0.0, (fw - 1.0).max(0.0)), y.round().clamp(0.0, (fh - 1.0).max(0.0)));
                    let (w, h) = ((o.width as f32).min(fw - x), (o.height as f32).min(fh - y));
                    if w < 1.0 || h < 1.0 {
                        continue;
                    }
                    // A viewport cut short would squash the picture: scissor instead.
                    pass.set_viewport(x, y, o.width as f32, o.height as f32, 0.0, 1.0);
                    pass.set_scissor_rect(x as u32, y as u32, w as u32, h as u32);
                    pass.set_bind_group(0, &o.group, &[]);
                    pass.draw(0..4, 0..1);
                }
            }
        }
        encoder
    }
}

/// A picture ready to draw: its index, bind group and place.
type Placed = (usize, wgpu::BindGroup, Placement);
/// What must live until the GPU is done with a frame (imported pictures).
type Keep = Vec<Box<dyn std::any::Any>>;

/// Our own frame to draw into and read back from (`row`: bytes a row,
/// padded as the GPU copies want).
struct Readback {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    buffer: wgpu::Buffer,
    width: u32,
    height: u32,
    row: u32,
}

impl Readback {
    fn new(device: &wgpu::Device, width: u32, height: u32) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("export frame"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let row = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("export frame read back"),
            size: row as u64 * height as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Readback { texture, view, buffer, width, height, row }
    }
}

/// A picture's planes uploaded from memory into textures kept for its
/// slot (made again when its size changes).
struct Upload {
    width: u32,
    height: u32,
    y: wgpu::Texture,
    uv: wgpu::Texture,
}

fn upload(device: &wgpu::Device, queue: &wgpu::Queue, slots: &mut Vec<Option<Upload>>, index: usize, frame: &crate::decode::Frame) -> Option<(wgpu::TextureView, wgpu::TextureView)> {
    let (w, h) = (frame.width(), frame.height());
    if slots.len() <= index {
        slots.resize_with(index + 1, || None);
    }
    if slots[index].as_ref().is_none_or(|u| u.width != w || u.height != h) {
        let plane = |w: u32, h: u32, format| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some("export plane"),
                size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        };
        slots[index] = Some(Upload { width: w, height: h, y: plane(w, h, wgpu::TextureFormat::R8Unorm), uv: plane(w.div_ceil(2), h.div_ceil(2), wgpu::TextureFormat::Rg8Unorm) });
    }
    let slot = slots[index].as_ref()?;
    let write = |tex: &wgpu::Texture, data: &[u8], stride: usize, w: u32, h: u32| {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            data,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride as u32), rows_per_image: Some(h) },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
    };
    frame.with_planes(|y, uv| {
        write(&slot.y, y.data, y.stride, y.width.min(w), y.height.min(h));
        write(&slot.uv, uv.data, uv.stride, uv.width.min(w.div_ceil(2)), uv.height.min(h.div_ceil(2)));
    })?;
    Some((slot.y.create_view(&Default::default()), slot.uv.create_view(&Default::default())))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Grey through decode, the compositor and back out of the encoder's
    /// frame: the BGRA drawn for each grey.
    #[test]
    fn compositor_keeps_levels() {
        let dir = std::env::temp_dir().join(format!("sentry-compose-levels-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let compositor = Compositor::new().unwrap();
        let settings = EncodeSettings { codec: Format::H264, width: 320, height: 240, fps: 36.0, timescale: 36_000, bitrate: 4_000_000, fast: false };
        let enc = Encoder::new(&settings).unwrap();
        for v in [30u8, 128, 200] {
            let path = dir.join(format!("g{v}.mp4"));
            crate::export::testing::clip(&path, 320, 240, 2, move |_, _, _| [v, v, v, 255]);
            let frames = decode_all(&path);
            let target = enc.frame().unwrap();
            compositor.draw_into(&target, &[(frames[0].clone(), Placement { x: 0.0, y: 0.0, width: 320.0, height: 240.0, mirror: false })]).unwrap();
            let px = target.pixel(160, 120);
            assert!((px[1] as i32 - v as i32).abs() <= 2, "grey {v} came out {px:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    use crate::export::encode::{EncodeSettings, Encoder};
    use crate::export::mp4_writer::Mp4Writer;
    use crate::export::encode::Format;
    use std::sync::Arc;

    /// Decoded frames of a clip.
    fn decode_all(path: &std::path::Path) -> Vec<Arc<crate::decode::Frame>> {
        let file = std::fs::File::open(path).unwrap();
        let track = crate::mp4::read_video_track(&file).unwrap();
        let mut dec = crate::decode::Decoder::new(&track).unwrap();
        let mut out = Vec::new();
        for s in &track.samples {
            let mut buf = vec![0u8; s.size as usize];
            crate::mp4::read_at(&file, &mut buf, s.offset).unwrap();
            out.extend(dec.decode(&buf).unwrap().map(Arc::new));
        }
        out.extend(dec.drain().into_iter().map(Arc::new));
        out
    }

    /// The luma at a point of a decoded frame.
    fn luma(frame: &crate::decode::Frame, x: usize, y: usize) -> u8 {
        frame.with_planes(|yp, _| yp.data[y * yp.stride + x]).unwrap()
    }

    /// Two cameras (dark left half / bright right half) side by side, the
    /// second mirrored: the output has them in place and the mirrored one
    /// flipped.
    #[test]
    fn cameras_land_in_place() {
        let dir = std::env::temp_dir().join(format!("sentry-studio-compose-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (w, h, n) = (320usize, 240usize, 12usize);
        // Left half dark, right half bright.
        let halves = |_: usize, x: usize, _: usize| if x < 160 { [30u8, 30, 30, 255] } else { [220, 220, 220, 255] };
        for cam in ["a", "b"] {
            crate::export::testing::clip(&dir.join(format!("{cam}.mp4")), w, h, n, halves);
        }
        let a = decode_all(&dir.join("a.mp4"));
        let b = decode_all(&dir.join("b.mp4"));
        let compositor = Compositor::new().unwrap();
        let settings = EncodeSettings { codec: Format::H264, width: 640, height: 240, fps: 36.0, timescale: 36_000, bitrate: 6_000_000, fast: false };
        let mut enc = Encoder::new(&settings).unwrap();
        let out = dir.join("grid.mp4");
        let mut mp4 = Mp4Writer::create(&out, 640, 240, 36_000).unwrap();
        for i in 0..n {
            let target = enc.frame().unwrap();
            let pictures = [
                (a[i].clone(), Placement { x: 0.0, y: 0.0, width: 320.0, height: 240.0, mirror: false }),
                (b[i].clone(), Placement { x: 320.0, y: 0.0, width: 320.0, height: 240.0, mirror: true }),
            ];
            compositor.draw_into(&target, &pictures).unwrap();
            enc.encode(&target, i as i64 * 1000, 1000).unwrap();
            for p in enc.take() {
                mp4.write_sample(&p.data, 1000, p.sync, 0).unwrap();
            }
        }
        let (rest, config) = enc.finish().unwrap();
        for p in rest {
            mp4.write_sample(&p.data, 1000, p.sync, 0).unwrap();
        }
        mp4.finish(&config).unwrap();
        let grid = decode_all(&out);
        assert_eq!(grid.len(), n);
        let f = &grid[n / 2];
        let (l, r) = (luma(f, 80, 120), luma(f, 240, 120));
        let (ml, mr) = (luma(f, 400, 120), luma(f, 560, 120));
        // Camera a as it is: dark then bright. Camera b mirrored: bright then dark.
        assert!(l < 70 && r > 170, "a: {l} {r}");
        assert!(ml > 170 && mr < 70, "b mirrored: {ml} {mr}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod speed {
    use super::*;
    use crate::export::encode::{EncodeSettings, Encoder};
    use crate::export::mp4_writer::Mp4Writer;
    use crate::export::encode::Format;
    use std::sync::{mpsc, Arc};

    /// Six Tesla-sized cameras through the whole export: decoded on a
    /// thread each, composited into a 3x2 grid, encoded and written
    /// (cargo test --release export_speed -- --ignored --nocapture).
    #[test]
    #[ignore]
    fn export_speed() {
        // SENTRY_EXPORT_CLIPS can name a folder holding cam0.mp4 .. cam5.mp4
        // (front first) to time other footage; it is only read.
        let given = std::env::var_os("SENTRY_EXPORT_CLIPS").map(std::path::PathBuf::from);
        let n: usize = std::env::var("SENTRY_EXPORT_FRAMES").ok().and_then(|v| v.parse().ok()).unwrap_or(360);
        let dir = given.clone().unwrap_or_else(|| std::env::temp_dir().join(format!("sentry-studio-exportspeed-{}", std::process::id())));
        let out_dir = std::env::temp_dir().join(format!("sentry-studio-exportspeed-out-{}", std::process::id()));
        std::fs::create_dir_all(&out_dir).unwrap();
        let sizes = [(2896usize, 1876usize), (1448, 938), (1448, 938), (1448, 938), (1448, 938), (1448, 938)];
        for (i, (w, h)) in sizes.iter().enumerate().filter(|_| given.is_none()) {
            std::fs::create_dir_all(&dir).unwrap();
            // Detail that changes every frame, like real footage.
            crate::export::testing::clip(&dir.join(format!("cam{i}.mp4")), *w, *h, n, move |f, x, y| {
                let v = ((x * 7 + y * 13 + f * 5 + i * 50) % 256) as u8;
                [v, v.wrapping_mul(3), v ^ 0x5a, 255]
            });
        }
        // Max (HEVC), the widest H.264, High, Medium.
        for (codec, out_w, out_h) in [(Format::Hevc, 4352u32, 1888u32), (Format::H264, 4096, 1776), (Format::H264, 3264, 1408), (Format::Hevc, 3264, 1408), (Format::H264, 2176, 944)] {
            let bitrate: u64 = std::env::var("SENTRY_EXPORT_KBPS").ok().and_then(|v| v.parse().ok()).unwrap_or(8000) * 1000;
            let skip: usize = std::env::var("SENTRY_EXPORT_SPEEDUP").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
            let fast = std::env::var("SENTRY_EXPORT_FAST").map(|v| v != "0").unwrap_or(true);
            let compositor = Compositor::new().unwrap();
            let settings = EncodeSettings { codec, width: out_w, height: out_h, fps: 36.0, timescale: 36_000, bitrate, fast };
            let mut enc = Encoder::new(&settings).unwrap();
            let hardware = enc.hardware();
            let out = out_dir.join("out.mp4");
            let mut mp4 = Mp4Writer::create(&out, out_w, out_h, 36_000).unwrap();
            let started = std::time::Instant::now();
            // A decoder thread per camera, a few frames ahead.
            let receivers: Vec<mpsc::Receiver<Arc<crate::decode::Frame>>> = (0..6)
                .map(|i| {
                    let (tx, rx) = mpsc::sync_channel(4);
                    let path = dir.join(format!("cam{i}.mp4"));
                    std::thread::spawn(move || {
                        let file = std::fs::File::open(&path).unwrap();
                        let track = crate::mp4::read_video_track(&file).unwrap();
                        let mut dec = crate::decode::Decoder::new(&track).unwrap();
                        let mut reader = crate::reader::WindowReader::new(file).unwrap();
                        for s in &track.samples {
                            let data = reader.read(s.offset, s.size as usize).unwrap();
                            if let Some(f) = dec.decode(data).unwrap() {
                                if tx.send(Arc::new(f)).is_err() {
                                    return;
                                }
                            }
                        }
                        for f in dec.drain() {
                            let _ = tx.send(Arc::new(f));
                        }
                    });
                    rx
                })
                .collect();
            let (cw, ch) = (out_w as f32 / 3.0, out_h as f32 / 2.0);
            for i in 0..n {
                let pictures: Vec<_> = receivers
                    .iter()
                    .enumerate()
                    .map(|(k, rx)| {
                        let place = Placement { x: (k % 3) as f32 * cw, y: (k / 3) as f32 * ch, width: cw, height: ch, mirror: k >= 3 };
                        (rx.recv().unwrap(), place)
                    })
                    .collect();
                // Time-lapse: frames between the kept ones are decoded (the
                // next frame needs them) but not drawn or encoded.
                if i % skip != 0 {
                    continue;
                }
                let target = enc.frame().unwrap();
                compositor.draw_into(&target, &pictures).unwrap();
                enc.encode(&target, (i / skip) as i64 * 1000, 1000).unwrap();
                for p in enc.take() {
                    mp4.write_sample(&p.data, 1000, p.sync, 0).unwrap();
                }
            }
            let (rest, config) = enc.finish().unwrap();
            for p in rest {
                mp4.write_sample(&p.data, 1000, p.sync, 0).unwrap();
            }
            mp4.finish(&config).unwrap();
            let secs = started.elapsed().as_secs_f64();
            println!(
                "{codec:?} {out_w}x{out_h} (hardware {hardware}, {skip}x time-lapse): {n} source frames in {secs:.2} s = {:.0} fps, {:.1}x real time",
                n as f64 / secs,
                n as f64 / secs / 36.0
            );
        }
        let _ = std::fs::remove_dir_all(&out_dir);
        if given.is_none() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
