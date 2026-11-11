//! Window context for the Quick overlay (ADR 0022 Phase 3): what the user was looking at when they
//! pressed the shortcut. Three levels, each only when it needs no new permission prompt:
//!
//! - 0, no permission: the frontmost app's name, bundle id and pid (`NSWorkspace`).
//! - 1, Accessibility (only if already granted; never prompts): the focused window's title, its
//!   document file and the selected text (AX API).
//! - 2, Automation (macOS asks once per target app): a small AppleScript per known app (`Adapter`):
//!   the browser tab's URL and title, Finder's folder and selection, iTerm2's folder.
//!
//! The pure parts (adapters, output parsing, file URLs) are tested here; the page formats the chip
//! and the prompt line (`app/src/windowContext.ts`). Other platforms have no context.

use serde::Serialize;

/// What the user was looking at. Field names match `WindowContext` in `app/src/windowContext.ts`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowContext {
    pub app: String,
    pub bundle_id: String,
    #[serde(skip)]
    pub pid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    /// Finder's open folder, iTerm2's working folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Finder's selected items (at most `FILES_MAX`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// Permissions that would give more context.
    pub missing: Vec<Missing>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Missing {
    Accessibility,
    Automation,
}

/// Longest selected text kept (characters).
pub const SELECTED_TEXT_MAX: usize = 2000;
/// Most Finder items kept.
pub const FILES_MAX: usize = 20;

/// `text` trimmed, at most `max` characters (with "…" when cut); `None` when empty.
pub fn cap(text: &str, max: usize) -> Option<String> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    if t.chars().count() <= max {
        return Some(t.to_owned());
    }
    let cut: String = t.chars().take(max).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// A known app whose AppleScript gives more than the window title.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Adapter {
    Safari,
    /// Chrome and the browsers built on it: same AppleScript dictionary.
    Chromium,
    Finder,
    ITerm,
}

/// The adapter for an app. Firefox has no AppleScript for its tabs, Terminal no reliable folder.
pub fn adapter(bundle_id: &str) -> Option<Adapter> {
    Some(match bundle_id {
        "com.apple.Safari" | "com.apple.SafariTechnologyPreview" => Adapter::Safari,
        "com.google.Chrome"
        | "company.thebrowser.Browser"
        | "com.brave.Browser"
        | "com.microsoft.edgemac"
        | "org.chromium.Chromium"
        | "com.vivaldi.Vivaldi" => Adapter::Chromium,
        "com.apple.finder" => Adapter::Finder,
        "com.googlecode.iterm2" => Adapter::ITerm,
        _ => return None,
    })
}

impl Adapter {
    /// The AppleScript for the app `bundle_id` (one of `adapter`'s, so it is safe to put in the
    /// script). Addressed by id, so it reaches the app that is frontmost and never starts another.
    pub fn script(self, bundle_id: &str) -> String {
        let body = match self {
            Adapter::Safari => "set t to current tab of front window\nreturn (URL of t as text) & linefeed & (name of t as text)",
            Adapter::Chromium => "set t to active tab of front window\nreturn (URL of t as text) & linefeed & (title of t as text)",
            Adapter::Finder => {
                "set out to \"\"\ntry\nset out to POSIX path of (insertion location as alias)\nend try\nset n to 0\nrepeat with f in (selection as alias list)\nset n to n + 1\nif n > 20 then exit repeat\nset out to out & linefeed & POSIX path of f\nend repeat\nreturn out"
            }
            Adapter::ITerm => "tell current session of current window to return variable named \"session.path\"",
        };
        format!("tell application id \"{bundle_id}\"\n{body}\nend tell")
    }

    /// Puts the script's output into `ctx`.
    pub fn apply(self, output: &str, ctx: &mut WindowContext) {
        let output = output.trim_end_matches(['\n', '\r']);
        match self {
            Adapter::Safari | Adapter::Chromium => {
                let (url, title) = output.split_once('\n').unwrap_or((output, ""));
                let url = url.trim();
                // A new tab, or `missing value`.
                if url.contains("://") && !url.starts_with("about:") && !url.starts_with("chrome://newtab") {
                    ctx.url = Some(url.to_owned());
                    ctx.page_title = cap(title, 300);
                }
            }
            Adapter::Finder => {
                let mut lines = output.lines();
                ctx.folder = lines.next().and_then(|l| cap(l, 1000));
                ctx.files = lines.filter_map(|l| cap(l, 1000)).take(FILES_MAX).collect();
            }
            Adapter::ITerm => ctx.folder = cap(output, 1000).filter(|p| p.starts_with('/')),
        }
    }
}

