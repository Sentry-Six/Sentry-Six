//! Development checks that run the real app pieces without a window (the
//! `--*-check` commands; see main.rs and the README).

use crate::player::Player;
use crate::{decode, library, mp4, reader};

pub fn decode_check(path: &std::path::Path) {
    let started = std::time::Instant::now();
    let run = || -> anyhow::Result<()> {
        let file = std::fs::File::open(path)?;
        let track = mp4::read_video_track(&file)?;
        println!(
            "{}: {}x{}, {} frames, {:.2} s, {} keyframes, index read in {} ms",
            path.display(),
            track.width,
            track.height,
            track.samples.len(),
            track.duration,
            track.samples.iter().filter(|s| s.sync).count(),
            started.elapsed().as_millis()
        );
        let mut decoder = decode::Decoder::new(&track)?;
        let mut reader = reader::WindowReader::new(file)?;
        let (mut ok, mut dropped, mut errors) = (0usize, 0usize, 0usize);
        let mut out_size = (0, 0);
        let mut checksum = 0u64;
        let (mut with_telemetry, mut top_speed, mut autopilot_frames) = (0usize, 0f64, 0usize);
        for s in &track.samples {
            let data = reader.read(s.offset, s.size as usize)?;
            if let Some(t) = crate::telemetry::sample_telemetry(data, track.nal_length_size as usize, track.codec) {
                with_telemetry += 1;
                top_speed = top_speed.max(t.vehicle_speed_mps * 3.6);
                if matches!(t.autopilot_state, 1 | 2) {
                    autopilot_frames += 1;
                }
            }
            match decoder.decode(data) {
                Ok(Some(f)) => {
                    ok += 1;
                    out_size = (f.width(), f.height());
                    if ok % 300 == 1 {
                        // Read a few pixels so a blank picture would show up.
                        checksum += f.with_planes(|y, _| y.data.iter().step_by(4099).map(|&b| b as u64).sum::<u64>()).unwrap_or(0);
                    }
                }
                Ok(None) => dropped += 1,
                Err(e) => {
                    errors += 1;
                    if errors <= 3 {
                        println!("  frame error: {e:#}");
                    }
                }
            }
        }
        println!("  telemetry in {with_telemetry} frames, top speed {top_speed:.0} km/h, Autopilot on in {autopilot_frames} frames");
        println!(
            "  decoded {ok}, dropped {dropped}, errors {errors}; output {}x{}; luma sample sum {checksum}; {} ms total",
            out_size.0,
            out_size.1,
            started.elapsed().as_millis()
        );
        Ok(())
    };
    if let Err(e) = run() {
        println!("{}: {e:#}", path.display());
    }
}

