//! Harness-managed runtimes for Agents (ADR 0007): pinned Node and uv in app data, verified by
//! sha256, never the user's system installs. Downloads use the system `curl`; archives are
//! unpacked with the system `tar` (bsdtar reads zip too).

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

struct Pin {
    name: &'static str,
    url: String,
    sha256: &'static str,
    /// Directory the archive unpacks to.
    top: String,
    /// Directory (relative to the unpacked root) holding the executables.
    bin: &'static str,
}

const NODE_VERSION: &str = "24.22.1";
const UV_VERSION: &str = "0.13.5";

fn node_pin() -> anyhow::Result<Pin> {
    let (arch, sha256) = match std::env::consts::ARCH {
        "aarch64" => ("arm64", "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7"),
        "x86_64" => ("x64", "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035"),
        a => anyhow::bail!("unsupported architecture {a}"),
    };
    let top = format!("node-v{NODE_VERSION}-darwin-{arch}");
    Ok(Pin { name: "node", url: format!("https://nodejs.org/dist/v{NODE_VERSION}/{top}.tar.gz"), sha256, top, bin: "bin" })
}

fn uv_pin() -> anyhow::Result<Pin> {
    let (target, sha256) = match std::env::consts::ARCH {
        "aarch64" => ("aarch64-apple-darwin", "743f85035a1996ecb350659e01cd9faea9709829be09b1b4b03c73eaf3c9cd73"),
        "x86_64" => ("x86_64-apple-darwin", "b0f52b0e3945b4107d89024ea38e625683011fbfc05a0d98f9fa2d6dcee28c66"),
        a => anyhow::bail!("unsupported architecture {a}"),
    };
    let top = format!("uv-{target}");
    Ok(Pin {
        name: "uv",
        url: format!("https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{top}.tar.gz"),
        sha256,
        top,
        bin: "",
    })
}

/// Registry platform key of this machine.
pub fn platform() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "darwin-aarch64",
        _ => "darwin-x86_64",
    }
}

pub struct Toolchain {
    root: PathBuf,
    lock: tokio::sync::Mutex<()>,
}

impl Toolchain {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("toolchain"), lock: Default::default() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn dir(&self, pin: &Pin) -> PathBuf {
        self.root.join(&pin.top)
    }

    /// Bin directory of the pinned runtime, installing it first if needed.
    async fn ensure(&self, pin: Pin) -> anyhow::Result<PathBuf> {
        let _guard = self.lock.lock().await;
        let dir = self.dir(&pin);
        let bin = dir.join(pin.bin);
        if bin.exists() {
            return Ok(bin);
        }
        std::fs::create_dir_all(&self.root)?;
        let staging = self.root.join(format!(".staging-{}", uuid::Uuid::now_v7()));
        let result = async {
            std::fs::create_dir_all(&staging)?;
            let archive = staging.join("archive.tar.gz");
            download(&pin.url, &archive, Some(pin.sha256)).await?;
            unpack(&archive, &staging).await?;
            std::fs::rename(staging.join(&pin.top), &dir)?;
            anyhow::Ok(())
        }
        .await;
        let _ = std::fs::remove_dir_all(&staging);
        result.map_err(|e| anyhow::anyhow!("installing {}: {e:#}", pin.name))?;
        Ok(bin)
    }

    pub async fn node(&self) -> anyhow::Result<PathBuf> {
        self.ensure(node_pin()?).await
    }

    pub async fn uv(&self) -> anyhow::Result<PathBuf> {
        self.ensure(uv_pin()?).await
    }

    /// PATH for Agents and their tools: installed runtimes first, then the login-shell PATH.
    pub fn path(&self) -> String {
        let mut parts: Vec<String> = [node_pin(), uv_pin()]
            .into_iter()
            .flatten()
            .map(|p| self.dir(&p).join(p.bin))
            .filter(|b| b.exists())
            .map(|b| b.display().to_string())
            .collect();
        parts.push(crate::env::login_path().to_owned());
        parts.join(":")
    }
}

/// Downloads `url` (http(s) or file) to `dest`, verifying the sha256 when given.
pub async fn download(url: &str, dest: &Path, sha256: Option<&str>) -> anyhow::Result<()> {
    let out = tokio::process::Command::new("curl")
        .args(["-fsSL", "--retry", "2", "-o"])
        .arg(dest)
        .arg(url)
        .output()
        .await?;
    anyhow::ensure!(out.status.success(), "download {url}: {}", String::from_utf8_lossy(&out.stderr).trim());
    if let Some(expected) = sha256 {
        let actual = format!("{:x}", Sha256::digest(std::fs::read(dest)?));
        anyhow::ensure!(actual.eq_ignore_ascii_case(expected), "checksum mismatch for {url}: expected {expected}, got {actual}");
    }
    Ok(())
}

pub async fn unpack(archive: &Path, into: &Path) -> anyhow::Result<()> {
    let out = tokio::process::Command::new("tar").arg("-xf").arg(archive).arg("-C").arg(into).output().await?;
    anyhow::ensure!(out.status.success(), "unpack {}: {}", archive.display(), String::from_utf8_lossy(&out.stderr).trim());
    Ok(())
}

pub fn is_archive(url: &str) -> bool {
    let u = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    [".zip", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar"].iter().any(|e| u.ends_with(e))
}
