//! Deterministic Thread transcript: the Context Seed for "continue with summary" and for Side
//! Threads that could not fork, and the text behind the transcript tools (ADR 0018).

use serde_json::Value;

use crate::api::{AttachmentKind, Event, EventKind, ForkPoint, ThreadId};

/// Upper bound for a seed; older Turns are dropped first.
const MAX_CHARS: usize = 24_000;
/// Upper bound for one tool input or output in a rendered transcript.
const MAX_TOOL_CHARS: usize = 1_000;

/// One Turn of a Thread, as the transcript sees it.
#[derive(Debug, Clone)]
pub struct Turn {
    /// 1-based position among the Thread's Turns.
    pub index: usize,
    pub prompt: String,
    pub attachments: Vec<String>,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone)]
pub enum Part {
    Reply(String),
    Tool { id: String, title: String, input: Option<Value>, output: Option<Value> },
}

impl Turn {
    pub fn tool_count(&self) -> usize {
        self.parts.iter().filter(|p| matches!(p, Part::Tool { .. })).count()
    }
}

/// The Thread's Turns, only events up to `upto_seq` when given.
pub fn turns(events: &[Event], thread: &ThreadId, upto_seq: Option<u64>) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    let mut reply = String::new();
    let flush = |out: &mut Vec<Turn>, reply: &mut String| {
        if !reply.trim().is_empty()
            && let Some(last) = out.last_mut()
        {
            last.parts.push(Part::Reply(reply.trim().to_owned()));
        }
        reply.clear();
    };
    for e in events.iter().filter(|e| e.thread_id.as_ref() == Some(thread) && upto_seq.is_none_or(|u| e.seq <= u)) {
        match &e.kind {
            EventKind::TurnStarted { text, attachments, .. } => {
                flush(&mut out, &mut reply);
                out.push(Turn {
                    index: out.len() + 1,
                    prompt: text.trim().to_owned(),
                    attachments: attachments
                        .iter()
                        .map(|a| match a.kind {
                            AttachmentKind::Image => format!("[image: {}]", a.name),
                            AttachmentKind::File => format!("[file: {}]", a.path),
                        })
                        .collect(),
                    parts: Vec::new(),
                });
            }
            EventKind::AgentMessageChunk { text } => reply.push_str(text),
            EventKind::ToolCall { tool_call_id, title, raw_input, .. } if !out.is_empty() => {
                flush(&mut out, &mut reply);
                out.last_mut().unwrap().parts.push(Part::Tool {
                    id: tool_call_id.clone(),
                    title: title.clone(),
                    input: raw_input.clone(),
                    output: None,
                });
            }
            EventKind::ToolCallUpdate { tool_call_id, title: new_title, raw_input: new_input, raw_output: new_output, .. } => {
                if let Some(Part::Tool { title, input, output, .. }) = out
                    .last_mut()
                    .and_then(|t| t.parts.iter_mut().rev().find(|p| matches!(p, Part::Tool { id, .. } if id == tool_call_id)))
                {
                    if let Some(t) = new_title {
                        *title = t.clone();
                    }
                    if new_input.is_some() {
                        *input = new_input.clone();
                    }
                    if new_output.is_some() {
                        *output = new_output.clone();
                    }
                }
            }
            _ => {}
        }
    }
    flush(&mut out, &mut reply);
    out
}

/// The Thread's last finished Turn: its 1-based position and the log position of its end
/// (`turn` 0 and `seq` 0 when none finished).
pub fn last_finished_turn(events: &[Event], thread: &ThreadId) -> ForkPoint {
    let mut ordinal = std::collections::HashMap::new();
    let mut point = ForkPoint { thread_id: thread.clone(), turn: 0, seq: 0 };
    for e in events.iter().filter(|e| e.thread_id.as_ref() == Some(thread)) {
        match &e.kind {
            EventKind::TurnStarted { turn_id, .. } => {
                let n = ordinal.len() as u32 + 1;
                ordinal.insert(turn_id.clone(), n);
            }
            EventKind::TurnEnded { turn_id, .. } => {
                if let Some(n) = ordinal.get(turn_id) {
                    point = ForkPoint { thread_id: thread.clone(), turn: *n, seq: e.seq };
                }
            }
            _ => {}
        }
    }
    point
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    format!("{}... [truncated]", &s[..s.floor_char_boundary(max)])
}