pub fn skip_check(dir: &std::path::Path, start: f64, presses: usize) {
    use std::time::{Duration, Instant};
    let collections = match library::scan(dir) {
        Ok(c) => c,
        Err(e) => return println!("{e:#}"),
    };
    let segments = match library::load_segments(&collections[0]) {
        Ok(s) => s,
        Err(e) => return println!("{e:#}"),
    };
    let mut p = Player::new();
    p.load(segments, start);
    p.set_playing(true);
    let t0 = Instant::now();
    let pictures = |p: &Player| -> String {
        (0..6).filter_map(|i| p.shown(i).map(|s| format!("{:.1}", s.pts))).collect::<Vec<_>>().join(" ")
    };
    let run_for = |p: &mut Player, ms: u64, log_every: u64, t0: Instant| {
        let end = Instant::now() + Duration::from_millis(ms);
        let mut next_log = Instant::now();
        while Instant::now() < end {
            p.tick();
            if Instant::now() >= next_log {
                println!("  {:>5} ms  position {:6.2}  pictures [{}]", t0.elapsed().as_millis(), p.position(), pictures(p));
                next_log += Duration::from_millis(log_every);
            }
            std::thread::sleep(Duration::from_millis(8));
        }
    };
    println!("playing from {start} s");
    run_for(&mut p, 1500, 500, t0);
    let mut target = 0.0;
    for k in 0..presses {
        target = p.position() + 10.0;
        p.seek(target);
        println!("  {:>5} ms  press +10s #{} -> {:.2}", t0.elapsed().as_millis(), k + 1, target);
        run_for(&mut p, 100, 1000, t0);
    }
    // Pictures carry times within their own clip.
    let local_target = p.local_time() - (p.position() - target);
    let pressed = Instant::now();
    let mut caught_up = None;
    let end = pressed + Duration::from_secs(8);
    let mut next_log = Instant::now();
    while Instant::now() < end {
        p.tick();
        // (A camera whose clip can't be played has nothing to show.)
        let all = (0..6)
            .filter(|&i| p.slot_active(i) && p.slot_error(i).is_none())
            .all(|i| p.shown(i).is_some_and(|s| s.pts >= local_target - 0.2));
        if all && caught_up.is_none() {
            caught_up = Some(pressed.elapsed().as_millis());
        }
        if Instant::now() >= next_log {
            println!("  {:>5} ms  position {:6.2}  pictures [{}]", t0.elapsed().as_millis(), p.position(), pictures(&p));
            next_log += Duration::from_millis(500);
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    let total = p.total() as u64;
    println!("collection length {}:{:02}:{:02}", total / 3600, total / 60 % 60, total % 60);
    match caught_up {
        Some(ms) => println!("every camera showed {target:.1} s {ms} ms after the last press"),
        None => println!("cameras had not reached {target:.1} s 8 s after the last press"),
    }
}

pub fn seek_check(path: &std::path::Path, at: f64) {
    let run = || -> anyhow::Result<()> {
        let file = std::fs::File::open(path)?;
        let track = mp4::read_video_track(&file)?;
        let mut decoder = decode::Decoder::new(&track)?;
        let mut reader = reader::WindowReader::new(file)?;
        // Play the first second, as if the tile was already running.
        for s in track.samples.iter().take(36) {
            let data = reader.read(s.offset, s.size as usize)?;
            decoder.decode(data)?;
        }
        let started = std::time::Instant::now();
        let target = track.sample_at(at);
        let first = track.sync_at_or_before(target);
        for s in &track.samples[first..=target] {
            let data = reader.read(s.offset, s.size as usize)?;
            decoder.decode(data)?;
        }
        println!(
            "{}: jump to {at:.1} s decoded {} frames from the keyframe, first picture after {} ms",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
            target - first + 1,
            started.elapsed().as_millis()
        );
        Ok(())
    };
    if let Err(e) = run() {
        println!("{}: {e:#}", path.display());
    }
}

/// `--drives-compare <drive-data.json>`: the streaming loader against the
/// whole-file loader; they must give identical drives.
pub fn drives_compare(file: &std::path::Path) {
    let t = std::time::Instant::now();
    let streamed = match crate::drives::load_streaming(file) {
        Ok(Some(d)) => d,
        Ok(None) => return println!("routes are not in time order: the whole-file loader is used"),
        Err(e) => return println!("{e:#}"),
    };
    println!("streaming: {} drives in {} ms", streamed.len(), t.elapsed().as_millis());
    let t = std::time::Instant::now();
    let whole = match crate::drives::load_whole(file) {
        Ok(d) => d,
        Err(e) => return println!("{e:#}"),
    };
    println!("whole file: {} drives in {} ms", whole.len(), t.elapsed().as_millis());
    let differ = streamed.iter().zip(&whole).filter(|(a, b)| a != b).count();
    if streamed.len() == whole.len() && differ == 0 {
        println!("identical");
    } else {
        println!("DIFFERENT: {} vs {} drives, {differ} differ", streamed.len(), whole.len());
        if let Some((a, b)) = streamed.iter().zip(&whole).find(|(a, b)| a != b) {
            println!("first difference:\n  {a:?}\n  {b:?}");
        }
    }
}

/// `--drives-check <drive-data.json> <TeslaCam folder>`: load the drive
/// history, print the newest drives, and match the newest one to its clips.
pub fn drives_check(file: &std::path::Path, root: &std::path::Path) {
    let t = std::time::Instant::now();
    let list = match crate::drives::load(file) {
        Ok(l) => l,
        Err(e) => return println!("{e:#}"),
    };
    println!("{} drives in {} ms", list.len(), t.elapsed().as_millis());
    for d in list.iter().take(3) {
        println!(
            "  {} {} -> {} | {} | {} | FSD {} {}% | {} clips | {} -> {}",
            d.date,
            crate::drives::clock(d.start_ms, false),
            crate::drives::clock(d.end_ms, false),
            crate::drives::distance(d, true),
            crate::drives::journey_duration(d.duration_ms),
            d.has_fsd,
            d.fsd_percent,
            d.clip_keys.len(),
            crate::drives::gps_label(d.start_point),
            crate::drives::gps_label(d.end_point)
        );
    }
    let collections = library::scan(root).unwrap_or_default();
    let Some(d) = list.first() else { return };
    let keys = crate::drives::key_set(d);
    let mut found = 0;
    for day in crate::drives::clip_days(d) {
        for c in collections.iter().filter(|c| c.kind == library::Kind::Recent && c.day() == day) {
            if let Ok(segs) = library::load_segments(c) {
                found += segs.iter().filter(|s| keys.contains(library::stamp_key(s.start).as_str())).count();
            }
        }
    }
    println!("newest drive: {} of its {} clip minutes found in RecentClips", found, d.clip_keys.len());
}

/// `--hold-check <day folder>`: hold +5 s (a key repeat every 33 ms for
/// 1.3 s) while playing, and report the largest gap between the cameras'
/// pictures seen on any frame.
pub fn hold_check(dir: &std::path::Path) {
    use std::time::{Duration, Instant};
    let collections = library::scan(dir).unwrap_or_default();
    let Some(c) = collections.first() else { return println!("no clips") };
    let segments = library::load_segments(c).unwrap_or_default();
    let mut p = Player::new();
    p.load(segments, 2.0);
    p.set_playing(true);
    let start = Instant::now();
    let mut worst = 0.0f64;
    let mut next_press = start + Duration::from_millis(1000);
    let mut presses = 0;
    while start.elapsed() < Duration::from_millis(5000) {
        if presses < 40 && Instant::now() >= next_press {
            let t = p.position() + 5.0;
            p.seek(t);
            presses += 1;
            next_press += Duration::from_millis(33);
        }
        p.tick();
        let pts: Vec<f64> = (0..6).filter(|&i| p.slot_active(i)).filter_map(|i| p.shown(i).map(|s| s.pts)).collect();
        if pts.len() > 1 {
            let spread = pts.iter().cloned().fold(f64::MIN, f64::max) - pts.iter().cloned().fold(f64::MAX, f64::min);
            worst = worst.max(spread);
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    println!("{presses} presses; final position {:.1} s; largest gap between cameras on any frame: {:.3} s", p.position(), worst);
}

/// `--place-check <lat> <lon>`: one place-name lookup through the app's
/// geocoder and cache.
pub fn place_check(lat: f64, lon: f64) {
    let Some(dir) = crate::settings::data_dir() else { return println!("no data folder") };
    let seeds: Vec<std::path::PathBuf> = crate::settings::sentry_drive_caches();
    let g = crate::geocode::Geocoder::new(dir.join("place-names.json"), &seeds);
    let t = std::time::Instant::now();
    if let Some(hit) = g.cached(lat, lon) {
        return println!("cached: {hit:?}");
    }
    g.show(&[(lat, lon)]);
    g.wait_for_update(0);
    println!("looked up in {} ms: {:?} (cache: {})", t.elapsed().as_millis(), g.cached(lat, lon), dir.join("place-names.json").display());
}

/// `--keyframe-check <clip.mp4>`: start decoding at every keyframe, the
/// way a seek does (a fresh decoder, and the playing decoder jumping
/// there), and report keyframes the decoder rejects.
pub fn keyframe_check(path: &std::path::Path) {
    let run = || -> anyhow::Result<()> {
        let file = std::fs::File::open(path)?;
        let track = mp4::read_video_track(&file)?;
        let mut reader = reader::WindowReader::new(file)?;
        let keys: Vec<usize> = (0..track.samples.len()).filter(|&i| track.samples[i].sync).collect();
        println!("{}: {} frames, keyframes at {:?}", path.display(), track.samples.len(), keys);
        let (mut fresh_bad, mut jump_bad) = (Vec::new(), Vec::new());
        // A fresh decoder starting at each keyframe.
        for &k in &keys {
            let mut d = decode::Decoder::new(&track)?;
            for i in k..(k + 6).min(track.samples.len()) {
                let s = track.samples[i];
                // Open-GOP leading pictures (shown before the keyframe) may fail.
                if let Err(e) = d.decode(reader.read(s.offset, s.size as usize)?) {
                    if s.pts >= track.samples[k].pts {
                        fresh_bad.push((k, i, format!("{e:#}")));
                        break;
                    }
                }
            }
        }
        // One decoder jumping backwards and forwards between keyframes.
        let mut d = decode::Decoder::new(&track)?;
        let order: Vec<usize> = keys.iter().rev().chain(keys.iter()).copied().collect();
        for &k in &order {
            d.reset();
            for i in k..(k + 6).min(track.samples.len()) {
                let s = track.samples[i];
                if let Err(e) = d.decode(reader.read(s.offset, s.size as usize)?) {
                    if s.pts >= track.samples[k].pts {
                        jump_bad.push((k, i, format!("{e:#}")));
                        break;
                    }
                }
            }
        }
        println!("fresh decoder: {} bad of {} keyframes {:?}", fresh_bad.len(), keys.len(), fresh_bad.iter().take(5).collect::<Vec<_>>());
        println!("after a jump: {} bad of {} {:?}", jump_bad.len(), order.len(), jump_bad.iter().take(5).collect::<Vec<_>>());
        Ok(())
    };
    if let Err(e) = run() {
        println!("{}: {e:#}", path.display());
    }
}

/// `--order-check <clip.mp4>`: play a clip through the real player for two
/// seconds, then seek to its middle, checking pictures come in display
/// order (B-frame reordering) and the seek lands where asked.
pub fn order_check(path: &std::path::Path) {
    use crate::library::{Camera, Segment, GRID};
    let mut files = std::collections::BTreeMap::new();
    files.insert(Camera::Front, path.to_path_buf());
    let mut player = crate::player::Player::new();
    player.load(vec![Segment { start: crate::library::LocalSecs::default(), files }], 0.0);
    player.set_playing(true);
    let front = GRID.iter().position(|c| *c == Camera::Front).unwrap();
    let run = |player: &mut crate::player::Player, secs: f64| -> (usize, usize, f64, f64) {
        let started = std::time::Instant::now();
        let (mut seen, mut backwards, mut first, mut last, mut last_id) = (0usize, 0usize, f64::NAN, f64::NAN, 0u64);
        while started.elapsed().as_secs_f64() < secs {
            player.tick();
            if let Some(s) = player.shown(front) {
                if s.id != last_id {
                    last_id = s.id;
                    if first.is_nan() {
                        first = s.pts;
                    }
                    if !last.is_nan() && s.pts < last {
                        backwards += 1;
                    }
                    last = s.pts;
                    seen += 1;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(4));
        }
        (seen, backwards, first, last)
    };
    let (seen, backwards, first, last) = run(&mut player, 2.0);
    println!("play: {seen} pictures, {backwards} out of order, {first:.3} s -> {last:.3} s");
    let middle = player.total() / 2.0;
    player.seek(middle);
    player.set_playing(true);
    // The picture from before the seek stays up until the new one arrives.
    let before = player.shown(front).map(|s| s.id);
    while player.shown(front).map(|s| s.id) == before {
        player.tick();
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    let (seen, backwards, first, last) = run(&mut player, 1.0);
    println!("seek to {middle:.3} s: {seen} pictures, {backwards} out of order, first {first:.3} s, last {last:.3} s");
}

/// `--tiles-check <lat> <lon> <zoom>`: fetch the 3x3 tiles around a point
/// through the map's tile loader (SENTRY_STUDIO_TILES for a test server),
/// and report what was decoded and cached.
pub fn tiles_check(lat: f64, lon: f64, zoom: u8) {
    let dir = std::env::temp_dir().join(format!("sentry-studio-tiles-check-{}", std::process::id()));
    let tiles = crate::map::tiles::Tiles::new(Some(dir.clone()));
    let started = std::time::Instant::now();
    while tiles.index().is_none() && started.elapsed().as_secs() < 10 {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let Some(index) = tiles.index() else { return println!("no tile index") };
    let (x, y) = crate::map::world(lat, lon);
    let n = (1u32 << zoom) as f64;
    let (tx, ty) = ((x * n) as i64, (y * n) as i64);
    let ids: Vec<_> = (-1..=1)
        .flat_map(|dy| (-1..=1).map(move |dx| (dx, dy)))
        .map(|(dx, dy)| crate::map::tiles::TileId { style: crate::map::tiles::Style::Light, z: zoom, x: (tx + dx) as u32, y: (ty + dy) as u32 })
        .collect();
    let mut seen = 0;
    let mut ready = 0;
    while started.elapsed().as_secs() < 20 {
        ready = ids.iter().filter(|id| tiles.get(**id).is_some()).count();
        if ready == ids.len() {
            break;
        }
        seen = tiles.wait_for_update(seen);
    }
    let cached = walk(&dir.join("tiles"));
    println!(
        "index max zoom {}, credits \"{}\"; {ready}/{} tiles decoded in {} ms; {cached} files in the disk cache",
        index.max_zoom,
        index.attribution,
        ids.len(),
        started.elapsed().as_millis()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

fn walk(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| if e.path().is_dir() { walk(&e.path()) } else { 1 }).sum()).unwrap_or(0)
}

/// `--route-check <clip.mp4>`: the map's route for a clip, and where the
/// telemetry sits in the first frames (which NAL, how far in).
pub fn route_check(path: &std::path::Path) {
    let route = crate::map::clip_route(path);
    println!("{} route points", route.len());
    let Ok(file) = std::fs::File::open(path) else { return };
    let Ok(track) = mp4::read_video_track(&file) else { return };
    for s in track.samples.iter().take(3) {
        let mut buf = vec![0u8; s.size as usize];
        if mp4::read_at(&file, &mut buf, s.offset).is_err() {
            continue;
        }
        let n = track.nal_length_size as usize;
        let mut p = 0usize;
        let mut nals = Vec::new();
        while p + n <= buf.len() {
            let len = buf[p..p + n].iter().fold(0usize, |a, &b| (a << 8) | b as usize);
            if len == 0 || p + n + len > buf.len() {
                break;
            }
            nals.push(format!("type {} at {} ({} bytes)", buf[p + n] & 31, p, len));
            p += n + len;
        }
        println!("sample of {} bytes: {}", s.size, nals.join(", "));
    }
}

/// Decodes a clip with the GStreamer decoder (Linux's) and compares every
/// picture against this OS's own decoder at the same moment: sizes, a
/// sampled luma/chroma difference, and how far behind GStreamer hands
/// pictures back. On Linux there is nothing to compare with, so it only
/// decodes.
#[cfg(unix)]
pub fn gst_check(path: &std::path::Path) {
    let run = || -> anyhow::Result<()> {
        let file = std::fs::File::open(path)?;
        let track = mp4::read_video_track(&file)?;
        let mut reader = reader::WindowReader::new(file)?;
        let started = std::time::Instant::now();
        let mut gst = decode::gstreamer::Decoder::new(&track)?;
        // Sampled Y and CbCr values on a 16x16 grid, by moment.
        let grid = |w: u32, h: u32, y: &decode::Plane, uv: &decode::Plane| -> Vec<u8> {
            let mut out = Vec::with_capacity(512);
            for gy in 0..16u32 {
                for gx in 0..16u32 {
                    let (x, yy) = ((gx * 2 + 1) * w / 32, (gy * 2 + 1) * h / 32);
                    out.push(y.data[yy as usize * y.stride + x as usize]);
                    out.push(uv.data[(yy / 2) as usize * uv.stride + (x & !1) as usize]);
                }
            }
            out
        };
        let mut gst_pictures: Vec<(f64, (u32, u32), Vec<u8>)> = Vec::new();
        let mut lag_max = 0usize;
        let mut given = 0usize;
        let mut errors = 0usize;
        for (i, s) in track.samples.iter().enumerate() {
            let data = reader.read(s.offset, s.size as usize)?;
            let pts = track.pts_secs(i);
            given += 1;
            match gst.decode_at(data, pts) {
                Ok(Some(f)) => {
                    let at = f.pts().unwrap_or(f64::NAN);
                    let g = f.with_planes(|y, uv| grid(f.width(), f.height(), &y, &uv)).unwrap();
                    gst_pictures.push((at, (f.width(), f.height()), g));
                }
                Ok(None) => {}
                Err(e) => {
                    errors += 1;
                    if errors <= 3 {
                        println!("  GStreamer error at frame {i}: {e:#}");
                    }
                }
            }
            lag_max = lag_max.max(given - gst_pictures.len());
        }
        for f in gst.drain() {
            let g = f.with_planes(|y, uv| grid(f.width(), f.height(), &y, &uv)).unwrap();
            gst_pictures.push((f.pts().unwrap_or(f64::NAN), (f.width(), f.height()), g));
        }
        let gst_ms = started.elapsed().as_millis();
        // A seek: restart at a keyframe halfway in and decode 30 frames;
        // the pictures must be those frames' moments, in order.
        let k = (track.samples.len() / 2..track.samples.len()).find(|&k| track.samples[k].sync).unwrap_or(0);
        gst.reset();
        let seek_started = std::time::Instant::now();
        let mut first_ms = None;
        let mut seek_pts = Vec::new();
        for i in k..(k + 30).min(track.samples.len()) {
            let s = &track.samples[i];
            let data = reader.read(s.offset, s.size as usize)?;
            if let Ok(Some(f)) = gst.decode_at(data, track.pts_secs(i)) {
                first_ms.get_or_insert(seek_started.elapsed().as_millis());
                seek_pts.push(f.pts().unwrap_or(f64::NAN));
            }
        }
        seek_pts.extend(gst.drain().iter().map(|f| f.pts().unwrap_or(f64::NAN)));
        let expected: Vec<f64> = {
            let mut v: Vec<f64> = (k..(k + 30).min(track.samples.len())).map(|i| track.pts_secs(i)).collect();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v
        };
        // Every picture is one of those moments, in order, and only an open
        // GOP's leading pictures (before the keyframe) may be missing.
        let key_pts = track.pts_secs(k);
        let seek_ok = seek_pts.windows(2).all(|w| w[0] < w[1])
            && seek_pts.iter().all(|p| expected.iter().any(|e| (e - p).abs() < 1e-4))
            && expected.iter().filter(|e| **e + 1e-6 >= key_pts).all(|e| seek_pts.iter().any(|p| (e - p).abs() < 1e-4));
        println!(
            "  seek to frame {k}: {} pictures, first after {} ms, right moments in order: {seek_ok}",
            seek_pts.len(),
            first_ms.unwrap_or(0)
        );
        let in_order = gst_pictures.windows(2).all(|w| w[0].0 < w[1].0);
        println!(
            "{}: {}x{}, {} frames; GStreamer gave {} pictures ({}), {} errors, at most {} behind, in order: {}, {} ms",
            path.display(),
            track.width,
            track.height,
            track.samples.len(),
            gst_pictures.len(),
            gst_pictures.first().map(|p| format!("{}x{}", p.1 .0, p.1 .1)).unwrap_or_default(),
            errors,
            lag_max,
            in_order,
            gst_ms
        );
        #[cfg(not(target_os = "linux"))]
        {
            // The same clip through this OS's decoder, compared by moment.
            let file = std::fs::File::open(path)?;
            let mut reader = reader::WindowReader::new(file)?;
            let mut os_decoder = decode::Decoder::new(&track)?;
            let by_pts: std::collections::HashMap<i64, &Vec<u8>> = gst_pictures.iter().map(|p| ((p.0 * 1e4).round() as i64, &p.2)).collect();
            let (mut compared, mut worst, mut total) = (0usize, 0f64, 0f64);
            for (i, s) in track.samples.iter().enumerate() {
                let data = reader.read(s.offset, s.size as usize)?;
                let Ok(Some(f)) = os_decoder.decode(data) else { continue };
                let pts = track.pts_secs(i);
                let Some(g) = by_pts.get(&((pts * 1e4).round() as i64)) else { continue };
                let n = f.with_planes(|y, uv| grid(f.width(), f.height(), &y, &uv)).unwrap_or_default();
                if n.len() != g.len() {
                    continue;
                }
                let diff = n.iter().zip(g.iter()).map(|(a, b)| (*a as f64 - *b as f64).abs()).sum::<f64>() / n.len() as f64;
                worst = worst.max(diff);
                total += diff;
                compared += 1;
            }
            println!(
                "  against this OS's decoder: {compared} pictures compared, mean difference {:.2}, worst {:.2} (0-255 scale)",
                total / compared.max(1) as f64,
                worst
            );
        }
        Ok(())
    };
    if let Err(e) = run() {
        println!("{}: {e:#}", path.display());
    }
}

/// `--update-check [stable|prerelease] [as-version] [download]`: the
/// install ID and what a check finds (without asking api.sentry-six.com,
/// so nothing is counted), then optionally the download and its SHA-512.
pub fn update_check(prerelease: bool, as_version: Option<&str>, download: bool) {
    use crate::update;
    println!("install ID {} ({} {}), how: {:?}", update::install_id(), update::platform(), update::arch(), update::how());
    let channel = if prerelease { update::Channel::Prerelease } else { update::Channel::Stable };
    let current = as_version.unwrap_or(update::current());
    let started = std::time::Instant::now();
    let outcome = update::check_as(channel, false, current, false);
    println!("{channel:?} as {current}, {} ms:", started.elapsed().as_millis());
    match outcome {
        update::Outcome::Offer(offer) => {
            println!("  offer {} -> {} ({} bytes), page {}", offer.version, offer.asset.url, offer.asset.size, offer.page);
            for n in &offer.notes {
                println!("  v{} {} \"{}\": {} changes", n.version, n.date, n.title, n.changes.len());
            }
            if download {
                let progress = std::sync::atomic::AtomicU64::new(0);
                let started = std::time::Instant::now();
                match update::download(&offer.asset, &progress) {
                    Ok(path) => println!("  downloaded and verified in {} ms: {}", started.elapsed().as_millis(), path.display()),
                    Err(e) => println!("  download failed: {e}"),
                }
            }
        }
        other => println!("  {other:?}"),
    }
}

/// Exports a clip folder (a Sentry or Saved event, or a day of Recent
/// clips) with all its cameras and times it: `--export-check <folder>
/// [mobile|medium|high|max] [speed] [out.mp4]`.
pub fn export_check(dir: &std::path::Path, quality: Option<&str>, speed: Option<f64>, out: Option<&std::path::Path>) {
    use crate::export::job;
    let dashboard = std::env::var_os("SENTRY_EXPORT_DASHBOARD").is_some();
    let run = || -> anyhow::Result<()> {
        let collections = library::scan(dir)?;
        let Some(c) = collections.first() else { anyhow::bail!("no clips found in {}", dir.display()) };
        let segments = library::load_segments(c)?;
        anyhow::ensure!(!segments.is_empty(), "no clips found in {}", dir.display());
        let mut cameras: Vec<library::Camera> = library::GRID.iter().copied().filter(|cam| segments.iter().any(|s| s.files.contains_key(cam))).collect();
        cameras.dedup();
        let output = out.map(std::path::Path::to_path_buf).unwrap_or_else(|| std::env::temp_dir().join("sentry-studio-export-check.mp4"));
        let last = segments.len() - 1;
        let request = job::Request {
            segments,
            start: job::Position { segment: 0, secs: 0.0 },
            end: job::Position { segment: last, secs: f64::MAX },
            tiles: job::grid(&cameras),
            quality: crate::export_view::quality_from_key(quality.unwrap_or("high")).unwrap_or(job::Quality::High),
            format: std::env::var("SENTRY_EXPORT_FORMAT").ok().and_then(|f| crate::export::encode::Format::from_key(&f)),
            speed: speed.unwrap_or(1.0),
            mirror: true,
            // SENTRY_EXPORT_FAST=0: the encoder's normal (quality) mode.
            fast: std::env::var("SENTRY_EXPORT_FAST").map_or(true, |v| v != "0"),
            // The dashboard with SENTRY_EXPORT_DASHBOARD=1, else the timestamp.
            // SENTRY_EXPORT_TIMESTAMP=0: none.
            timestamp: (!dashboard && std::env::var("SENTRY_EXPORT_TIMESTAMP").map_or(true, |v| v != "0")).then_some(crate::export::overlay::Timestamp {
                corner: crate::export::overlay::Corner::BottomCenter,
                date_format: crate::settings::DateFormat::Ymd,
                h24: false,
            }),
            dashboard: dashboard.then_some(crate::export::overlay::Dashboard {
                // SENTRY_EXPORT_DASHBOARD=tesla-mobile for that style.
                style: crate::export::overlay::DashStyle::from_key(&std::env::var("SENTRY_EXPORT_DASHBOARD").unwrap_or_default()).unwrap_or(crate::export::overlay::DashStyle::Compact),
                corner: std::env::var("SENTRY_EXPORT_DASH_CORNER").ok().and_then(|c| crate::export::overlay::Corner::from_key(&c)).unwrap_or(crate::export::overlay::Corner::BottomCenter),
                size: crate::export::overlay::DashSize::Medium,
                metric: false,
                h24: false,
                accel: crate::dashboard::AccelMode::IconBar,
                // Playback's glass (SENTRY_EXPORT_GLASS=0 for the dark bar).
                glass: std::env::var("SENTRY_EXPORT_GLASS").ok().and_then(|v| v.parse().ok()).unwrap_or(13.0),
                free: None,
            }),
            // The minimap with SENTRY_EXPORT_MINIMAP=1.
            minimap: std::env::var_os("SENTRY_EXPORT_MINIMAP").map(|_| crate::export::overlay::Minimap {
                corner: crate::export::overlay::Corner::TopRight,
                size: crate::export::overlay::DashSize::Small,
                dark: false,
                tiles: crate::export::overlay::MapTiles(crate::map::tiles::Tiles::new(crate::settings::data_dir().map(|d| d.join("map")))),
                // SENTRY_EXPORT_MINIMAP=live: the map follows the car.
                live: std::env::var("SENTRY_EXPORT_MINIMAP").is_ok_and(|v| v == "live"),
                free: None,
            }),
            // A zone over the middle of every camera with SENTRY_EXPORT_BLUR=1.
            blur_zones: if std::env::var_os("SENTRY_EXPORT_BLUR").is_some() { cameras.iter().map(|c| crate::export::blur::BlurZone::starting(*c)).collect() } else { Vec::new() },
            output: output.clone(),
        };
        use crate::export::encode::{support, Format};
        println!("formats this computer encodes: {}", Format::ALL.iter().map(|f| format!("{} {:?}", f.label(), support(*f))).collect::<Vec<_>>().join(", "));
        let plan = job::plan(&request)?;
        // SENTRY_EXPORT_PREVIEW=out.png: the dialog's preview of the frame
        // 10 s in, instead of exporting.
        if let Some(path) = std::env::var_os("SENTRY_EXPORT_PREVIEW") {
            for _ in 0..2 {
                let started = std::time::Instant::now();
                let width = std::env::var("SENTRY_EXPORT_PREVIEW_WIDTH").ok().and_then(|w| w.parse().ok()).unwrap_or(960);
                let p = job::preview(&request, job::Position { segment: 0, secs: 10.0 }, width)?;
                println!("preview of {}x{} in {} ms ({}x{})", p.width, p.height, started.elapsed().as_millis(), p.shown.0, p.shown.1);
                // The PNG encoder itself: image's save() would link every
                // format's encoder (AVIF's alone is over 1 MB).
                let file = std::io::BufWriter::new(std::fs::File::create(&path)?);
                image::ImageEncoder::write_image(image::codecs::png::PngEncoder::new(file), &p.rgba, p.shown.0, p.shown.1, image::ExtendedColorType::Rgba8)?;
            }
            return Ok(());
        }
        println!(
            "{} ({} minute(s)): {} camera(s), {:?}, {}x{} {:?} at {} kbit/s, {} frames",
            c.name,
            last + 1,
            cameras.len(),
            request.quality,
            plan.width,
            plan.height,
            plan.codec,
            plan.bitrate / 1000,
            plan.frames.len()
        );
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let source_secs = plan.seconds() * request.speed;
        match job::run(&request, &cancel, |_| {})? {
            job::Outcome::Done { bytes, seconds, warnings, .. } => {
                println!(
                    "{:.0} s of footage in {seconds:.1} s = {:.1}x real time, {:.1} MB: {}",
                    source_secs,
                    source_secs / seconds,
                    bytes as f64 / 1e6,
                    output.display()
                );
                for w in warnings {
                    println!("note: {}", crate::i18n::t(w));
                }
            }
            job::Outcome::Cancelled => println!("cancelled"),
        }
        Ok(())
    };
    if let Err(e) = run() {
        println!("export failed: {e:#}");
    }
}
