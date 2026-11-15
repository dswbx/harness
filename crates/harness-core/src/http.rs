//! HTTP for the core: one reqwest stack (rustls, ring provider, platform certificate verifier, proxy
//! from the standard env vars). `download` streams to a file, `get_bytes`/`get_json` read small
//! documents. Every call has a connect timeout, a stall timeout, a size cap and a redirect limit; small
//! documents also a total limit (a download has none: it runs as long as bytes keep coming). https only, unless `Opts::insecure` (a test server or a local registry).

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};

pub fn builder() -> reqwest::ClientBuilder {
    // Fails when a provider is installed already, which is fine.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder().user_agent(concat!("harness/", env!("CARGO_PKG_VERSION")))
}

/// Limits and checks of one call. `Opts::download()` and `Opts::small()` are the two presets.
#[derive(Debug, Clone)]
pub struct Opts {
    pub connect_timeout: Duration,
    /// Give up when no bytes arrive for this long (also while waiting for the response headers).
    pub stall_timeout: Duration,
    /// Give up after this long in total, per attempt. `None`: as long as bytes keep coming.
    pub total_timeout: Option<Duration>,
    pub max_bytes: u64,
    pub max_redirects: usize,
    /// Extra attempts after a connection failure or a 5xx. A stall or timeout is not retried: a
    /// retry restarts from byte 0 and would only repeat the wait.
    pub retries: u32,
    /// Hex sha256 the body must have; checked before the file is put in place.
    pub sha256: Option<String>,
    /// Allow `http://` and `file://`.
    pub insecure: bool,
    pub accept: Option<&'static str>,
}

impl Opts {
    /// Archives and binaries: up to 2 GiB, no total limit, 60 s without bytes, 2 retries.
    pub fn download() -> Self {
        Self {
            connect_timeout: Duration::from_secs(30),
            stall_timeout: Duration::from_secs(60),
            total_timeout: None,
            max_bytes: 2 << 30,
            max_redirects: 10,
            retries: 2,
            sha256: None,
            insecure: false,
            accept: None,
        }
    }

    /// A small document: 15 s, 512 KB, no retries.
    pub fn small() -> Self {
        Self { total_timeout: Some(Duration::from_secs(15)), stall_timeout: Duration::from_secs(15), max_bytes: 512 * 1024, retries: 0, ..Self::download() }
    }

    pub fn sha256(mut self, hex: Option<&str>) -> Self {
        self.sha256 = hex.map(str::to_owned);
        self
    }

    pub fn insecure(mut self, yes: bool) -> Self {
        self.insecure = yes;
        self
    }

    pub fn max_bytes(mut self, n: u64) -> Self {
        self.max_bytes = n;
        self
    }

    pub fn accept(mut self, a: &'static str) -> Self {
        self.accept = Some(a);
        self
    }
}

#[derive(Debug)]
pub enum Error {
    NotHttps,
    Status(u16),
    TooLarge(u64),
    Stalled(u64),
    TimedOut(u64),
    Checksum {
        expected: String,
        actual: String,
    },
    /// The request was refused on purpose: a certificate that does not verify, a redirect that is not allowed.
    /// Retrying cannot help.
    Refused(String),
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NotHttps => f.write_str("only https URLs are allowed"),
            Error::Status(s) => write!(f, "HTTP {s}"),
            Error::TooLarge(n) => write!(f, "larger than the {n} byte limit"),
            Error::Stalled(s) => write!(f, "no data for {s} s"),
            Error::TimedOut(s) => write!(f, "not finished within {s} s"),
            Error::Checksum { expected, actual } => write!(f, "checksum mismatch: expected {expected}, got {actual}"),
            Error::Refused(m) | Error::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {}

impl Error {
    /// What a caller can act on: a timeout, or a network failure worth trying again later.
    pub fn code(&self) -> Option<crate::api::ErrorCode> {
        match self {
            Error::Stalled(_) | Error::TimedOut(_) => Some(crate::api::ErrorCode::Timeout),
            Error::Refused(_) => Some(crate::api::ErrorCode::Invalid),
            e if e.transient() => Some(crate::api::ErrorCode::Unavailable),
            _ => None,
        }
    }

