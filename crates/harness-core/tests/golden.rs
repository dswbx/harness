//! Golden Session Logs (ADR 0021): every recorded log must keep parsing, with no `Unknown`s.
//! The chat Frontend reduces the same files against a committed snapshot (`golden.test.ts`).
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use harness_core::api::{Event, EventKind};
use harness_core::log::SessionLog;
use std::path::PathBuf;

fn golden_logs() -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let mut logs: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "jsonl")).collect();
    logs.sort();
    logs
}

#[test]
fn there_are_golden_logs() {
    assert!(golden_logs().len() >= 2);
}

#[test]
fn every_golden_log_parses_with_zero_unknowns() {
    for path in golden_logs() {
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        // Strictly, as the Rust type: no fallback involved.
        for (i, l) in lines.iter().enumerate() {
            let e: Event = serde_json::from_str(l).unwrap_or_else(|e| panic!("{} line {}: {e}", path.display(), i + 1));
            assert!(!matches!(e.kind, EventKind::Unknown), "{} line {} is Unknown", path.display(), i + 1);
        }
        // And through the Session Log reader, on a copy (open may trim a torn tail).
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("log.jsonl");
        std::fs::copy(&path, &copy).unwrap();
        let log = SessionLog::open("golden".into(), &copy).unwrap();
        assert!(log.read_only_reason().is_none(), "{}", path.display());
        let events = log.events().unwrap();
        assert_eq!(events.len(), lines.len(), "{}", path.display());
        assert!(events.iter().all(|e| !matches!(e.kind, EventKind::Unknown)), "{}", path.display());
        assert!(events.iter().enumerate().all(|(i, e)| e.seq == i as u64), "{} seq is contiguous", path.display());
        drop(log);
        assert_eq!(std::fs::read(&copy).unwrap(), text.as_bytes(), "{} is read without being changed", path.display());
        let leftovers: Vec<_> =
            std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).filter(|n| n.contains("corrupt")).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }
}
