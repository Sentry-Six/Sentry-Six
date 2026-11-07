//! The app's log (applog, beside the `log` crate whose macros feed it),
//! which diagnostics reports (src/diagnostics.rs).
//!
//! Lines come from the `log` macros: the app's own at Info and above, other
//! crates' (wgpu, winit, …) at Warn and above. Each goes to a ring in memory
//! (this session) and to this session's file in the data folder's `logs`
//! folder, which keeps the last few sessions so a crash or a problem from
//! before a restart can still be reported. A line repeated straight away is
//! counted, not stored again. A panic is logged with where it happened.
//!
//! `stats` holds always-on playback health counters: cheap enough to keep
//! for every frame, where a log line each time would drown everything else.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Lines kept in memory for this session.
const RING: usize = 4000;
/// A session's file stops growing here (a runaway loop can't fill a disk).
const FILE_CAP: u64 = 4 << 20;
/// Session files kept, this one included.
const SESSIONS: usize = 4;
/// The longest a line may be.
const LINE_CHARS: usize = 2000;

#[derive(Debug, Clone)]
pub struct Line {
    /// Seconds since launch.
    pub t: f64,
    pub level: log::Level,
    pub target: String,
    pub text: String,
    /// How many more times it came straight after.
    pub repeats: u32,
}

impl Line {
    pub fn render(&self) -> String {
        let more = if self.repeats > 0 { format!(" (×{})", self.repeats + 1) } else { String::new() };
        format!("{:>9.3} {} {}: {}{more}", self.t, level_letter(self.level), self.target, self.text)
    }
}

fn level_letter(l: log::Level) -> char {
    match l {
        log::Level::Error => 'E',
        log::Level::Warn => 'W',
        log::Level::Info => 'I',
        log::Level::Debug => 'D',
        log::Level::Trace => 'T',
    }
}

struct FileSink {
    file: std::fs::File,
    written: u64,
    /// The last line written and how many times it has come again since.
    last: Option<(String, u32)>,
}

impl FileSink {
    fn write(&mut self, key: &str, rendered: &str) {
        if self.written >= FILE_CAP {
            return;
        }
        if let Some((last, n)) = &mut self.last {
            if last == key {
                *n += 1;
                return;
            }
            if *n > 0 {
                let note = format!("          (the line above came {} more times)\n", n);
                self.written += note.len() as u64;
                let _ = self.file.write_all(note.as_bytes());
            }
        }
        self.last = Some((key.to_string(), 0));
        let line = format!("{rendered}\n");
        self.written += line.len() as u64;
        let _ = self.file.write_all(line.as_bytes());
        if self.written >= FILE_CAP {
            let _ = self.file.write_all(b"(log file full: later lines are in memory only)\n");
        }
    }
}

struct Logger {
    start: Instant,
    ring: Mutex<VecDeque<Line>>,
    file: Mutex<Option<FileSink>>,
    /// Lines by level this session: errors, warnings.
    counts: [std::sync::atomic::AtomicU32; 2],
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

fn logger() -> &'static Logger {
    LOGGER.get_or_init(|| Logger {
        start: Instant::now(),
        ring: Mutex::new(VecDeque::with_capacity(RING)),
        file: Mutex::new(None),
        counts: Default::default(),
    })
}

/// Targets the app names itself (besides its module paths).
const OWN_TARGETS: [&str; 3] = ["app", "panic", "update"];

/// The app's own lines, as opposed to other crates'.
fn ours(target: &str) -> bool {
    target.starts_with("sentry_studio") || OWN_TARGETS.contains(&target)
}

impl log::Log for Logger {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        meta.level() <= if ours(meta.target()) { log::Level::Info } else { log::Level::Warn }
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let mut text = record.args().to_string();
        if text.len() > LINE_CHARS {
            let cut = (0..=LINE_CHARS).rev().find(|&i| text.is_char_boundary(i)).unwrap_or(0);
            text.truncate(cut);
            text.push('…');
        }
        let target = match record.target() {
            "sentry_studio" => "app",
            t => t.strip_prefix("sentry_studio::").unwrap_or(t),
        }
        .to_string();
        let level = record.level();
        match level {
            log::Level::Error => self.counts[0].fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            log::Level::Warn => self.counts[1].fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            _ => 0,
        };
        let line = Line { t: self.start.elapsed().as_secs_f64(), level, target, text, repeats: 0 };
        let rendered = line.render();
        let key = format!("{}{}{}", level_letter(level), line.target, line.text);
        if cfg!(debug_assertions) || crate::trace::on() {
            eprintln!("{rendered}");
        }
        {
            let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
            match ring.back_mut() {
                Some(last) if last.level == level && last.target == line.target && last.text == line.text => last.repeats += 1,
                _ => {
                    if ring.len() == RING {
                        ring.pop_front();
                    }
                    ring.push_back(line);
                }
            }
        }
        let mut file = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sink) = file.as_mut() {
            sink.write(&key, &rendered);
            if level <= log::Level::Warn {
                let _ = sink.file.flush();
            }
        }
    }

    fn flush(&self) {
        if let Some(sink) = self.file.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = sink.file.flush();
        }
    }
}

