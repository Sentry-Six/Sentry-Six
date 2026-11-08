//! Blur zones (Privacy): polygons over a camera, blurred in the export, as
//! in earlier versions. Points run 0..1 across and down the camera's
//! picture as shown, so mirrored if the camera is shown mirrored (the
//! editor shows the mirrored picture too).

use crate::library::Camera;

#[derive(Debug, Clone, PartialEq)]
pub struct BlurZone {
    pub camera: Camera,
    pub points: Vec<(f32, f32)>,
}

impl BlurZone {
    /// Earlier versions' first zone: a box in the middle, 30% of the
    /// picture (at most 200 x 150 px of the editor).
    pub fn starting(camera: Camera) -> Self {
        let (w, h) = (0.3f32, 0.3f32);
        let (x0, y0) = (0.5 - w / 2.0, 0.5 - h / 2.0);
        BlurZone { camera, points: vec![(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)] }
    }
}

/// Whether `p` is inside the polygon (even-odd).
pub fn inside(p: (f32, f32), poly: &[(f32, f32)]) -> bool {
    let mut inside = false;
    let mut j = poly.len().wrapping_sub(1);
    for i in 0..poly.len() {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        if (yi > p.1) != (yj > p.1) && p.0 < (xj - xi) * (p.1 - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// The zones as a `width` x `height` mask: 255 inside any of them.
pub fn mask(zones: &[&BlurZone], width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let mut out = vec![0u8; w * h];
    for zone in zones.iter().filter(|z| z.points.len() >= 3) {
        let poly: Vec<(f32, f32)> = zone.points.iter().map(|(x, y)| (x * width as f32, y * height as f32)).collect();
        // Rows the zone covers; each pixel tested at its centre.
        let top = poly.iter().map(|p| p.1).fold(f32::MAX, f32::min).floor().max(0.0) as usize;
        let bottom = (poly.iter().map(|p| p.1).fold(f32::MIN, f32::max).ceil().max(0.0) as usize).min(h);
        let left = poly.iter().map(|p| p.0).fold(f32::MAX, f32::min).floor().max(0.0) as usize;
        let right = (poly.iter().map(|p| p.0).fold(f32::MIN, f32::max).ceil().max(0.0) as usize).min(w);
        for y in top..bottom {
            for x in left..right {
                if inside((x as f32 + 0.5, y as f32 + 0.5), &poly) {
                    out[y * w + x] = 255;
                }
            }
        }
    }
    out
}

/// One camera's share of a rounded rectangle given in the frame's pixels
/// (`[x, y, width, height, radius]`), the camera's cell starting at
/// `cell` and `width` x `height` big: each pixel's coverage (smooth at the
/// edge). None where the rectangle misses the cell.
pub fn rounded_mask(rect: [f32; 5], cell: (f32, f32), width: u32, height: u32) -> Option<Vec<u8>> {
    let [x, y, w, h, r] = rect;
    let (x0, y0) = (x - cell.0, y - cell.1);
    if x0 >= width as f32 || y0 >= height as f32 || x0 + w <= 0.0 || y0 + h <= 0.0 {
        return None;
    }
    let (cx, cy) = (x0 + w / 2.0, y0 + h / 2.0);
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    let mut out = vec![0u8; width as usize * height as usize];
    let rows = (y0.floor().max(0.0) as usize)..((y0 + h).ceil().max(0.0) as usize).min(height as usize);
    let cols = (x0.floor().max(0.0) as usize)..((x0 + w).ceil().max(0.0) as usize).min(width as usize);
    for py in rows {
        for px in cols.clone() {
            let qx = (px as f32 + 0.5 - cx).abs() - (w / 2.0 - r);
            let qy = (py as f32 + 0.5 - cy).abs() - (h / 2.0 - r);
            let d = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r;
            out[py * width as usize + px] = ((0.5 - d).clamp(0.0, 1.0) * 255.0).round() as u8;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn rounded_mask_covers_its_share() {
        // A 100 x 40 rectangle with 20 px corners, half over a 60 px cell.
        let m = super::rounded_mask([30.0, 10.0, 100.0, 40.0, 20.0], (0.0, 0.0), 60, 60).unwrap();
        assert_eq!(m[30 * 60 + 59], 255); // inside
        assert_eq!(m[5 * 60 + 40], 0); // above
        assert_eq!(m[11 * 60 + 31], 0); // the rounded corner
        assert!(super::rounded_mask([100.0, 0.0, 10.0, 10.0, 2.0], (0.0, 0.0), 60, 60).is_none());
    }

    use super::*;

    #[test]
    fn masks_cover_the_zones() {
        let zone = BlurZone { camera: Camera::Back, points: vec![(0.25, 0.25), (0.75, 0.25), (0.75, 0.75), (0.25, 0.75)] };
        let m = mask(&[&zone], 8, 4);
        let rows: Vec<String> = m.chunks(8).map(|r| r.iter().map(|v| if *v > 0 { '#' } else { '.' }).collect()).collect();
        assert_eq!(rows, ["........", "..####..", "..####..", "........"]);
        // A triangle: the corner outside it stays clear.
        let tri = BlurZone { camera: Camera::Back, points: vec![(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)] };
        let m = mask(&[&tri], 10, 10);
        assert_eq!((m[0], m[99]), (255, 0));
        assert_eq!(BlurZone::starting(Camera::Front).points.len(), 4);
    }
}
