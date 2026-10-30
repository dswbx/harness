//! The app's own settings that are not a Primitive (appearance, imported themes): opaque JSON the
//! app owns, one file per key in the data dir, like `editor.json`. Plus the theme fetch: a theme
//! URL (a shadcn registry item, e.g. tweakcn) is read once and stored by the app.

use std::path::Path;

use crate::api::{AppSettingKey, Json};

fn file(key: AppSettingKey) -> &'static str {
    match key {
        AppSettingKey::Appearance => "appearance.json",
        AppSettingKey::Themes => "themes.json",
    }
}

pub fn load(data_dir: &Path, key: AppSettingKey) -> Option<Json> {
    serde_json::from_slice(&std::fs::read(data_dir.join(file(key))).ok()?).ok()
}

pub fn save(data_dir: &Path, key: AppSettingKey, value: Option<&Json>) -> anyhow::Result<()> {
    let path = data_dir.join(file(key));
    match value {
        Some(v) => {
            // Write then rename: a crash never leaves half a file.
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(v)?)?;
            std::fs::rename(tmp, path)?;
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// Largest theme document we read.
const MAX_BYTES: &str = "524288";

/// The JSON at an https `url` (system `curl`, like toolchain downloads; https only, 512 KB at most).
pub async fn fetch_json(url: &str) -> anyhow::Result<Json> {
    anyhow::ensure!(url.starts_with("https://"), "only https URLs");
    let out = tokio::process::Command::new("curl")
        .args(["-fsSL", "--proto", "=https", "--max-time", "15", "--max-filesize", MAX_BYTES, "-H", "Accept: application/json"])
        .arg(url)
        .output()
        .await?;
    anyhow::ensure!(out.status.success(), "fetch {url}: {}", String::from_utf8_lossy(&out.stderr).trim());
    serde_json::from_slice(&out.stdout).map_err(|e| anyhow::anyhow!("{url} is not JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_loads_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path(), AppSettingKey::Themes), None);
        let v = serde_json::json!({ "zen": { "label": "Zen" } });
        save(dir.path(), AppSettingKey::Themes, Some(&v)).unwrap();
        assert_eq!(load(dir.path(), AppSettingKey::Themes), Some(v));
        assert_eq!(load(dir.path(), AppSettingKey::Appearance), None);
        save(dir.path(), AppSettingKey::Themes, None).unwrap();
        assert_eq!(load(dir.path(), AppSettingKey::Themes), None);
    }

    #[tokio::test]
    async fn fetch_refuses_http() {
        assert!(fetch_json("http://example.com/x.json").await.unwrap_err().to_string().contains("https"));
    }
}
