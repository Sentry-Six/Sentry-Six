//! Draws decoded NV12 pictures with iced's wgpu shader widget: the Y and
//! CbCr planes go to two GPU textures and a fragment shader converts them to
//! RGB (BT.709, limited range, like the Tesla clips). The picture keeps its
//! aspect ratio inside the tile.
//!
//! Frosted glass works like a browser's `backdrop-filter: blur()
//! saturate()`: the tile is drawn at a quarter of its size, blurred with a
//! separable Gaussian (across, then down), and the result is shown, more
//! saturated, wherever a glass panel covers the tile. This only runs for
//! tiles under glass, and only when the frame, size, zoom or pan changes.

use crate::decode::Frame;

#[cfg(target_os = "macos")]
pub(crate) mod metal_import;

/// Decoded pictures kept alive after they are replaced (see metal_import).
#[cfg(target_os = "macos")]
const KEEP_FRAMES: usize = 4;
use iced::mouse;
use iced::wgpu;
use iced::widget::shader::{self, Viewport};
use iced::Rectangle;
use std::collections::HashMap;
use std::sync::Arc;

/// Space around the tile inside the shader's bounds (half the grid gap):
/// under glass the blur fills it, so the gaps between tiles smear too.
pub const MARGIN: f32 = 5.0;

/// A tile's shader program: what to show in that slot. Its bounds are the
/// tile plus MARGIN on every side.
pub struct VideoTile {
    pub slot: usize,
    pub picture: Option<(u64, Arc<Frame>)>,
    /// A glass panel floating over the video: the video under it is drawn
    /// blurred, like CSS `backdrop-filter`.
    pub glass: Option<Glass>,
    /// A second glass area (the dashboard over the front camera).
    pub glass2: Option<Glass>,
    pub view: View,
}

/// How the picture sits in its tile: zoom (1 = fit), pan and mirroring,
/// like the CSS transform `scale(zoom) translate(pan) scaleX(-1)`.
#[derive(Debug, Clone, Copy)]
pub struct View {
    pub zoom: f32,
    /// Pan in tile pixels before zooming (CSS `translate` inside `scale`).
    pub pan: (f32, f32),
    pub mirror: bool,
}

impl Default for View {
    fn default() -> Self {
        Self { zoom: 1.0, pan: (0.0, 0.0), mirror: false }
    }
}

/// A frosted-glass area in window coordinates (logical pixels).
#[derive(Debug, Clone, Copy)]
pub struct Glass {
    pub rect: Rectangle,
    pub radius: f32,
    /// Gaussian standard deviation, like CSS `blur(<length>)`.
    pub blur: f32,
    /// Saturation boost, like CSS `saturate(185%)`.
    pub saturate: f32,
}

impl<Message> shader::Program<Message> for VideoTile {
    type State = ();
    type Primitive = VideoPrimitive;

    fn draw(&self, _state: &(), _cursor: mouse::Cursor, _bounds: Rectangle) -> VideoPrimitive {
        VideoPrimitive { slot: self.slot, picture: self.picture.clone(), glass: self.glass, glass2: self.glass2, view: self.view }
    }
}

pub struct VideoPrimitive {
    slot: usize,
    picture: Option<(u64, Arc<Frame>)>,
    glass: Option<Glass>,
    glass2: Option<Glass>,
    view: View,
}

impl std::fmt::Debug for VideoPrimitive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoPrimitive")
            .field("slot", &self.slot)
            .field("picture", &self.picture.as_ref().map(|p| p.0))
            .finish()
    }
}

struct TileGpu {
    size: (u32, u32),
    y: wgpu::Texture,
    uv: wgpu::Texture,
    uniform: wgpu::Buffer,
    /// For drawing the tile (samples the blurred texture).
    bind: wgpu::BindGroup,
    /// For drawing the quarter-size copy (must not sample its own target).
    down_bind: wgpu::BindGroup,
    uploaded: u64,
    blur: Option<BlurGpu>,
    /// What the blurred texture was last made from.
    blur_key: Option<BlurKey>,
    /// `y`/`uv` are the decoder's own picture (not copied into).
    imported: bool,
    #[cfg(target_os = "macos")]
    kept: std::collections::VecDeque<metal_import::Imported>,
}