    /// Worth another attempt: a connection failure or a 5xx. Not a stall or timeout (see `Opts::retries`).
    fn transient(&self) -> bool {
        match self {
            Error::Status(s) => *s >= 500,
            Error::Other(m) => m.starts_with("request:"),
            _ => false,
        }
    }
}

fn client(url: &str, o: &Opts) -> Result<reqwest::Client, Error> {
    if !o.insecure && !url.starts_with("https://") {
        return Err(Error::NotHttps);
    }
    let insecure = o.insecure;
    let max = o.max_redirects;
    let policy = reqwest::redirect::Policy::custom(move |a| {
        if a.previous().len() >= max {
            a.error("too many redirects")
        } else if !insecure && a.url().scheme() != "https" {
            a.error("redirect to a non-https URL")
        } else {
            a.follow()
        }
    });
    builder().connect_timeout(o.connect_timeout).redirect(policy).build().map_err(|e| Error::Other(e.to_string()))
}

/// Starts the GET and returns the response once the status is a success.
async fn open(url: &str, o: &Opts) -> Result<reqwest::Response, Error> {
    let mut req = client(url, o)?.get(url);
    if let Some(a) = o.accept {
        req = req.header(reqwest::header::ACCEPT, a);
    }
    let resp = req.send().await.map_err(|e| request_error(&e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(Error::Status(status.as_u16()));
    }
    if resp.content_length().is_some_and(|n| n > o.max_bytes) {
        return Err(Error::TooLarge(o.max_bytes));
    }
    Ok(resp)
}

/// A reqwest error as ours: refused on purpose (TLS, redirect policy), else a network failure.
fn request_error(e: &reqwest::Error) -> Error {
    let message = format!("request: {}", describe(e));
    if e.is_redirect() || message.to_lowercase().contains("certificate") { Error::Refused(message) } else { Error::Other(message) }
}

/// The innermost causes of a reqwest error, without its URL (callers name the URL).
fn describe(e: &reqwest::Error) -> String {
    use std::error::Error as _;
    let mut parts = vec![];
    let mut src = e.source();
    while let Some(c) = src {
        parts.push(c.to_string());
        src = c.source();
    }
    if parts.is_empty() { e.to_string() } else { parts.join(": ") }
}

/// Reads chunks into `sink` with the stall, total (when set) and size limits; returns the sha256 of the body.
async fn pump(url: &str, o: &Opts, mut sink: impl FnMut(&[u8]) -> std::io::Result<()>) -> Result<String, Error> {
    let io = |e: std::io::Error| Error::Other(e.to_string());
    let hash = |h: Sha256| format!("{:x}", h.finalize());
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    if let Some(path) = url.strip_prefix("file://") {
        require_insecure(o)?;
        let bytes = std::fs::read(path).map_err(io)?;
        if bytes.len() as u64 > o.max_bytes {
            return Err(Error::TooLarge(o.max_bytes));
        }
        hasher.update(&bytes);
        sink(&bytes).map_err(io)?;
        return Ok(hash(hasher));
    }
    let work = async {
        let resp = tokio::time::timeout(o.stall_timeout, open(url, o)).await.map_err(|_| Error::Stalled(o.stall_timeout.as_secs()))??;
        let mut stream = resp.bytes_stream();
        loop {
            let next = tokio::time::timeout(o.stall_timeout, stream.next()).await.map_err(|_| Error::Stalled(o.stall_timeout.as_secs()))?;
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|e| request_error(&e))?;
            total += chunk.len() as u64;
            if total > o.max_bytes {
                return Err(Error::TooLarge(o.max_bytes));
            }
            hasher.update(&chunk);
            sink(&chunk).map_err(io)?;
        }
        Ok(())
    };
    match o.total_timeout {
        Some(limit) => tokio::time::timeout(limit, work).await.map_err(|_| Error::TimedOut(limit.as_secs()))??,
        None => work.await?,
    }
    Ok(hash(hasher))
}

fn require_insecure(o: &Opts) -> Result<(), Error> {
    if o.insecure { Ok(()) } else { Err(Error::NotHttps) }
}

fn verify(o: &Opts, actual: &str) -> Result<(), Error> {
    match &o.sha256 {
        Some(expected) if !actual.eq_ignore_ascii_case(expected) => Err(Error::Checksum { expected: expected.clone(), actual: actual.to_owned() }),
        _ => Ok(()),
    }
}

async fn with_retries<T, F, Fut>(o: &Opts, mut attempt: F) -> Result<T, Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, Error>>,
{
    let mut left = o.retries;
    loop {
        match attempt().await {
            Err(e) if left > 0 && e.transient() => {
                left -= 1;
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            r => return r,
        }
    }
}

/// The body of `url` in memory (at most `o.max_bytes`).
pub async fn get_bytes(url: &str, o: &Opts) -> Result<Vec<u8>, Error> {
    with_retries(o, || async {
        let mut buf = Vec::new();
        let sha = pump(url, o, |c| {
            buf.extend_from_slice(c);
            Ok(())
        })
        .await?;
        verify(o, &sha)?;
        Ok(buf)
    })
    .await
}

pub async fn get_json(url: &str, o: &Opts) -> anyhow::Result<serde_json::Value> {
    let o = o.clone().accept("application/json");
    let bytes = get_bytes(url, &o).await.map_err(|e| crate::error::from_http(&e, e.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|e| anyhow::anyhow!("{url} is not JSON: {e}"))
}

/// Downloads `url` to `dest` and returns the sha256 of the body. The body goes to a temp file next
/// to `dest`, which is renamed into place only after the hash matched: a failure leaves no `dest`.
pub async fn download(url: &str, dest: &Path, o: &Opts) -> Result<String, Error> {
    let dir = dest.parent().unwrap_or(Path::new("."));
    // Its own name per download, removed however this ends (also when the future is dropped).
    let tmp = Part(dir.join(format!(".{}.{}.part", dest.file_name().and_then(|n| n.to_str()).unwrap_or("download"), uuid::Uuid::new_v4().simple())));
    let r = with_retries(o, || async {
        let mut file = std::fs::File::create(&tmp.0).map_err(|e| Error::Other(e.to_string()))?;
        let sha = pump(url, o, |c| std::io::Write::write_all(&mut file, c)).await?;
        verify(o, &sha)?;
        file.sync_all().map_err(|e| Error::Other(e.to_string()))?;
        Ok(sha)
    })
    .await;
    let sha = r?;
    tokio::fs::rename(&tmp.0, dest).await.map_err(|e| Error::Other(e.to_string()))?;
    Ok(sha)
}

/// A download's temp file; deleted on drop (after a rename there is nothing left to delete).
struct Part(PathBuf);

impl Drop for Part {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A hand-rolled one-route-per-path HTTP/1.1 server: enough for these tests.
    async fn serve() -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let body = b"hello world".to_vec();
                    let reply = |status: &str, extra: &str, body: &[u8]| {
                        let mut r = format!("HTTP/1.1 {status}\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n", body.len()).into_bytes();
                        r.extend_from_slice(body);
                        r
                    };
                    match path.as_str() {
                        "/ok" => {
                            let _ = s.write_all(&reply("200 OK", "", &body)).await;
                        }
                        "/big" => {
                            let _ = s.write_all(&reply("200 OK", "", &vec![b'x'; 10_000])).await;
                        }
                        "/chunked-big" => {
                            // No content-length: the cap has to hold while streaming.
                            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n").await;
                            for _ in 0..20 {
                                if s.write_all(&[b'x'; 1000]).await.is_err() {
                                    return;
                                }
                            }
                        }
                        "/stall" => {
                            let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nabc").await;
                            tokio::time::sleep(Duration::from_secs(30)).await;
                        }
                        "/drip" => {
                            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n").await;
                            for _ in 0..100 {
                                if s.write_all(b"x").await.is_err() {
                                    return;
                                }
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                        }
                        "/drip-short" => {
                            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n").await;
                            for _ in 0..30 {
                                if s.write_all(b"x").await.is_err() {
                                    return;
                                }
                                tokio::time::sleep(Duration::from_millis(30)).await;
                            }
                        }
                        "/no-headers" => {
                            tokio::time::sleep(Duration::from_secs(30)).await;
                        }
                        "/loop" => {
                            let _ = s.write_all(&reply("302 Found", "location: /loop\r\n", b"")).await;
                        }
                        "/to-ok" => {
                            let _ = s.write_all(&reply("302 Found", "location: /ok\r\n", b"")).await;
                        }
                        "/json" => {
                            let _ = s.write_all(&reply("200 OK", "content-type: application/json\r\n", br#"{"a":1}"#)).await;
                        }
                        "/ua" => {
                            let ua = req.lines().find(|l| l.to_ascii_lowercase().starts_with("user-agent:")).unwrap_or("").to_owned();
                            let _ = s.write_all(&reply("200 OK", "", ua.as_bytes())).await;
                        }
                        _ => {
                            let _ = s.write_all(&reply("404 Not Found", "", b"nope")).await;
                        }
                    }
                });
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    fn opts() -> Opts {
        Opts { retries: 0, ..Opts::download() }.insecure(true)
    }

    const HELLO_SHA: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

    #[tokio::test]
    async fn downloads_and_hashes() {
        let base = serve().await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("f");
        let sha = download(&format!("{base}/ok"), &dest, &opts().sha256(Some(HELLO_SHA))).await.unwrap();
        assert_eq!(sha, HELLO_SHA);
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello world");
        // No temp file left next to it.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn hash_mismatch_leaves_nothing() {
        let base = serve().await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("f");
        std::fs::write(&dest, "old").unwrap();
        let err = download(&format!("{base}/ok"), &dest, &opts().sha256(Some("00"))).await.unwrap_err();
        assert!(matches!(err, Error::Checksum { .. }), "{err}");
        // The previous file is untouched and no temp file stays.
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        std::fs::remove_file(&dest).unwrap();
        download(&format!("{base}/ok"), &dest, &opts().sha256(Some("00"))).await.unwrap_err();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn size_cap_by_header_and_while_streaming() {
        let base = serve().await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("f");
        let e = download(&format!("{base}/big"), &dest, &opts().max_bytes(1000)).await.unwrap_err();
        assert!(matches!(e, Error::TooLarge(1000)), "{e}");
        let e = download(&format!("{base}/chunked-big"), &dest, &opts().max_bytes(5000)).await.unwrap_err();
        assert!(matches!(e, Error::TooLarge(5000)), "{e}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn stall_timeout() {
        let base = serve().await;
        let dir = tempfile::tempdir().unwrap();
        let o = Opts { stall_timeout: Duration::from_millis(300), ..opts() };
        let e = download(&format!("{base}/stall"), &dir.path().join("f"), &o).await.unwrap_err();
        assert!(matches!(e, Error::Stalled(_)), "{e}");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn a_slow_but_alive_download_has_no_total_limit() {
        let base = serve().await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("f");
        // About 0.9 s of body, past the 400 ms a total limit would allow; every gap is far below the stall limit.
        let o = Opts { stall_timeout: Duration::from_millis(500), ..opts() };
        assert!(o.total_timeout.is_none());
        download(&format!("{base}/drip-short"), &dest, &o).await.unwrap();
        assert_eq!(std::fs::read(&dest).unwrap().len(), 30);
        let limited = Opts { total_timeout: Some(Duration::from_millis(400)), ..o };
        let e = download(&format!("{base}/drip-short"), &dir.path().join("g"), &limited).await.unwrap_err();
        assert!(matches!(e, Error::TimedOut(_)), "{e}");
    }

    #[tokio::test]
    async fn a_stall_is_not_retried_and_silent_headers_count_as_a_stall() {
        let base = serve().await;
        let dir = tempfile::tempdir().unwrap();
        let o = Opts { stall_timeout: Duration::from_millis(300), retries: 2, ..opts() };
        let started = std::time::Instant::now();
        let e = download(&format!("{base}/stall"), &dir.path().join("f"), &o).await.unwrap_err();
        assert!(matches!(e, Error::Stalled(_)), "{e}");
        // Three attempts would take over 1.9 s (3 x 300 ms plus two pauses).
        assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());
        let e = download(&format!("{base}/no-headers"), &dir.path().join("f"), &o).await.unwrap_err();
        assert!(matches!(e, Error::Stalled(_)), "{e}");
    }

    #[tokio::test]
    async fn total_timeout_even_when_bytes_keep_coming() {
        let base = serve().await;
        let dir = tempfile::tempdir().unwrap();
        let o = Opts { total_timeout: Some(Duration::from_millis(400)), ..opts() };
        let e = download(&format!("{base}/drip"), &dir.path().join("f"), &o).await.unwrap_err();
        assert!(matches!(e, Error::TimedOut(_)), "{e}");
    }

    #[tokio::test]
    async fn redirects_are_followed_but_limited() {
        let base = serve().await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("f");
        download(&format!("{base}/to-ok"), &dest, &opts()).await.unwrap();
        let o = Opts { max_redirects: 3, ..opts() };
        let e = download(&format!("{base}/loop"), &dest, &o).await.unwrap_err();
        assert!(e.to_string().contains("redirect"), "{e}");
    }

    #[tokio::test]
    async fn not_found_is_a_typed_error_and_http_needs_opt_in() {
        let base = serve().await;
        let dir = tempfile::tempdir().unwrap();
        let e = download(&format!("{base}/missing"), &dir.path().join("f"), &opts()).await.unwrap_err();
        assert!(matches!(e, Error::Status(404)), "{e}");
        let e = get_bytes(&format!("{base}/ok"), &Opts::small()).await.unwrap_err();
        assert!(matches!(e, Error::NotHttps), "{e}");
        let e = get_bytes("file:///etc/hosts", &Opts::small()).await.unwrap_err();
        assert!(matches!(e, Error::NotHttps), "{e}");
    }

    #[tokio::test]
    async fn get_json_and_user_agent() {
        let base = serve().await;
        let v = get_json(&format!("{base}/json"), &Opts::small().insecure(true)).await.unwrap();
        assert_eq!(v["a"], 1);
        let ua = get_bytes(&format!("{base}/ua"), &Opts::small().insecure(true)).await.unwrap();
        assert!(String::from_utf8_lossy(&ua).contains("harness/"));
        assert!(get_json(&format!("{base}/ok"), &Opts::small().insecure(true)).await.unwrap_err().to_string().contains("not JSON"));
    }

    #[tokio::test]
    async fn file_urls_need_opt_in_and_verify() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::write(&src, "hello world").unwrap();
        let dest = dir.path().join("dest");
        let url = format!("file://{}", src.display());
        assert_eq!(download(&url, &dest, &opts().sha256(Some(HELLO_SHA))).await.unwrap(), HELLO_SHA);
        std::fs::remove_file(&dest).unwrap();
        download(&url, &dest, &opts().sha256(Some("00"))).await.unwrap_err();
        assert!(!dest.exists());
    }
}
