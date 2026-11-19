//! The branch prefix setting (`<data dir>/branch_prefix.json`): what new Session branches start with.

use std::path::Path;

use crate::api::BranchPrefix;

const FILE: &str = "branch_prefix.json";
const DEFAULT: &str = "harness";

fn file(data_dir: &Path) -> crate::persist::JsonFile<BranchPrefix> {
    crate::persist::JsonFile::in_dir(data_dir, FILE)
}

/// The setting, else `Harness`.
pub fn branch_prefix(data_dir: &Path) -> BranchPrefix {
    file(data_dir).load_logged().unwrap_or_default()
}

/// None (or `Harness`) resets it. A Custom prefix is trimmed of spaces and slashes and must be a
/// valid branch name part.
pub fn set_branch_prefix(data_dir: &Path, prefix: Option<&BranchPrefix>) -> anyhow::Result<()> {
    match prefix {
        None | Some(BranchPrefix::Harness) => file(data_dir).remove(),
        Some(BranchPrefix::Custom { prefix }) => {
            let p = clean(prefix);
            if !p.is_empty() && !valid(p) {
                return Err(crate::error::invalid(format!("\"{p}\" is not a valid branch prefix")));
            }
            file(data_dir).save(&BranchPrefix::Custom { prefix: p.to_owned() })?;
        }
        Some(p) => file(data_dir).save(p)?,
    }
    Ok(())
}

/// The prefix the setting gives: `login` for `GithubUser` (`harness` without one), `""` for none.
pub fn resolve_branch_prefix(prefix: &BranchPrefix, login: Option<&str>) -> String {
    match prefix {
        BranchPrefix::Harness => DEFAULT.to_owned(),
        BranchPrefix::GithubUser => login.map(clean).filter(|l| valid(l)).unwrap_or(DEFAULT).to_owned(),
        BranchPrefix::Custom { prefix } => {
            let p = clean(prefix);
            if p.is_empty() || valid(p) { p.to_owned() } else { DEFAULT.to_owned() }
        }
    }
}

/// `<prefix>/<name>`, or `name` without a prefix.
pub fn prefixed(prefix: &str, name: &str) -> String {
    if prefix.is_empty() { name.to_owned() } else { format!("{prefix}/{name}") }
}

fn clean(p: &str) -> &str {
    p.trim().trim_matches('/')
}

/// A conservative subset of `git check-ref-format`: `[A-Za-z0-9._-]` parts split by `/`, none
/// empty, starting with `.` or `-`, or ending with `.lock` or `.`; no `..`.
fn valid(p: &str) -> bool {
    !p.contains("..")
        && p.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with(['.', '-'])
                && !part.ends_with('.')
                && !part.ends_with(".lock")
                && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_resets() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(branch_prefix(d.path()), BranchPrefix::Harness);
        set_branch_prefix(d.path(), Some(&BranchPrefix::Custom { prefix: " /me/wip/ ".into() })).unwrap();
        assert_eq!(branch_prefix(d.path()), BranchPrefix::Custom { prefix: "me/wip".into() });
        set_branch_prefix(d.path(), Some(&BranchPrefix::GithubUser)).unwrap();
        assert_eq!(branch_prefix(d.path()), BranchPrefix::GithubUser);
        set_branch_prefix(d.path(), Some(&BranchPrefix::Harness)).unwrap();
        assert!(!d.path().join(FILE).exists());
    }

    #[test]
    fn rejects_invalid_custom_prefixes() {
        let d = tempfile::tempdir().unwrap();
        for bad in ["a b", "a..b", ".a", "a//b", "a.lock", "x~", "-a"] {
            assert!(set_branch_prefix(d.path(), Some(&BranchPrefix::Custom { prefix: bad.into() })).is_err(), "{bad}");
        }
        set_branch_prefix(d.path(), Some(&BranchPrefix::Custom { prefix: "".into() })).unwrap();
        assert_eq!(branch_prefix(d.path()), BranchPrefix::Custom { prefix: "".into() });
    }

    #[test]
    fn resolves() {
        assert_eq!(resolve_branch_prefix(&BranchPrefix::Harness, Some("octo")), "harness");
        assert_eq!(resolve_branch_prefix(&BranchPrefix::GithubUser, Some("octo")), "octo");
        assert_eq!(resolve_branch_prefix(&BranchPrefix::GithubUser, None), "harness");
        assert_eq!(resolve_branch_prefix(&BranchPrefix::Custom { prefix: "".into() }, None), "");
        assert_eq!(resolve_branch_prefix(&BranchPrefix::Custom { prefix: "a b".into() }, None), "harness");
        assert_eq!(prefixed("", "x-1"), "x-1");
        assert_eq!(prefixed("me/wip", "x-1"), "me/wip/x-1");
    }
}