/// The quarter-size copy of a tile and its blur passes: `a` is drawn,
/// blurred across into `b`, then down back into `a`.
struct BlurGpu {
    size: (u32, u32),
    a_view: wgpu::TextureView,
    b_view: wgpu::TextureView,
    across: wgpu::BindGroup,
    down: wgpu::BindGroup,
    /// The passes' uniforms (direction and blur strength), rewritten when
    /// the Glass Blur setting changes.
    across_buf: wgpu::Buffer,
    down_buf: wgpu::Buffer,
}

#[derive(Clone, Copy, PartialEq)]
struct BlurKey {
    frame: u64,
    size: (u32, u32),
    zoom: u32,
    pan: (u32, u32),
    mirror: bool,
    sigma: u32,
}

pub struct VideoPipeline {
    pipeline: wgpu::RenderPipeline,
    down_pipeline: wgpu::RenderPipeline,
    blur_pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    blur_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    /// Stands in for the blurred texture where there is none.
    blank_view: wgpu::TextureView,
    srgb_target: bool,
    tiles: HashMap<usize, TileGpu>,
    /// Shows decoded pictures without copying them (macOS).
    #[cfg(target_os = "macos")]
    metal: Option<metal_import::Cache>,
}

/// The blurred copy is this many times smaller than the tile.
const BLUR_DOWNSCALE: f32 = 4.0;
const BLUR_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

