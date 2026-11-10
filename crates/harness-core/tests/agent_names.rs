//! Agent-specific handling lives only in `agent_quirks.rs` (and `agents.rs`, the registry of known
//! Agents). Agent names anywhere else in the core's source are a leak (ADR 0008).
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use std::path::Path;

const NAMES: &[&str] = &["claude", "codex", "gemini", "opencode"];

/// Files allowed to name Agents.
const ALLOWED: &[&str] = &["agent_quirks.rs", "agents.rs"];

/// The code of `src` without comments and without the `#[cfg(test)]` tail.
fn code_only(src: &str) -> String {
    let mut out = String::new();
    for line in src.lines() {
        if line.trim() == "#[cfg(test)]" {
            break;
        }
        let mut in_str = false;
        let mut prev = ' ';
        let mut kept = String::new();
        for c in line.chars() {
            if c == '"' && prev != '\\' {
                in_str = !in_str;
            }
            if c == '/' && prev == '/' && !in_str {
                kept.pop();
                break;
            }
            kept.push(c);
            prev = c;
        }
        out.push_str(&kept);
        out.push('\n');
    }
    out
}

#[test]
fn agent_names_stay_in_agent_quirks() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut leaks = Vec::new();
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap().to_owned();
        if !name.ends_with(".rs") || ALLOWED.contains(&name.as_str()) {
            continue;
        }
        let code = code_only(&std::fs::read_to_string(&path).unwrap()).to_lowercase();
        for (n, line) in code.lines().enumerate() {
            if let Some(w) = NAMES.iter().find(|w| line.contains(**w)) {
                leaks.push(format!("{name}:{}: `{w}`: {}", n + 1, line.trim()));
            }
        }
    }
    assert!(leaks.is_empty(), "Agent names outside agent_quirks.rs, move the handling there:\n{}", leaks.join("\n"));
}
