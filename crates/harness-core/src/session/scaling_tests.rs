//! The hot paths read projections, so their cost does not grow with the Session Log: a permission
//! request, a Harness MCP call's context lookup and a prompt take as long on 50k Events as on 1k.
//! Prints the per-call numbers (`cargo test -p harness-core scaling -- --nocapture`).
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use super::projection_tests::session;
use super::*;
use std::time::{Duration, Instant};

/// A Session whose log holds about `n` Events: mostly noise, with attaches, Frontend Tool
/// calls and errors, config options and Turns spread through it.
async fn session_with(n: u64) -> (Arc<Session>, tempfile::TempDir) {
    let (s, dir) = session().await;
    let thread = s.meta().main_thread_id;
    for i in 0..n {
        let kind = match i % 1000 {
            10 => EventKind::ArtifactAttached { id: format!("a{}", i / 1000), by: crate::api::StateWriter::Agent },
            20 => EventKind::ArtifactDetached { id: format!("a{}", i / 1000), by: crate::api::StateWriter::User },
            30 => EventKind::FrontendToolOutput {
                tool: "render_ui".into(),
                call_id: format!("c{i}"),
                path: "x.json".into(),
                input: serde_json::json!({ "id": format!("p{}", i % 7) }),
                files: Default::default(),
            },
            40 => EventKind::FrontendError { tool: "render_ui".into(), item: format!("p{}", i % 7), message: "bad".into() },
            50 => EventKind::config_options(serde_json::json!([{ "id": "mode", "category": "mode", "currentValue": "default" }])),
            60 => EventKind::TurnStarted { turn_id: format!("t{i}"), text: "go".into(), attachments: vec![], origin: None, context: None },
            70 => EventKind::TurnEnded { turn_id: format!("t{}", i - 10), stop_reason: "end_turn".into() },
            _ => EventKind::Error { message: "noise".into() },
        };
        s.log.append(Some(thread.clone()), kind).unwrap();
    }
    (s, dir)
}

/// Mean time of one call of `f`.
fn per_call(mut f: impl FnMut()) -> Duration {
    f();
    let start = Instant::now();
    let mut n = 0u32;
    while n < 20 || start.elapsed() < Duration::from_millis(30) {
        f();
        n += 1;
    }
    start.elapsed() / n
}

fn measure(s: &Session) -> [Duration; 3] {
    let thread = s.meta().main_thread_id;
    [
        // A permission request: the attached Shared Artifact folders for the Policy, and whether a Turn is open.
        per_call(|| {
            std::hint::black_box(s.attached_shared_dirs());
            std::hint::black_box(s.thread_working(&thread).unwrap());
        }),
        // A Harness MCP call: the same folders, and the Frontend items `harness_info` / `ui_get` read.
        per_call(|| {
            std::hint::black_box(s.attached_shared_dirs());
            std::hint::black_box(s.frontend_items().unwrap());
        }),
        // A prompt: the Frontend errors block of `<harness_context>`.
        per_call(|| {
            std::hint::black_box(crate::harness_context::frontend_errors(s, &thread).unwrap());
        }),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn hot_paths_do_not_grow_with_the_log() {
    let (small, _d1) = session_with(1_000).await;
    let (big, _d2) = session_with(50_000).await;
    let (a, b) = (measure(&small), measure(&big));
    let names = ["permission request", "Harness MCP call context", "prompt"];
    for i in 0..3 {
        println!("{:<26} 1k Events {:>10?}   50k Events {:>10?}", names[i], a[i], b[i]);
    }
    for i in 0..3 {
        // 50x the Events: a scan would be ~50x slower. Allow noise.
        assert!(b[i] < a[i] * 5 + Duration::from_micros(300), "{}: {:?} on 1k, {:?} on 50k", names[i], a[i], b[i]);
    }
}