const BLUR_SHADER: &str = r#"
struct B { dir: vec2<f32>, sigma: f32, pad: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var bsamp: sampler;
@group(0) @binding(2) var<uniform> b: B;

struct O { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> O {
    var corners = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
    let c = corners[i];
    var o: O;
    o.pos = vec4<f32>(c, 0.0, 1.0);
    o.uv = vec2<f32>((c.x + 1.0) * 0.5, (1.0 - c.y) * 0.5);
    return o;
}

// One direction of a Gaussian over +-3 sigma, 25 taps.
@fragment
fn fs(o: O) -> @location(0) vec4<f32> {
    let texel = 1.0 / vec2<f32>(textureDimensions(src));
    let spacing = max(b.sigma * 3.0 / 12.0, 0.5);
    var acc = vec3<f32>(0.0);
    var total = 0.0;
    for (var k: i32 = -12; k <= 12; k = k + 1) {
        let d = f32(k) * spacing;
        let w = exp(-d * d / (2.0 * b.sigma * b.sigma));
        acc = acc + w * textureSampleLevel(src, bsamp, o.uv + b.dir * d * texel, 0.0).rgb;
        total = total + w;
    }
    return vec4<f32>(acc / total, 1.0);
}
"#;

/// The tile's corner radius inside its border (the tile's 12 px minus 1).
const TILE_RADIUS: f32 = 11.0;

const SHADER: &str = r#"
struct U {
    scale: vec2<f32>, srgb: f32, glass_on: f32,
    // Glass panel in framebuffer pixels: x, y, width, height.
    panel: vec4<f32>,
    radius: f32, sigma: f32, saturate: f32, mirror: f32,
    // Bounds size over tile size (the bounds include a margin); pan offset
    // in the tile's clip space.
    grow: vec2<f32>, offset: vec2<f32>,
    // The tile's inside (within its 1 px border) in framebuffer pixels, and
    // its corner radius: the picture is clipped to it, so it never spills
    // past the rounded tile.
    tile: vec4<f32>,
    // (pad: unused, keeps the layout of the 32 floats the app writes.)
    tile_radius: f32, glass2_on: f32, radius2: f32, pad: f32,
    // Second glass area, framebuffer pixels.
    panel2: vec4<f32>,
    // The whole bounds (tile and margin), framebuffer pixels.
    cell: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex_y: texture_2d<f32>;
@group(0) @binding(2) var tex_uv: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var tex_blur: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
    var corners = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
    let c = corners[i];
    var o: VOut;
    // The quad covers the whole tile; the picture sits inside it (fitted,
    // zoomed, panned) and the rest is the tile's black background.
    o.pos = vec4<f32>(c, 0.0, 1.0);
    let pc = (c * u.grow - u.offset) / u.scale;
    var x = (pc.x + 1.0) * 0.5;
    if (u.mirror > 0.5) {
        x = 1.0 - x;
    }
    o.uv = vec2<f32>(x, (1.0 - pc.y) * 0.5);
    return o;
}

fn in_picture(uv: vec2<f32>) -> bool {
    return all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
}

// How many picture pixels one screen pixel spans, per axis. Called from
// the entry points (derivatives need uniform control flow).
fn footprint(uv: vec2<f32>) -> vec2<f32> {
    let dims = vec2<f32>(textureDimensions(tex_y));
    return (abs(dpdx(uv)) + abs(dpdy(uv))) * dims;
}

fn sample_one(uv: vec2<f32>) -> vec3<f32> {
    return vec3<f32>(textureSampleLevel(tex_y, samp, uv, 0.0).r, textureSampleLevel(tex_uv, samp, uv, 0.0).rg);
}

// Y and CbCr at uv; outside the picture, video black (Y 16, Cb/Cr 128).
// When the picture is shown smaller than its size (`fp` > 1), one sample
// would skip most of the pixels under this one (jagged, shimmering
// detail), so it averages a grid of up to 4x4 bilinear samples spread
// over them, like a browser's smooth downscaling.
fn sample_yc(uv: vec2<f32>, fp: vec2<f32>) -> vec3<f32> {
    if (!in_picture(uv)) {
        return vec3<f32>(16.0 / 255.0, 128.0 / 255.0, 128.0 / 255.0);
    }
    // Each bilinear sample covers 2 pixels per axis.
    let n = clamp(ceil(fp * 0.5), vec2<f32>(1.0), vec2<f32>(4.0));
    if (n.x * n.y <= 1.0) {
        return sample_one(uv);
    }
    let step = fp / n / vec2<f32>(textureDimensions(tex_y));
    var acc = vec3<f32>(0.0);
    for (var j: i32 = 0; j < 4; j = j + 1) {
        if (f32(j) >= n.y) {
            break;
        }
        for (var k: i32 = 0; k < 4; k = k + 1) {
            if (f32(k) >= n.x) {
                break;
            }
            let off = (vec2<f32>(f32(k), f32(j)) - (n - vec2<f32>(1.0)) * 0.5) * step;
            acc = acc + sample_one(clamp(uv + off, vec2<f32>(0.0), vec2<f32>(1.0)));
        }
    }
    return acc / (n.x * n.y);
}

fn to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

// BT.709 limited range to gamma-encoded RGB.
fn to_rgb(y_raw: f32, c_raw: vec2<f32>) -> vec3<f32> {
    let y = (y_raw - 16.0 / 255.0) * (255.0 / 219.0);
    let c = (c_raw - vec2<f32>(128.0 / 255.0)) * (255.0 / 224.0);
    return clamp(vec3<f32>(
        y + 1.5748 * c.y,
        y - 0.187324 * c.x - 0.468124 * c.y,
        y + 1.8556 * c.x), vec3<f32>(0.0), vec3<f32>(1.0));
}

// How much of pixel p is inside a rounded rectangle (x, y, w, h).
fn rounded_coverage(p: vec2<f32>, rect: vec4<f32>, radius: f32) -> f32 {
    let half = rect.zw * 0.5;
    let q = abs(p - (rect.xy + half)) - (half - vec2<f32>(radius));
    let d = length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
    return clamp(0.5 - d, 0.0, 1.0);
}

fn panel_coverage(p: vec2<f32>) -> f32 {
    var c = 0.0;
    if (u.glass_on > 0.5) {
        c = rounded_coverage(p, u.panel, u.radius);
    }
    if (u.glass2_on > 0.5) {
        c = max(c, rounded_coverage(p, u.panel2, u.radius2));
    }
    return c;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4<f32> {
    let here = sample_yc(i.uv, footprint(i.uv));
    var rgb = to_rgb(here.x, here.yz);
    var vivid = vec3<f32>(0.0);
    var cover = 0.0;
    if (u.glass_on > 0.5 || u.glass2_on > 0.5) {
        cover = panel_coverage(i.pos.xy);
        if (cover > 0.0) {
            // The blurred quarter-size copy of the whole cell (tile, border
            // and margin), at this pixel.
            var blurred = textureSampleLevel(tex_blur, samp, (i.pos.xy - u.cell.xy) / u.cell.zw, 0.0).rgb;
            if (u.sigma < 0.5) {
                blurred = rgb;
            }
            let luma = dot(blurred, vec3<f32>(0.2126, 0.7152, 0.0722));
            vivid = clamp(mix(vec3<f32>(luma), blurred, u.saturate), vec3<f32>(0.0), vec3<f32>(1.0));
            rgb = mix(rgb, vivid, cover);
        }
    }
    if (u.srgb > 0.5) {
        rgb = to_linear(rgb);
        vivid = to_linear(vivid);
    }
    // The picture inside the rounded tile; under glass, the blur also
    // covers the border and the margin around it.
    let inside = rounded_coverage(i.pos.xy, u.tile, u.tile_radius);
    let outside = cover * (1.0 - inside);
    return vec4<f32>(rgb * inside + vivid * outside, inside + outside);
}

// The tile as it looks (picture, black around it), for the blur.
@fragment
fn fs_down(i: VOut) -> @location(0) vec4<f32> {
    let yc = sample_yc(i.uv, footprint(i.uv));
    return vec4<f32>(to_rgb(yc.x, yc.yz), 1.0);
}
"#;

impl shader::Pipeline for VideoPipeline {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("video nv12"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let blur_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("video glass blur"),
            source: wgpu::ShaderSource::Wgsl(BLUR_SHADER.into()),
        });
        let tex_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let uniform_entry = |binding, visibility| wgpu::BindGroupLayoutEntry {
            binding,
            visibility,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let sampler_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("video tile"),
            entries: &[uniform_entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT), tex_entry(1), tex_entry(2), sampler_entry(3), tex_entry(4)],
        });
        let blur_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("video glass blur"),
            entries: &[tex_entry(0), sampler_entry(1), uniform_entry(2, wgpu::ShaderStages::FRAGMENT)],
        });
        let make = |label: &str, module: &wgpu::ShaderModule, layout: &wgpu::BindGroupLayout, fs: &str, target: wgpu::TextureFormat, blend: Option<wgpu::BlendState>| {
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &[layout],
                push_constant_ranges: &[],
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState { module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
                fragment: Some(wgpu::FragmentState {
                    module,
                    entry_point: Some(fs),
                    targets: &[Some(wgpu::ColorTargetState { format: target, blend, write_mask: wgpu::ColorWrites::ALL })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, ..Default::default() },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        // Premultiplied: the clipped corners blend into the tile.
        let pipeline = make("video", &module, &layout, "fs", format, Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING));
        let down_pipeline = make("video glass copy", &module, &layout, "fs_down", BLUR_FORMAT, None);
        let blur_pipeline = make("video glass blur", &blur_module, &blur_layout, "fs", BLUR_FORMAT, None);
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("video"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let blank = blur_texture(device, 1, 1);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &blank, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &[0, 0, 0, 255],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );
        Self {
            pipeline,
            down_pipeline,
            blur_pipeline,
            layout,
            blur_layout,
            sampler,
            blank_view: blank.create_view(&Default::default()),
            srgb_target: format.is_srgb(),
            tiles: HashMap::new(),
            #[cfg(target_os = "macos")]
            metal: if std::env::var_os("SENTRY_STUDIO_COPY_FRAMES").is_some() { None } else { metal_import::Cache::new(device) },
        }
    }
}

fn plane_texture(device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("video plane"),
        size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

fn blur_texture(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("video glass"),
        size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: BLUR_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

fn write_plane(queue: &wgpu::Queue, tex: &wgpu::Texture, data: &[u8], stride: usize, w: u32, h: u32) {
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        data,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(stride as u32), rows_per_image: Some(h) },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
}

fn main_bind(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    y: &wgpu::Texture,
    uv: &wgpu::Texture,
    uniform: &wgpu::Buffer,
    blurred: &wgpu::TextureView,
) -> wgpu::BindGroup {
    let y_view = y.create_view(&Default::default());
    let uv_view = uv.create_view(&Default::default());
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("video tile"),
        layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&y_view) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&uv_view) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(sampler) },
            wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(blurred) },
        ],
    })
}