fn json_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// One Turn as plain text: header, user prompt, Agent replies and tool titles (with their input
/// and output when `tools`).
pub fn render_turn(t: &Turn, tools: bool) -> String {
    let mut out = format!("[Turn {}]\nUser: {}\n", t.index, t.prompt);
    for a in &t.attachments {
        out.push_str(a);
        out.push('\n');
    }
    for p in &t.parts {
        match p {
            Part::Reply(r) => out.push_str(&format!("Agent: {r}\n")),
            Part::Tool { title, input, output, .. } => {
                out.push_str(&format!("(tool: {title})\n"));
                if tools {
                    if let Some(i) = input.as_ref().filter(|i| !i.is_null() && **i != serde_json::json!({})) {
                        out.push_str(&format!("  input: {}\n", clip(&json_text(i), MAX_TOOL_CHARS)));
                    }
                    if let Some(o) = output.as_ref().filter(|o| !o.is_null()) {
                        out.push_str(&format!("  output: {}\n", clip(&json_text(o), MAX_TOOL_CHARS)));
                    }
                }
            }
        }
    }
    out
}

/// The most recent Turns that fit `MAX_CHARS`, and how many earlier ones were left out.
fn recent(turns: &[Turn]) -> (Vec<String>, usize) {
    let mut kept = Vec::new();
    let mut len = 0;
    for t in turns.iter().rev() {
        let text = render_turn(t, false);
        if len + text.len() > MAX_CHARS && !kept.is_empty() {
            break;
        }
        len += text.len();
        kept.push(text);
    }
    kept.reverse();
    let omitted = turns.len() - kept.len();
    (kept, omitted)
}

fn seed_of(turns: &[Turn], intro: &str) -> String {
    let (kept, omitted) = recent(turns);
    let mut out = format!("{intro}\n\n");
    if omitted > 0 {
        out.push_str(&format!("[{omitted} earlier turns omitted]\n\n"));
    }
    out.push_str(&kept.join("\n"));
    out
}

/// Renders the Thread's Turns as a plain transcript: user prompts, Agent replies and tool titles.
pub fn summarize(events: &[Event], thread: &ThreadId) -> String {
    seed_of(
        &turns(events, thread, None),
        "This conversation continues an earlier one whose Agent Session could not be resumed. Transcript so far:",
    )
}

/// Seed for a Side Thread that could not fork: the Main Thread up to `upto_seq`. `None` when the
/// Main Thread has no Turns to show.
pub fn side_thread_seed(events: &[Event], main: &ThreadId, upto_seq: u64) -> Option<String> {
    let turns = turns(events, main, Some(upto_seq));
    if turns.is_empty() {
        return None;
    }
    Some(seed_of(
        &turns,
        "This is a Side Thread, a detour from the main conversation. Transcript of the main conversation up to where this Side Thread started:",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(thread: &str, kind: EventKind) -> Event {
        Event { v: 1, seq: 0, session_id: "s".into(), thread_id: Some(thread.into()), ts_ms: 0, kind }
    }

    #[test]
    fn renders_turns_of_one_thread() {
        let events = vec![
            ev("t", EventKind::TurnStarted {
                turn_id: "1".into(),
                text: "add a README".into(),
                attachments: vec![crate::api::Attachment {
                    name: "shot.png".into(),
                    mime: "image/png".into(),
                    path: "/s/attachments/x-shot.png".into(),
                    kind: AttachmentKind::Image,
                }],
                context: None,
            }),
            ev("t", EventKind::AgentMessageChunk { text: "Sure, ".into() }),
            ev("t", EventKind::ToolCall {
                tool_call_id: "c".into(),
                title: "Write README.md".into(),
                kind: Some("edit".into()),
                status: None,
                content: serde_json::json!([]),
                locations: serde_json::json!([]),
                raw_input: None,
                parent_tool_call_id: None,
                report: None,
                harness_tool: None,
            }),
            ev("t", EventKind::AgentMessageChunk { text: "done.".into() }),
            ev("other", EventKind::TurnStarted { turn_id: "2".into(), text: "elsewhere".into(), attachments: vec![], context: None }),
        ];
        let s = summarize(&events, &"t".to_owned());
        assert!(s.ends_with("User: add a README\n[image: shot.png]\nAgent: Sure,\n(tool: Write README.md)\nAgent: done.\n"), "{s}");
        assert!(!s.contains("elsewhere"));
    }
}
