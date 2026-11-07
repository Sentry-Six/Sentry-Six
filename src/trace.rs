//! Playback trace for diagnosing stutter: `SENTRY_STUDIO_TRACE=1` prints
//! slow reads and decodes, clock holds, display gaps and seek times to
//! stderr, each line stamped with milliseconds since launch.

use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();
static ON: OnceLock<bool> = OnceLock::new();

pub fn on() -> bool {
    *ON.get_or_init(|| {
        START.get_or_init(Instant::now);
        std::env::var_os("SENTRY_STUDIO_TRACE").is_some()
    })
}

pub fn ms() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_millis()
}

macro_rules! trace {
    ($($arg:tt)*) => {
        if $crate::trace::on() {
            eprintln!("[{:>7} ms] {}", $crate::trace::ms(), format!($($arg)*));
        }
    };
}
pub(crate) use trace;
