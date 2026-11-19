//! The Session Log's projections (kept up to date on append, rebuilt on load) must equal a scan
//! of all Events from scratch: after every append, and after a reload. Checked on the golden logs
//! and on random Event sequences.
#![allow(clippy::unwrap_used, reason = "tests fail loudly")]

use harness_core::api::{Event, EventKind, StateWriter};
use harness_core::log::SessionLog;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;

const THREADS: [&str; 3] = ["main", "side", "other"];

fn is_mode(o: &Value) -> bool {
    o["category"] == "mode" || o["id"] == "mode"
}

/// Everything the log projects, computed by scanning `events` (the code the projections replaced).
#[derive(Debug, PartialEq)]
struct Scanned {
    attached: Vec<String>,
    items: String,
    keyed: Vec<((String, String), String)>,
    errors: String,
    open_turn: Vec<(String, bool)>,
    turn_started: Vec<(String, Option<u64>)>,
    config: Vec<(String, Option<Vec<Value>>)>,
    mode: Vec<(String, Option<String>)>,
    before_plan: Vec<(String, Option<String>)>,
    title: Option<String>,
}

fn rev_of(events: &[Event], t: String) -> impl Iterator<Item = &Event> {
    events.iter().rev().filter(move |e| e.thread_id.as_deref() == Some(t.as_str()))
}