/// The folder of session files.
pub fn folder() -> Option<PathBuf> {
    crate::settings::data_dir().map(|d| d.join("logs"))
}

/// Session files, oldest first (named by start time, so the names sort).
pub fn session_files() -> Vec<PathBuf> {
    let Some(dir) = folder() else { return Vec::new() };
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("session-") && n.ends_with(".log")))
        .collect();
    files.sort();
    files
}

/// This session's file, once `start` has opened it.
static THIS_FILE: OnceLock<PathBuf> = OnceLock::new();

pub fn this_session_file() -> Option<&'static PathBuf> {
    THIS_FILE.get()
}

/// Starts logging (memory and this session's file) and records panics.
/// Called once, as the window starts.
pub fn start() {
    let l = logger();
    if log::set_logger(l).is_err() {
        return;
    }
    log::set_max_level(log::LevelFilter::Info);
    if let Some(dir) = folder() {
        if std::fs::create_dir_all(&dir).is_ok() {
            // Make room for this session.
            let old = session_files();
            for f in old.iter().take((old.len() + 1).saturating_sub(SESSIONS)) {
                let _ = std::fs::remove_file(f);
            }
            let name = format!("session-{}.log", chrono::Local::now().format("%Y%m%d-%H%M%S"));
            let path = dir.join(name);
            if let Ok(file) = std::fs::File::create(&path) {
                *l.file.lock().unwrap_or_else(|e| e.into_inner()) = Some(FileSink { file, written: 0, last: None });
                let _ = THIS_FILE.set(path);
            }
        }
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".into());
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        CRASHED.store(true, std::sync::atomic::Ordering::Relaxed);
        log::error!(target: "panic", "thread {thread} panicked at {place}: {message}");
        log::logger().flush();
        previous(info);
    }));
    // However the app ends (main returning, Cmd+Q, exit()), short of a
    // crash or being killed.
    #[cfg(unix)]
    {
        extern "C" fn at_exit() {
            end();
        }
        unsafe {
            libc::atexit(at_exit);
        }
    }
}

