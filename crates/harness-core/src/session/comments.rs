//! Review Comments of a Session (ADR 0027): add, edit, delete, send, resolve. State is projected from the log.

use super::Session;
use crate::api::{CommentSide, CommentState, CommentStatus, EventKind, LineComment, StateWriter};
use crate::error::{conflict, invalid, not_found};

impl Session {
    /// Review Comments in the order added, with their state.
    pub fn comments(&self) -> anyhow::Result<Vec<CommentState>> {
        self.log.comments()
    }

    fn comment(&self, id: &str) -> anyhow::Result<CommentState> {
        self.comments()?.into_iter().find(|c| c.comment.id == id).ok_or_else(|| not_found(format!("unknown comment {id}")))
    }

    /// Adds a comment: pending when the user made it, open when the Agent did.
    pub fn add_comment(&self, path: String, line: u32, side: Option<CommentSide>, code: String, text: String, by: StateWriter) -> anyhow::Result<LineComment> {
        let p = std::path::Path::new(&path);
        if path.is_empty() || p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(invalid("path must be relative to the Workspace, without `..`"));
        }
        if line < 1 {
            return Err(invalid("line is 1-based"));
        }
        if text.trim().is_empty() {
            return Err(invalid("comment text is empty"));
        }
        let comment = LineComment { id: format!("c{}", self.log.comments_added()? + 1), path, line, side, code, text, by };
        self.log.append(None, EventKind::CommentAdded { comment: comment.clone() })?;
        Ok(comment)
    }

    fn pending(&self, id: &str, what: &str) -> anyhow::Result<()> {
        if self.comment(id)?.status != CommentStatus::Pending {
            return Err(conflict(format!("comment {id} was already sent; {what}")));
        }
        Ok(())
    }

    /// Changes a pending comment's text.
    pub fn edit_comment(&self, id: &str, text: String) -> anyhow::Result<()> {
        self.pending(id, "add a new comment instead")?;
        if text.trim().is_empty() {
            return Err(invalid("comment text is empty"));
        }
        self.log.append(None, EventKind::CommentEdited { id: id.to_owned(), text })?;
        Ok(())
    }

    /// Deletes a pending comment.
    pub fn delete_comment(&self, id: &str) -> anyhow::Result<()> {
        self.pending(id, "it can no longer be deleted; resolve it instead")?;
        self.log.append(None, EventKind::CommentDeleted { id: id.to_owned() })?;
        Ok(())
    }

    /// Marks the pending comments among `ids` as sent; logs nothing when none is pending.
    pub fn mark_comments_sent(&self, ids: &[String]) -> anyhow::Result<()> {
        let pending: Vec<String> =
            self.comments()?.into_iter().filter(|c| c.status == CommentStatus::Pending && ids.contains(&c.comment.id)).map(|c| c.comment.id).collect();
        if !pending.is_empty() {
            self.log.append(None, EventKind::CommentsSent { ids: pending })?;
        }
        Ok(())
    }

    /// Resolves a sent comment. Already resolved: nothing happens.
    pub fn resolve_comment(&self, id: &str, by: StateWriter, note: Option<String>) -> anyhow::Result<()> {
        match self.comment(id)?.status {
            CommentStatus::Pending => return Err(conflict(format!("comment {id} is not sent yet"))),
            CommentStatus::Resolved => return Ok(()),
            CommentStatus::Open => {}
        }
        let note = note.filter(|n| !n.trim().is_empty());
        self.log.append(None, EventKind::CommentResolved { id: id.to_owned(), by, note })?;
        Ok(())
    }

    /// The text of line `line` (1-based) of `path` in the working tree, or at HEAD for the old side of a diff.
    pub async fn comment_code(&self, path: &str, line: u32, side: Option<CommentSide>) -> anyhow::Result<String> {
        let folder = std::path::PathBuf::from(self.meta().folder);
        let p = std::path::Path::new(path);
        if path.is_empty() || p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(invalid("path must be relative to the Workspace, without `..`"));
        }
        let content = if side == Some(CommentSide::Old) {
            crate::git::git(&folder, &["show", "--end-of-options", &format!("HEAD:./{path}")])
                .await
                .map_err(|_| not_found(format!("{path} does not exist at HEAD")))?
        } else {
            std::fs::read_to_string(folder.join(path)).map_err(|_| not_found(format!("cannot read {path} in the Workspace")))?
        };
        let idx = (line as usize).checked_sub(1).ok_or_else(|| invalid("line is 1-based"))?;
        content.lines().nth(idx).map(str::to_owned).ok_or_else(|| not_found(format!("{path} has no line {line}")))
    }
}