fn scan(events: &[Event]) -> Scanned {
    let mut attached: Vec<String> = Vec::new();
    for e in events {
        match &e.kind {
            EventKind::ArtifactAttached { id, .. } if !attached.contains(id) => attached.push(id.clone()),
            EventKind::ArtifactDetached { id, .. } => attached.retain(|x| x != id),
            _ => {}
        }
    }
    let mut items: Vec<harness_core::session::FrontendItem> = Vec::new();
    let mut overrides: HashMap<(String, String), (Option<String>, Option<String>)> = HashMap::new();
    for e in events {
        match &e.kind {
            EventKind::PanelEdited { tool, id, title, icon } => {
                overrides.insert((tool.clone(), id.clone()), (title.clone(), icon.clone()));
                if let Some(x) = items.iter_mut().find(|x| x.tool == *tool && x.id == *id) {
                    x.title = title.clone();
                    x.icon = icon.clone();
                }
                continue;
            }
            EventKind::PanelDeleted { tool, id } => {
                items.retain(|x| !(x.tool == *tool && x.id == *id));
                continue;
            }
            _ => {}
        }
        let EventKind::FrontendToolOutput { tool, input, files, .. } = &e.kind else { continue };
        let Some(id) = input.get("id").and_then(Value::as_str).map(str::to_owned) else { continue };
        let at = items.iter().position(|x| x.tool == *tool && x.id == id);
        let (title, icon) = overrides.get(&(tool.clone(), id.clone())).cloned().unwrap_or_default();
        let item = harness_core::session::FrontendItem {
            tool: tool.clone(),
            id,
            title,
            icon,
            input: input.clone(),
            ts_ms: e.ts_ms,
            thread: e.thread_id.clone(),
            files: files.clone(),
        };
        match (input.get("remove") == Some(&Value::Bool(true)), at) {
            (true, Some(i)) => {
                items.remove(i);
            }
            (true, None) => {}
            (false, Some(i)) => items[i] = item,
            (false, None) => items.push(item),
        }
    }
    let mut keyed: HashMap<(String, String), String> = HashMap::new();
    let mut errors: Vec<harness_core::session::FrontendErrorEntry> = Vec::new();
    for e in events {
        match &e.kind {
            EventKind::PanelDeleted { tool, id } => {
                keyed.remove(&(tool.clone(), id.clone()));
            }
            EventKind::FrontendToolOutput { tool, call_id, input, .. } => {
                let Some(thread) = e.thread_id.clone() else { continue };
                match input.get("id").and_then(Value::as_str) {
                    Some(id) => {
                        errors.retain(|x| !(x.tool == *tool && x.item == id));
                        let key = (tool.clone(), id.to_owned());
                        if input.get("remove") == Some(&Value::Bool(true)) {
                            keyed.remove(&key);
                        } else {
                            keyed.insert(key, thread);
                        }
                    }
                    None => {
                        keyed.insert((tool.clone(), call_id.clone()), thread);
                    }
                }
            }
            EventKind::FrontendError { tool, item, message } => errors.push(harness_core::session::FrontendErrorEntry {
                seq: e.seq,
                thread: e.thread_id.clone().unwrap_or_default(),
                tool: tool.clone(),
                item: item.clone(),
                message: message.clone(),
            }),
            _ => {}
        }
    }
    errors.retain(|x| keyed.contains_key(&(x.tool.clone(), x.item.clone())));
    let mut keyed: Vec<_> = keyed.into_iter().collect();
    keyed.sort();

    let for_threads = |f: &dyn Fn(&str) -> Option<String>| -> Vec<(String, Option<String>)> { THREADS.iter().map(|t| (t.to_string(), f(t))).collect() };
    let rev_thread = |t: &str| rev_of(events, t.to_owned());
    // The newest mode the Thread was put in, by `ModeChanged` or the mode option of its config options.
    let mode_of = |e: &Event| match &e.kind {
        EventKind::ModeChanged { mode_id, .. } if !mode_id.is_empty() => Some(mode_id.clone()),
        EventKind::ConfigOptionsChanged { options, .. } => {
            options.as_array()?.iter().find(|o| is_mode(o)).and_then(|o| o["currentValue"].as_str()).filter(|v| !v.is_empty()).map(str::to_owned)
        }
        _ => None,
    };
    let title_of = |t: Option<&str>| {
        events
            .iter()
            .filter(|e| e.thread_id.as_deref() == t)
            .filter_map(|e| match &e.kind {
                EventKind::SessionInfoUpdated { title: Some(x) } if !x.trim().is_empty() => Some((e.seq, x.clone())),
                _ => None,
            })
            .next_back()
    };
    let title = match (title_of(Some("main")), title_of(None)) {
        (Some(a), Some(b)) => Some(if a.0 >= b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
    .map(|(_, t)| t);

    Scanned {
        attached,
        items: format!("{items:?}"),
        keyed,
        errors: format!("{errors:?}"),
        open_turn: THREADS
            .iter()
            .map(|t| {
                let open = rev_thread(t).find_map(|e| match e.kind {
                    EventKind::TurnStarted { .. } => Some(true),
                    EventKind::TurnEnded { .. } => Some(false),
                    _ => None,
                });
                (t.to_string(), open.unwrap_or(false))
            })
            .collect(),
        turn_started: THREADS.iter().map(|t| (t.to_string(), rev_thread(t).find(|e| matches!(e.kind, EventKind::TurnStarted { .. })).map(|e| e.seq))).collect(),
        config: THREADS
            .iter()
            .map(|t| {
                let c = rev_thread(t).find_map(|e| match &e.kind {
                    EventKind::ConfigOptionsChanged { options, .. } => options.as_array().cloned(),
                    _ => None,
                });
                (t.to_string(), c)
            })
            .collect(),
        mode: for_threads(&|t| rev_thread(t).find_map(mode_of)),
        before_plan: for_threads(&|t| rev_thread(t).filter_map(mode_of).find(|m| m != "plan")),
        title,
    }
}

fn projected(log: &SessionLog) -> Scanned {
    let (keyed, errors) = log.frontend_state().unwrap();
    let mut keyed: Vec<_> = keyed.into_iter().collect();
    keyed.sort();
    let t = |t: &str| t.to_string();
    Scanned {
        attached: log.attached_shared().unwrap(),
        items: format!("{:?}", log.frontend_items().unwrap()),
        keyed,
        errors: format!("{errors:?}"),
        open_turn: THREADS.iter().map(|x| (t(x), log.thread_turn_open(&t(x)).unwrap())).collect(),
        turn_started: THREADS.iter().map(|x| (t(x), log.thread_turn_started(&t(x)).unwrap())).collect(),
        config: THREADS.iter().map(|x| (t(x), log.thread_config_options(&t(x)).unwrap())).collect(),
        mode: THREADS.iter().map(|x| (t(x), log.thread_mode(&t(x)).unwrap())).collect(),
        before_plan: THREADS.iter().map(|x| (t(x), log.thread_mode_before_plan(&t(x)).unwrap())).collect(),
        title: log.agent_title(&t("main")).unwrap(),
    }
}

fn check(log: &SessionLog, what: &str) {
    let events: Vec<Event> = log.events().unwrap().iter().map(|e| (**e).clone()).collect();
    assert_eq!(projected(log), scan(&events), "{what}");
}

fn golden_logs() -> Vec<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let mut logs: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "jsonl")).collect();
    logs.sort();
    logs
}