/// A panic happened: the session didn't end cleanly even if the process
/// then exits normally.
static CRASHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Logging to memory only (the command-line checks and tests).
pub fn start_in_memory() {
    if log::set_logger(logger()).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

/// Writes the line that marks a clean exit (a session file without it
/// ended in a crash, a force quit or a power cut).
pub fn end() {
    use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
    static ENDED: AtomicBool = AtomicBool::new(false);
    if ENDED.swap(true, Relaxed) || CRASHED.load(Relaxed) || LOGGER.get().is_none() {
        return;
    }
    if stats::count(&stats::FRAMES) > 0 {
        log::info!(target: "app", "playback this session: {}", stats::summary());
    }
    log::info!(target: "app", "{CLEAN_EXIT}");
    log::logger().flush();
}

pub const CLEAN_EXIT: &str = "quit normally";

/// This session's lines, oldest first.
pub fn lines() -> Vec<Line> {
    logger().ring.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
}

/// Errors and warnings logged this session.
pub fn problem_counts() -> (u32, u32) {
    let c = &logger().counts;
    (c[0].load(std::sync::atomic::Ordering::Relaxed), c[1].load(std::sync::atomic::Ordering::Relaxed))
}

/// Seconds since launch.
pub fn uptime() -> f64 {
    logger().start.elapsed().as_secs_f64()
}

/// Playback health, counted for every frame (see the module notes).
pub mod stats {
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

    /// How often something happened, and how long it took (ms).
    pub struct Timing {
        count: AtomicU64,
        total_us: AtomicU64,
        max_us: AtomicU64,
    }

    impl Timing {
        const fn new() -> Self {
            Timing { count: AtomicU64::new(0), total_us: AtomicU64::new(0), max_us: AtomicU64::new(0) }
        }

        pub fn add(&self, ms: f64) {
            let us = (ms.max(0.0) * 1000.0) as u64;
            self.count.fetch_add(1, Relaxed);
            self.total_us.fetch_add(us, Relaxed);
            self.max_us.fetch_max(us, Relaxed);
        }

        /// "none", or "12 (average 140 ms, worst 820 ms)".
        pub fn describe(&self) -> String {
            let n = self.count.load(Relaxed);
            if n == 0 {
                return "none".into();
            }
            let avg = self.total_us.load(Relaxed) as f64 / n as f64 / 1000.0;
            let max = self.max_us.load(Relaxed) as f64 / 1000.0;
            format!("{n} (average {avg:.0} ms, worst {max:.0} ms)")
        }
    }

    /// Frames that took over 25 ms to read and decode.
    pub static SLOW_FRAMES: Timing = Timing::new();
    /// Pauses over 40 ms between frames shown while playing.
    pub static DISPLAY_GAPS: Timing = Timing::new();
    /// The clock held for a camera that was behind.
    pub static CLOCK_HOLDS: Timing = Timing::new();
    /// From a seek to every camera showing the new spot.
    pub static SEEKS: Timing = Timing::new();
    /// Opening a camera's clip (index read).
    pub static CLIP_OPENS: Timing = Timing::new();
    /// Frames that could not be decoded.
    pub static DECODE_ERRORS: AtomicU64 = AtomicU64::new(0);
    /// Frames decoded.
    pub static FRAMES: AtomicU64 = AtomicU64::new(0);

    pub fn count(c: &AtomicU64) -> u64 {
        c.load(Relaxed)
    }

    /// One line of playback health (the report's, and the log's every few
    /// minutes and at quit).
    pub fn summary() -> String {
        format!(
            "{} frames decoded, {} decode errors; slow frames (over 25 ms) {}; display pauses (over 40 ms) {}; clock held for a camera {}; seeks {}; clip opens {}",
            count(&FRAMES),
            count(&DECODE_ERRORS),
            SLOW_FRAMES.describe(),
            DISPLAY_GAPS.describe(),
            CLOCK_HOLDS.describe(),
            SEEKS.describe(),
            CLIP_OPENS.describe(),
        )
    }

    /// Very slow frames (over 500 ms) since the last line about them.
    struct Spikes {
        since: Option<std::time::Instant>,
        count: u32,
        worst_ms: f64,
        worst_read_ms: f64,
        cameras: Vec<String>,
    }

    static SPIKES: std::sync::Mutex<Spikes> =
        std::sync::Mutex::new(Spikes { since: None, count: 0, worst_ms: 0.0, worst_read_ms: 0.0, cameras: Vec::new() });

    /// A frame that took over 500 ms: the first is logged straight away,
    /// later ones as one line every 30 s (a slow network share can do this
    /// for every few frames).
    pub fn very_slow_frame(camera: &str, ms: f64, read_ms: f64) {
        let mut s = SPIKES.lock().unwrap_or_else(|e| e.into_inner());
        if s.since.is_none() {
            s.since = Some(std::time::Instant::now());
            log::warn!(target: "player", "{camera}: a frame took {ms:.0} ms (reading {read_ms:.0} ms, decoding {:.0} ms)", ms - read_ms);
            return;
        }
        s.count += 1;
        if ms > s.worst_ms {
            s.worst_ms = ms;
            s.worst_read_ms = read_ms;
        }
        if !s.cameras.iter().any(|c| c == camera) {
            s.cameras.push(camera.to_string());
        }
        if s.since.is_some_and(|t| t.elapsed().as_secs() >= 30) {
            log::warn!(
                target: "player",
                "{} more frames took over 500 ms in the last {} s ({}; worst {:.0} ms, of which reading {:.0} ms)",
                s.count,
                s.since.map_or(0, |t| t.elapsed().as_secs()),
                s.cameras.join(", "),
                s.worst_ms,
                s.worst_read_ms
            );
            *s = Spikes { since: Some(std::time::Instant::now()), count: 0, worst_ms: 0.0, worst_read_ms: 0.0, cameras: Vec::new() };
        }
    }
}

/// What decodes video, as the decoder last announced it.
static DECODER: Mutex<String> = Mutex::new(String::new());

pub fn set_decoder(what: String) {
    *DECODER.lock().unwrap_or_else(|e| e.into_inner()) = what;
}

pub fn decoder() -> String {
    DECODER.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
