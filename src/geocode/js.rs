//! From Sentry Drive (src-tauri/src/geocode/js.rs), unchanged.
//! JavaScript coercion helpers, so provider JSON and renderer input are read
//! exactly the way the JavaScript version read them.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

/// JS truthiness of a property read (`undefined` is `None`).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// First truthy `obj[key]` in order, like `a.x || a.y || a.z`.
pub fn first_truthy<'a>(obj: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    let obj = obj?;
    keys.iter().map(|k| obj.get(*k)).find(|v| truthy(*v)).flatten()
}

/// `String(value)`.
pub fn to_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|x| if x.is_null() { String::new() } else { to_string(Some(x)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `String(number)`.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into();
    }
    let a = x.abs();
    if !(1e-6..1e21).contains(&a) {
        let s = format!("{x:e}");
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        };
    }
    format!("{x}")
}

/// `Number(value)`.
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Array(items)) => match items.len() {
            0 => 0.0,
            1 => string_to_number(&to_string(items.first())),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn string_to_number(s: &str) -> f64 {
    let s = s.trim();
    if s.is_empty() {
        return 0.0;
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(digits) = prefixes.iter().find_map(|p| s.strip_prefix(p)) {
            return u128::from_str_radix(digits, radix).map(|n| n as f64).unwrap_or(f64::NAN);
        }
    }
    if s.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E')) {
        s.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `parseFloat(value)`.
pub fn parse_float(v: Option<&Value>) -> f64 {
    if let Some(Value::Number(n)) = v {
        return n.as_f64().unwrap_or(f64::NAN);
    }
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    let re = PREFIX.get_or_init(|| {
        Regex::new(r"^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)").expect("valid regex")
    });
    let s = to_string(v);
    let Some(m) = re.find(s.trim_start()) else { return f64::NAN };
    match m.as_str().trim_start_matches(['+', '-']) {
        "Infinity" if m.as_str().starts_with('-') => f64::NEG_INFINITY,
        "Infinity" => f64::INFINITY,
        _ => m.as_str().parse::<f64>().unwrap_or(f64::NAN),
    }
}

/// `x.toFixed(digits)` for coordinate-sized values. Rust's fixed formatting
/// rounds exact binary ties to even; JS picks the larger magnitude.
pub fn to_fixed(x: f64, digits: i32) -> String {
    let x = if x == 0.0 { 0.0 } else { x };
    let scale = 10f64.powi(digits);
    let scaled = x * scale;
    // A true decimal tie is a multiple of 2^-(digits+1), which makes both
    // products below exact.
    let exact_tie = (x * 2f64.powi(digits + 1)).fract() == 0.0 && scaled.fract().abs() == 0.5;
    if !exact_tie {
        return format!("{:.*}", digits as usize, x);
    }
    let n = (scaled.abs().floor() + 1.0) as u128;
    let width = digits as usize + 1;
    let s = format!("{n:0width$}");
    let (int, frac) = s.split_at(s.len() - digits as usize);
    let sign = if x < 0.0 { "-" } else { "" };
    if digits == 0 { format!("{sign}{int}") } else { format!("{sign}{int}.{frac}") }
}

/// Serialize a JS number the way `JSON.stringify` would (integers without
/// a trailing `.0`, non-finite as `null`).
pub fn num(x: f64) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        return Value::from(x as i64);
    }
    Value::from(x)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn to_fixed_matches_js_rounding() {
        assert_eq!(to_fixed(0.015625, 5), "0.01563");
        assert_eq!(to_fixed(-0.015625, 5), "-0.01563");
        assert_eq!(to_fixed(40.123454, 5), "40.12345");
        assert_eq!(to_fixed(-76.5, 5), "-76.50000");
        assert_eq!(to_fixed(-0.0, 5), "0.00000");
        assert_eq!(to_fixed(-0.000001, 5), "-0.00000");
    }

    #[test]
    fn coercions_match_js() {
        assert_eq!(to_number(Some(&json!(" 12 "))), 12.0);
        assert_eq!(to_number(Some(&json!(""))), 0.0);
        assert!(to_number(Some(&json!("abc"))).is_nan());
        assert!(to_number(None).is_nan());
        assert_eq!(to_number(Some(&Value::Null)), 0.0);
        assert_eq!(parse_float(Some(&json!("12.5abc"))), 12.5);
        assert!(parse_float(Some(&json!("abc"))).is_nan());
        assert_eq!(number_to_string(1.0), "1");
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(-0.5), "-0.5");
        assert_eq!(to_string(Some(&json!(99))), "99");
        assert_eq!(num(20.0), json!(20));
    }
}
