//! From Sentry Drive (src-tauri/src/geocode/matching.rs), unchanged apart from
//! imports: how a reverse-geocoding result becomes a trustworthy label.
//! Pure label selection, provider settings normalization, and cache-record
//! rules.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};
use url::Url;

use super::js;
use super::calc::{geodesic_m, js_round};

pub const DEFAULT_ENDPOINT: &str = "https://nominatim.openstreetmap.org";
/// ~1.1 m grouping: house-level distinct while absorbing GPS jitter.
const KEY_DECIMALS: i32 = 5;
const ADDRESS_POINT_TRUST_M: f64 = 25.0;
const POI_POINT_TRUST_M: f64 = 30.0;
const ENTRANCE_TRUST_M: f64 = 20.0;
const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

const POI_CATEGORIES: &[&str] = &[
    "aeroway", "amenity", "club", "craft", "healthcare", "historic", "leisure",
    "office", "shop", "sport", "tourism",
];
const POI_TYPE_DENYLIST: &[&str] = &[
    "bench", "bicycle_parking", "drinking_water", "fire_hydrant", "give_way",
    "guidepost", "information", "post_box", "recycling", "street_lamp",
    "telephone", "traffic_signals", "vending_machine", "waste_basket",
    "waste_disposal",
];

// ---------------------------------------------------------------- settings

pub fn normalize_endpoint(value: Option<&Value>) -> String {
    let raw = match value {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim(),
        _ => DEFAULT_ENDPOINT,
    };
    let Ok(mut url) = Url::parse(raw) else { return DEFAULT_ENDPOINT.into() };
    if !matches!(url.scheme(), "https" | "http") {
        return DEFAULT_ENDPOINT.into();
    }
    url.set_fragment(None);
    url.set_query(None);
    static TRAILING: OnceLock<Regex> = OnceLock::new();
    let re = TRAILING.get_or_init(|| Regex::new(r"/(?:reverse)?/?$").expect("valid regex"));
    let path = re.replace(url.path(), "").into_owned();
    url.set_path(if path.is_empty() { "/" } else { &path });
    let s = url.to_string();
    s.strip_suffix('/').map(str::to_owned).unwrap_or(s)
}

pub fn normalize_endpoint_str(value: &str) -> String {
    normalize_endpoint(Some(&Value::String(value.to_owned())))
}

pub fn normalize_language(value: Option<&Value>, fallback: &str) -> String {
    let language: String = match value {
        Some(Value::String(s)) => s.trim().chars().take(80).collect(),
        _ => String::new(),
    };
    if language.bytes().all(|b| b.is_ascii_alphanumeric() || b",;=._* -".contains(&b)) {
        language
    } else {
        fallback.to_owned()
    }
}

pub fn key_for(lat: f64, lng: f64) -> String {
    format!("{},{}", js::to_fixed(lat, KEY_DECIMALS), js::to_fixed(lng, KEY_DECIMALS))
}

pub fn build_reverse_url(endpoint: &str, lat: f64, lng: f64, zoom: u8, layer: Option<&str>) -> Option<Url> {
    let mut url = Url::parse(&format!("{endpoint}/reverse")).ok()?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("format", "jsonv2");
        q.append_pair("lat", &js::number_to_string(lat));
        q.append_pair("lon", &js::number_to_string(lng));
        q.append_pair("zoom", &zoom.to_string());
        q.append_pair("addressdetails", "1");
        q.append_pair("entrances", "1");
        if zoom == 18 {
            q.append_pair("polygon_geojson", "1");
        }
        if let Some(layer) = layer.filter(|l| !l.is_empty()) {
            q.append_pair("layer", layer);
        }
    }
    Some(url)
}

// ------------------------------------------------------------ feature tests

fn lower_field(j: &Value, keys: &[&str]) -> String {
    js::first_truthy(Some(j), keys)
        .map(|v| js::to_string(Some(v)).to_lowercase())
        .unwrap_or_default()
}

