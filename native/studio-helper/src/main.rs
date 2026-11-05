//! Sentry Studio native helper.
//!
//! A small command-line program that Electron's main process runs for the two
//! CPU-heavy parsing jobs, instead of doing them in JavaScript:
//!
//!   sentry-studio-helper drives <drive-data.json>
//!       Stream-parse a SentryUSB drive-data.json and group it into drives
//!       (the same result as src/main/driveLoadWorker.js + driveTagsWorker.js).
//!   sentry-studio-helper sei <clip.mp4>
//!       Extract SEI telemetry (the same result as extractSeiFromBuffer in
//!       src/renderer/scripts/core/seiExtractor.js).
//!   sentry-studio-helper version
//!
//! It reads only the file it is given and writes only to stdout/stderr. Any
//! failure exits non-zero, and Studio then falls back to its JavaScript code.
//!
//! `drives` output (binary, little-endian), so per-drive GPS points arrive as
//! raw doubles that Electron wraps in Float64Arrays without parsing:
//!   b"SSH1"  u64 json_len  json  f64[...]
//! where json = { driveCount, routeCount, routesLen, drives: [light drive],
//! fsdEvents: [[event]], pointCounts: [n] } and the doubles are each drive's
//! points ([lat, lng, 0, speed, ap] per point) back to back.
//!
//! `sei` output is the JSON of { seiData, mapPath }.

mod crmath;
mod crmath_tables;
mod drive_data;
mod sei;

use std::io::{BufWriter, Write};
use std::path::Path;
use std::process::ExitCode;

use anyhow::{bail, Result};
use serde_json::{json, Value};

const DRIVES_MAGIC: &[u8; 4] = b"SSH1";

fn run_drives(path: &Path) -> Result<()> {
    let store = drive_data::read_store_data(path)?;
    let grouped = drive_data::group_store_data(store);
    let header = json!({
        "driveCount": grouped.drives.len(),
        "routeCount": grouped.route_count,
        "routesLen": grouped.routes_len,
        "drives": grouped.drives.iter().map(|d| Value::Object(d.light.clone())).collect::<Vec<_>>(),
        "fsdEvents": grouped.drives.iter().map(|d| Value::Array(d.fsd_events.clone())).collect::<Vec<_>>(),
        "pointCounts": grouped.drives.iter().map(|d| d.points.len()).collect::<Vec<_>>(),
    });
    let header = serde_json::to_vec(&header)?;
    let stdout = std::io::stdout();
    let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());
    out.write_all(DRIVES_MAGIC)?;
    out.write_all(&(header.len() as u64).to_le_bytes())?;
    out.write_all(&header)?;
    for d in &grouped.drives {
        for p in &d.points {
            for v in p {
                out.write_all(&v.to_le_bytes())?;
            }
        }
    }
    out.flush()?;
    Ok(())
}

fn run_sei(path: &Path) -> Result<()> {
    let result = sei::extract_from_file(path)?;
    let stdout = std::io::stdout();
    let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());
    serde_json::to_writer(&mut out, &result)?;
    out.flush()?;
    Ok(())
}

fn run(args: &[String]) -> Result<()> {
    match args {
        [cmd, file] if cmd == "drives" => run_drives(Path::new(file)),
        [cmd, file] if cmd == "sei" => run_sei(Path::new(file)),
        [cmd] if cmd == "version" => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => bail!("usage: sentry-studio-helper drives <drive-data.json> | sei <clip.mp4> | version"),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("sentry-studio-helper: {err:#}");
            ExitCode::FAILURE
        }
    }
}
