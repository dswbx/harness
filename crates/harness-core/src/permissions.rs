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
    /// Folders of the Shared Artifacts attached to the Session (ADR 0024): writable without asking,
    /// except their `meta.json`.
    pub shared: &'a [PathBuf],
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
        // A corrupt file is moved aside and the built-in defaults apply (ask), never a looser policy.
        let rules = crate::persist::JsonFile::<File>::new(path.clone()).load_or_default()?.rules;
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
        // In memory only once saved: a refused save must not leave a rule that is not on disk.
        let mut next = rules.clone();
        next.push(rule.clone());
        self.save(&next)?;
        *rules = next;
        Ok(rule)
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let mut rules = self.rules.write();
        // In memory only once saved, like `add`.
        let mut next = rules.clone();
        next.retain(|r| r.id != id);
        if next.len() == rules.len() {
            return Err(crate::error::not_found(format!("unknown permission rule {id}")));
        }
        self.save(&next)?;
        *rules = next;
        Ok(())
    }

    /// Drops rules scoped to a Session that no longer exists.
    pub fn forget_session(&self, session_id: &str) -> anyhow::Result<()> {
        let mut rules = self.rules.write();
        let mut next = rules.clone();
        next.retain(|r| !matches!(&r.scope, RuleScope::Session { session_id: s } if s == session_id));
        if next.len() == rules.len() {
            return Ok(());
        }
        self.save(&next)?;
        *rules = next;
        Ok(())
    }

    fn save(&self, rules: &[PermissionRule]) -> anyhow::Result<()> {
        crate::persist::JsonFile::new(self.path.clone()).save(&File { rules: rules.to_vec() })
    }

    pub fn evaluate(&self, cx: &Context, facts: &ToolFacts) -> Verdict {
        if facts.kind.as_deref() == Some("switch_mode") {
            return Verdict { decision: Decision::Ask, rule_id: None };
        }
        let folder = Folder { lexical: cx.folder, real: cx.folder.canonicalize().ok() };
        // Resolved once per request, for every rule.
        let forms: Vec<Forms> = facts.paths.iter().map(|p| Forms::of(p)).collect();
        let rules = self.rules.read();
        let best = rules.iter().filter_map(|r| rank(r, cx, &folder, facts, &forms).map(|k| (k, r))).max_by_key(|(k, _)| *k);
        match best {
            Some((_, r)) => Verdict { decision: r.decision, rule_id: Some(r.id.clone()) },
            None => Verdict { decision: default_decision(cx, &folder, facts, &forms), rule_id: None },
        }
    }
}

/// The Session folder as written and with symbolic links resolved (`None` when it cannot be
/// resolved: missing, removed or dangling; then no path counts as inside it).
struct Folder<'a> {
    lexical: &'a Path,
    real: Option<PathBuf>,
}

impl Folder<'_> {
    /// The resolved real location is the folder or under it.
    fn contains(&self, forms: &Forms) -> bool {
        let Some(root) = &self.real else { return false };
        forms.real.as_ref().is_some_and(|real| real.starts_with(root))
    }
}

/// The forms of one requested path a rule is matched against.
struct Forms {
    /// As written (`..` included).
    raw: PathBuf,
    /// Without `.` and `..`.
    plain: PathBuf,
    /// With symbolic links resolved.
    real: Option<PathBuf>,
}

impl Forms {
    fn of(raw: &Path) -> Self {
        Self { raw: raw.to_path_buf(), plain: crate::fsutil::normalize_lexical(raw), real: crate::fsutil::resolve_physical(raw) }
    }
}