fn feature_class(j: &Value) -> String {
    lower_field(j, &["category", "class"])
}

fn is_area_feature(j: &Value) -> bool {
    matches!(lower_field(j, &["osm_type"]).as_str(), "way" | "relation")
}

fn is_address_feature(j: &Value) -> bool {
    let category = feature_class(j);
    let address_type = lower_field(j, &["addresstype"]);
    category == "place"
        || category == "building"
        || address_type == "house"
        || address_type == "building"
        || lower_field(j, &["type"]) == "house"
}

pub fn result_layer(j: &Value) -> &'static str {
    let category = feature_class(j);
    if ["place", "building", "highway", "boundary", "landuse"].contains(&category.as_str()) || is_address_feature(j) {
        "address"
    } else {
        "poi"
    }
}

fn is_meaningful_poi(j: &Value) -> bool {
    POI_CATEGORIES.contains(&feature_class(j).as_str())
        && !POI_TYPE_DENYLIST.contains(&lower_field(j, &["type"]).as_str())
}

fn result_distance_m(j: &Value, lat: f64, lng: f64) -> f64 {
    let rlat = js::parse_float(j.get("lat"));
    let rlng = js::parse_float(j.get("lon"));
    if !rlat.is_finite() || !rlng.is_finite() {
        return f64::INFINITY;
    }
    geodesic_m(lat, lng, rlat, rlng)
}

// ------------------------------------------------------------- geometry

fn point_on_segment(x: f64, y: f64, ax: f64, ay: f64, bx: f64, by: f64) -> bool {
    let cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if cross.abs() > 1e-12 {
        return false;
    }
    x >= ax.min(bx) - 1e-12 && x <= ax.max(bx) + 1e-12 && y >= ay.min(by) - 1e-12 && y <= ay.max(by) + 1e-12
}

/// 1 inside, 0 outside, 2 on the boundary.
fn ring_relation(lng: f64, lat: f64, ring: Option<&Value>) -> u8 {
    let Some(ring) = ring.and_then(Value::as_array) else { return 0 };
    if ring.len() < 4 {
        return 0;
    }
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (Some(a), Some(b)) = (ring[j].as_array(), ring[i].as_array()) else { return 0 };
        let (ax, ay) = (js::to_number(a.first()), js::to_number(a.get(1)));
        let (bx, by) = (js::to_number(b.first()), js::to_number(b.get(1)));
        if ![ax, ay, bx, by].iter().all(|v| v.is_finite()) {
            return 0;
        }
        if point_on_segment(lng, lat, ax, ay, bx, by) {
            return 2;
        }
        if (ay > lat) != (by > lat) && lng < ((bx - ax) * (lat - ay)) / (by - ay) + ax {
            inside = !inside;
        }
        j = i;
    }
    u8::from(inside)
}

fn polygon_contains_point(coordinates: Option<&Value>, lat: f64, lng: f64) -> bool {
    let Some(rings) = coordinates.and_then(Value::as_array).filter(|r| !r.is_empty()) else { return false };
    if ring_relation(lng, lat, rings.first()) == 0 {
        return false;
    }
    for hole in &rings[1..] {
        match ring_relation(lng, lat, Some(hole)) {
            1 => return false,
            2 => return true,
            _ => {}
        }
    }
    true
}

pub fn geometry_contains_point(geometry: Option<&Value>, lat: f64, lng: f64) -> bool {
    let Some(g) = geometry.filter(|g| g.is_object()) else { return false };
    match g.get("type").and_then(Value::as_str) {
        Some("Polygon") => polygon_contains_point(g.get("coordinates"), lat, lng),
        Some("MultiPolygon") => g
            .get("coordinates")
            .and_then(Value::as_array)
            .is_some_and(|ps| ps.iter().any(|p| polygon_contains_point(Some(p), lat, lng))),
        Some("GeometryCollection") => g
            .get("geometries")
            .and_then(Value::as_array)
            .is_some_and(|parts| parts.iter().any(|p| geometry_contains_point(Some(p), lat, lng))),
        _ => false,
    }
}