/// Replays a log's Events into a fresh log one by one, checking after each, then reloads it.
fn replay_and_check(events: Vec<(Option<String>, EventKind)>, what: &str) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("log.jsonl");
    let log = SessionLog::open("s".into(), &path).unwrap();
    // Loaded before the appends, so each one updates the projections rather than a later load rebuilding them.
    check(&log, what);
    for (i, (thread, kind)) in events.into_iter().enumerate() {
        log.append(thread, kind).unwrap();
        check(&log, &format!("{what}, after append {i}"));
    }
    log.sync().unwrap();
    drop(log);
    let again = SessionLog::open("s".into(), &path).unwrap();
    check(&again, &format!("{what}, after reload"));
}

#[test]
fn golden_logs_project_what_a_scan_finds() {
    for path in golden_logs() {
        // Loaded straight from the file: rebuilt on load.
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("log.jsonl");
        std::fs::copy(&path, &copy).unwrap();
        let log = SessionLog::open("golden".into(), &copy).unwrap();
        check(&log, &format!("{} (load)", path.display()));
        // And built up append by append, checked after each.
        let events: Vec<(Option<String>, EventKind)> = log.events().unwrap().iter().map(|e| (e.thread_id.clone(), e.kind.clone())).collect();
        replay_and_check(events, &path.display().to_string());
    }
}

/// xorshift: the same sequences on every run.
struct Rng(u64);
impl Rng {
    fn next(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n
    }
}

fn random_event(r: &mut Rng) -> (Option<String>, EventKind) {
    let thread = match r.next(4) {
        0 => None,
        n => Some(THREADS[(n - 1) as usize].to_owned()),
    };
    let item = format!("i{}", r.next(4));
    let tool = ["render_ui", "other"][r.next(2) as usize].to_owned();
    let mode = ["default", "plan", "edit", ""][r.next(4) as usize].to_owned();
    let kind = match r.next(20) {
        0 => EventKind::ModeChanged { mode_id: mode, mode: None },
        1 => EventKind::ConfigOptionsChanged {
            options: json!([{ "id": "mode", "category": "mode", "currentValue": mode }, { "id": "model", "currentValue": "m" }]),
            side_mode: None,
            mode: None,
        },
        2 => EventKind::ConfigOptionsChanged { options: json!({ "not": "an array" }), side_mode: None, mode: None },
        3 => EventKind::SessionInfoUpdated {
            title: [Some("T".to_owned()), Some("  ".to_owned()), None][r.next(3) as usize].clone().map(|t| format!("{t}{}", r.next(9))),
        },
        4 | 5 => EventKind::ArtifactAttached { id: format!("a{}", r.next(3)), by: StateWriter::Agent },
        6 => EventKind::ArtifactDetached { id: format!("a{}", r.next(3)), by: StateWriter::User },
        7 | 8 => EventKind::TurnStarted { turn_id: format!("t{}", r.next(100)), text: "x".into(), attachments: vec![], context: None, origin: None },
        9 => EventKind::TurnEnded { turn_id: "t".into(), stop_reason: "end_turn".into() },
        10 | 11 => {
            let input = match r.next(4) {
                0 => json!({ "id": item, "remove": true }),
                1 => json!({ "no": "id" }),
                _ => json!({ "id": item, "v": r.next(100) }),
            };
            EventKind::FrontendToolOutput { tool, call_id: format!("c{}", r.next(5)), path: "p".into(), input, files: Default::default() }
        }
        12 | 13 => EventKind::FrontendError { tool, item: if r.next(3) == 0 { format!("c{}", r.next(5)) } else { item }, message: format!("m{}", r.next(3)) },
        14 => EventKind::PanelEdited {
            tool,
            id: item,
            title: [Some("Mine".to_owned()), None][r.next(2) as usize].clone(),
            icon: [Some("star".to_owned()), None][r.next(2) as usize].clone(),
        },
        15 => EventKind::PanelDeleted { tool, id: item },
        _ => EventKind::Error { message: "noise".into() },
    };
    (thread, kind)
}

#[test]
fn random_sequences_project_what_a_scan_finds() {
    for seed in 1..=8u64 {
        let mut r = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let events = (0..300).map(|_| random_event(&mut r)).collect();
        replay_and_check(events, &format!("random seed {seed}"));
    }
}
