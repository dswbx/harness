//! Agent-specific handling lives only in `agent_quirks.rs` (and `agents.rs`, the registry of known
//! Agents). Agent names anywhere else in the core's source are a leak (ADR 0008).
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use std::path::{Path, PathBuf};

const NAMES: &[&str] = &["claude", "codex", "gemini", "opencode"];

/// Files allowed to name Agents, by path relative to `src`.
const ALLOWED: &[&str] = &["agent_quirks.rs", "agents.rs"];

/// `line` without its `//` comment (a `//` inside a string literal stays).
fn strip_comment(line: &str) -> String {
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
    kept
}

/// The code of `src` without comments and without `#[cfg(test)]` items: each attribute hides the
/// one item after it (a `mod tests { .. }` block, a `fn`, or a `;`-terminated `use` / `mod`), at any
/// indentation, so code after a single test-only item is still checked.
fn code_only(src: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    let mut depth: i32 = 0;
    let mut opened = false;
    for line in src.lines() {
        let code = strip_comment(line);
        if !skipping && code.trim() == "#[cfg(test)]" {
            skipping = true;
            depth = 0;
            opened = false;
            continue;
        }
        if skipping {
            if code.trim_start().starts_with("#[") {
                continue;
            }
            depth += code.matches('{').count() as i32 - code.matches('}').count() as i32;
            opened |= code.contains('{');
            if (opened && depth <= 0) || (!opened && code.trim_end().ends_with(';')) {
                skipping = false;
            }
            continue;
        }
        out.push_str(&code);
        out.push('\n');
    }
    out
}

/// Every `.rs` file under `dir`, recursively, as a path relative to `root`.
fn rust_files(root: &Path, dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(rust_files(root, &path));
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path.strip_prefix(root).unwrap().to_owned());
        }
    }
    out.sort();
    out
}

#[test]
fn walk_covers_subdirectories() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let files = rust_files(&src, &src);
    assert!(files.iter().any(|f| f.starts_with("acp") && f.file_name().is_some_and(|n| n == "mod.rs")), "{files:?}");
    assert!(files.iter().any(|f| f.starts_with("bin")), "{files:?}");
    assert!(files.contains(&PathBuf::from("agent_quirks.rs")));
}

#[test]
fn code_only_hides_test_items_but_not_the_code_after_them() {
    let src = "use a;\n#[cfg(test)]\nmod tests;\nfn live() { claude }\n    #[cfg(test)]\n    mod t {\n        fn x() { codex }\n    }\nfn after() { gemini }\n";
    let code = code_only(src);
    assert!(code.contains("live") && code.contains("after"), "{code}");
    assert!(!code.contains("codex") && !code.contains("tests"), "{code}");
}

#[test]
fn agent_names_stay_in_agent_quirks() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut leaks = Vec::new();
    for rel in rust_files(&src, &src) {
        if ALLOWED.contains(&rel.to_str().unwrap()) {
            continue;
        }
        let code = code_only(&std::fs::read_to_string(src.join(&rel)).unwrap()).to_lowercase();
        for (n, line) in code.lines().enumerate() {
            if let Some(w) = NAMES.iter().find(|w| line.contains(**w)) {
                leaks.push(format!("{}:{}: `{w}`: {}", rel.display(), n + 1, line.trim()));
            }
        }
    }
    assert!(leaks.is_empty(), "Agent names outside agent_quirks.rs, move the handling there:\n{}", leaks.join("\n"));
}