fn closest_entrance_distance_m(j: &Value, lat: f64, lng: f64) -> f64 {
    let Some(entrances) = j.get("entrances").and_then(Value::as_array) else { return f64::INFINITY };
    entrances
        .iter()
        .filter_map(|e| {
            let (elat, elng) = (js::to_number(e.get("lat")), js::to_number(e.get("lon")));
            (elat.is_finite() && elng.is_finite()).then(|| geodesic_m(lat, lng, elat, elng))
        })
        .fold(f64::INFINITY, f64::min)
}

/// Area centroids can be far from a legitimately parked coordinate, so area
/// names count only when the OSM geometry (or a mapped entrance) covers the
/// query point; point features use conservative distances.
fn feature_is_trusted(j: &Value, lat: f64, lng: f64, point_limit_m: f64, query_accuracy_m: f64) -> bool {
    if is_area_feature(j) {
        if geometry_contains_point(j.get("geojson"), lat, lng) {
            return true;
        }
        let entrance_limit = ENTRANCE_TRUST_M + query_accuracy_m.clamp(0.0, 10.0);
        return closest_entrance_distance_m(j, lat, lng) <= entrance_limit;
    }
    result_distance_m(j, lat, lng) <= point_limit_m
}

fn osm_feature_id(j: &Value) -> Option<String> {
    let osm_type = j.get("osm_type");
    let osm_id = j.get("osm_id").filter(|v| !v.is_null());
    (js::truthy(osm_type) && osm_id.is_some())
        .then(|| format!("{}/{}", js::to_string(osm_type), js::to_string(osm_id)))
}

// --------------------------------------------------------------- matches

#[derive(Clone, Debug, PartialEq)]
pub struct Match {
    pub label: String,
    pub feature_type: &'static str,
    pub confidence: &'static str,
    pub distance_m: Option<f64>,
    pub osm_id: Option<String>,
    pub query_accuracy_m: Option<f64>,
}

pub fn round1(x: f64) -> f64 {
    js_round(x * 10.0) / 10.0
}

fn round1_finite(x: f64) -> Option<f64> {
    x.is_finite().then(|| round1(x))
}

