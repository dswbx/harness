//! Outside links open in the default browser, never in a Harness webview. A plain `<a href>` in a
//! chat (or any page) would otherwise replace the main window or the Quick overlay with that page.
//! This guards every webview (main, overlay, popped-out windows, agent HTML frames).

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("links")
        .on_navigation(|webview, url| {
            let dev_url = webview.app_handle().config().build.dev_url.clone();
            if !is_outside(url, dev_url.as_ref()) {
                return true;
            }
            if let Err(e) = webview.app_handle().opener().open_url(url.as_str(), None::<&str>) {
                tracing::warn!("open {url} failed: {e}");
            }
            false
        })
        .build()
}

/// An `http(s)` or `mailto` URL that is not the app itself: not the dev server and not a
/// `*.localhost` custom protocol host (`tauri.localhost`, `harness-frame.localhost`, `ipc.localhost`).
fn is_outside(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "mailto" => true,
        "http" | "https" => {
            if dev_url.is_some_and(|d| d.origin() == url.origin()) {
                return false;
            }
            !url.host_str().is_some_and(|h| h.ends_with(".localhost"))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outside(url: &str) -> bool {
        let dev = Url::parse("http://localhost:1420").ok();
        is_outside(&Url::parse(url).expect("url"), dev.as_ref())
    }

    #[test]
    fn web_pages_are_outside() {
        assert!(outside("https://github.com/x/y"));
        assert!(outside("http://example.com"));
        assert!(outside("mailto:a@b.c"));
        // A user's own dev server is a different app.
        assert!(outside("http://localhost:3000/"));
        assert!(outside("http://127.0.0.1:1420/"));
    }

    #[test]
    fn app_pages_stay() {
        assert!(!outside("http://localhost:1420/?overlay=1"));
        assert!(!outside("tauri://localhost/"));
        assert!(!outside("http://tauri.localhost/"));
        assert!(!outside("http://harness-frame.localhost/x"));
        assert!(!outside("harness-frame://localhost/x"));
        assert!(!outside("about:blank"));
        assert!(!outside("data:text/html,hi"));
        assert!(!outside("blob:tauri://localhost/abc"));
    }
}
