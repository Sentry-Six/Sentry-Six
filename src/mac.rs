//! macOS: links, files and folders through AppKit and Foundation rather
//! than the `open` and `defaults` tools, which the App Store build's
//! sandbox may not let it run; and the bookmarks that let that build reopen
//! a folder the user picked in an earlier session.

use objc2::rc::Retained;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSArray, NSLocale, NSString, NSURL};
use std::path::Path;

fn file_url(path: &Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

/// Opens a web page, or a file in its usual app.
pub fn open(target: &str) -> bool {
    let url = if target.contains("://") { NSURL::URLWithString(&NSString::from_str(target)) } else { Some(file_url(Path::new(target))) };
    url.is_some_and(|u| NSWorkspace::sharedWorkspace().openURL(&u))
}

/// Shows a file selected in the Finder.
pub fn reveal(path: &Path) {
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&[file_url(path)]));
}

/// The user's preferred languages, most preferred first ("fr-CA", "en-CA").
pub fn preferred_languages() -> Vec<String> {
    NSLocale::preferredLanguages().iter().map(|l| l.to_string()).collect()
}

#[cfg(feature = "app-store")]
/// A security-scoped bookmark for a file or folder the user just picked
/// (the sandbox lets the app in for this session only): kept in the
/// settings, it opens the way again in later sessions (`resolve`).
pub fn bookmark(path: &Path) -> Option<Vec<u8>> {
    use objc2_foundation::NSURLBookmarkCreationOptions;
    match file_url(path).bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(NSURLBookmarkCreationOptions::WithSecurityScope, None, None) {
        Ok(data) => Some(data.to_vec()),
        Err(e) => {
            log::warn!("could not remember access to a folder: {}", e.localizedDescription());
            None
        }
    }
}

#[cfg(feature = "app-store")]
/// The path a bookmark points to, with the sandbox opened to it for the
/// rest of this session; and whether the bookmark should be made again
/// (the folder moved or was renamed).
pub fn resolve(bookmark: &[u8]) -> Option<(std::path::PathBuf, bool)> {
    use objc2::runtime::Bool;
    use objc2_foundation::NSURLBookmarkResolutionOptions;
    let data = objc2_foundation::NSData::with_bytes(bookmark);
    let mut stale = Bool::NO;
    let url = unsafe { NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(&data, NSURLBookmarkResolutionOptions::WithSecurityScope, None, &mut stale) };
    let url = match url {
        Ok(u) => u,
        Err(e) => {
            log::warn!("a remembered folder can't be opened: {}", e.localizedDescription());
            return None;
        }
    };
    // Kept open until the app quits (never stopped): the folder is read
    // throughout the session.
    if !unsafe { url.startAccessingSecurityScopedResource() } {
        log::warn!("the sandbox didn't open a remembered folder");
    }
    Some((std::path::PathBuf::from(url.path()?.to_string()), stale.as_bool()))
}

/// The App Store build: winit (under iced) refers to two private
/// CoreGraphics functions for blurring a window's background, which this
/// app never asks for (its glass is drawn by its own shaders). Apple's
/// review rejects a build that merely refers to a private API, so the App
/// Store build defines them itself as doing nothing, and links neither.
#[cfg(feature = "app-store")]
#[unsafe(no_mangle)]
pub extern "C" fn CGSMainConnectionID() -> *mut std::ffi::c_void {
    std::ptr::null_mut()
}

#[cfg(feature = "app-store")]
#[unsafe(no_mangle)]
pub extern "C" fn CGSSetWindowBackgroundBlurRadius(_connection: *mut std::ffi::c_void, _window: isize, _radius: i64) -> i32 {
    0
}
