//! Boot defaults every host shares (the desktop adapter, the smoke example): where the data lives
//! and which Frontends ship with the app.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::api::FrontendManifest;

/// `$HARNESS_HOME` (`harness_home`, when set and not empty), else `~/.harness`, or `~/.harness-dev`
/// for dev builds so they never touch real data. The core cannot know the build profile or the
/// home folder: the host passes them.
pub fn default_data_dir(home: PathBuf, harness_home: Option<OsString>, dev: bool) -> PathBuf {
    match harness_home {
        Some(dir) if !dir.is_empty() => dir.into(),
        _ => home.join(if dev { ".harness-dev" } else { ".harness" }),
    }
}

/// Manifests of the built-in Frontends (the chat and the inspector), to register at boot.
pub fn builtin_frontends() -> Vec<FrontendManifest> {
    [include_str!("../../../../packages/frontend-chat/manifest.json"), include_str!("../../../../packages/frontend-inspector/manifest.json")]
        .into_iter()
        .map(|raw| serde_json::from_str(raw).expect("built-in Frontend Manifest is valid"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/home/u")
    }

    #[test]
    fn release_uses_dot_harness() {
        assert_eq!(default_data_dir(home(), None, false), PathBuf::from("/home/u/.harness"));
    }

    #[test]
    fn dev_uses_dot_harness_dev() {
        assert_eq!(default_data_dir(home(), None, true), PathBuf::from("/home/u/.harness-dev"));
    }

    #[test]
    fn env_override_wins_in_both_profiles() {
        for dev in [false, true] {
            assert_eq!(default_data_dir(home(), Some("/data".into()), dev), PathBuf::from("/data"));
        }
    }

    #[test]
    fn empty_env_is_ignored() {
        assert_eq!(default_data_dir(home(), Some("".into()), false), PathBuf::from("/home/u/.harness"));
    }

    #[test]
    fn builtin_frontends_are_chat_and_inspector() {
        let ids: Vec<_> = builtin_frontends().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["chat", "inspector"]);
    }
}
