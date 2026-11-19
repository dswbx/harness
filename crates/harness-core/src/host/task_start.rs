//! "Start Session from a task" (ADR 0028): links the new Session to the task, sets the task's
//! status once, and seeds the first prompt with the parts of the task the user picked.

use crate::api::*;
use crate::host::Harness;
use crate::session::Session;
use crate::tasks::Actor;

impl Harness {
    /// Refuses an unknown task before the Session is made.
    pub(in crate::host) fn check_task_start(&self, start: &TaskStart) -> anyhow::Result<()> {
        self.shared.tasks.get(&start.id).map(drop)
    }

    /// After `create_session`: the link (the one record of "started from"), the status and the seed.
    pub(in crate::host) fn start_from_task(&self, session: &Session, start: TaskStart) -> anyhow::Result<()> {
        let meta = session.meta();
        let task = self.shared.tasks.link_session(&start.id, &meta.id, &meta.title, start.set_status, &Actor::user())?;
        if let Some(seed) = self.task_seed(&task, start.include) {
            session.update_meta(|m| {
                m.seeds.insert(m.main_thread_id.clone(), seed);
            })?;
        }
        Ok(())
    }

    /// The context text of the chosen parts; `None` when no part has any text.
    fn task_seed(&self, task: &Task, include: TaskContextParts) -> Option<String> {
        let mut parts = Vec::new();
        if include.summary {
            parts.push(summary(task));
        }
        if include.body_and_assets {
            parts.extend(self.body_and_assets(task));
        }
        if include.parent_and_siblings {
            parts.extend(self.parent_and_siblings(task));
        }
        let origin = task.origin_session_id.as_deref().and_then(|id| self.session(id).ok());
        if let Some(origin) = origin.as_deref() {
            let title = origin.meta().title;
            if include.origin_note {
                match origin.read_note() {
                    Ok(n) if !n.content.trim().is_empty() => {
                        parts.push(format!("## Note of the Session \"{title}\", where the task was created\n\n{}", n.content.trim()));
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("reading the note of session {}: {e:#}", origin.id()),
                }
            }
            if include.origin_transcript {
                let main = origin.meta().main_thread_id;
                match origin.log().events() {
                    Ok(events) => {
                        parts.extend(crate::summary::session_transcript(&events, &main, &title).map(|t| format!("## Transcript of the origin Session\n\n{t}")))
                    }
                    Err(e) => tracing::warn!("reading the log of session {}: {e:#}", origin.id()),
                }
            }
        }
        if parts.is_empty() {
            return None;
        }
        Some(format!("This Session was started from the user's task {}.\n\n{}", task.id, parts.join("\n\n")))
    }

    fn body_and_assets(&self, task: &Task) -> Option<String> {
        let mut out = Vec::new();
        if !task.body.trim().is_empty() {
            out.push(task.body.trim().to_owned());
        }
        if !task.assets.is_empty()
            && let Ok(dir) = self.shared.tasks.files_dir(&task.id)
        {
            let files: Vec<String> = task.assets.iter().map(|a| format!("- {} ({}, {} bytes)", dir.join(&a.name).display(), a.mime, a.size)).collect();
            out.push(format!("Files of the task:\n{}", files.join("\n")));
        }
        (!out.is_empty()).then(|| format!("## Description\n\n{}", out.join("\n\n")))
    }

    fn parent_and_siblings(&self, task: &Task) -> Option<String> {
        let parent = self.shared.tasks.get(task.parent_id.as_deref()?).ok()?;
        let mut siblings: Vec<TaskSummary> =
            self.shared.tasks.list().into_iter().filter(|t| t.parent_id.as_deref() == Some(&parent.id) && t.id != task.id).collect();
        siblings.sort_by(|a, b| a.order.total_cmp(&b.order));
        let mut out = format!("## Parent task\n\n{} \"{}\" ({})", parent.id, parent.title, status_name(parent.status));
        if !siblings.is_empty() {
            let rows: Vec<String> = siblings.iter().map(|s| format!("- {} \"{}\" ({})", s.id, s.title, status_name(s.status))).collect();
            out.push_str(&format!("\n\nOther tasks under it:\n{}", rows.join("\n")));
        }
        Some(out)
    }
}

fn summary(task: &Task) -> String {
    let mut lines = vec![format!("## Task {}: {}", task.id, task.title), format!("- Status: {}", status_name(task.status))];
    if task.priority != TaskPriority::None {
        lines.push(format!("- Priority: {}", enum_name(&task.priority)));
    }
    if let Some(due) = &task.due {
        lines.push(format!("- Due: {due}"));
    }
    if let Some(u) = &task.upstream {
        lines.push(match &u.label {
            Some(label) => format!("- Upstream: {label} {}", u.url),
            None => format!("- Upstream: {}", u.url),
        });
    }
    lines.join("\n")
}

fn status_name(s: TaskStatus) -> String {
    enum_name(&s)
}

/// The snake_case name serde gives a unit variant.
fn enum_name<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}
