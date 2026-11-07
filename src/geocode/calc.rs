//! From Sentry Drive (src-tauri/src/loader/calc.rs): the WGS-84 distance
//! and JavaScript's Math.round, used by the place-name matching.

const WGS84_A: f64 = 6378137.0;
const WGS84_F: f64 = 1.0 / 298.257223563;

mod m {
    pub fn sin(x: f64) -> f64 {
        libm::sin(x)
    }
    pub fn cos(x: f64) -> f64 {
        libm::cos(x)
    }
    pub fn tan(x: f64) -> f64 {
        libm::tan(x)
    }
    pub fn atan(x: f64) -> f64 {
        libm::atan(x)
    }
    pub fn atan2(y: f64, x: f64) -> f64 {
        libm::atan2(y, x)
    }
}

/// Canonical WGS-84 Andoyer–Lambert distance (metres).
pub fn geodesic_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    if lat1 == lat2 && lon1 == lon2 {
        return 0.0;
    }
    let to_rad = |d: f64| (d * std::f64::consts::PI) / 180.0;
    let f = WGS84_F;
    let b1 = m::atan((1.0 - f) * m::tan(to_rad(lat1)));
    let b2 = m::atan((1.0 - f) * m::tan(to_rad(lat2)));
    let p = (b1 + b2) / 2.0;
    let q = (b2 - b1) / 2.0;
    let sin_half_dlon = m::sin(to_rad(lon2 - lon1) / 2.0);
    let sin_q = m::sin(q);
    let h = sin_q * sin_q + m::cos(b1) * m::cos(b2) * sin_half_dlon * sin_half_dlon;
    let sigma = 2.0 * m::atan2(h.sqrt(), (1.0 - h).max(0.0).sqrt());
    if sigma == 0.0 {
        return 0.0;
    }
    let sin_sigma = m::sin(sigma);
    let cos2_half = (1.0 - h).max(1e-12);
    let sin2_half = h.max(1e-12);
    let sin_p = m::sin(p);
    let cos_p = m::cos(p);
    let cos_q = m::cos(q);
    let x = (sigma - sin_sigma) * (sin_p * sin_p * cos_q * cos_q) / cos2_half;
    let y = (sigma + sin_sigma) * (cos_p * cos_p * sin_q * sin_q) / sin2_half;
    WGS84_A * (sigma - (f / 2.0) * (x + y))
}

/// JavaScript `Math.round`: ties round toward +infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}