#[cfg(test)]
mod tests {
    use super::super::projection_tests::session;
    use super::*;

    fn user(s: &Session, text: &str) -> LineComment {
        s.add_comment("src/a.ts".into(), 3, Some(CommentSide::New), "let x".into(), text.into(), StateWriter::User).unwrap()
    }

    fn status(s: &Session, id: &str) -> CommentStatus {
        s.comment(id).unwrap().status
    }

    #[tokio::test]
    async fn lifecycle_pending_sent_resolved() {
        let (s, _d) = session().await;
        let c = user(&s, "why?");
        assert_eq!(c.id, "c1");
        assert_eq!(status(&s, "c1"), CommentStatus::Pending);
        s.edit_comment("c1", "why not?".into()).unwrap();
        assert_eq!(s.comment("c1").unwrap().comment.text, "why not?");
        assert!(s.resolve_comment("c1", StateWriter::User, None).unwrap_err().to_string().contains("not sent yet"));
        s.mark_comments_sent(&["c1".into(), "nope".into()]).unwrap();
        assert_eq!(status(&s, "c1"), CommentStatus::Open);
        let e = s.edit_comment("c1", "x".into()).unwrap_err();
        assert!(e.to_string().contains("already sent"), "{e}");
        assert!(s.delete_comment("c1").is_err());
        s.resolve_comment("c1", StateWriter::Agent, Some("done".into())).unwrap();
        let st = s.comment("c1").unwrap();
        assert_eq!((st.status, st.resolved_by, st.note.as_deref()), (CommentStatus::Resolved, Some(StateWriter::Agent), Some("done")));
        let n = s.log.events().unwrap().len();
        s.resolve_comment("c1", StateWriter::User, None).unwrap();
        assert_eq!(s.log.events().unwrap().len(), n, "resolving twice logs nothing");
        assert!(s.resolve_comment("c9", StateWriter::User, None).is_err());
    }

    #[tokio::test]
    async fn ids_are_never_reused_and_delete_only_pending() {
        let (s, _d) = session().await;
        user(&s, "a");
        s.delete_comment("c1").unwrap();
        assert!(s.comments().unwrap().is_empty());
        assert_eq!(user(&s, "b").id, "c2");
        let agent = s.add_comment("a.rs".into(), 1, None, "fn".into(), "hm".into(), StateWriter::Agent).unwrap();
        assert_eq!(agent.id, "c3");
        assert_eq!(status(&s, "c3"), CommentStatus::Open);
        // Nothing pending: no event.
        let n = s.log.events().unwrap().len();
        s.mark_comments_sent(&["c3".into()]).unwrap();
        assert_eq!(s.log.events().unwrap().len(), n);
    }

    #[tokio::test]
    async fn validates_input() {
        let (s, _d) = session().await;
        let add = |p: &str, l: u32, t: &str| s.add_comment(p.into(), l, None, String::new(), t.into(), StateWriter::User);
        assert!(add("../x", 1, "t").is_err());
        assert!(add("/x", 1, "t").is_err());
        assert!(add("x", 0, "t").is_err());
        assert!(add("x", 1, "  ").is_err());
        user(&s, "ok");
        assert!(s.edit_comment("c1", " ".into()).is_err());
    }

    #[tokio::test]
    async fn projection_survives_reopen() {
        let (s, _dir) = session().await;
        user(&s, "a");
        user(&s, "b");
        s.mark_comments_sent(&["c1".into()]).unwrap();
        s.resolve_comment("c1", StateWriter::User, None).unwrap();
        s.edit_comment("c2", "b2".into()).unwrap();
        s.log().sync().unwrap();
        let before = s.comments().unwrap();
        let log = crate::log::SessionLog::open(s.id(), &s.dir().join("log.jsonl")).unwrap();
        assert_eq!(log.comments().unwrap(), before);
        assert_eq!(log.comments_added().unwrap(), 2);
    }
}
