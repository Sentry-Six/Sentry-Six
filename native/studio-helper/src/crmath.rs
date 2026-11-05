//! Correctly rounded `sin`, `cos` and `atan2` for the drive distance sums.
//!
//! Studio's JavaScript loader computes haversine distances with `Math.sin`,
//! `Math.cos` and `Math.atan2`. In Electron 45 (V8 15.6) those return the
//! correctly rounded result (checked against 300-bit mpmath on 100,000 inputs
//! and against Electron on 2,000,000), while fdlibm (the `libm` crate) and the
//! platform libraries differ in the last bit for 1-25% of inputs. Matching V8
//! bit for bit therefore means rounding correctly here too.
//!
//! Method: double-double arithmetic (Dekker products, no FMA, so every target
//! computes the same bits), reduction by pi/2 split in four parts, then
//! sin/cos(j/64) from a table plus short Taylor series for the remainder
//! (|t| <= 1/128). The double-double result is accurate to about 2^-100
//! relative before the final rounding, so it rounds correctly unless the true
//! value lies within ~2^-100 of a midpoint between two doubles (vanishingly
//! rare for these inputs). atan2 takes fdlibm's result and applies one Newton
//! step on x*sin(t) - y*cos(t), computed in double-double.
//!
//! Arguments of magnitude >= 1e5 (not real GPS input) fall back to `libm`.

use crate::crmath_tables::{C4, C6, PIO2, S3, S5, S7, SINCOS_J64, TWO_OVER_PI};

#[derive(Clone, Copy, Debug)]
struct Dd(f64, f64);

#[inline]
fn two_sum(a: f64, b: f64) -> Dd {
    let s = a + b;
    let bb = s - a;
    Dd(s, (a - (s - bb)) + (b - bb))
}

#[inline]
fn quick_two_sum(a: f64, b: f64) -> Dd {
    let s = a + b;
    Dd(s, b - (s - a))
}

#[inline]
fn split(a: f64) -> (f64, f64) {
    let t = 134_217_729.0 * a; // 2^27 + 1
    let hi = t - (t - a);
    (hi, a - hi)
}

#[inline]
fn two_prod(a: f64, b: f64) -> Dd {
    let p = a * b;
    let (ah, al) = split(a);
    let (bh, bl) = split(b);
    Dd(p, ((ah * bh - p) + ah * bl + al * bh) + al * bl)
}

#[inline]
fn add(a: Dd, b: Dd) -> Dd {
    let s = two_sum(a.0, b.0);
    let t = two_sum(a.1, b.1);
    let r = quick_two_sum(s.0, s.1 + t.0);
    quick_two_sum(r.0, t.1 + r.1)
}

#[inline]
fn add_d(a: Dd, b: f64) -> Dd {
    let s = two_sum(a.0, b);
    quick_two_sum(s.0, s.1 + a.1)
}

#[inline]
fn mul(a: Dd, b: Dd) -> Dd {
    let p = two_prod(a.0, b.0);
    quick_two_sum(p.0, p.1 + (a.0 * b.1 + a.1 * b.0))
}

#[inline]
fn mul_d(a: Dd, b: f64) -> Dd {
    let p = two_prod(a.0, b);
    quick_two_sum(p.0, p.1 + a.1 * b)
}

#[inline]
fn neg(a: Dd) -> Dd {
    Dd(-a.0, -a.1)
}

#[inline]
fn dd(c: (f64, f64)) -> Dd {
    Dd(c.0, c.1)
}

/// sin and cos of r, |r| <= ~0.79, as double-doubles.
fn sincos_reduced(r: Dd) -> (Dd, Dd) {
    let j = (r.0 * 64.0).round();
    // r.0 - j/64 is exact: j = 0, or r.0 and j/64 are within a factor of 2.
    let t = two_sum(r.0 - j / 64.0, r.1);
    let u = mul(t, t); // |u| <= 2^-14
    let uh = u.0;
    // sin t = t (1 + u (S3 + u (S5 + u (S7 + u/9! - u^2/11!))))
    let a = add_d(dd(S7), uh * (1.0 / 362_880.0 - uh / 39_916_800.0));
    let b = add(dd(S5), mul(a, u));
    let c = add(dd(S3), mul(b, u));
    let sin_t = mul(t, add_d(mul(c, u), 1.0));
    // cos t = 1 + u (-1/2 + u (C4 + u (C6 + u/8! - u^2/10!)))
    let a = add_d(dd(C6), uh * (1.0 / 40_320.0 - uh / 3_628_800.0));
    let b = add(dd(C4), mul(a, u));
    let c = add_d(mul(b, u), -0.5);
    let cos_t = add_d(mul(c, u), 1.0);
    if j == 0.0 {
        return (sin_t, cos_t);
    }
    let row = SINCOS_J64[j.abs() as usize];
    let sc = if j < 0.0 { Dd(-row[0], -row[1]) } else { Dd(row[0], row[1]) };
    let cc = Dd(row[2], row[3]);
    let sin_r = add(mul(sc, cos_t), mul(cc, sin_t));
    let cos_r = add(mul(cc, cos_t), neg(mul(sc, sin_t)));
    (sin_r, cos_r)
}