pub fn confidence_for_accuracy(confidence: &'static str, query_accuracy_m: f64) -> &'static str {
    if query_accuracy_m.is_nan() || query_accuracy_m <= 15.0 {
        return confidence;
    }
    if query_accuracy_m > 30.0 {
        return "low";
    }
    if confidence == "high" { "medium" } else { "low" }
}

fn match_result(
    j: &Value,
    label: String,
    feature_type: &'static str,
    confidence: &'static str,
    lat: f64,
    lng: f64,
    query_accuracy_m: f64,
) -> Match {
    Match {
        label,
        feature_type,
        confidence: confidence_for_accuracy(confidence, query_accuracy_m),
        distance_m: round1_finite(result_distance_m(j, lat, lng)),
        osm_id: osm_feature_id(j),
        query_accuracy_m: round1_finite(query_accuracy_m),
    }
}

fn format_house_address(j: &Value, road: &str, house_number: &str) -> String {
    let display = match j.get("display_name") {
        v if js::truthy(v) => js::to_string(v),
        _ => String::new(),
    };
    let parts: Vec<&str> = display.split(',').map(str::trim).collect();
    let number_index = parts.iter().position(|p| *p == house_number);
    let road_lower = road.to_lowercase();
    let road_index = parts.iter().position(|p| p.to_lowercase() == road_lower);
    match (road_index, number_index) {
        (Some(r), Some(n)) if r < n => format!("{road} {house_number}"),
        _ => format!("{house_number} {road}"),
    }
}

fn display_name_head(j: &Value) -> Option<String> {
    match j.get("display_name") {
        Some(Value::String(s)) if !s.is_empty() => Some(s.split(',').next().unwrap_or("").trim().to_owned()),
        _ => None,
    }
}

/// Prefer POI, verified address, street, then locality, keeping the evidence
/// used to choose the label.
pub fn label_match(j: &Value, lat: f64, lng: f64, query_accuracy_m: f64) -> Option<Match> {
    if !js::truthy(Some(j)) {
        return None;
    }
    let address = j.get("address").filter(|a| js::truthy(Some(a)));
    let is_address = is_address_feature(j);
    let name_limit_m = if is_address { ADDRESS_POINT_TRUST_M } else { POI_POINT_TRUST_M };
    let name_eligible = is_address || is_meaningful_poi(j);
    let name = j.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty());
    if let Some(name) = name.filter(|_| name_eligible) {
        if feature_is_trusted(j, lat, lng, name_limit_m, query_accuracy_m) {
            let feature_type = if is_area_feature(j) {
                if feature_class(j) == "building" { "building" } else { "area" }
            } else if is_address {
                "address-point"
            } else {
                "poi"
            };
            return Some(match_result(j, name.to_owned(), feature_type, "high", lat, lng, query_accuracy_m));
        }
    }
    let road = js::first_truthy(address, &["road", "pedestrian", "footway", "path", "cycleway"])
        .map(|v| js::to_string(Some(v)));
    let house_number = address.and_then(|a| a.get("house_number")).filter(|v| js::truthy(Some(v)));
    if let (Some(road), Some(house_number)) = (&road, house_number) {
        if feature_is_trusted(j, lat, lng, ADDRESS_POINT_TRUST_M, query_accuracy_m) {
            let feature_type = if is_area_feature(j) { "building" } else { "address-point" };
            let label = format_house_address(j, road, &js::to_string(Some(house_number)));
            return Some(match_result(j, label, feature_type, "high", lat, lng, query_accuracy_m));
        }
    }
    if let Some(road) = road {
        return Some(match_result(j, road, "road", "medium", lat, lng, query_accuracy_m));
    }
    let place = js::first_truthy(
        address,
        &["neighbourhood", "suburb", "hamlet", "village", "town", "city", "municipality", "county"],
    );
    if let Some(place) = place {
        return Some(match_result(j, js::to_string(Some(place)), "locality", "low", lat, lng, query_accuracy_m));
    }
    display_name_head(j).map(|label| match_result(j, label, "locality", "low", lat, lng, query_accuracy_m))
}

pub fn city_match(j: &Value, lat: f64, lng: f64, query_accuracy_m: f64) -> Option<Match> {
    if !js::truthy(Some(j)) {
        return None;
    }
    let address = j.get("address").filter(|a| js::truthy(Some(a)));
    let place = js::first_truthy(address, &["city", "town", "village", "municipality", "hamlet", "county"]);
    if let Some(place) = place {
        return Some(match_result(j, js::to_string(Some(place)), "locality", "low", lat, lng, query_accuracy_m));
    }
    display_name_head(j).map(|label| match_result(j, label, "locality", "low", lat, lng, query_accuracy_m))
}

fn confidence_rank(m: &Match) -> u8 {
    match m.confidence {
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 0,
    }
}

fn feature_rank(m: &Match) -> u8 {
    match m.feature_type {
        "known-place" => 7,
        "poi" => 6,
        "building" | "address-point" => 5,
        "area" => 4,
        "road" => 2,
        "locality" => 1,
        _ => 0,
    }
}

pub fn choose_better_match(first: Option<Match>, second: Option<Match>) -> Option<Match> {
    let Some(first) = first else { return second };
    let Some(second) = second else { return Some(first) };
    let by_confidence = confidence_rank(&second).cmp(&confidence_rank(&first));
    if by_confidence.is_ne() {
        return Some(if by_confidence.is_gt() { second } else { first });
    }
    let by_feature = feature_rank(&second).cmp(&feature_rank(&first));
    if by_feature.is_ne() {
        return Some(if by_feature.is_gt() { second } else { first });
    }
    let d = |m: &Match| m.distance_m.unwrap_or(f64::INFINITY);
    Some(if d(&second) < d(&first) { second } else { first })
}

