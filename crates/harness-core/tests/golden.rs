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

/// The variant's name. Exhaustive on purpose: adding an `EventKind` variant fails to compile here
/// until it is named, which is the reminder to record it in a golden log.
fn variant_name(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::SessionCreated { .. } => "SessionCreated",
        EventKind::SessionStatusChanged { .. } => "SessionStatusChanged",
        EventKind::ThreadStarted { .. } => "ThreadStarted",
        EventKind::AuthRequired { .. } => "AuthRequired",
        EventKind::ThreadReadOnly { .. } => "ThreadReadOnly",
        EventKind::AgentSessionRestoring { .. } => "AgentSessionRestoring",
        EventKind::AgentSessionStarted { .. } => "AgentSessionStarted",
        EventKind::AgentProcessState { .. } => "AgentProcessState",
        EventKind::AgentCapabilities { .. } => "AgentCapabilities",
        EventKind::TurnStarted { .. } => "TurnStarted",
        EventKind::TurnEnded { .. } => "TurnEnded",
        EventKind::AgentMessageChunk { .. } => "AgentMessageChunk",
        EventKind::AgentThoughtChunk { .. } => "AgentThoughtChunk",
        EventKind::ToolCall { .. } => "ToolCall",
        EventKind::ToolCallUpdate { .. } => "ToolCallUpdate",
        EventKind::BackgroundJobEnded { .. } => "BackgroundJobEnded",
        EventKind::TaskListUpdated { .. } => "TaskListUpdated",
        EventKind::ModeChanged { .. } => "ModeChanged",
        EventKind::ConfigOptionsChanged { .. } => "ConfigOptionsChanged",
        EventKind::AvailableCommandsChanged { .. } => "AvailableCommandsChanged",
        EventKind::UsageUpdated { .. } => "UsageUpdated",
        EventKind::SessionInfoUpdated { .. } => "SessionInfoUpdated",
        EventKind::PermissionRequested { .. } => "PermissionRequested",
        EventKind::PermissionResolved { .. } => "PermissionResolved",
        EventKind::PermissionRuleAdded { .. } => "PermissionRuleAdded",
        EventKind::WorkspaceChanged { .. } => "WorkspaceChanged",
        EventKind::FrontendToolOutput { .. } => "FrontendToolOutput",
        EventKind::FrontendError { .. } => "FrontendError",
        EventKind::StateChanged { .. } => "StateChanged",
        EventKind::ArtifactAttached { .. } => "ArtifactAttached",
        EventKind::ArtifactDetached { .. } => "ArtifactDetached",
        EventKind::ArtifactStateChanged { .. } => "ArtifactStateChanged",
        EventKind::GitCommitted { .. } => "GitCommitted",
        EventKind::GitPushed { .. } => "GitPushed",
        EventKind::SessionArchived { .. } => "SessionArchived",
        EventKind::AgentNotice { .. } => "AgentNotice",
        EventKind::AgentUpdate { .. } => "AgentUpdate",
        EventKind::Error { .. } => "Error",
        // Never written (a newer build's line reads as this), so no golden log can hold it.
        EventKind::Unknown => "Unknown",
    }
}

/// The variant names declared in `api.rs`, read from the source (a variant starts a line at four
/// spaces of indent inside `enum EventKind`).
fn declared_variants() -> Vec<String> {
    let src = include_str!("../src/api.rs");
    let start = src.find("pub enum EventKind").unwrap();
    let body = &src[start..];
    let body = &body[..body.find("\nimpl EventKind").unwrap()];
    body.lines()
        .filter_map(|l| l.strip_prefix("    "))
        .filter(|l| l.starts_with(|c: char| c.is_ascii_uppercase()))
        .map(|l| l.split(|c: char| !c.is_alphanumeric()).next().unwrap().to_owned())
        .collect()
}

#[test]
fn every_event_kind_appears_in_a_golden_log() {
    let mut seen = std::collections::BTreeSet::new();
    for path in golden_logs() {
        for l in std::fs::read_to_string(&path).unwrap().lines().filter(|l| !l.trim().is_empty()) {
            let e: Event = serde_json::from_str(l).unwrap();
            let tag = serde_json::from_str::<serde_json::Value>(l).unwrap()["kind"]["type"].as_str().unwrap().to_owned();
            assert_eq!(variant_name(&e.kind), tag, "{}: the name table is out of date", path.display());
            seen.insert(tag);
        }
    }
    let declared = declared_variants();
    assert!(declared.len() > 30 && declared.iter().any(|v| v == "Unknown"), "reading the enum from api.rs failed: {declared:?}");
    let missing: Vec<_> = declared.iter().filter(|v| *v != "Unknown" && !seen.contains(*v)).collect();
    assert!(missing.is_empty(), "no golden log holds these Event kinds (add lines to one, ADR 0021): {missing:?}");
}
