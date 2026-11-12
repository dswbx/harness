//! Session State (ADR 0015): one free JSON document per Session, kept in `state.json` in the
//! Session Directory. Agents (MCP tools), Frontends (`PatchState`) and bound UI change it only with
//! patches; each patch is logged as `StateChanged`, so any Frontend can rebuild it from the log.
//!
//! Patches are JSON Patch (RFC 6902) `add`, `replace`, `remove` and `test`, a little more lenient:
//! `add`/`replace` create missing parent objects and set missing keys; `replace` at an array's
//! length appends; `remove` of a missing path does nothing. `-` appends to an array. A patch
//! applies whole or not at all. UI writes use `replace` (an `add` at an array index inserts).
//! `@harness/api`'s `applyStatePatch` must match these rules.

use serde_json::{Map, Value};

use crate::api::StatePatchOp;

pub fn apply(doc: &Value, ops: &[StatePatchOp]) -> anyhow::Result<Value> {
    let mut out = doc.clone();
    for op in ops {
        match op {
            StatePatchOp::Add { path, value } => set(&mut out, path, value.clone(), true)?,
            StatePatchOp::Replace { path, value } => set(&mut out, path, value.clone(), false)?,
            StatePatchOp::Remove { path } => remove(&mut out, path)?,
            StatePatchOp::Test { path, value } => {
                let found = out.pointer(path);
                anyhow::ensure!(found == Some(value), "test failed at {path}: found {}", found.map_or("nothing".to_owned(), Value::to_string));
            }
        }
    }
    Ok(out)
}

/// `/a/b~1c` -> `["a", "b/c"]`.
fn tokens(path: &str) -> anyhow::Result<Vec<String>> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    anyhow::ensure!(path.starts_with('/'), "{path}: a path is empty or starts with /");
    Ok(path[1..].split('/').map(|t| t.replace("~1", "/").replace("~0", "~")).collect())
}

/// Sets `value` at `path`. `insert`: an array index inserts (`add`) instead of replacing.
fn set(doc: &mut Value, path: &str, value: Value, insert: bool) -> anyhow::Result<()> {
    let tokens = tokens(path)?;
    let Some((last, parents)) = tokens.split_last() else {
        *doc = value;
        return Ok(());
    };
    let mut cur = doc;
    for t in parents {
        if cur.is_null() {
            *cur = Value::Object(Map::new());
        }
        cur = match cur {
            Value::Object(o) => o.entry(t.clone()).or_insert(Value::Null),
            Value::Array(a) => {
                let i = index(t, a.len())?;
                &mut a[i]
            }
            _ => anyhow::bail!("{path}: {t} is inside a value that is not an object or array"),
        };
    }
    if cur.is_null() {
        *cur = Value::Object(Map::new());
    }
    match cur {
        Value::Object(o) => {
            o.insert(last.clone(), value);
        }
        Value::Array(a) if last == "-" => a.push(value),
        Value::Array(a) => {
            let i: usize = last.parse().map_err(|_| anyhow::anyhow!("{path}: {last} is not an array index"))?;
            anyhow::ensure!(i <= a.len(), "{path}: index {i} is out of range");
            if insert {
                a.insert(i, value)
            } else if i == a.len() {
                a.push(value)
            } else {
                a[i] = value
            }
        }
        _ => anyhow::bail!("{path}: the parent is not an object or array"),
    }
    Ok(())
}

fn remove(doc: &mut Value, path: &str) -> anyhow::Result<()> {
    let tokens = tokens(path)?;
    let Some((last, parents)) = tokens.split_last() else {
        *doc = Value::Object(Map::new());
        return Ok(());
    };
    let mut cur = doc;
    for t in parents {
        cur = match cur {
            Value::Object(o) => match o.get_mut(t) {
                Some(v) => v,
                None => return Ok(()),
            },
            Value::Array(a) => match t.parse::<usize>().ok().filter(|i| *i < a.len()) {
                Some(i) => &mut a[i],
                None => return Ok(()),
            },
            _ => return Ok(()),
        };
    }
    match cur {
        Value::Object(o) => {
            o.remove(last);
        }
        Value::Array(a) => {
            if let Some(i) = last.parse::<usize>().ok().filter(|i| *i < a.len()) {
                a.remove(i);
            }
        }
        _ => {}
    }
    Ok(())
}

