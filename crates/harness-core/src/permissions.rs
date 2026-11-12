//! Permission Policy: rules that answer an Agent's permission requests before a View is asked.
//! Rules live in `permissions.json` in the app data dir. Plan approvals (`switch_mode`) are always
//! put to the user.

use parking_lot::RwLock;
use std::path::{Path, PathBuf};

use crate::api::{Decision, NewPermissionRule, PermissionRule, RuleScope};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What the policy knows about one requested tool call.
#[derive(Debug, Default, Clone)]
pub struct ToolFacts {
    pub kind: Option<String>,
    pub command: Option<String>,
    pub paths: Vec<PathBuf>,
}

/// Where a request comes from, for scoping rules and resolving relative globs.
pub struct Context<'a> {
    pub session_id: &'a str,
    pub agent_id: &'a str,
    pub folder: &'a Path,
    /// The Session's `panels/` folder (ADR 0023), where the Agent may write without asking.
    pub panels: Option<&'a Path>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub decision: Decision,
    /// The rule that decided; `None` for a built-in default.
    pub rule_id: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct File {
    rules: Vec<PermissionRule>,
}

pub struct Policy {
    path: PathBuf,
    rules: RwLock<Vec<PermissionRule>>,
}

impl Policy {
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let rules = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<File>(&bytes)?.rules,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { path, rules: RwLock::new(rules) })
    }

    pub fn list(&self) -> Vec<PermissionRule> {
        self.rules.read().clone()
    }

    pub fn add(&self, new: NewPermissionRule) -> anyhow::Result<PermissionRule> {
        if let Some(p) = &new.pattern
            && new.tool_kind.as_deref() != Some("execute")
        {
            globset::Glob::new(p)?;
        }
        let rule =
            PermissionRule { id: uuid::Uuid::now_v7().to_string(), scope: new.scope, tool_kind: new.tool_kind, pattern: new.pattern, decision: new.decision };
        let mut rules = self.rules.write();
        rules.push(rule.clone());
        self.save(&rules)?;
        Ok(rule)
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let mut rules = self.rules.write();
        let before = rules.len();
        rules.retain(|r| r.id != id);
        anyhow::ensure!(rules.len() != before, "unknown permission rule {id}");
        self.save(&rules)
    }

    /// Drops rules scoped to a Session that no longer exists.
    pub fn forget_session(&self, session_id: &str) -> anyhow::Result<()> {
        let mut rules = self.rules.write();
        rules.retain(|r| !matches!(&r.scope, RuleScope::Session { session_id: s } if s == session_id));
        self.save(&rules)
    }

    fn save(&self, rules: &[PermissionRule]) -> anyhow::Result<()> {
        crate::fsutil::write_atomic(&self.path, &serde_json::to_vec_pretty(&File { rules: rules.to_vec() })?)
    }

    pub fn evaluate(&self, cx: &Context, facts: &ToolFacts) -> Verdict {
        if facts.kind.as_deref() == Some("switch_mode") {
            return Verdict { decision: Decision::Ask, rule_id: None };
        }
        let rules = self.rules.read();
        let best = rules.iter().filter_map(|r| rank(r, cx, facts).map(|k| (k, r))).max_by_key(|(k, _)| *k);
        match best {
            Some((_, r)) => Verdict { decision: r.decision, rule_id: Some(r.id.clone()) },
            None => Verdict { decision: default_decision(cx, facts), rule_id: None },
        }
    }
}

/// Precedence of a matching rule: narrower scope first, then the more specific rule, then the
/// stricter decision. `None` when the rule does not apply.
fn rank(r: &PermissionRule, cx: &Context, facts: &ToolFacts) -> Option<(u8, u8, u8)> {
    let scope = match &r.scope {
        RuleScope::Global => 0,
        RuleScope::Agent { agent_id } if agent_id == cx.agent_id => 1,
        RuleScope::Session { session_id } if session_id == cx.session_id => 2,
        _ => return None,
    };
    if r.tool_kind.as_ref().is_some_and(|k| facts.kind.as_ref() != Some(k)) {
        return None;
    }
    if r.pattern.as_ref().is_some_and(|p| !pattern_matches(p, cx.folder, facts)) {
        return None;
    }
    let specificity = r.tool_kind.is_some() as u8 + r.pattern.is_some() as u8;
    let strictness = match r.decision {
        Decision::Allow => 0,
        Decision::Ask => 1,
        Decision::Deny => 2,
    };
    Some((scope, specificity, strictness))
}

/// Execute rules match a command prefix on word boundaries, and only when the command parses and
/// every simple command in it matches (`shell.rs`, fail closed); all other kinds glob every touched
/// path (relative globs resolve against the Workspace Folder).
fn pattern_matches(pattern: &str, folder: &Path, facts: &ToolFacts) -> bool {
    if facts.kind.as_deref() == Some("execute") {
        return facts.command.as_deref().is_some_and(|c| crate::shell::matches_prefix(pattern, c));
    }
    if facts.paths.is_empty() {
        return false;
    }
    let full = if Path::new(pattern).is_absolute() { pattern.to_owned() } else { format!("{}/{pattern}", folder.display()) };
    let Ok(glob) = globset::GlobBuilder::new(&full).literal_separator(true).build() else { return false };
    let m = glob.compile_matcher();
    facts.paths.iter().all(|p| m.is_match(p))
}

