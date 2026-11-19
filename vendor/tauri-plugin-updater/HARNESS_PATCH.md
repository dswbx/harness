# Harness patch

`tauri-plugin-updater` 2.14.1 from crates.io, with one change in `src/updater.rs` (search for `harness patch`).

Upstream installs a macOS update by swapping the whole `Harness.app` dir with the new one. The new dir has a new file id (inode). The Dock tracks a pinned app by file id, so after each update the pin points at the old, deleted copy and the user must pin the app again.

The patch swaps `Harness.app/Contents` with the new `Contents` instead. `Harness.app` keeps its file id, so the pin stays.

To update: copy the new crate version from `~/.cargo/registry/src/*/tauri-plugin-updater-<version>`, re-apply the `harness patch` changes, and bump the version in this file.
