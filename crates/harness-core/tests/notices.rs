//! Settings files that do not load reach the host as notices, once.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use std::sync::Arc;

use harness_core::Harness;
use harness_core::api::{AppEvent, Command, CommandResult, NoticeKind, StartupNotice};

async fn take(h: &Harness) -> Vec<StartupNotice> {
    match h.execute(Command::TakeNotices).await.unwrap() {
        CommandResult::Notices { notices } => notices,
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn startup_notices_are_listed_once_and_later_ones_announce_themselves() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("permissions.json"), b"{\"rules\": [").unwrap();
    std::fs::write(data.join("mcp.json"), br#"{"not":"a list"}"#).unwrap();
    let h = Harness::with_agents(data.clone(), vec![]).unwrap();
    let mut notices = take(&h).await;
    notices.sort_by(|a, b| a.file.cmp(&b.file));
    let files: Vec<_> = notices.iter().map(|n| (n.file.as_str(), n.kind.clone())).collect();
    assert_eq!(files, [("mcp.json", NoticeKind::Unreadable), ("permissions.json", NoticeKind::Corrupt)]);
    assert!(notices[1].message.starts_with("Permission rules were reset."), "{}", notices[1].message);
    let copy = notices[1].copy.as_ref().unwrap();
    assert!(copy.contains("permissions.json.corrupt-") && std::fs::read(copy).unwrap() == b"{\"rules\": [");
    assert!(take(&h).await.is_empty());

    // A file read later (the editor setting) reports through an AppEvent and the same Command.
    let announced = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let a = announced.clone();
    h.subscribe_app(Box::new(move |e: &AppEvent| {
        if matches!(e, AppEvent::NoticesChanged) {
            a.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        true
    }));
    std::fs::write(data.join("editor.json"), b"][").unwrap();
    h.execute(Command::GetEditor).await.unwrap();
    assert_eq!(announced.load(std::sync::atomic::Ordering::SeqCst), 1);
    let later = take(&h).await;
    assert_eq!(later.len(), 1);
    assert_eq!(later[0].file, "editor.json");
    assert!(take(&h).await.is_empty());
}
