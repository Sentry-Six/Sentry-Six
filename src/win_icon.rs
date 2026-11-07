//! Windows: the window's title-bar and taskbar icons, loaded from the
//! .exe's own icon (assets/windows/app.rc) at the sizes Windows wants for
//! the window's display scaling. Handing winit one large picture instead
//! leaves Windows to shrink it to 16 px itself, which looks smeared.

use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::WindowsAndMessaging::*;

/// Sets the icons on this thread's top-level windows (the UI thread owns
/// the app's window). Returns whether there was a window to set them on.
pub fn apply() -> bool {
    let mut found = false;
    unsafe {
        let _ = EnumThreadWindows(GetCurrentThreadId(), Some(set_icons), LPARAM(&mut found as *mut bool as isize));
    }
    found
}

unsafe extern "system" fn set_icons(hwnd: HWND, found: LPARAM) -> BOOL {
    unsafe {
        // Top-level windows only (no owner).
        if GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid()) {
            return true.into();
        }
        let Ok(module) = GetModuleHandleW(None) else { return false.into() };
        let dpi = match GetDpiForWindow(hwnd) {
            0 => 96,
            d => d,
        };
        // Resource 1 in app.rc; LoadImage picks the closest size in the .ico.
        let load = |cx: SYSTEM_METRICS_INDEX, cy: SYSTEM_METRICS_INDEX| {
            LoadImageW(Some(module.into()), PCWSTR(std::ptr::without_provenance(1)), IMAGE_ICON, GetSystemMetricsForDpi(cx, dpi), GetSystemMetricsForDpi(cy, dpi), LR_DEFAULTCOLOR).ok()
        };
        for (which, icon) in [(ICON_SMALL, load(SM_CXSMICON, SM_CYSMICON)), (ICON_BIG, load(SM_CXICON, SM_CYICON))] {
            if let Some(icon) = icon {
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(which as usize)), Some(LPARAM(icon.0 as isize)));
                *(found.0 as *mut bool) = true;
            }
        }
    }
    true.into()
}
