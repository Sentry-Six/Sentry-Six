//! Windows: release builds are windowed apps (no console window opens next
//! to the app). Started from a terminal, it attaches to that terminal's
//! console so diagnostics ("video decoding: GPU", SENTRY_STUDIO_TRACE, the
//! --*-check commands) still print there. Output already redirected (for
//! example `2> trace.log`) is left as it is.

use windows::core::w;
use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows::Win32::Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
use windows::Win32::System::Console::{AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};

pub fn attach_parent() {
    unsafe {
        let missing = |which| GetStdHandle(which).map_or(true, |h: HANDLE| h.is_invalid() || h.0.is_null());
        let (out, err) = (missing(STD_OUTPUT_HANDLE), missing(STD_ERROR_HANDLE));
        if !out && !err {
            return;
        }
        if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
            return; // Not started from a terminal.
        }
        let Ok(console) = CreateFileW(
            w!("CONOUT$"),
            (GENERIC_READ | GENERIC_WRITE).0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        ) else {
            return;
        };
        if out {
            let _ = SetStdHandle(STD_OUTPUT_HANDLE, console);
        }
        if err {
            let _ = SetStdHandle(STD_ERROR_HANDLE, console);
        }
    }
}
