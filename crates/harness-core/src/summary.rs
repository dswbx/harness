//! Deterministic Thread summary used as the Context Seed for "continue with summary".

use crate::api::{AttachmentKind, Event, EventKind, ThreadId};

/// Upper bound for the summary; older Turns are dropped first.
const MAX_CHARS: usize = 24_000;

/// Renders the Thread's Turns as a plain transcript: user prompts, Agent replies and tool titles.
pub fn summarize(events: &[Event], thread: &ThreadId) -> String {
    let mut turns: Vec<String> = Vec::new();
    let mut reply = String::new();
    let flush = |turns: &mut Vec<String>, reply: &mut String| {
        if !reply.trim().is_empty()
            && let Some(last) = turns.last_mut()
        {
            last.push_str(&format!("Agent: {}\n", reply.trim()));
        }
        reply.clear();
    };
    for e in events.iter().filter(|e| e.thread_id.as_ref() == Some(thread)) {
        match &e.kind {
            EventKind::TurnStarted { text, attachments, .. } => {
                flush(&mut turns, &mut reply);
                let mut t = format!("User: {}\n", text.trim());
                for a in attachments {
                    match a.kind {
                        AttachmentKind::Image => t.push_str(&format!("[image: {}]\n", a.name)),
                        AttachmentKind::File => t.push_str(&format!("[file: {}]\n", a.path)),
                    }
                }
                turns.push(t);
            }
            EventKind::AgentMessageChunk { text } => reply.push_str(text),
            EventKind::ToolCall { title, .. } if !turns.is_empty() => {
                flush(&mut turns, &mut reply);
                turns.last_mut().unwrap().push_str(&format!("(tool: {title})\n"));
            }
            _ => {}
        }
    }
    flush(&mut turns, &mut reply);

    let mut kept = Vec::new();
    let mut len = 0;
    for t in turns.iter().rev() {
        if len + t.len() > MAX_CHARS && !kept.is_empty() {
            break;
        }
        len += t.len();
        kept.push(t.as_str());
    }
    let omitted = turns.len() - kept.len();
    kept.reverse();
    let mut out = String::from(
        "This conversation continues an earlier one whose Agent Session could not be resumed. Transcript so far:\n\n",
    );
    if omitted > 0 {
        out.push_str(&format!("[{omitted} earlier turns omitted]\n\n"));
    }
    out.push_str(&kept.join("\n"));
    out
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
            ev("other", EventKind::TurnStarted { turn_id: "2".into(), text: "elsewhere".into(), attachments: vec![] }),
        ];
        let s = summarize(&events, &"t".to_owned());
        assert!(s.ends_with("User: add a README\n[image: shot.png]\nAgent: Sure,\n(tool: Write README.md)\nAgent: done.\n"), "{s}");
        assert!(!s.contains("elsewhere"));
    }
}