/// The Session State paths a `render_ui` input reads or writes: `$state`, `$bindState`, `statePath`
/// (Accordion/Tabs `repeat` and action targets) and `${/path}` in `$template`. `$computed` args
/// are ordinary `$state` values. In order first seen, no duplicates.
pub fn bound_paths(v: &Value) -> Vec<String> {
    fn add(out: &mut Vec<String>, p: &str) {
        if p.starts_with('/') && !out.iter().any(|o| o == p) {
            out.push(p.to_owned());
        }
    }
    fn walk(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Object(o) => {
                for (k, v) in o {
                    match (k.as_str(), v) {
                        ("$state" | "$bindState" | "statePath", Value::String(p)) => add(out, p),
                        ("$template", Value::String(t)) => {
                            let mut rest = t.as_str();
                            while let Some((_, after)) = rest.split_once("${") {
                                let Some((p, tail)) = after.split_once('}') else { break };
                                add(out, p);
                                rest = tail;
                            }
                        }
                        _ => {}
                    }
                    walk(v, out);
                }
            }
            Value::Array(a) => a.iter().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(v, &mut out);
    out
}

/// A copy of the values of `doc` at `paths` (missing ones left out), built with `add` ops.
pub fn subset(doc: &Value, paths: &[String]) -> anyhow::Result<Value> {
    let ops: Vec<StatePatchOp> = paths.iter().filter_map(|p| doc.pointer(p).map(|v| StatePatchOp::Add { path: p.clone(), value: v.clone() })).collect();
    apply(&Value::Object(Map::new()), &ops)
}

fn index(t: &str, len: usize) -> anyhow::Result<usize> {
    t.parse::<usize>().ok().filter(|i| *i < len).ok_or_else(|| anyhow::anyhow!("{t} is not an index of an array of {len}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use StatePatchOp::*;
    use serde_json::json;

    fn p(path: &str) -> String {
        path.to_owned()
    }

    #[test]
    fn lenient_json_patch() {
        let doc = json!({});
        let doc = apply(
            &doc,
            &[
                Add { path: p("/quiz/score"), value: json!(0) },
                Add { path: p("/quiz/answers"), value: json!([]) },
                Add { path: p("/quiz/answers/-"), value: json!("B") },
                Add { path: p("/quiz/answers/0"), value: json!("A") },
                Replace { path: p("/quiz/score"), value: json!(1) },
                Replace { path: p("/a~1b"), value: json!(true) },
            ],
        )
        .unwrap();
        assert_eq!(doc, json!({ "quiz": { "score": 1, "answers": ["A", "B"] }, "a/b": true }));
        let doc =
            apply(&doc, &[Remove { path: p("/quiz/answers/0") }, Remove { path: p("/missing/x") }, Test { path: p("/quiz/score"), value: json!(1) }]).unwrap();
        assert_eq!(doc["quiz"]["answers"], json!(["B"]));
        // All or nothing.
        let err = apply(&doc, &[Replace { path: p("/quiz/score"), value: json!(5) }, Test { path: p("/quiz/score"), value: json!(1) }]).unwrap_err();
        assert!(err.to_string().contains("test failed at /quiz/score"), "{err}");
        assert!(apply(&doc, &[Add { path: p("/quiz/score/x"), value: json!(1) }]).is_err());
        assert!(apply(&doc, &[Add { path: p("quiz"), value: json!(1) }]).is_err());
        assert!(apply(&doc, &[Replace { path: p("/quiz/answers/3"), value: json!(1) }]).is_err());
        // `replace` at an index sets it (or appends at the length); `add` inserts.
        let doc =
            apply(&json!({ "r": [null, null] }), &[Replace { path: p("/r/0"), value: json!(true) }, Replace { path: p("/r/2"), value: json!(false) }]).unwrap();
        assert_eq!(doc["r"], json!([true, null, false]));
    }

    #[test]
    fn bound_paths_and_subset() {
        let tree = json!({ "type": "Stack", "children": [
            { "type": "Stat", "props": { "value": { "$state": "/quiz/score" }, "label": { "$template": "${/n} of ${/total}" } } },
            { "type": "Choice", "props": { "value": { "$bindState": "/a/q1" } }, "on": { "press": { "action": "setState", "params": { "statePath": "/quiz/score" } } } }
        ] });
        let paths = bound_paths(&tree);
        assert_eq!(paths, vec!["/quiz/score", "/n", "/total", "/a/q1"]);
        let doc = json!({ "quiz": { "score": 3, "other": 1 }, "n": 1, "a": { "q1": "x" }, "unrelated": true });
        assert_eq!(subset(&doc, &paths).unwrap(), json!({ "quiz": { "score": 3 }, "n": 1, "a": { "q1": "x" } }));
    }
}
