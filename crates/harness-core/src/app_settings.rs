//! The app's own settings that are not a Primitive (appearance, imported themes, the Quick overlay): opaque JSON the
//! app owns, one file per key in the data dir, like `editor.json`. Plus the theme fetch: a theme
//! URL (a shadcn registry item, e.g. tweakcn) is read once and stored by the app.

use std::path::Path;

use crate::api::{AppSettingKey, Json};

fn file(key: AppSettingKey) -> &'static str {
    match key {
        AppSettingKey::Appearance => "appearance.json",
        AppSettingKey::Themes => "themes.json",
        AppSettingKey::Overlay => "overlay.json",
    }
}

pub fn load(data_dir: &Path, key: AppSettingKey) -> Option<Json> {
    json_file(data_dir, key).load_logged()
}

fn json_file(data_dir: &Path, key: AppSettingKey) -> crate::persist::JsonFile<Json> {
    crate::persist::JsonFile::in_dir(data_dir, file(key))
}

pub fn save(data_dir: &Path, key: AppSettingKey, value: Option<&Json>) -> anyhow::Result<()> {
    match value {
        Some(v) => json_file(data_dir, key).save(v)?,
        None => json_file(data_dir, key).remove(),
    }
    Ok(())
}

/// The JSON at an https `url` (512 KB at most, 15 s).
pub async fn fetch_json(url: &str) -> anyhow::Result<Json> {
    crate::http::get_json(url, &crate::http::Opts::small()).await.map_err(|e| crate::error::reword(&e, format!("fetch {url}: {e}")))
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_corrupt_setting_is_moved_aside_and_reads_as_unset() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("themes.json"), r#"{"zen":{"label":"Zen"}}"#).unwrap();
        assert_eq!(load(dir.path(), AppSettingKey::Themes), Some(serde_json::json!({"zen": {"label": "Zen"}})));
        std::fs::write(dir.path().join("themes.json"), b"{").unwrap();
        assert_eq!(load(dir.path(), AppSettingKey::Themes), None);
        assert!(std::fs::read_dir(dir.path()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("themes.json.corrupt-")));
    }
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

    #[test]
    fn overlay_round_trips_and_fills_defaults() {
        use crate::api::{OverlayPosition, OverlaySettings};
        let dir = tempfile::tempdir().unwrap();
        let v = OverlaySettings { shortcut: "CmdOrCtrl+Shift+K".into(), position: OverlayPosition::Bottom, window_context: false };
        save(dir.path(), AppSettingKey::Overlay, Some(&serde_json::to_value(&v).unwrap())).unwrap();
        assert!(dir.path().join("overlay.json").exists());
        let back: OverlaySettings = serde_json::from_value(load(dir.path(), AppSettingKey::Overlay).unwrap()).unwrap();
        assert_eq!(back, v);
        // A file with only some fields (older or hand-edited) takes the defaults for the rest.
        let partial: OverlaySettings = serde_json::from_value(serde_json::json!({ "position": "bottom" })).unwrap();
        assert_eq!(partial, OverlaySettings { position: OverlayPosition::Bottom, ..Default::default() });
        assert_eq!(
            serde_json::to_value(OverlaySettings::default()).unwrap(),
            serde_json::json!({ "shortcut": "Alt+Space", "position": "cursor", "window_context": true })
        );
    }

    #[tokio::test]
    async fn fetch_refuses_http() {
        assert!(fetch_json("http://example.com/x.json").await.unwrap_err().to_string().contains("https"));
    }
}