/// The path of a `file://` URL (as `AXDocument` gives it), percent-decoded.
pub fn file_url_to_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    // `file://localhost/path` or `file:///path`.
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = rest.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    let path = String::from_utf8(out).ok()?;
    // A folder URL ends with "/".
    Some(if path.len() > 1 { path.trim_end_matches('/').to_owned() } else { path })
}

/// osascript's error for an app the user has not allowed (or denied) Automation for.
pub fn automation_denied(stderr: &str) -> bool {
    stderr.contains("-1743")
}

/// Level 0: the frontmost app, `None` when it is Harness itself. Fast; call before the overlay shows.
pub fn capture() -> Option<WindowContext> {
    #[cfg(target_os = "macos")]
    {
        let (app, bundle_id, pid) = mac::frontmost()?;
        if pid == std::process::id() as i32 {
            return None;
        }
        let mut missing = Vec::new();
        if !mac::trusted() {
            missing.push(Missing::Accessibility);
        }
        Some(WindowContext { app, bundle_id, pid, missing, ..Default::default() })
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// Levels 1 and 2 (blocking, up to about a second per level): call off the main thread.
pub fn enrich(ctx: &mut WindowContext) {
    #[cfg(target_os = "macos")]
    {
        if !ctx.missing.contains(&Missing::Accessibility) {
            mac::accessibility(ctx);
        }
        if let Some(a) = adapter(&ctx.bundle_id) {
            match mac::osascript(&a.script(&ctx.bundle_id), std::time::Duration::from_millis(1500)) {
                Ok(out) => a.apply(&out, ctx),
                Err(e) if automation_denied(&e) => ctx.missing.push(Missing::Automation),
                Err(e) => tracing::debug!("window context {}: {e}", ctx.bundle_id),
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = ctx;
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{SELECTED_TEXT_MAX, WindowContext, cap, file_url_to_path};
    use std::ffi::c_void;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type AXUIElementRef = *const c_void;

    #[repr(C)]
    struct CFRange {
        location: isize,
        length: isize,
    }

    const UTF8: u32 = 0x0800_0100;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        /// Never the prompting `AXIsProcessTrustedWithOptions`.
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementSetAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFURLGetTypeID() -> usize;
        fn CFURLGetString(url: CFTypeRef) -> CFStringRef;
        fn CFStringCreateWithBytes(alloc: *const c_void, bytes: *const u8, len: isize, encoding: u32, external: u8) -> CFStringRef;
        fn CFStringGetLength(s: CFStringRef) -> isize;
        #[allow(clippy::too_many_arguments, reason = "CoreFoundation's signature")]
        fn CFStringGetBytes(
            s: CFStringRef,
            range: CFRange,
            encoding: u32,
            loss_byte: u8,
            external: u8,
            buffer: *mut u8,
            max_len: isize,
            used: *mut isize,
        ) -> isize;
    }

    /// An owned CoreFoundation object, released on drop.
    struct Cf(CFTypeRef);

    impl Drop for Cf {
        fn drop(&mut self) {
            // SAFETY: `Cf` only holds non-null objects this code owns (a Create or Copy result).
            unsafe { CFRelease(self.0) }
        }
    }

    impl Cf {
        fn new(r: CFTypeRef) -> Option<Cf> {
            (!r.is_null()).then_some(Cf(r))
        }

        fn string(s: &str) -> Option<Cf> {
            // SAFETY: `s` is valid UTF-8 for `len` bytes; CF copies them.
            Cf::new(unsafe { CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as isize, UTF8, 0) })
        }
    }

    /// The first `max` UTF-16 units of a CFString as a Rust string (unconvertible ones as "?").
    /// SAFETY: `s` must be a live CFString.
    unsafe fn to_string(s: CFStringRef, max: usize) -> Option<String> {
        // SAFETY: as the caller promises; the buffer is as large as the first call says it must be.
        unsafe {
            let len = CFStringGetLength(s).min(max as isize);
            let range = || CFRange { location: 0, length: len };
            let mut used = 0isize;
            CFStringGetBytes(s, range(), UTF8, b'?', 0, std::ptr::null_mut(), 0, &mut used);
            let mut buf = vec![0u8; used.max(0) as usize];
            CFStringGetBytes(s, range(), UTF8, b'?', 0, buf.as_mut_ptr(), used, &mut used);
            buf.truncate(used.max(0) as usize);
            String::from_utf8(buf).ok()
        }
    }

    /// An attribute of an AX element, owned.
    fn attribute(element: AXUIElementRef, name: &str) -> Option<Cf> {
        let name = Cf::string(name)?;
        let mut value: CFTypeRef = std::ptr::null();
        // SAFETY: `element` is a live AXUIElement, `name` a CFString; on success the value is ours.
        let err = unsafe { AXUIElementCopyAttributeValue(element, name.0, &mut value) };
        if err != 0 { None } else { Cf::new(value) }
    }

    /// A string (or URL) attribute as text, at most `max` UTF-16 units.
    fn text(element: AXUIElementRef, name: &str, max: usize) -> Option<String> {
        let v = attribute(element, name)?;
        // SAFETY: the type is checked before the value is used as a CFString or CFURL.
        unsafe {
            let id = CFGetTypeID(v.0);
            if id == CFStringGetTypeID() {
                to_string(v.0, max)
            } else if id == CFURLGetTypeID() {
                // A Get function: the string belongs to the URL.
                let s = CFURLGetString(v.0);
                if s.is_null() { None } else { to_string(s, max) }
            } else {
                None
            }
        }
    }

    pub fn trusted() -> bool {
        // SAFETY: a plain query; it shows no prompt.
        unsafe { AXIsProcessTrusted() != 0 }
    }

    /// Level 1: the focused window's title and document, the focused element's selected text.
    pub fn accessibility(ctx: &mut WindowContext) {
        // SAFETY: creates an element for a pid (any pid is accepted; a gone one makes calls fail).
        let Some(app) = Cf::new(unsafe { AXUIElementCreateApplication(ctx.pid) }) else { return };
        // SAFETY: `app` is a live AXUIElement; `kCFBooleanTrue` is a static CF constant.
        unsafe {
            AXUIElementSetMessagingTimeout(app.0, 0.5);
            // Electron apps (Slack, VS Code, Cursor) build their AX tree only when asked; others ignore it.
            if let Some(name) = Cf::string("AXManualAccessibility") {
                AXUIElementSetAttributeValue(app.0, name.0, kCFBooleanTrue);
            }
        }
        if let Some(window) = attribute(app.0, "AXFocusedWindow") {
            ctx.window_title = text(window.0, "AXTitle", 500).and_then(|t| cap(&t, 300));
            ctx.document_path = text(window.0, "AXDocument", 4000).and_then(|u| file_url_to_path(&u));
        }
        if let Some(focused) = attribute(app.0, "AXFocusedUIElement") {
            ctx.selected_text = text(focused.0, "AXSelectedText", SELECTED_TEXT_MAX + 1).and_then(|t| cap(&t, SELECTED_TEXT_MAX));
        }
    }

    /// The frontmost app: (name, bundle id, pid).
    pub fn frontmost() -> Option<(String, String, i32)> {
        use objc2::runtime::AnyObject;
        let ns = |s: *mut AnyObject| -> Option<String> {
            if s.is_null() {
                return None;
            }
            // SAFETY: `s` is a live NSString (toll-free bridged with CFString).
            unsafe { to_string(s as CFStringRef, 1000) }
        };
        // SAFETY: `NSWorkspace.sharedWorkspace.frontmostApplication` and its getters are plain AppKit
        // getters that may be called from any thread.
        unsafe {
            let ws: *mut AnyObject = objc2::msg_send![objc2::class!(NSWorkspace), sharedWorkspace];
            if ws.is_null() {
                return None;
            }
            let app: *mut AnyObject = objc2::msg_send![ws, frontmostApplication];
            if app.is_null() {
                return None;
            }
            let pid: i32 = objc2::msg_send![app, processIdentifier];
            let name: *mut AnyObject = objc2::msg_send![app, localizedName];
            let bundle: *mut AnyObject = objc2::msg_send![app, bundleIdentifier];
            let bundle = ns(bundle).unwrap_or_default();
            let name = ns(name).unwrap_or_else(|| bundle.clone());
            (!name.is_empty()).then_some((name, bundle, pid))
        }
    }

    /// Runs an AppleScript with `osascript`, killed after `timeout`. `Err` holds its error output.
    /// The first run for an app shows macOS's Automation prompt; a capture that waits past the
    /// timeout gets no level 2, the next one does once allowed.
    pub fn osascript(script: &str, timeout: Duration) -> Result<String, String> {
        let mut child = Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let start = Instant::now();
        let status = loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(s) => break s,
                None if start.elapsed() > timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("timed out".into());
                }
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        };
        let mut out = String::new();
        let mut err = String::new();
        if let Some(mut o) = child.stdout.take() {
            let _ = o.read_to_string(&mut out);
        }
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        if status.success() { Ok(out) } else { Err(err) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> WindowContext {
        WindowContext { app: "X".into(), bundle_id: "x".into(), ..Default::default() }
    }

    #[test]
    fn adapters_by_bundle_id() {
        assert_eq!(adapter("com.apple.Safari"), Some(Adapter::Safari));
        for id in
            ["com.google.Chrome", "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac", "org.chromium.Chromium", "com.vivaldi.Vivaldi"]
        {
            assert_eq!(adapter(id), Some(Adapter::Chromium), "{id}");
        }
        assert_eq!(adapter("com.apple.finder"), Some(Adapter::Finder));
        assert_eq!(adapter("com.googlecode.iterm2"), Some(Adapter::ITerm));
        assert_eq!(adapter("org.mozilla.firefox"), None);
        assert_eq!(adapter("com.apple.Terminal"), None);
    }

    #[test]
    fn scripts_address_the_app_by_id() {
        let s = Adapter::Chromium.script("com.brave.Browser");
        assert!(s.starts_with("tell application id \"com.brave.Browser\"\n"), "{s}");
        assert!(s.contains("active tab of front window") && s.ends_with("end tell"));
        assert!(Adapter::Safari.script("com.apple.Safari").contains("current tab of front window"));
    }

    #[test]
    fn browser_output_gives_url_and_title() {
        let mut c = ctx();
        Adapter::Chromium.apply("https://github.com/dswbx/harness/pull/52\nQuick overlay · PR #52\n", &mut c);
        assert_eq!(c.url.as_deref(), Some("https://github.com/dswbx/harness/pull/52"));
        assert_eq!(c.page_title.as_deref(), Some("Quick overlay · PR #52"));
    }

    #[test]
    fn browser_new_tab_gives_nothing() {
        for out in ["chrome://newtab/\nNew Tab", "missing value\n", "about:blank\n", ""] {
            let mut c = ctx();
            Adapter::Safari.apply(out, &mut c);
            assert_eq!(c.url, None, "{out}");
        }
    }

    #[test]
    fn finder_output_gives_folder_and_capped_files() {
        let mut c = ctx();
        let files: Vec<String> = (0..30).map(|i| format!("/Users/me/Downloads/f{i}.txt")).collect();
        Adapter::Finder.apply(&format!("/Users/me/Downloads/\n{}\n", files.join("\n")), &mut c);
        assert_eq!(c.folder.as_deref(), Some("/Users/me/Downloads/"));
        assert_eq!(c.files.len(), FILES_MAX);
        assert_eq!(c.files[0], "/Users/me/Downloads/f0.txt");
        // No window, no selection.
        let mut c = ctx();
        Adapter::Finder.apply("\n", &mut c);
        assert_eq!((c.folder, c.files.len()), (None, 0));
    }

    #[test]
    fn iterm_output_gives_a_folder() {
        let mut c = ctx();
        Adapter::ITerm.apply("/Users/me/code/harness\n", &mut c);
        assert_eq!(c.folder.as_deref(), Some("/Users/me/code/harness"));
        let mut c = ctx();
        Adapter::ITerm.apply("missing value\n", &mut c);
        assert_eq!(c.folder, None);
    }

    #[test]
    fn file_urls_to_paths() {
        assert_eq!(file_url_to_path("file:///Users/me/My%20Doc.pages").as_deref(), Some("/Users/me/My Doc.pages"));
        assert_eq!(file_url_to_path("file://localhost/tmp/a%C3%A9.txt").as_deref(), Some("/tmp/aé.txt"));
        assert_eq!(file_url_to_path("file:///Users/me/folder/").as_deref(), Some("/Users/me/folder"));
        assert_eq!(file_url_to_path("file:///").as_deref(), Some("/"));
        assert_eq!(file_url_to_path("https://example.com/x"), None);
        // A broken escape stays as it is.
        assert_eq!(file_url_to_path("file:///a%zz").as_deref(), Some("/a%zz"));
    }

    #[test]
    fn cap_trims_and_cuts() {
        assert_eq!(cap("  hi \n", 10).as_deref(), Some("hi"));
        assert_eq!(cap("   ", 10), None);
        assert_eq!(cap("abcdef", 3).as_deref(), Some("abc…"));
        assert_eq!(cap("ééééé", 5).as_deref(), Some("ééééé"));
    }

    #[test]
    fn automation_denied_is_error_1743() {
        assert!(automation_denied("execution error: Not authorized to send Apple events to Google Chrome. (-1743)"));
        assert!(!automation_denied("execution error: Can’t get window 1. Invalid index. (-1719)"));
    }

    #[test]
    fn serializes_camel_case_and_skips_empty() {
        let mut c = ctx();
        c.url = Some("https://x.dev".into());
        c.missing = vec![Missing::Accessibility];
        assert_eq!(serde_json::to_value(&c).unwrap(), serde_json::json!({ "app": "X", "bundleId": "x", "url": "https://x.dev", "missing": ["accessibility"] }));
    }
}
