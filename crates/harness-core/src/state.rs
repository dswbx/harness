//! Session State (ADR 0015): one free JSON document per Session, kept in `state.json` in the
//! Session Directory. Agents (MCP tools), Frontends (`PatchState`) and bound UI change it only with
//! patches; each patch is logged as `StateChanged`, so any Frontend can rebuild it from the log.
//!
//! Patches are JSON Patch (RFC 6902) `add`, `replace`, `remove` and `test`, a little more lenient:
//! `add`/`replace` create missing parent objects and set missing keys; `remove` of a missing path
//! does nothing. `-` appends to an array. A patch applies whole or not at all.
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
            anyhow::ensure!(i <= a.len() && (insert || i < a.len()), "{path}: index {i} is out of range");
            if insert { a.insert(i, value) } else { a[i] = value }
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

fn index(t: &str, len: usize) -> anyhow::Result<usize> {
    t.parse::<usize>().ok().filter(|i| *i < len).ok_or_else(|| anyhow::anyhow!("{t} is not an index of an array of {len}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use StatePatchOp::*;

    fn p(path: &str) -> String {
        path.to_owned()
    }

    #[test]
    fn lenient_json_patch() {
        let doc = json!({});
        let doc = apply(&doc, &[
            Add { path: p("/quiz/score"), value: json!(0) },
            Add { path: p("/quiz/answers"), value: json!([]) },
            Add { path: p("/quiz/answers/-"), value: json!("B") },
            Add { path: p("/quiz/answers/0"), value: json!("A") },
            Replace { path: p("/quiz/score"), value: json!(1) },
            Replace { path: p("/a~1b"), value: json!(true) },
        ])
        .unwrap();
        assert_eq!(doc, json!({ "quiz": { "score": 1, "answers": ["A", "B"] }, "a/b": true }));
        let doc = apply(&doc, &[Remove { path: p("/quiz/answers/0") }, Remove { path: p("/missing/x") }, Test { path: p("/quiz/score"), value: json!(1) }]).unwrap();
        assert_eq!(doc["quiz"]["answers"], json!(["B"]));
        // All or nothing.
        let err = apply(&doc, &[Replace { path: p("/quiz/score"), value: json!(5) }, Test { path: p("/quiz/score"), value: json!(1) }]).unwrap_err();
        assert!(err.to_string().contains("test failed at /quiz/score"), "{err}");
        assert!(apply(&doc, &[Add { path: p("/quiz/score/x"), value: json!(1) }]).is_err());
        assert!(apply(&doc, &[Add { path: p("quiz"), value: json!(1) }]).is_err());
        assert!(apply(&doc, &[Replace { path: p("/quiz/answers/3"), value: json!(1) }]).is_err());
    }
}
