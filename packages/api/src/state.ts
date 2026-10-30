import type { StatePatchOp } from "./generated";

/**
 * Session State (ADR 0015): applies `ops` to `doc` and returns the new document (all or nothing;
 * throws on failure). Same lenient JSON Patch rules as the core's `state.rs`: `add`/`replace`
 * create missing parent objects, `-` appends, `remove` of a missing path does nothing.
 */
export function applyStatePatch(doc: unknown, ops: StatePatchOp[]): unknown {
  let out: unknown = structuredClone(doc ?? {});
  for (const op of ops) {
    if (op.op === "test") {
      const found = getAt(out, op.path);
      if (JSON.stringify(found) !== JSON.stringify(op.value)) throw new Error(`test failed at ${op.path}`);
    } else if (op.op === "remove") out = removeAt(out, op.path);
    else out = setAt(out, op.path, structuredClone(op.value), op.op === "add");
  }
  return out;
}

function tokens(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`${path}: a path is empty or starts with /`);
  return path.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value at a JSON Pointer, or undefined. */
export function getAt(doc: unknown, path: string): unknown {
  let cur = doc;
  for (const t of tokens(path)) {
    if (Array.isArray(cur)) cur = cur[Number(t)];
    else if (isObj(cur)) cur = cur[t];
    else return undefined;
  }
  return cur;
}

function setAt(doc: unknown, path: string, value: unknown, insert: boolean): unknown {
  const ts = tokens(path);
  if (ts.length === 0) return value;
  const root = { v: doc } as Obj;
  let parent: Obj | unknown[] = root;
  let key: string | number = "v";
  for (const t of ts.slice(0, -1)) {
    let cur: unknown = (parent as Obj)[key as string];
    if (cur == null) cur = (parent as Obj)[key as string] = {};
    if (Array.isArray(cur)) {
      const i = Number(t);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) throw new Error(`${path}: ${t} is not an index`);
      parent = cur;
      key = i;
    } else if (isObj(cur)) {
      parent = cur;
      key = t;
    } else throw new Error(`${path}: ${t} is inside a value that is not an object or array`);
  }
  let target = (parent as Obj)[key as string];
  if (target == null) target = (parent as Obj)[key as string] = {};
  const last = ts.at(-1)!;
  if (isObj(target)) target[last] = value;
  else if (Array.isArray(target)) {
    if (last === "-") target.push(value);
    else {
      const i = Number(last);
      if (!Number.isInteger(i) || i < 0 || i > target.length || (!insert && i === target.length)) throw new Error(`${path}: index ${last} is out of range`);
      if (insert) target.splice(i, 0, value);
      else target[i] = value;
    }
  } else throw new Error(`${path}: the parent is not an object or array`);
  return root.v;
}

function removeAt(doc: unknown, path: string): unknown {
  const ts = tokens(path);
  if (ts.length === 0) return {};
  const parent = getAt(doc, "/" + ts.slice(0, -1).map((t) => t.replace(/~/g, "~0").replace(/\//g, "~1")).join("/"));
  const last = ts.at(-1)!;
  if (Array.isArray(parent)) {
    const i = Number(last);
    if (Number.isInteger(i) && i >= 0 && i < parent.length) parent.splice(i, 1);
  } else if (isObj(parent)) delete parent[last];
  return doc;
}