/// Precedence of a matching rule: narrower scope first, then the more specific rule, then the
/// stricter decision. `None` when the rule does not apply.
fn rank(r: &PermissionRule, cx: &Context, folder: &Folder, facts: &ToolFacts, forms: &[Forms]) -> Option<(u8, u8, u8)> {
    let scope = match &r.scope {
        RuleScope::Global => 0,
        RuleScope::Agent { agent_id } if agent_id == cx.agent_id => 1,
        RuleScope::Session { session_id } if session_id == cx.session_id => 2,
        _ => return None,
    };
    if r.tool_kind.as_ref().is_some_and(|k| facts.kind.as_ref() != Some(k)) {
        return None;
    }
    // A file from outside the Workspace Folder is approved by the user every time: no Allow rule.
    if r.decision == Decision::Allow && facts.kind.as_deref() == Some(crate::acp::OUTSIDE_FILE_KIND) {
        return None;
    }
    if r.pattern.as_ref().is_some_and(|p| !pattern_matches(p, folder, facts, forms, r.decision)) {
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

/// `~` and `~/x` as the home directory; any other path as given.
fn expand_home(path: &str) -> PathBuf {
    let rest = path.strip_prefix('~').filter(|r| r.is_empty() || r.starts_with('/'));
    match (rest, std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest.trim_start_matches('/')),
        _ => PathBuf::from(path),
    }
}

const GLOB_META: [char; 4] = ['*', '?', '[', '{'];

/// `pattern` with the directory part before its first wildcard resolved (`/tmp/x/**` is
/// `/private/tmp/x/**` on macOS), so it can be compared with a resolved path.
fn resolved_glob(pattern: &str) -> String {
    let cut = pattern.find(GLOB_META).unwrap_or(pattern.len());
    let Some(slash) = pattern[..cut].rfind('/') else { return pattern.to_owned() };
    match crate::fsutil::resolve_physical(Path::new(&pattern[..slash.max(1)])) {
        Some(dir) => format!("{}/{}", globset::escape(dir.display().to_string().trim_end_matches('/')), pattern[slash..].trim_start_matches('/')),
        None => pattern.to_owned(),
    }
}

/// Execute rules match a command prefix on word boundaries, and only when the command parses and
/// every simple command in it matches (`shell.rs`, fail closed). All other kinds glob the touched
/// paths (relative globs resolve against the Workspace Folder, `~` is the home directory). An
/// Allow rule matches only when EVERY path matches by its resolved location (a relative rule
/// against the resolved folder, an absolute one with its fixed directory part resolved). A Deny or
/// Ask rule matches when ANY path matches, in its written form, without `..`, or resolved (and, for
/// a pattern with no wildcard, resolved to its target); on macOS and Windows these ignore letter
/// case, as the volumes do.
fn pattern_matches(pattern: &str, folder: &Folder, facts: &ToolFacts, forms: &[Forms], decision: Decision) -> bool {
    if facts.kind.as_deref() == Some("execute") {
        return facts.command.as_deref().is_some_and(|c| crate::shell::matches_prefix(pattern, c));
    }
    if forms.is_empty() {
        return false;
    }
    let strict = decision == Decision::Allow;
    let ignore_case = !strict && cfg!(any(target_os = "macos", target_os = "windows"));
    let matcher = |g: &str| globset::GlobBuilder::new(g).literal_separator(true).case_insensitive(ignore_case).build().ok().map(|g| g.compile_matcher());
    let expanded = expand_home(pattern);
    let absolute = expanded.is_absolute();
    let (written, resolved) = if absolute {
        let g = expanded.display().to_string();
        (matcher(&g), matcher(&resolved_glob(&g)))
    } else {
        let lexical = matcher(&format!("{}/{pattern}", globset::escape(&folder.lexical.display().to_string())));
        (lexical, folder.real.as_ref().and_then(|r| matcher(&format!("{}/{pattern}", globset::escape(&r.display().to_string())))))
    };
    // A pattern naming one file also covers what that file is a link to.
    let target = (!strict && !pattern.contains(GLOB_META))
        .then(|| crate::fsutil::resolve_physical(&if absolute { expanded.clone() } else { folder.lexical.join(pattern) }))
        .flatten()
        .and_then(|t| matcher(&globset::escape(&t.display().to_string())));
    let hit = |m: &Option<globset::GlobMatcher>, p: &Path| m.as_ref().is_some_and(|m| m.is_match(p));
    if strict {
        forms.iter().all(|f| f.real.as_ref().is_some_and(|r| hit(&resolved, r)))
    } else {
        forms.iter().any(|f| {
            [Some(f.raw.as_path()), Some(f.plain.as_path()), f.real.as_deref()]
                .into_iter()
                .flatten()
                .any(|p| hit(&written, p) || hit(&resolved, p) || hit(&target, p))
        })
    }
}

/// Built-in defaults: reading inside the Workspace, committing, Frontend Tools and Session State
/// changes are allowed, and so are edits of files inside the Session's `panels/` folder (ADR 0023)
/// or inside the folder of an attached Shared Artifact, but not its `meta.json` (ADR 0024); paths
/// are resolved (symlinks followed, `..` refused), and a read counts as inside the Workspace by
/// its resolved location (a recursive tool is judged by the root it names, not by what it finds below). A read or search that names no path asks. Everything else (edits,
/// commands, fetches, pushes) asks.
fn default_decision(cx: &Context, folder: &Folder, facts: &ToolFacts, forms: &[Forms]) -> Decision {
    let writable = |p: &Path| {
        cx.panels.is_some_and(|panels| crate::fsutil::resolve_below_via_ancestor(panels, p).is_some())
            || cx.shared.iter().any(|dir| {
                let Some(real) = crate::fsutil::resolve_below_via_ancestor(dir, p) else { return false };
                // `resolve_below_via_ancestor` resolved `dir` the same way: compare against its real path.
                dir.canonicalize().is_ok_and(|d| real != d.join("meta.json"))
            })
    };
    if facts.kind.as_deref() == Some("edit") && facts.command.is_none() && !facts.paths.is_empty() && facts.paths.iter().all(|p| writable(p)) {
        return Decision::Allow;
    }
    let safe = matches!(facts.kind.as_deref(), Some("read" | "search" | "think" | "git_commit" | "frontend_tool" | "state"));
    let names_a_path = !matches!(facts.kind.as_deref(), Some("read" | "search")) || !facts.paths.is_empty();
    if safe && names_a_path && forms.iter().all(|f| folder.contains(f)) { Decision::Allow } else { Decision::Ask }
}

/// The place a search pattern starts from: its fixed part up to the last `/` before a wildcard.
fn search_root(pattern: &str, folder: &Path) -> PathBuf {
    let cut = pattern.find(GLOB_META).unwrap_or(pattern.len());
    let fixed = pattern[..cut].rfind('/').map_or(pattern, |i| &pattern[..i.max(1)]);
    let expanded = expand_home(fixed);
    if expanded.is_absolute() || fixed.starts_with('~') { expanded } else { folder.join(expanded) }
}

/// Extracts kind, command and paths from an ACP tool call (JSON, camelCase). Paths keep their
/// written form (`..` included), made absolute against the folder; `~` is the home directory. A
/// search that names no path searches the folder.
pub fn facts_of(tool_call: &Value, folder: &Path) -> ToolFacts {
    let raw = tool_call.get("rawInput");
    let command = raw.and_then(|r| r.get("command")).and_then(|c| match c {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => Some(crate::agent_quirks::command_from_parts(&parts.iter().filter_map(Value::as_str).collect::<Vec<_>>())),
        _ => None,
    });
    let mut written: Vec<&str> =
        tool_call.get("locations").and_then(Value::as_array).into_iter().flatten().filter_map(|l| l.get("path").and_then(Value::as_str)).collect();
    for key in ["file_path", "path", "notebook_path"] {
        written.extend(raw.and_then(|r| r.get(key)).and_then(Value::as_str));
    }
    let mut paths: Vec<PathBuf> = written
        .into_iter()
        .map(|p| {
            let expanded = expand_home(p);
            // An unexpanded `~` stays relative: it is never a place inside the folder.
            if expanded.is_absolute() || p.starts_with('~') { expanded } else { folder.join(expanded) }
        })
        .collect();
    let kind = tool_call.get("kind").and_then(Value::as_str).map(str::to_owned);
    if kind.as_deref() == Some("search") && paths.is_empty() {
        // No path: the search covers the folder, unless its pattern names a place of its own.
        let reach = raw.and_then(|r| r.get("pattern")).and_then(Value::as_str).filter(|p| p.starts_with(['/', '~']) || p.starts_with("../") || *p == "..");
        paths.push(reach.map_or_else(|| folder.to_owned(), |p| search_root(p, folder)));
    }
    ToolFacts { kind, command, paths }
}

#[cfg(test)]
mod tests {

    fn corrupt_files(d: &Path) -> usize {
        std::fs::read_dir(d).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("permissions.json.corrupt-")).count()
    }

    #[test]
    fn reads_the_file_format_of_today() {
        let d = tempfile::tempdir().unwrap();
        let fixture = r#"{"rules":[{"id":"r1","scope":{"type":"agent","agent_id":"claude"},"tool_kind":"fetch","pattern":null,"decision":"deny"},{"id":"r2","scope":{"type":"global"},"tool_kind":"read","pattern":"src/**","decision":"allow"}]}"#;
        std::fs::write(d.path().join("permissions.json"), fixture).unwrap();
        let p = Policy::open(d.path().join("permissions.json")).unwrap();
        assert_eq!(p.list().len(), 2);
        p.remove("r1").unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(d.path().join("permissions.json")).unwrap()).unwrap();
        assert_eq!(written["rules"].as_array().unwrap().len(), 1);
        assert_eq!(written["rules"][0]["id"], "r2");
        assert_eq!(written["rules"][0]["pattern"], "src/**");
    }

    fn asks_everything(p: &Policy) {
        assert!(p.list().is_empty());
        for facts in [
            ToolFacts { kind: Some("edit".into()), command: None, paths: vec![PathBuf::from(w("a.rs"))] },
            exec("rm -rf /"),
            ToolFacts { kind: Some("fetch".into()), ..Default::default() },
        ] {
            assert_eq!(p.evaluate(&cx(), &facts).decision, Decision::Ask);
        }
    }

    #[test]
    fn a_file_from_a_newer_build_is_set_aside_as_unreadable_and_the_defaults_apply() {
        let d = tempfile::tempdir().unwrap();
        let file = r#"{"rules":[{"id":"r1","scope":{"type":"global"},"tool_kind":"fetch","pattern":null,"decision":"allow-for-ever"}]}"#;
        std::fs::write(d.path().join("permissions.json"), file).unwrap();
        let p = Policy::open(d.path().join("permissions.json")).unwrap();
        asks_everything(&p);
        let names: Vec<_> = std::fs::read_dir(d.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        let copy = names.iter().find(|n| n.starts_with("permissions.json.unreadable-")).unwrap();
        assert_eq!(std::fs::read_to_string(d.path().join(copy)).unwrap(), file);
        let n = crate::persist::take_problems(d.path());
        assert_eq!(n.len(), 1);
        assert!(n[0].notice().message.starts_with("Permission rules were reset."));
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_remove_or_forget_keeps_the_rules() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let p = Policy::open(d.path().join("permissions.json")).unwrap();
        let global = p.add(rule(RuleScope::Global, Some("fetch"), None, Decision::Allow)).unwrap();
        p.add(rule(RuleScope::Session { session_id: "s1".into() }, Some("fetch"), None, Decision::Allow)).unwrap();
        assert_eq!(p.list().len(), 2);
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let writable = std::fs::write(d.path().join("probe"), b"").is_ok();
        let removed = p.remove(&global.id);
        let forgot = p.forget_session("s1");
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        if writable {
            return; // running as root
        }
        assert!(removed.is_err() && forgot.is_err());
        assert_eq!(p.list().len(), 2, "memory matches the file");
        // Unknown ids are a not-found, and nothing changes.
        let e = p.remove("nope").unwrap_err();
        assert_eq!(crate::api::HarnessError::from(e).code, crate::api::ErrorCode::NotFound);
        p.forget_session("s1").unwrap();
        assert_eq!(p.list().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn when_the_file_cannot_be_moved_the_defaults_apply_and_it_is_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("permissions.json");
        std::fs::write(&file, b"{\"rules\": [{\"id\":").unwrap();
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let writable = std::fs::write(d.path().join("probe"), b"").is_ok();
        let p = Policy::open(file.clone()).unwrap();
        std::fs::set_permissions(d.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        if writable {
            return; // running as root
        }
        asks_everything(&p);
        // Adding a rule is refused: saving would destroy the unreadable file, and the rule must not apply unsaved.
        assert!(p.add(rule(RuleScope::Global, Some("fetch"), None, Decision::Allow)).is_err());
        asks_everything(&p);
        assert_eq!(std::fs::read(&file).unwrap(), b"{\"rules\": [{\"id\":");
        assert_eq!(crate::persist::take_problems(d.path()).len(), 1);
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_and_the_safe_defaults_apply() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("permissions.json"), b"{\"rules\": [{\"id\":").unwrap();
        let p = Policy::open(d.path().join("permissions.json")).unwrap();
        assert!(p.list().is_empty());
        assert_eq!(corrupt_files(d.path()), 1);
        // Fresh-install behaviour: edits, commands and fetches ask.
        for facts in [
            ToolFacts { kind: Some("edit".into()), command: None, paths: vec![PathBuf::from(w("a.rs"))] },
            exec("rm -rf /"),
            ToolFacts { kind: Some("fetch".into()), ..Default::default() },
        ] {
            assert_eq!(p.evaluate(&cx(), &facts).decision, Decision::Ask);
        }
        // Rules can be added again afterwards.
        p.add(rule(RuleScope::Global, Some("fetch"), None, Decision::Deny)).unwrap();
        assert_eq!(Policy::open(d.path().join("permissions.json")).unwrap().list().len(), 1);
    }
    use super::*;
    use serde_json::json;

    fn policy() -> (Policy, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Policy::open(dir.path().join("permissions.json")).unwrap(), dir)
    }

    /// A real folder for the whole test run: the policy resolves paths on disk.
    fn work() -> &'static Path {
        static DIR: std::sync::OnceLock<(tempfile::TempDir, PathBuf)> = std::sync::OnceLock::new();
        &DIR.get_or_init(|| {
            let d = tempfile::tempdir().unwrap();
            let real = d.path().canonicalize().unwrap();
            std::fs::create_dir_all(real.join("src")).unwrap();
            (d, real)
        })
        .1
    }

    fn w(rel: &str) -> String {
        format!("{}/{rel}", work().display())
    }

    fn cx() -> Context<'static> {
        Context { session_id: "s1", agent_id: "claude", folder: work(), panels: None, shared: &[] }
    }

    fn rule(scope: RuleScope, kind: Option<&str>, pattern: Option<&str>, decision: Decision) -> NewPermissionRule {
        NewPermissionRule { scope, tool_kind: kind.map(Into::into), pattern: pattern.map(Into::into), decision }
    }

    fn exec(cmd: &str) -> ToolFacts {
        facts_of(&json!({"kind": "execute", "rawInput": {"command": cmd}}), work())
    }

    fn edit(path: &str) -> ToolFacts {
        facts_of(&json!({"kind": "edit", "locations": [{"path": path}]}), work())
    }

    #[test]
    fn defaults() {
        let (p, _d) = policy();
        let read = |path: &str| facts_of(&json!({"kind": "read", "rawInput": {"file_path": path}}), work());
        assert_eq!(p.evaluate(&cx(), &read(&w("a.rs"))).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &read(&w("../etc/passwd"))).decision, Decision::Ask);
        assert_eq!(p.evaluate(&cx(), &edit(&w("a.rs"))).decision, Decision::Ask);
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
        let write = |path: &Path| facts_of(&json!({"kind": "edit", "rawInput": {"file_path": path}}), work());
        let at = |rel: &str| write(&panels.join(rel));

        for ok in ["a.md", "sub/b.md", "sub/new/c.md"] {
            assert_eq!(p.evaluate(&cx, &at(ok)).decision, Decision::Allow, "{ok}");
        }
        for bad in ["../state.json", "sub/../../state.json", "link.md", "up/state.json", "dangling.md"] {
            assert_eq!(p.evaluate(&cx, &at(bad)).decision, Decision::Ask, "{bad}");
        }
        assert_eq!(p.evaluate(&cx, &write(&panels)).decision, Decision::Ask, "the folder itself");
        assert_eq!(p.evaluate(&cx, &edit(&w("a.md"))).decision, Decision::Ask, "the Workspace still asks");
        assert_eq!(p.evaluate(&none, &at("a.md")).decision, Decision::Ask, "no panels folder known");
        let both = facts_of(&json!({"kind": "edit", "locations": [{"path": panels.join("a.md")}, {"path": w("a.md")}]}), work());
        assert_eq!(p.evaluate(&cx, &both).decision, Decision::Ask, "every path must be inside");
        let delete = facts_of(&json!({"kind": "delete", "rawInput": {"file_path": panels.join("a.md")}}), work());
        assert_eq!(p.evaluate(&cx, &delete).decision, Decision::Ask, "only edits");
        // A user rule still wins over the built-in default.
        p.add(rule(RuleScope::Global, Some("edit"), None, Decision::Deny)).unwrap();
        assert_eq!(p.evaluate(&cx, &at("a.md")).decision, Decision::Deny);
    }

    #[test]
    fn edits_inside_attached_shared_artifacts_are_allowed() {
        let (p, _d) = policy();
        let d = tempfile::tempdir().unwrap();
        let shared = d.path().join("shared");
        let (a, b) = (shared.join("plan-aaaaaa"), shared.join("other-bbbbbb"));
        std::fs::create_dir_all(a.join("files")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("meta.json"), "{}").unwrap();
        std::fs::write(b.join("content.md"), "x").unwrap();
        std::os::unix::fs::symlink(b.join("content.md"), a.join("link.md")).unwrap();
        std::os::unix::fs::symlink(&b, a.join("up")).unwrap();
        std::os::unix::fs::symlink(a.join("gone.md"), a.join("dangling.md")).unwrap();
        let attached = [a.clone()];
        let none = cx();
        let both_base = cx();
        let cx = Context { shared: &attached, ..cx() };
        let write = |path: &Path| facts_of(&json!({"kind": "edit", "rawInput": {"file_path": path}}), work());
        let at = |rel: &str| write(&a.join(rel));

        for ok in ["content.md", "content.html", "ui.json", "state.json", "files/new.png"] {
            assert_eq!(p.evaluate(&cx, &at(ok)).decision, Decision::Allow, "{ok}");
        }
        for bad in ["meta.json", "../other-bbbbbb/content.md", "link.md", "up/content.md", "dangling.md"] {
            assert_eq!(p.evaluate(&cx, &at(bad)).decision, Decision::Ask, "{bad}");
        }
        assert_eq!(p.evaluate(&cx, &write(&a)).decision, Decision::Ask, "the folder itself");
        assert_eq!(p.evaluate(&cx, &write(&b.join("content.md"))).decision, Decision::Ask, "not attached");
        assert_eq!(p.evaluate(&none, &at("content.md")).decision, Decision::Ask, "nothing attached");
        // Panels and attached artifacts together.
        let panels = d.path().join("panels");
        std::fs::create_dir_all(&panels).unwrap();
        let both = Context { panels: Some(&panels), shared: &attached, ..both_base };
        let two = facts_of(&json!({"kind": "edit", "locations": [{"path": panels.join("p.md")}, {"path": a.join("content.md")}]}), work());
        assert_eq!(p.evaluate(&both, &two).decision, Decision::Allow);
        let delete = facts_of(&json!({"kind": "delete", "rawInput": {"file_path": a.join("content.md")}}), work());
        assert_eq!(p.evaluate(&cx, &delete).decision, Decision::Ask, "only edits");
        p.add(rule(RuleScope::Global, Some("edit"), None, Decision::Deny)).unwrap();
        assert_eq!(p.evaluate(&cx, &at("content.md")).decision, Decision::Deny, "a user rule still wins");
    }

    /// A real folder with an outside folder next to it and links between them.
    struct Linked {
        _d: tempfile::TempDir,
        folder: PathBuf,
        outside: PathBuf,
    }

    fn linked() -> Linked {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().canonicalize().unwrap();
        let (folder, outside) = (base.join("work"), base.join("elsewhere"));
        std::fs::create_dir_all(folder.join("pkg")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(folder.join("a.rs"), "x").unwrap();
        std::fs::write(folder.join("pkg/real.rs"), "x").unwrap();
        std::fs::write(outside.join("o.txt"), "x").unwrap();
        std::os::unix::fs::symlink(folder.join("pkg"), folder.join("inner")).unwrap();
        std::os::unix::fs::symlink(&outside, folder.join("out")).unwrap();
        std::os::unix::fs::symlink(outside.join("o.txt"), folder.join("o.link")).unwrap();
        std::os::unix::fs::symlink(outside.join("gone"), folder.join("dangling")).unwrap();
        Linked { _d: d, folder, outside }
    }

    fn read_at(l: &Linked, rel: &str) -> ToolFacts {
        facts_of(&json!({"kind": "read", "rawInput": {"file_path": l.folder.join(rel)}}), &l.folder)
    }

    #[test]
    fn a_link_that_leaves_the_folder_is_outside() {
        let (p, _d) = policy();
        let l = linked();
        let cx = Context { session_id: "s1", agent_id: "claude", folder: &l.folder, panels: None, shared: &[] };
        for ok in ["a.rs", "pkg/real.rs", "inner/real.rs", "inner/new.rs", "new/deeper.rs", ""] {
            assert_eq!(p.evaluate(&cx, &read_at(&l, ok)).decision, Decision::Allow, "{ok}");
        }
        for bad in ["o.link", "out/o.txt", "out/missing.txt", "out/a/b/missing.txt", "dangling"] {
            assert_eq!(p.evaluate(&cx, &read_at(&l, bad)).decision, Decision::Ask, "{bad}");
        }
        let two = facts_of(&json!({"kind": "read", "locations": [{"path": l.folder.join("a.rs")}, {"path": l.folder.join("o.link")}]}), &l.folder);
        assert_eq!(p.evaluate(&cx, &two).decision, Decision::Ask, "every path must be inside");
    }

    #[test]
    fn an_allow_rule_matches_by_the_resolved_location() {
        let (p, _d) = policy();
        let l = linked();
        let cx = Context { session_id: "s1", agent_id: "claude", folder: &l.folder, panels: None, shared: &[] };
        p.add(rule(RuleScope::Global, Some("edit"), Some("**"), Decision::Allow)).unwrap();
        let edit_at = |rel: &str| facts_of(&json!({"kind": "edit", "locations": [{"path": l.folder.join(rel)}]}), &l.folder);
        for ok in ["a.rs", "inner/real.rs", "inner/new.rs", "new.rs"] {
            assert_eq!(p.evaluate(&cx, &edit_at(ok)).decision, Decision::Allow, "{ok}");
        }
        for bad in ["o.link", "out/o.txt", "out/missing.txt"] {
            assert_eq!(p.evaluate(&cx, &edit_at(bad)).decision, Decision::Ask, "{bad}");
        }
        // A rule for a place outside the folder keeps working for plain paths there.
        let glob = format!("{}/**", l.outside.display());
        p.add(rule(RuleScope::Global, Some("edit"), Some(&glob), Decision::Allow)).unwrap();
        let direct = facts_of(&json!({"kind": "edit", "locations": [{"path": l.outside.join("o.txt")}]}), &l.folder);
        assert_eq!(p.evaluate(&cx, &direct).decision, Decision::Allow);
    }

    #[test]
    fn a_deny_rule_matches_the_written_and_the_resolved_form() {
        let (p, _d) = policy();
        let l = linked();
        let cx = Context { session_id: "s1", agent_id: "claude", folder: &l.folder, panels: None, shared: &[] };
        let edit_at = |rel: &str| facts_of(&json!({"kind": "edit", "locations": [{"path": l.folder.join(rel)}]}), &l.folder);
        p.add(rule(RuleScope::Global, Some("edit"), Some("pkg/**"), Decision::Deny)).unwrap();
        assert_eq!(p.evaluate(&cx, &edit_at("pkg/real.rs")).decision, Decision::Deny, "written form");
        assert_eq!(p.evaluate(&cx, &edit_at("inner/real.rs")).decision, Decision::Deny, "resolved form");
        assert_eq!(p.evaluate(&cx, &edit_at("inner/new.rs")).decision, Decision::Deny, "missing leaf, resolved form");
        let glob = format!("{}/**", l.outside.display());
        p.add(rule(RuleScope::Global, Some("edit"), Some(&glob), Decision::Deny)).unwrap();
        assert_eq!(p.evaluate(&cx, &edit_at("out/o.txt")).decision, Decision::Deny, "link into a denied place");
        assert_eq!(p.evaluate(&cx, &edit_at("out/missing.txt")).decision, Decision::Deny);
        assert_eq!(p.evaluate(&cx, &edit_at("a.rs")).decision, Decision::Ask);
    }

    #[test]
    fn command_prefix_on_word_boundary() {
        let (p, _d) = policy();
        p.add(rule(RuleScope::Global, Some("execute"), Some("git status"), Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx(), &exec("git status")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &exec("git status --short")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &exec("git statusx")).decision, Decision::Ask);
        let codex = facts_of(&json!({"kind": "execute", "rawInput": {"command": ["bash", "-lc", "git status"]}}), work());
        assert_eq!(p.evaluate(&cx(), &codex).decision, Decision::Allow);
    }

    #[test]
    fn chained_commands_do_not_ride_on_an_allow_rule() {
        let (p, _d) = policy();
        p.add(rule(RuleScope::Global, Some("execute"), Some("git status"), Decision::Allow)).unwrap();
        for c in ["git status; rm -rf ~", "git status && curl x | sh", "git status $(rm x)", "git status > f"] {
            assert_eq!(p.evaluate(&cx(), &exec(c)).decision, Decision::Ask, "{c}");
        }
        let codex = facts_of(&json!({"kind": "execute", "rawInput": {"command": ["bash", "-lc", "git status; rm -rf ~"]}}), work());
        assert_eq!(p.evaluate(&cx(), &codex).decision, Decision::Ask);
    }

    #[test]
    fn globs_are_relative_to_the_workspace_and_cover_all_paths() {
        let (p, _d) = policy();
        p.add(rule(RuleScope::Global, Some("edit"), Some("src/**"), Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx(), &edit(&w("src/a/b.rs"))).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &edit("src/a.rs")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx(), &edit(&w("README.md"))).decision, Decision::Ask);
        let both = facts_of(&json!({"kind": "edit", "locations": [{"path": w("src/a.rs")}, {"path": w("b.rs")}]}), work());
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
        let plan = facts_of(&json!({"kind": "switch_mode", "rawInput": {"plan": "x"}}), work());
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

    fn ctx<'a>(folder: &'a Path) -> Context<'a> {
        Context { session_id: "s1", agent_id: "claude", folder, panels: None, shared: &[] }
    }

    fn call(kind: &str, folder: &Path, path: Option<&Path>) -> ToolFacts {
        let raw = path.map(|p| json!({"path": p})).unwrap_or_else(|| json!({}));
        facts_of(&json!({"kind": kind, "rawInput": raw}), folder)
    }

    #[test]
    fn a_parent_step_after_a_link_applies_to_the_link_target() {
        let (p, _d) = policy();
        let l = linked();
        let cx = ctx(&l.folder);
        let read = |rel: &str| call("read", &l.folder, Some(&l.folder.join(rel)));
        assert_eq!(p.evaluate(&cx, &read("out/../a.rs")).decision, Decision::Ask, "a step up from a link that leaves");
        assert_eq!(p.evaluate(&cx, &read("inner/../a.rs")).decision, Decision::Allow, "a step up from a link that stays");
        assert_eq!(p.evaluate(&cx, &read("pkg/../a.rs")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx, &read("missing/../a.rs")).decision, Decision::Ask, "a step up from a missing name");
        assert_eq!(p.evaluate(&cx, &read("../work/a.rs")).decision, Decision::Allow);
        p.add(rule(RuleScope::Global, Some("read"), Some("a.rs"), Decision::Deny)).unwrap();
        assert_eq!(p.evaluate(&cx, &read("out/../a.rs")).decision, Decision::Deny, "a deny sees the lexical form too");
    }

    #[test]
    fn home_paths_are_not_inside_the_folder() {
        let (p, _d) = policy();
        let l = linked();
        let cx = ctx(&l.folder);
        for path in ["~/x", "~", "~someone/x"] {
            let facts = facts_of(&json!({"kind": "read", "rawInput": {"file_path": path}}), &l.folder);
            assert_eq!(p.evaluate(&cx, &facts).decision, Decision::Ask, "{path}");
            assert!(!facts.paths[0].starts_with(&l.folder), "{path} is not joined to the folder");
        }
    }

    #[test]
    fn a_read_that_names_no_path_asks_and_a_search_without_one_covers_the_folder() {
        let (p, _d) = policy();
        let l = linked();
        let cx = ctx(&l.folder);
        assert_eq!(p.evaluate(&cx, &call("read", &l.folder, None)).decision, Decision::Ask);
        assert_eq!(p.evaluate(&cx, &call("search", &l.folder, None)).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx, &call("search", &l.folder, Some(&l.folder.join("pkg")))).decision, Decision::Allow, "a directory");
        assert_eq!(p.evaluate(&cx, &call("search", &l.folder, Some(&l.folder.join("out")))).decision, Decision::Ask);
        assert_eq!(p.evaluate(&cx, &call("search", &l.folder, Some(&l.outside))).decision, Decision::Ask);
        assert_eq!(p.evaluate(&cx, &call("think", &l.folder, None)).decision, Decision::Allow, "kinds without paths stay allowed");
    }

    #[test]
    fn relative_paths_are_taken_from_the_folder() {
        let (p, _d) = policy();
        let l = linked();
        let cx = ctx(&l.folder);
        for (rel, want) in
            [("pkg/real.rs", Decision::Allow), ("inner/real.rs", Decision::Allow), ("out/o.txt", Decision::Ask), ("../elsewhere/o.txt", Decision::Ask)]
        {
            let facts = facts_of(&json!({"kind": "read", "rawInput": {"file_path": rel}}), &l.folder);
            assert_eq!(p.evaluate(&cx, &facts).decision, want, "{rel}");
        }
    }

    #[test]
    fn the_folder_may_be_reached_through_a_link_and_reported_in_either_form() {
        let (p, _d) = policy();
        let l = linked();
        let via = l.folder.parent().unwrap().join("via");
        std::os::unix::fs::symlink(&l.folder, &via).unwrap();
        p.add(rule(RuleScope::Global, Some("edit"), Some("pkg/**"), Decision::Allow)).unwrap();
        for folder in [&via, &l.folder] {
            let cx = ctx(folder);
            for base in [&via, &l.folder] {
                assert_eq!(p.evaluate(&cx, &call("read", folder, Some(&base.join("a.rs")))).decision, Decision::Allow);
                assert_eq!(p.evaluate(&cx, &call("read", folder, Some(&base.join("o.link")))).decision, Decision::Ask);
                assert_eq!(p.evaluate(&cx, &call("edit", folder, Some(&base.join("pkg/new.rs")))).decision, Decision::Allow, "an Allow rule, either spelling");
                assert_eq!(p.evaluate(&cx, &call("edit", folder, Some(&base.join("a.rs")))).decision, Decision::Ask);
            }
        }
    }

    #[test]
    fn a_removed_folder_has_no_inside() {
        let (p, _d) = policy();
        let l = linked();
        let cx = ctx(&l.folder);
        let (read, folder) = (call("read", &l.folder, Some(&l.folder.join("a.rs"))), l.folder.clone());
        assert_eq!(p.evaluate(&cx, &read).decision, Decision::Allow);
        std::fs::remove_dir_all(&folder).unwrap();
        assert_eq!(p.evaluate(&cx, &read).decision, Decision::Ask);
        p.add(rule(RuleScope::Global, Some("read"), Some("**"), Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx, &read).decision, Decision::Ask, "an Allow rule cannot place a path in a folder that is gone");
    }

    #[test]
    fn a_link_loop_is_outside() {
        let (p, _d) = policy();
        let l = linked();
        std::os::unix::fs::symlink(l.folder.join("loop2"), l.folder.join("loop1")).unwrap();
        std::os::unix::fs::symlink(l.folder.join("loop1"), l.folder.join("loop2")).unwrap();
        let cx = ctx(&l.folder);
        assert_eq!(p.evaluate(&cx, &call("read", &l.folder, Some(&l.folder.join("loop1/x")))).decision, Decision::Ask);
    }

    #[test]
    fn an_allow_rule_for_a_place_outside_the_folder_follows_the_resolved_location() {
        let (p, _d) = policy();
        let l = linked();
        let base = l.folder.parent().unwrap();
        let granted = base.join("granted");
        std::fs::create_dir_all(&granted).unwrap();
        std::fs::write(granted.join("f.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&l.outside, granted.join("leak")).unwrap();
        std::os::unix::fs::symlink(&granted, base.join("lnk")).unwrap();
        std::os::unix::fs::symlink(&l.outside, base.join("lnk2")).unwrap();
        p.add(rule(RuleScope::Global, Some("edit"), Some(&format!("{}/**", granted.display())), Decision::Allow)).unwrap();
        let cx = ctx(&l.folder);
        let edit_at = |path: PathBuf| call("edit", &l.folder, Some(&path));
        assert_eq!(p.evaluate(&cx, &edit_at(granted.join("f.txt"))).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx, &edit_at(granted.join("new/f.txt"))).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx, &edit_at(granted.join("leak/o.txt"))).decision, Decision::Ask, "a link in the granted place that leaves it");
        assert_eq!(p.evaluate(&cx, &edit_at(base.join("lnk2/o.txt"))).decision, Decision::Ask, "a link elsewhere into a place outside the grant");
        assert_eq!(p.evaluate(&cx, &edit_at(l.folder.join("out/o.txt"))).decision, Decision::Ask);
    }

    #[test]
    fn an_allow_rule_inside_the_folder_does_not_cover_a_link_target_outside_its_glob() {
        let (p, _d) = policy();
        let l = linked();
        std::fs::create_dir_all(l.folder.join("src")).unwrap();
        std::fs::create_dir_all(l.folder.join("docs")).unwrap();
        std::os::unix::fs::symlink(l.folder.join("src"), l.folder.join("docs/to_src")).unwrap();
        p.add(rule(RuleScope::Global, Some("edit"), Some("docs/**"), Decision::Allow)).unwrap();
        let cx = ctx(&l.folder);
        let edit_at = |rel: &str| call("edit", &l.folder, Some(&l.folder.join(rel)));
        assert_eq!(p.evaluate(&cx, &edit_at("docs/a.md")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx, &edit_at("docs/to_src/a.rs")).decision, Decision::Ask);
        assert_eq!(p.evaluate(&cx, &edit_at("src/a.rs")).decision, Decision::Ask);
    }

    #[test]
    fn a_deny_rule_with_an_absolute_glob_matches_through_a_linked_prefix() {
        let (p, _d) = policy();
        let l = linked();
        let base = l.folder.parent().unwrap();
        std::fs::create_dir_all(base.join("secret")).unwrap();
        std::os::unix::fs::symlink(base.join("secret"), base.join("shortcut")).unwrap();
        p.add(rule(RuleScope::Global, Some("read"), Some(&format!("{}/shortcut/**", base.display())), Decision::Deny)).unwrap();
        let cx = ctx(&l.folder);
        let read_at = |path: PathBuf| call("read", &l.folder, Some(&path));
        assert_eq!(p.evaluate(&cx, &read_at(base.join("shortcut/x"))).decision, Decision::Deny);
        assert_eq!(p.evaluate(&cx, &read_at(base.join("secret/x"))).decision, Decision::Deny, "the resolved form of the same place");
        assert_eq!(p.evaluate(&cx, &read_at(l.folder.join("a.rs"))).decision, Decision::Allow);
    }

    #[test]
    fn a_deny_or_ask_rule_matches_when_any_path_matches_and_an_allow_needs_all() {
        let (p, _d) = policy();
        let l = linked();
        std::fs::create_dir_all(l.folder.join("secrets")).unwrap();
        std::fs::create_dir_all(l.folder.join("src")).unwrap();
        let cx = ctx(&l.folder);
        let two =
            |a: &str, b: &str| facts_of(&json!({"kind": "edit", "locations": [{"path": l.folder.join(a)}], "rawInput": {"path": l.folder.join(b)}}), &l.folder);
        p.add(rule(RuleScope::Global, Some("edit"), None, Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx, &two("src/a.rs", "secrets/k")).decision, Decision::Allow, "no narrower rule yet");
        let deny = p.add(rule(RuleScope::Global, Some("edit"), Some("secrets/**"), Decision::Deny)).unwrap();
        for (a, b) in [("src/a.rs", "secrets/k"), ("secrets/k", "src/a.rs"), ("secrets/k", "secrets/j")] {
            let v = p.evaluate(&cx, &two(a, b));
            assert_eq!((v.decision, v.rule_id), (Decision::Deny, Some(deny.id.clone())), "{a} {b}");
        }
        assert_eq!(p.evaluate(&cx, &two("src/a.rs", "src/b.rs")).decision, Decision::Allow);
        // An Ask rule behaves the same; an Allow rule with a pattern needs every path.
        let (p, _d) = policy();
        p.add(rule(RuleScope::Global, Some("edit"), Some("src/**"), Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx, &two("src/a.rs", "src/b.rs")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx, &two("src/a.rs", "secrets/k")).decision, Decision::Ask);
        p.add(rule(RuleScope::Global, Some("edit"), Some("src/b.rs"), Decision::Ask)).unwrap();
        assert_eq!(p.evaluate(&cx, &two("src/a.rs", "src/b.rs")).decision, Decision::Ask);
        // Equal specificity: the stricter decision wins, as before.
        p.add(rule(RuleScope::Global, Some("edit"), Some("**"), Decision::Allow)).unwrap();
        p.add(rule(RuleScope::Global, Some("edit"), Some("secrets/**"), Decision::Deny)).unwrap();
        assert_eq!(p.evaluate(&cx, &two("src/a.rs", "secrets/k")).decision, Decision::Deny);
    }

    #[test]
    fn deny_and_ask_rules_ignore_letter_case_where_the_volume_does() {
        let (p, _d) = policy();
        let l = linked();
        let cx = ctx(&l.folder);
        p.add(rule(RuleScope::Global, Some("edit"), Some("secrets/**"), Decision::Deny)).unwrap();
        p.add(rule(RuleScope::Global, Some("read"), Some("**/.env"), Decision::Deny)).unwrap();
        let denied = cfg!(any(target_os = "macos", target_os = "windows"));
        let edit_at = |rel: &str| call("edit", &l.folder, Some(&l.folder.join(rel)));
        let read_at = |rel: &str| call("read", &l.folder, Some(&l.folder.join(rel)));
        assert_eq!(p.evaluate(&cx, &edit_at("secrets/k")).decision, Decision::Deny);
        assert_eq!(p.evaluate(&cx, &edit_at("Secrets/k")).decision == Decision::Deny, denied);
        assert_eq!(p.evaluate(&cx, &read_at("pkg/.ENV")).decision == Decision::Deny, denied);
        // An Allow rule stays exact.
        p.add(rule(RuleScope::Global, Some("edit"), Some("src/**"), Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx, &edit_at("src/a.rs")).decision, Decision::Allow);
        assert_eq!(p.evaluate(&cx, &edit_at("SRC/a.rs")).decision, Decision::Ask);
    }

    #[test]
    fn wildcard_characters_in_the_folder_name_are_literal() {
        let (p, _d) = policy();
        let d = tempfile::tempdir().unwrap();
        let base = d.path().canonicalize().unwrap();
        for name in ["W[1]", "W{a}", "W*"] {
            let folder = base.join(name);
            std::fs::create_dir_all(folder.join("secrets")).unwrap();
            std::fs::create_dir_all(base.join("W1")).unwrap();
            std::fs::create_dir_all(base.join("Wa")).unwrap();
            let cx = ctx(&folder);
            let (sp, _s) = policy();
            sp.add(rule(RuleScope::Global, Some("edit"), Some("secrets/**"), Decision::Deny)).unwrap();
            assert_eq!(sp.evaluate(&cx, &call("edit", &folder, Some(&folder.join("secrets/k")))).decision, Decision::Deny, "{name}");
            let (ap, _a) = policy();
            ap.add(rule(RuleScope::Global, Some("edit"), Some("**"), Decision::Allow)).unwrap();
            assert_eq!(ap.evaluate(&cx, &call("edit", &folder, Some(&folder.join("a.rs")))).decision, Decision::Allow, "{name}");
            for sibling in ["W1", "Wa", "Wb"] {
                assert_eq!(ap.evaluate(&cx, &call("edit", &folder, Some(&base.join(sibling).join("a.rs")))).decision, Decision::Ask, "{name} vs {sibling}");
            }
        }
        drop(p);
    }

    #[test]
    fn a_deny_rule_naming_a_file_also_covers_the_target_of_a_link() {
        let (p, _d) = policy();
        let l = linked();
        std::fs::create_dir_all(l.folder.join("docs")).unwrap();
        std::fs::write(l.folder.join("pkg/real.md"), "x").unwrap();
        std::os::unix::fs::symlink(l.folder.join("pkg/real.md"), l.folder.join("docs/link.md")).unwrap();
        p.add(rule(RuleScope::Global, Some("read"), Some("docs/link.md"), Decision::Deny)).unwrap();
        let cx = ctx(&l.folder);
        let read_at = |rel: &str| call("read", &l.folder, Some(&l.folder.join(rel)));
        assert_eq!(p.evaluate(&cx, &read_at("docs/link.md")).decision, Decision::Deny);
        assert_eq!(p.evaluate(&cx, &read_at("pkg/real.md")).decision, Decision::Deny, "the target");
        assert_eq!(p.evaluate(&cx, &read_at("pkg/real.rs")).decision, Decision::Allow);
    }

    #[test]
    fn an_outside_file_always_asks() {
        let (p, _d) = policy();
        let l = linked();
        let cx = ctx(&l.folder);
        let file = || call(crate::acp::OUTSIDE_FILE_KIND, &l.folder, Some(&l.outside.join("o.txt")));
        assert_eq!(p.evaluate(&cx, &file()).decision, Decision::Ask);
        p.add(rule(RuleScope::Global, None, None, Decision::Allow)).unwrap();
        p.add(rule(RuleScope::Global, Some(crate::acp::OUTSIDE_FILE_KIND), None, Decision::Allow)).unwrap();
        p.add(rule(RuleScope::Global, None, Some("**"), Decision::Allow)).unwrap();
        assert_eq!(p.evaluate(&cx, &file()).decision, Decision::Ask, "no Allow rule applies");
        p.add(rule(RuleScope::Global, Some(crate::acp::OUTSIDE_FILE_KIND), None, Decision::Deny)).unwrap();
        assert_eq!(p.evaluate(&cx, &file()).decision, Decision::Deny, "a Deny still does");
    }

    #[test]
    fn a_search_whose_pattern_leaves_the_folder_is_judged_by_where_it_starts() {
        let (p, _d) = policy();
        let l = linked();
        let cx = ctx(&l.folder);
        let search = |pattern: &str| facts_of(&json!({"kind": "search", "rawInput": {"pattern": pattern}}), &l.folder);
        for (pattern, want) in [
            ("/etc/**", Decision::Ask),
            ("/etc/passwd", Decision::Ask),
            ("../elsewhere/*.txt", Decision::Ask),
            ("..", Decision::Ask),
            ("~/x/**", Decision::Ask),
            ("TODO", Decision::Allow),
            ("src/**/*.rs", Decision::Allow),
            (&format!("{}/pkg/**", l.folder.display()), Decision::Allow),
        ] {
            assert_eq!(p.evaluate(&cx, &search(pattern)).decision, want, "{pattern}");
        }
    }
}
