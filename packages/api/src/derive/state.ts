import type { StatePatchOp } from "../generated";

/**
 * Session State (ADR 0015): applies `ops` to `doc` and returns the new document (all or nothing;
 * throws on failure). Mirrors `apply` (and `set`, `remove`, `tokens`) in `crates/harness-core/src/state.rs`; change them together. Same lenient JSON Patch rules: `add`/`replace`
 * create missing parent objects, `replace` at an array's length appends, `-` appends, `remove` of a
 * missing path does nothing. UI writes use `replace` (an `add` at an array index inserts).
 */
export function applyStatePatch(doc: unknown, ops: StatePatchOp[]): unknown {
   // Persistent updates: only the containers on an op's path are copied, the rest keeps identity,
   // and `doc` is never written. A throw leaves `doc` as it was. A container copied by an earlier
   // op of this call is ours (`fresh`) and later ops write into it instead of copying it again.
   const fresh = new WeakSet<object>();
   let out: unknown = doc ?? {};
   for (const op of ops) {
      if (op.op === "test") {
         const found = getAt(out, op.path);
         if (!deepEqual(found, op.value)) throw new Error(`test failed at ${op.path}`);
      } else if (op.op === "remove") out = removeAt(out, op.path, fresh);
      else out = setAt(out, op.path, op.value, op.op === "add", fresh);
   }
   return out;
}

/** JSON value equality: object key order is ignored, array order counts (as Rust's `Value ==`). */
function deepEqual(a: unknown, b: unknown): boolean {
   if (a === b) return true;
   if (Array.isArray(a))
      return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
   if (isObj(a) && isObj(b)) {
      const ka = Object.keys(a);
      return (
         ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]))
      );
   }
   return false;
}

function tokens(path: string): string[] {
   if (path === "") return [];
   if (!path.startsWith("/")) throw new Error(`${path}: a path is empty or starts with /`);
   return path
      .slice(1)
      .split("/")
      .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
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

type Fresh = WeakSet<object>;

/** A writable copy of `x` (or `x` itself when this call already copied it). */
function own<T extends Obj | unknown[]>(x: T, fresh: Fresh): T {
   if (fresh.has(x)) return x;
   let copy: T;
   if (Array.isArray(x)) copy = x.slice() as T;
   else {
      // A key loop is ~3x faster than `{ ...x }` on large objects.
      const o: Obj = {};
      for (const k of Object.keys(x)) {
         if (k === "__proto__")
            Object.defineProperty(o, k, {
               value: x[k],
               enumerable: true,
               writable: true,
               configurable: true,
            });
         else o[k] = (x as Obj)[k];
      }
      copy = o as T;
   }
   fresh.add(copy);
   return copy;
}

function setAt(doc: unknown, path: string, value: unknown, insert: boolean, fresh: Fresh): unknown {
   const ts = tokens(path);
   if (ts.length === 0) return value;
   return setIn(doc, ts, 0, path, value, insert, fresh);
}

/** `node` is the value at depth `i`; returns it with `ts[i..]` applied (a copy of what changed). */
function setIn(
   node: unknown,
   ts: string[],
   i: number,
   path: string,
   value: unknown,
   insert: boolean,
   fresh: Fresh,
): unknown {
   const t = ts[i]!;
   const last = i === ts.length - 1;
   const cur = node ?? {};
   if (Array.isArray(cur)) {
      const n = Number(t);
      if (last) {
         if (!Number.isInteger(n) && t !== "-")
            throw new Error(`${path}: index ${t} is out of range`);
         if (t !== "-" && (n < 0 || n > cur.length))
            throw new Error(`${path}: index ${t} is out of range`);
         const copy = own(cur, fresh);
         if (t === "-") copy.push(value);
         else if (insert) copy.splice(n, 0, value);
         else copy[n] = value;
         return copy;
      }
      if (!Number.isInteger(n) || n < 0 || n >= cur.length)
         throw new Error(`${path}: ${t} is not an index`);
      const child = setIn(cur[n], ts, i + 1, path, value, insert, fresh);
      const copy = own(cur, fresh);
      copy[n] = child;
      return copy;
   }
   if (isObj(cur)) {
      const child = last ? value : setIn(cur[t], ts, i + 1, path, value, insert, fresh);
      const copy = own(cur, fresh);
      if (t === "__proto__")
         Object.defineProperty(copy, t, {
            value: child,
            enumerable: true,
            writable: true,
            configurable: true,
         });
      else copy[t] = child;
      return copy;
   }
   throw new Error(
      last
         ? `${path}: the parent is not an object or array`
         : `${path}: ${t} is inside a value that is not an object or array`,
   );
}

function removeAt(doc: unknown, path: string, fresh: Fresh): unknown {
   const ts = tokens(path);
   if (ts.length === 0) return {};
   return removeIn(doc, ts, 0, fresh);
}

/** Returns `node` itself when nothing at the path exists to remove. */
function removeIn(node: unknown, ts: string[], i: number, fresh: Fresh): unknown {
   const t = ts[i]!;
   const last = i === ts.length - 1;
   if (Array.isArray(node)) {
      const n = Number(t);
      if (last) {
         if (!Number.isInteger(n) || n < 0 || n >= node.length) return node;
         const copy = own(node, fresh);
         copy.splice(n, 1);
         return copy;
      }
      const child = removeIn(node[n], ts, i + 1, fresh);
      if (child === node[n]) return node;
      const copy = own(node, fresh);
      copy[n] = child;
      return copy;
   }
   if (isObj(node)) {
      if (last) {
         if (!Object.hasOwn(node, t)) return node;
         const copy = own(node, fresh);
         delete copy[t];
         return copy;
      }
      const child = removeIn(node[t], ts, i + 1, fresh);
      if (child === node[t]) return node;
      const copy = own(node, fresh);
      copy[t] = child;
      return copy;
   }
   return node;
}