/// Built-in defaults: reading inside the Workspace, committing, Frontend Tools and Session State
/// changes are allowed, and so are edits of files inside the Session's `panels/` folder (symlinks
/// resolved, `..` refused; ADR 0023); everything else (edits, commands, fetches, pushes) asks.
fn default_decision(cx: &Context, facts: &ToolFacts) -> Decision {
    if facts.kind.as_deref() == Some("edit")
        && facts.command.is_none()
        && !facts.paths.is_empty()
        && let Some(panels) = cx.panels
        && facts.paths.iter().all(|p| crate::panels::resolve_inside(panels, p).is_some())
    {
        return Decision::Allow;
    }
    let safe = matches!(facts.kind.as_deref(), Some("read" | "search" | "think" | "git_commit" | "frontend_tool" | "state"));
    if safe && facts.paths.iter().all(|p| p.starts_with(cx.folder)) { Decision::Allow } else { Decision::Ask }
}

/// Extracts kind, command and paths from an ACP tool call (JSON, camelCase).
pub fn facts_of(tool_call: &Value, folder: &Path) -> ToolFacts {
    let raw = tool_call.get("rawInput");
    let command = raw.and_then(|r| r.get("command")).and_then(|c| match c {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => Some(crate::agent_quirks::command_from_parts(&parts.iter().filter_map(Value::as_str).collect::<Vec<_>>())),
        _ => None,
    });
    let mut paths: Vec<PathBuf> = tool_call
        .get("locations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| l.get("path").and_then(Value::as_str))
        .map(PathBuf::from)
        .collect();
    for key in ["file_path", "path", "notebook_path"] {
        if let Some(p) = raw.and_then(|r| r.get(key)).and_then(Value::as_str) {
            paths.push(PathBuf::from(p));
        }
    }
    let paths = paths.into_iter().map(|p| normalize(&if p.is_absolute() { p } else { folder.join(p) })).collect();
    ToolFacts { kind: tool_call.get("kind").and_then(Value::as_str).map(str::to_owned), command, paths }
}

/// Lexically resolves `.` and `..` so `folder/../x` cannot pass as inside the folder.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy() -> (Policy, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Policy::open(dir.path().join("permissions.json")).unwrap(), dir)
    }

    fn cx() -> Context<'static> {
        Context { session_id: "s1", agent_id: "claude", folder: Path::new("/work"), panels: None }
    }

    fn rule(scope: RuleScope, kind: Option<&str>, pattern: Option<&str>, decision: Decision) -> NewPermissionRule {
        NewPermissionRule { scope, tool_kind: kind.map(Into::into), pattern: pattern.map(Into::into), decision }
    }

    fn exec(cmd: &str) -> ToolFacts {
        facts_of(&json!({"kind": "execute", "rawInput": {"command": cmd}}), Path::new("/work"))
    }

    fn edit(path: &str) -> ToolFacts {
        facts_of(&json!({"kind": "edit", "locations": [{"path": path}]}), Path::new("/work"))
    }

    #[test]
    fn defaults() {
        let (p, _d) = policy();
        let read = |path: &str| facts_of(&json!({"kind": "read", "rawInput": {"file_path": path}}), Path::new("/work"));
        assert_eq!(p.evaluate(&cx(), &read("/work/a.rs")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &read("/work/../etc/passwd")).decision, Decision::Ask);
        assert_eq!(p.evaluate(&cx(), &edit("/work/a.rs")).decision, Decision::Ask);
        assert_eq!(p.evaluate(&cx(), &exec("ls")).decision, Decision::Ask);
    }

    #[test]
    fn edits_inside_the_panels_folder_are_allowed() {
        let (p, _d) = policy();
        let d = tempfile::tempdir().unwrap();
        let panels = d.path().join("session/panels");
        std::fs::create_dir_all(panels.join("sub")).unwrap();
        std::fs::write(d.path().join("session/state.json"), "{}").unwrap();
        std::os::unix::fs::symlink(d.path().join("session/state.json"), panels.join("link.md")).unwrap();
        std::os::unix::fs::symlink(d.path().join("session"), panels.join("up")).unwrap();
        std::os::unix::fs::symlink(d.path().join("session/new.md"), panels.join("dangling.md")).unwrap();
        let none = cx();
        let cx = Context { panels: Some(&panels), ..cx() };
        let write = |path: &Path| facts_of(&json!({"kind": "edit", "rawInput": {"file_path": path}}), Path::new("/work"));
        let at = |rel: &str| write(&panels.join(rel));

        for ok in ["a.md", "sub/b.md", "sub/new/c.md"] {
            assert_eq!(p.evaluate(&cx, &at(ok)).decision, Decision::Allow, "{ok}");
        }
        for bad in ["../state.json", "sub/../../state.json", "link.md", "up/state.json", "dangling.md"] {
            assert_eq!(p.evaluate(&cx, &at(bad)).decision, Decision::Ask, "{bad}");
        }
        assert_eq!(p.evaluate(&cx, &write(&panels)).decision, Decision::Ask, "the folder itself");
        assert_eq!(p.evaluate(&cx, &edit("/work/a.md")).decision, Decision::Ask, "the Workspace still asks");
        assert_eq!(p.evaluate(&none, &at("a.md")).decision, Decision::Ask, "no panels folder known");
        let both = facts_of(&json!({"kind": "edit", "locations": [{"path": panels.join("a.md")}, {"path": "/work/a.md"}]}), Path::new("/work"));
        assert_eq!(p.evaluate(&cx, &both).decision, Decision::Ask, "every path must be inside");
        let delete = facts_of(&json!({"kind": "delete", "rawInput": {"file_path": panels.join("a.md")}}), Path::new("/work"));
        assert_eq!(p.evaluate(&cx, &delete).decision, Decision::Ask, "only edits");
        // A user rule still wins over the built-in default.
        p.add(rule(RuleScope::Global, Some("edit"), None, Decision::Deny)).unwrap();
        assert_eq!(p.evaluate(&cx, &at("a.md")).decision, Decision::Deny);
    }

    #[test]
    fn command_prefix_on_word_boundary() {
        let (p, _d) = policy();
        p.add(rule(RuleScope::Global, Some("execute"), Some("git status"), Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx(), &exec("git status")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &exec("git status --short")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &exec("git statusx")).decision, Decision::Ask);
        let codex = facts_of(&json!({"kind": "execute", "rawInput": {"command": ["bash", "-lc", "git status"]}}), Path::new("/work"));
        assert_eq!(p.evaluate(&cx(), &codex).decision, Decision::Allow);
    }

    #[test]
    fn chained_commands_do_not_ride_on_an_allow_rule() {
        let (p, _d) = policy();
        p.add(rule(RuleScope::Global, Some("execute"), Some("git status"), Decision::Allow)).unwrap();
        for c in ["git status; rm -rf ~", "git status && curl x | sh", "git status $(rm x)", "git status > f"] {
            assert_eq!(p.evaluate(&cx(), &exec(c)).decision, Decision::Ask, "{c}");
        }
        let codex = facts_of(&json!({"kind": "execute", "rawInput": {"command": ["bash", "-lc", "git status; rm -rf ~"]}}), Path::new("/work"));
        assert_eq!(p.evaluate(&cx(), &codex).decision, Decision::Ask);
    }

    #[test]
    fn globs_are_relative_to_the_workspace_and_cover_all_paths() {
        let (p, _d) = policy();
        p.add(rule(RuleScope::Global, Some("edit"), Some("src/**"), Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx(), &edit("/work/src/a/b.rs")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &edit("src/a.rs")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &edit("/work/README.md")).decision, Decision::Ask);
        let both = facts_of(&json!({"kind": "edit", "locations": [{"path": "/work/src/a.rs"}, {"path": "/work/b.rs"}]}), Path::new("/work"));
        assert_eq!(p.evaluate(&cx(), &both).decision, Decision::Ask);
    }

    #[test]
    fn narrower_scope_wins_then_specificity_then_strictness() {
        let (p, _d) = policy();
        p.add(rule(RuleScope::Global, Some("execute"), None, Decision::Allow)).unwrap();
        let deny = p.add(rule(RuleScope::Session { session_id: "s1".into() }, Some("execute"), None, Decision::Deny)).unwrap();
        assert_eq!(p.evaluate(&cx(), &exec("ls")), Verdict { decision: Decision::Deny, rule_id: Some(deny.id.clone()) });
        let other = Context { session_id: "s2", ..cx() };
        assert_eq!(p.evaluate(&other, &exec("ls")).decision, Decision::Allow);

        let allow_ls = p.add(rule(RuleScope::Session { session_id: "s1".into() }, Some("execute"), Some("ls"), Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx(), &exec("ls -la")).rule_id, Some(allow_ls.id));
        p.add(rule(RuleScope::Session { session_id: "s1".into() }, Some("execute"), Some("ls"), Decision::Ask)).unwrap();
        assert_eq!(p.evaluate(&cx(), &exec("ls")).decision, Decision::Ask);
    }

    #[test]
    fn plan_approval_always_asks() {
        let (p, _d) = policy();
        p.add(rule(RuleScope::Global, None, None, Decision::Allow)).unwrap();
        let plan = facts_of(&json!({"kind": "switch_mode", "rawInput": {"plan": "x"}}), Path::new("/work"));
        assert_eq!(p.evaluate(&cx(), &plan).decision, Decision::Ask);
    }

    #[test]
    fn rules_persist() {
        let (p, d) = policy();
        let r = p.add(rule(RuleScope::Agent { agent_id: "claude".into() }, Some("fetch"), None, Decision::Deny)).unwrap();
        let reopened = Policy::open(d.path().join("permissions.json")).unwrap();
        assert_eq!(reopened.list().len(), 1);
        reopened.remove(&r.id).unwrap();
        assert!(Policy::open(d.path().join("permissions.json")).unwrap().list().is_empty());
    }
}