fn blur_bind(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    src: &wgpu::TextureView,
    dir: [f32; 2],
    sigma: f32,
) -> (wgpu::BindGroup, wgpu::Buffer) {
    use wgpu::util::DeviceExt;
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("video glass blur"),
        contents: bytemuck::cast_slice(&blur_uniform(dir, sigma)),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("video glass blur"),
        layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(src) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
            wgpu::BindGroupEntry { binding: 2, resource: uniform.as_entire_binding() },
        ],
    });
    (bind, uniform)
}

fn blur_uniform(dir: [f32; 2], sigma: f32) -> [f32; 4] {
    [dir[0], dir[1], sigma, 0.0]
}

fn run_pass(encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView, pipeline: &wgpu::RenderPipeline, bind: &wgpu::BindGroup) {
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("video glass"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bind, &[]);
    pass.draw(0..4, 0..1);
}

impl shader::Primitive for VideoPrimitive {
    type Pipeline = VideoPipeline;

    fn prepare(
        &self,
        pipeline: &mut VideoPipeline,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bounds: &Rectangle,
        viewport: &Viewport,
    ) {
        let Some((id, frame)) = &self.picture else { return };
        let size = (frame.width(), frame.height());
        if size.0 == 0 || size.1 == 0 {
            return;
        }
        let scale = viewport.scale_factor();
        // Only tiles a glass area actually overlaps need the blurred copy.
        let covers = |g: &Option<Glass>| g.is_some_and(|g| g.rect.intersects(bounds));
        let has_glass = covers(&self.glass) || covers(&self.glass2);
        let blur_size = (
            ((bounds.width * scale) / BLUR_DOWNSCALE).ceil().max(1.0) as u32,
            ((bounds.height * scale) / BLUR_DOWNSCALE).ceil().max(1.0) as u32,
        );
        // Both glass areas share the blur settings.
        let (sigma, saturate) = match self.glass.or(self.glass2) {
            Some(g) => ((g.blur * scale).max(0.5), g.saturate),
            None => (1.0, 1.0),
        };
        let sigma_small = (sigma / BLUR_DOWNSCALE).max(0.5);
        // Glass Blur 0 means no blur at all (CSS blur(0)), just the tint.
        let raw_sigma = self.glass.or(self.glass2).map_or(0.0, |g| g.blur * scale);

        let needs_new = pipeline.tiles.get(&self.slot).is_none_or(|t| t.size != size);
        if needs_new {
            let y = plane_texture(device, size.0, size.1, wgpu::TextureFormat::R8Unorm);
            let uv = plane_texture(device, size.0.div_ceil(2), size.1.div_ceil(2), wgpu::TextureFormat::Rg8Unorm);
            let uniform = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("video tile"),
                size: 128,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let bind = main_bind(device, &pipeline.layout, &pipeline.sampler, &y, &uv, &uniform, &pipeline.blank_view);
            let down_bind = main_bind(device, &pipeline.layout, &pipeline.sampler, &y, &uv, &uniform, &pipeline.blank_view);
            // Pictures the GPU may still be reading stay alive.
            #[cfg(target_os = "macos")]
            let kept = pipeline.tiles.remove(&self.slot).map(|t| t.kept).unwrap_or_default();
            pipeline.tiles.insert(
                self.slot,
                TileGpu {
                    size,
                    y,
                    uv,
                    uniform,
                    bind,
                    down_bind,
                    uploaded: 0,
                    blur: None,
                    blur_key: None,
                    imported: false,
                    #[cfg(target_os = "macos")]
                    kept,
                },
            );
        }

        // (Re)make the quarter-size textures when the tile's size changes.
        let tile_size_changed = pipeline.tiles[&self.slot].blur.as_ref().map(|b| b.size) != Some(blur_size);
        if has_glass && tile_size_changed {
            let a = blur_texture(device, blur_size.0, blur_size.1);
            let b = blur_texture(device, blur_size.0, blur_size.1);
            let a_view = a.create_view(&Default::default());
            let b_view = b.create_view(&Default::default());
            let (across, across_buf) = blur_bind(device, &pipeline.blur_layout, &pipeline.sampler, &a_view, [1.0, 0.0], sigma_small);
            let (down, down_buf) = blur_bind(device, &pipeline.blur_layout, &pipeline.sampler, &b_view, [0.0, 1.0], sigma_small);
            let tile = pipeline.tiles.get(&self.slot).unwrap();
            let bind = main_bind(device, &pipeline.layout, &pipeline.sampler, &tile.y, &tile.uv, &tile.uniform, &a_view);
            let tile = pipeline.tiles.get_mut(&self.slot).unwrap();
            tile.bind = bind;
            tile.blur = Some(BlurGpu { size: blur_size, a_view, b_view, across, down, across_buf, down_buf });
            tile.blur_key = None;
        }
        let srgb = pipeline.srgb_target;
        let tile = pipeline.tiles.get_mut(&self.slot).unwrap();

        // The tile inside the bounds, and how much bigger the bounds are.
        let tile_rect = Rectangle {
            x: bounds.x + MARGIN,
            y: bounds.y + MARGIN,
            width: (bounds.width - 2.0 * MARGIN).max(1.0),
            height: (bounds.height - 2.0 * MARGIN).max(1.0),
        };
        let grow = (bounds.width / tile_rect.width, bounds.height / tile_rect.height);
        // Fit the picture inside the tile, keeping its aspect ratio.
        let video_aspect = size.0 as f32 / size.1 as f32;
        let tile_aspect = (tile_rect.width / tile_rect.height).max(0.01);
        let (fx, fy) = if video_aspect > tile_aspect { (1.0, tile_aspect / video_aspect) } else { (video_aspect / tile_aspect, 1.0) };
        let zoom = self.view.zoom.max(1.0);
        let (sx, sy) = (fx * zoom, fy * zoom);
        // CSS translate inside scale: on screen the pan moves by pan * zoom.
        let offset = (
            2.0 * self.view.pan.0 * zoom / tile_rect.width,
            -2.0 * self.view.pan.1 * zoom / tile_rect.height,
        );
        let rect = |g: Option<Glass>| match g {
            Some(g) => (1.0, [g.rect.x * scale, g.rect.y * scale, g.rect.width * scale, g.rect.height * scale], g.radius * scale),
            None => (0.0, [0.0; 4], 0.0),
        };
        let (glass_on, panel, radius) = rect(self.glass);
        let (glass2_on, panel2, radius2) = rect(self.glass2);
        // The tile's inside: 1 px in from its border, 11 px corners (12 - 1).
        let t = tile_rect;
        let inner = [(t.x + 1.0) * scale, (t.y + 1.0) * scale, (t.width - 2.0).max(0.0) * scale, (t.height - 2.0).max(0.0) * scale];
        let cell = [bounds.x * scale, bounds.y * scale, bounds.width * scale, bounds.height * scale];
        let uniform: [f32; 32] = [
            sx, sy, if srgb { 1.0 } else { 0.0 }, glass_on,
            panel[0], panel[1], panel[2], panel[3],
            radius, raw_sigma, saturate, if self.view.mirror { 1.0 } else { 0.0 },
            grow.0, grow.1, offset.0, offset.1,
            inner[0], inner[1], inner[2], inner[3],
            TILE_RADIUS * scale, glass2_on, radius2, scale,
            panel2[0], panel2[1], panel2[2], panel2[3],
            cell[0], cell[1], cell[2], cell[3],
        ];
        queue.write_buffer(&tile.uniform, 0, bytemuck::cast_slice(&uniform));

        if tile.uploaded != *id {
            let mut done = false;
            // macOS: use the decoder's picture as the texture itself.
            #[cfg(target_os = "macos")]
            if let Some(imported) = pipeline.metal.as_ref().and_then(|m| m.import(device, frame)) {
                let blurred = tile.blur.as_ref().map_or(&pipeline.blank_view, |b| &b.a_view);
                tile.bind = main_bind(device, &pipeline.layout, &pipeline.sampler, &imported.y, &imported.uv, &tile.uniform, blurred);
                tile.down_bind =
                    main_bind(device, &pipeline.layout, &pipeline.sampler, &imported.y, &imported.uv, &tile.uniform, &pipeline.blank_view);
                tile.y = imported.y.clone();
                tile.uv = imported.uv.clone();
                tile.kept.push_back(imported);
                while tile.kept.len() > KEEP_FRAMES {
                    tile.kept.pop_front();
                }
                tile.imported = true;
                done = true;
            }
            if !done {
                // Copy into our own textures (made again if the last
                // picture was the decoder's).
                if tile.imported {
                    tile.y = plane_texture(device, size.0, size.1, wgpu::TextureFormat::R8Unorm);
                    tile.uv = plane_texture(device, size.0.div_ceil(2), size.1.div_ceil(2), wgpu::TextureFormat::Rg8Unorm);
                    let blurred = tile.blur.as_ref().map_or(&pipeline.blank_view, |b| &b.a_view);
                    tile.bind = main_bind(device, &pipeline.layout, &pipeline.sampler, &tile.y, &tile.uv, &tile.uniform, blurred);
                    tile.down_bind = main_bind(device, &pipeline.layout, &pipeline.sampler, &tile.y, &tile.uv, &tile.uniform, &pipeline.blank_view);
                    tile.imported = false;
                }
                let (y_tex, uv_tex) = (&tile.y, &tile.uv);
                done = frame
                    .with_planes(|y, uv| {
                        write_plane(queue, y_tex, y.data, y.stride, y.width.min(size.0), y.height.min(size.1));
                        write_plane(queue, uv_tex, uv.data, uv.stride, uv.width, uv.height);
                    })
                    .is_some();
            }
            if done {
                tile.uploaded = *id;
            }
        }

        // The blurred copy, when something under glass changed. Submitted
        // now, ahead of the frame that samples it; the uploads and uniforms
        // written above are applied before it.
        if has_glass {
            let key = BlurKey {
                frame: tile.uploaded,
                size: blur_size,
                zoom: zoom.to_bits(),
                pan: (self.view.pan.0.to_bits(), self.view.pan.1.to_bits()),
                mirror: self.view.mirror,
                sigma: sigma_small.to_bits(),
            };
            if tile.blur_key != Some(key) {
                if let Some(blur) = &tile.blur {
                    // The strength may have changed since the passes were set up.
                    queue.write_buffer(&blur.across_buf, 0, bytemuck::cast_slice(&blur_uniform([1.0, 0.0], sigma_small)));
                    queue.write_buffer(&blur.down_buf, 0, bytemuck::cast_slice(&blur_uniform([0.0, 1.0], sigma_small)));
                    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("video glass") });
                    run_pass(&mut encoder, &blur.a_view, &pipeline.down_pipeline, &tile.down_bind);
                    run_pass(&mut encoder, &blur.b_view, &pipeline.blur_pipeline, &blur.across);
                    run_pass(&mut encoder, &blur.a_view, &pipeline.blur_pipeline, &blur.down);
                    queue.submit(Some(encoder.finish()));
                    tile.blur_key = Some(key);
                }
            }
        }
    }

    fn draw(&self, pipeline: &VideoPipeline, pass: &mut wgpu::RenderPass<'_>) -> bool {
        if self.picture.is_none() {
            return true;
        }
        let Some(tile) = pipeline.tiles.get(&self.slot) else { return true };
        pass.set_pipeline(&pipeline.pipeline);
        pass.set_bind_group(0, &tile.bind, &[]);
        pass.draw(0..4, 0..1);
        true
    }
}

#[cfg(test)]
mod tests {
    /// The shaders compile only at run time; check them here.
    #[test]
    fn shaders_validate() {
        use iced::wgpu;
        for (name, source) in [("video", super::SHADER), ("blur", super::BLUR_SHADER)] {
            let module = wgpu::naga::front::wgsl::parse_str(source).unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(source)));
            wgpu::naga::valid::Validator::new(wgpu::naga::valid::ValidationFlags::all(), wgpu::naga::valid::Capabilities::empty())
                .validate(&module)
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        }
    }
}
