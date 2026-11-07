//! Windows builds get the app's icon and version details as resources
//! (assets/windows/app.rc), compiled with mingw-w64's windres when cross-
//! compiling from macOS or Linux (x86_64-pc-windows-gnu).

use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=assets/windows/app.rc");
    println!("cargo:rerun-if-changed=assets/icons/sentry-studio.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("gnu") {
        println!("cargo:warning=no icon: the Windows resources are only built for the gnu target");
        return;
    }
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let windres = std::env::var("WINDRES").unwrap_or_else(|_| format!("{arch}-w64-mingw32-windres"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let out = out_dir.join("app-resources.o");
    // The version from Cargo.toml (what Explorer shows), and the
    // icon by absolute path.
    let version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let mut parts: Vec<String> = version.split(['.', '-', '+']).take(3).map(|p| p.parse::<u16>().unwrap_or(0).to_string()).collect();
    parts.resize(4, "0".into());
    let icon = std::fs::canonicalize("assets/icons/sentry-studio.ico").expect("the icon (assets/icons/sentry-studio.ico)");
    let rc = std::fs::read_to_string("assets/windows/app.rc")
        .unwrap()
        .replace("@VERSION_COMMAS@", &parts.join(","))
        .replace("@VERSION@", &version)
        .replace("@ICON@", &icon.display().to_string().replace('\\', "/"));
    let rc_path = out_dir.join("app.rc");
    std::fs::write(&rc_path, rc).unwrap();
    let status = Command::new(&windres)
        .arg("--input")
        .arg(&rc_path)
        .args(["--output-format=coff", "--output"])
        .arg(&out)
        .status();
    match status {
        Ok(s) if s.success() => println!("cargo:rustc-link-arg-bins={}", out.display()),
        Ok(s) => panic!("{windres} failed ({s}) compiling assets/windows/app.rc"),
        Err(e) => panic!("{windres} is needed for the Windows icon (brew install mingw-w64): {e}"),
    }
}