/// (sin x, cos x) as double-doubles, for finite 1e-150 < |x| < 1e5.
fn sincos_dd(x: f64) -> Option<(Dd, Dd)> {
    let ax = x.abs();
    if !(ax < 1.0e5) || ax < 1.0e-150 {
        return None;
    }
    if ax <= std::f64::consts::FRAC_PI_4 {
        return Some(sincos_reduced(Dd(x, 0.0)));
    }
    let k = (x * TWO_OVER_PI).round();
    // k * PIO2[0..3] are exact (33-bit constants, |k| < 2^17).
    let mut r = two_sum(x, -k * PIO2[0]);
    r = add_d(r, -k * PIO2[1]);
    r = add_d(r, -k * PIO2[2]);
    r = add_d(r, -k * PIO2[3]);
    let (s, c) = sincos_reduced(r);
    Some(match (k as i64) & 3 {
        0 => (s, c),
        1 => (c, neg(s)),
        2 => (neg(s), neg(c)),
        _ => (neg(c), s),
    })
}

pub fn sin(x: f64) -> f64 {
    match sincos_dd(x) {
        Some((s, _)) => s.0 + s.1,
        // |x| <= 1e-150: sin x rounds to x. Zero, NaN, infinities, huge: libm.
        None if x.abs() <= 1.0e-150 => x,
        None => libm::sin(x),
    }
}

pub fn cos(x: f64) -> f64 {
    match sincos_dd(x) {
        Some((_, c)) => c.0 + c.1,
        None if x.abs() <= 1.0e-150 => 1.0,
        None => libm::cos(x),
    }
}

pub fn atan2(y: f64, x: f64) -> f64 {
    let t0 = libm::atan2(y, x);
    // Zeros, infinities and NaN: fdlibm's special-case results are already
    // the correctly rounded ones.
    if y == 0.0 || x == 0.0 || !x.is_finite() || !y.is_finite() || t0 == 0.0 {
        return t0;
    }
    // Keep the double-double products away from overflow and underflow;
    // atan2 does not change when both arguments are scaled by 2^n.
    let m = x.abs().max(y.abs());
    let (y, x) = if m > 1.0e300 {
        (y * 2f64.powi(-600), x * 2f64.powi(-600))
    } else if m < 1.0e-290 {
        (y * 2f64.powi(600), x * 2f64.powi(600))
    } else {
        (y, x)
    };
    let Some((s, c)) = sincos_dd(t0) else { return t0 };
    // Newton step on f(t) = x sin t - y cos t (f' = x cos t + y sin t).
    let f = add(mul_d(s, x), neg(mul_d(c, y)));
    let fp = x * c.0 + y * s.0;
    let corr = -(f.0 + f.1) / fp;
    two_sum(t0, corr).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values() {
        assert_eq!(sin(0.0), 0.0);
        assert!(sin(-0.0).is_sign_negative());
        assert_eq!(cos(0.0), 1.0);
        assert_eq!(sin(1e-200), 1e-200);
        assert!(sin(f64::NAN).is_nan());
        assert_eq!(atan2(1.0, 1.0), std::f64::consts::FRAC_PI_4);
        assert_eq!(atan2(0.0, -1.0), std::f64::consts::PI);
        assert_eq!(atan2(1.0, 0.0), std::f64::consts::FRAC_PI_2);
        // cos(pi/2 as a double) = 6.123233995736766e-17 (correctly rounded)
        assert_eq!(cos(std::f64::consts::FRAC_PI_2), 6.123233995736766e-17);
        assert_eq!(sin(std::f64::consts::PI), 1.2246467991473532e-16);
    }

    #[test]
    fn close_to_libm() {
        let mut x = -7.0;
        while x < 7.0 {
            assert!((sin(x) - libm::sin(x)).abs() <= 2.3e-16, "sin {x}");
            assert!((cos(x) - libm::cos(x)).abs() <= 2.3e-16, "cos {x}");
            assert!((atan2(x, 0.37) - libm::atan2(x, 0.37)).abs() <= 4.5e-16, "atan2 {x}");
            x += 0.000_731;
        }
    }
}
