//! The install ID sent with update checks: the same pseudonymous ID earlier
//! versions of Sentry Studio sent (node-machine-id's hashed machine ID,
//! hashed again with a public salt), so a computer keeps its ID across the
//! update.

use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// Public; it only keeps the ID from being a bare hash of the machine ID.
const SALT: &str = "SENTRY_SIX_2026_PROD_SECRET";

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn install_id() -> String {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let machine = machine_id().map(|raw| sha256_hex(&raw)).unwrap_or_else(fallback);
        sha256_hex(&format!("{machine}{SALT}"))
    })
    .clone()
}

/// Without a machine ID: a hash of the computer's name, OS and CPU.
fn fallback() -> String {
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    sha256_hex(&format!("{host}-{}-{}", std::env::consts::OS, std::env::consts::ARCH))
}

/// What node-machine-id reads, cleaned up the same way: no whitespace,
/// lower case.
fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase()
}

/// The hardware UUID (ioreg's IOPlatformUUID).
#[cfg(target_os = "macos")]
fn machine_id() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let line = text.split("IOPlatformUUID").nth(1)?.lines().next()?;
    let id = clean(&line.replace(['=', '"'], ""));
    (!id.is_empty()).then_some(id)
}

/// HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid, from the 64-bit view.
#[cfg(target_os = "windows")]
fn machine_id() -> Option<String> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY};
    let mut buf = [0u16; 128];
    let mut len = std::mem::size_of_val(&buf) as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Cryptography"),
            w!("MachineGuid"),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if result.is_err() {
        return None;
    }
    // `len` counts bytes, with the closing NUL.
    let chars = (len as usize / 2).saturating_sub(1).min(buf.len());
    let id = clean(&String::from_utf16_lossy(&buf[..chars]));
    (!id.is_empty()).then_some(id)
}

/// The D-Bus machine ID (or /etc/machine-id), else the host name.
#[cfg(all(unix, not(target_os = "macos")))]
fn machine_id() -> Option<String> {
    let first = |p: &str| std::fs::read_to_string(p).ok().and_then(|t| t.lines().next().map(str::to_string)).filter(|l| !l.trim().is_empty());
    let raw = first("/var/lib/dbus/machine-id").or_else(|| first("/etc/machine-id")).or_else(|| first("/etc/hostname"))?;
    Some(clean(&raw))
}