pub fn known_place_match(label: &str, distance_m: f64, source: &str, query_accuracy_m: f64) -> Value {
    json!({
        "label": label,
        "featureType": "known-place",
        "confidence": confidence_for_accuracy("high", query_accuracy_m),
        "distanceM": js::num(distance_m),
        "osmId": null,
        "queryAccuracyM": round1_finite(query_accuracy_m).map(js::num),
        "source": source,
    })
}

// ----------------------------------------------------------- cache records

pub fn cache_record(m: Option<&Match>, resolved_at: i64, provider: &str) -> Value {
    json!({
        "label": m.map(|m| m.label.clone()),
        "featureType": m.map_or("none", |m| m.feature_type),
        "confidence": m.map_or("low", |m| m.confidence),
        "distanceM": m.and_then(|m| m.distance_m).map(js::num),
        "osmId": m.and_then(|m| m.osm_id.clone()),
        "queryAccuracyM": m.and_then(|m| m.query_accuracy_m).map(js::num),
        "source": "provider",
        "provider": normalize_endpoint_str(provider),
        "resolvedAt": resolved_at,
    })
}

pub fn cache_record_is_fresh(record: Option<&Value>, now: i64, provider: &str) -> bool {
    let Some(record) = record.filter(|r| r.is_object()) else { return false };
    let Some(resolved_at) = record.get("resolvedAt").and_then(Value::as_f64) else { return false };
    let label = record.get("label");
    if !matches!(label, Some(Value::Null | Value::String(_))) {
        return false;
    }
    if normalize_endpoint(record.get("provider")) != normalize_endpoint_str(provider) {
        return false;
    }
    let ttl_days = if matches!(label, Some(Value::Null)) {
        30.0
    } else {
        match record.get("confidence").and_then(Value::as_str) {
            Some("high") => 365.0,
            Some("medium") => 180.0,
            Some("miss") => 30.0,
            _ => 90.0,
        }
    };
    let age = now as f64 - resolved_at;
    age >= 0.0 && age < ttl_days * DAY_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const QLAT: f64 = 0.0;
    const QLNG: f64 = 0.0;

    fn short_label(j: &Value) -> Option<String> {
        label_match(j, QLAT, QLNG, 0.0).map(|m| m.label)
    }

    fn point_result(lat: f64, category: &str, name: Option<&str>, house_number: Option<&str>) -> Value {
        let mut address = json!({ "road": "Main Street" });
        if let Some(n) = house_number {
            address["house_number"] = json!(n);
        }
        let kind = if house_number.is_some() { "house" } else { category };
        let mut j = json!({
            "lat": js::number_to_string(lat),
            "lon": "0",
            "osm_type": "node",
            "category": category,
            "type": kind,
            "addresstype": kind,
            "address": address,
        });
        if let Some(name) = name {
            j["name"] = json!(name);
        }
        j
    }

    #[test]
    fn trusts_address_points_within_25m() {
        let nearby = point_result(0.00018, "place", None, Some("10"));
        let farther = point_result(0.00027, "place", None, Some("12"));
        assert_eq!(short_label(&nearby).as_deref(), Some("10 Main Street"));
        assert_eq!(short_label(&farther).as_deref(), Some("Main Street"));
    }

    #[test]
    fn trusts_point_pois_within_30m() {
        let nearby = point_result(0.00025, "amenity", Some("Corner Cafe"), None);
        let farther = point_result(0.00032, "amenity", Some("Wrong Cafe"), None);
        assert_eq!(short_label(&nearby).as_deref(), Some("Corner Cafe"));
        assert_eq!(short_label(&farther).as_deref(), Some("Main Street"));
    }

    #[test]
    fn rejects_incidental_map_objects() {
        let mut bench = point_result(0.00005, "amenity", Some("Memorial Bench"), None);
        bench["type"] = json!("bench");
        assert_eq!(short_label(&bench).as_deref(), Some("Main Street"));
    }

    #[test]
    fn trusts_building_areas_only_when_geometry_contains_point() {
        let building = json!({
            "lat": "0.0005", "lon": "0.0005", "osm_type": "way", "osm_id": 42,
            "category": "building", "type": "commercial", "name": "Market Hall",
            "boundingbox": ["-0.0001", "0.001", "-0.0001", "0.001"],
            "geojson": { "type": "Polygon", "coordinates": [[
                [-0.001, -0.001], [0.001, -0.001], [0.001, 0.001],
                [-0.001, 0.001], [-0.001, -0.001],
            ]] },
            "address": { "road": "Main Street" },
        });
        let mut adjacent = building.clone();
        adjacent["name"] = json!("Adjacent Market");
        adjacent["geojson"] = json!({ "type": "Polygon", "coordinates": [[
            [-0.001, -0.001], [0.001, -0.001], [0.001, -0.0002],
            [-0.0002, -0.0002], [-0.0002, 0.001], [-0.001, 0.001],
            [-0.001, -0.001],
        ]] });
        assert_eq!(short_label(&building).as_deref(), Some("Market Hall"));
        assert_eq!(short_label(&adjacent).as_deref(), Some("Main Street"));
    }

    #[test]
    fn polygon_containment_handles_holes_and_multipolygons() {
        let with_hole = json!({ "type": "Polygon", "coordinates": [
            [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]],
            [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]],
        ] });
        let multi = json!({ "type": "MultiPolygon", "coordinates": [
            [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
            [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
        ] });
        assert!(!geometry_contains_point(Some(&with_hole), 0.0, 0.0));
        assert!(geometry_contains_point(Some(&with_hole), 0.0, 1.0));
        assert!(geometry_contains_point(Some(&multi), 0.0, 0.0));
    }

    #[test]
    fn trusts_area_name_with_nearby_entrance() {
        let building = json!({
            "lat": "0.001", "lon": "0.001", "osm_type": "way", "category": "building",
            "type": "commercial", "name": "Entrance Market", "address": { "road": "Main Street" },
            "entrances": [{ "lat": "0.00012", "lon": "0" }],
        });
        assert_eq!(short_label(&building).as_deref(), Some("Entrance Market"));
    }

    #[test]
    fn endpoint_uncertainty_lowers_confidence() {
        let cafe = point_result(0.00005, "amenity", Some("Corner Cafe"), None);
        assert_eq!(label_match(&cafe, QLAT, QLNG, 20.0).unwrap().confidence, "medium");
        assert_eq!(label_match(&cafe, QLAT, QLNG, 35.0).unwrap().confidence, "low");
    }

    #[test]
    fn house_number_order_follows_display_name() {
        let mut house = point_result(0.00005, "place", None, Some("10"));
        house["display_name"] = json!("Main Street, 10, Sampletown");
        assert_eq!(short_label(&house).as_deref(), Some("Main Street 10"));
    }

    #[test]
    fn comparison_prefers_confidence_then_specificity() {
        let m = |label: &str, confidence, feature_type, d| Match {
            label: label.into(),
            feature_type,
            confidence,
            distance_m: Some(d),
            osm_id: None,
            query_accuracy_m: None,
        };
        let road = m("Main Street", "medium", "road", 2.0);
        let poi = m("Corner Cafe", "high", "poi", 20.0);
        let building = m("Market Hall", "high", "building", 5.0);
        assert_eq!(choose_better_match(Some(road), Some(poi.clone())), Some(poi.clone()));
        assert_eq!(choose_better_match(Some(building), Some(poi.clone())), Some(poi));
    }

    #[test]
    fn provider_url_supports_base_paths_entrances_polygons_layers() {
        let endpoint = normalize_endpoint(Some(&json!("https://geo.example/base/reverse")));
        assert_eq!(endpoint, "https://geo.example/base");
        assert_eq!(normalize_language(Some(&json!("fr")), ""), "fr");
        let url = build_reverse_url(&endpoint, 1.0, 2.0, 18, Some("poi")).unwrap();
        assert_eq!(format!("{}{}", url.origin().ascii_serialization(), url.path()), "https://geo.example/base/reverse");
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["entrances"], "1");
        assert_eq!(q["polygon_geojson"], "1");
        assert_eq!(q["layer"], "poi");
        assert_eq!(q["lat"], "1");
        assert_eq!(q["lon"], "2");
        let city = build_reverse_url(DEFAULT_ENDPOINT, 1.5, 2.0, 10, None).unwrap();
        assert_eq!(
            city.as_str(),
            "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=1.5&lon=2&zoom=10&addressdetails=1&entrances=1"
        );
    }

    #[test]
    fn settings_normalization() {
        assert_eq!(normalize_endpoint(None), DEFAULT_ENDPOINT);
        assert_eq!(normalize_endpoint(Some(&json!("   "))), DEFAULT_ENDPOINT);
        assert_eq!(normalize_endpoint(Some(&json!("ftp://geo.example"))), DEFAULT_ENDPOINT);
        assert_eq!(normalize_endpoint(Some(&json!("not a url"))), DEFAULT_ENDPOINT);
        assert_eq!(normalize_endpoint(Some(&json!("https://geo.example/reverse/?x=1#h"))), "https://geo.example");
        assert_eq!(normalize_endpoint(Some(&json!(" http://localhost:8080/nominatim/ "))), "http://localhost:8080/nominatim");
        assert_eq!(normalize_language(Some(&json!(" en-US,en;q=0.9 ")), ""), "en-US,en;q=0.9");
        assert_eq!(normalize_language(Some(&json!("en\r\nX: y")), "de"), "de");
        assert_eq!(normalize_language(Some(&json!(5)), "de"), "");
        assert_eq!(key_for(40.123456, -76.000004), "40.12346,-76.00000");
    }

    #[test]
    fn cache_records_retain_provenance_and_expire_by_confidence() {
        let m = label_match(
            &json!({
                "lat": "0.00018", "lon": "0", "osm_type": "node", "osm_id": 99,
                "category": "place", "type": "house", "addresstype": "house",
                "address": { "house_number": "10", "road": "Main Street" },
            }),
            QLAT,
            QLNG,
            0.0,
        )
        .unwrap();
        let resolved_at: i64 = 1_767_225_600_000; // 2026-01-01T00:00:00Z
        let record = cache_record(Some(&m), resolved_at, DEFAULT_ENDPOINT);
        assert_eq!(
            record,
            json!({
                "label": "10 Main Street",
                "featureType": "address-point",
                "confidence": "high",
                "distanceM": js::num(m.distance_m.unwrap()),
                "osmId": "node/99",
                "queryAccuracyM": 0,
                "source": "provider",
                "provider": "https://nominatim.openstreetmap.org",
                "resolvedAt": resolved_at,
            })
        );
        let day = 86_400_000;
        assert!(cache_record_is_fresh(Some(&record), resolved_at + 364 * day, DEFAULT_ENDPOINT));
        assert!(!cache_record_is_fresh(Some(&record), resolved_at + 366 * day, DEFAULT_ENDPOINT));

        let miss = cache_record(None, resolved_at, DEFAULT_ENDPOINT);
        assert!(cache_record_is_fresh(Some(&miss), resolved_at + 29 * day, DEFAULT_ENDPOINT));
        assert!(!cache_record_is_fresh(Some(&miss), resolved_at + 31 * day, DEFAULT_ENDPOINT));
        assert!(!cache_record_is_fresh(Some(&record), resolved_at + 1, "https://geo.example"));
        assert!(!cache_record_is_fresh(Some(&record), resolved_at - 1, DEFAULT_ENDPOINT));
    }
}
