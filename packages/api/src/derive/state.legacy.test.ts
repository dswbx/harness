import { describe, expect, it } from "vitest";
import type { StatePatchOp } from "../generated";
import { applyStatePatch } from "./state";

// Differential test: the structural-sharing `applyStatePatch` against the previous
// clone-everything implementation (kept below as the oracle), plus sharing and purity checks.

const deepFreeze = <T>(x: T): T => {
   if (x === null || typeof x !== "object" || Object.isFrozen(x)) return x;
   Object.freeze(x);
   for (const v of Object.values(x)) deepFreeze(v);
   return x;
};

const run = (f: () => unknown): { ok: unknown } | { err: string } => {
   try {
      return { ok: f() };
   } catch (e) {
      return { err: (e as Error).message };
   }
};

// xorshift: deterministic fuzz
let seed = 12345;
const rnd = (n: number) => {
   seed ^= seed << 13;
   seed ^= seed >>> 17;
   seed ^= seed << 5;
   return (seed >>> 0) % n;
};
const pick = <T>(xs: T[]): T => xs[rnd(xs.length)]!;
const KEYS = ["a", "b", "c", "0", "1", "-", "", "a~1b"];
const VALUES: unknown[] = [1, "x", null, true, [], {}, [1, 2], { a: 1, b: [0] }];
const randPath = () => {
   const n = rnd(4);
   return n === 0 && rnd(5) === 0
      ? ""
      : Array.from({ length: n + 1 }, () => `/${pick(KEYS)}`).join("");
};
const randDoc = (d = 0): unknown => {
   const r = rnd(6);
   if (d > 2 || r === 0) return pick<unknown>([1, "s", null, true]);
   if (r < 3) return Array.from({ length: rnd(3) }, () => randDoc(d + 1));
   return Object.fromEntries(
      Array.from({ length: rnd(3) }, () => [pick(["a", "b", "c", "0"]), randDoc(d + 1)]),
   );
};
const randOp = (): StatePatchOp =>
   pick(["add", "replace", "remove", "test"] as const) === "remove"
      ? { op: "remove", path: randPath() }
      : ({
           op: pick(["add", "replace", "test"]),
           path: randPath(),
           value: pick(VALUES),
        } as StatePatchOp);

describe("applyStatePatch vs the clone-everything oracle", () => {
   it("agrees on results and errors over 20k random patches, never mutating the input", () => {
      for (let i = 0; i < 20_000; i++) {
         const doc = randDoc();
         const ops = Array.from({ length: 1 + rnd(3) }, randOp);
         const expected = run(() => legacyApply(structuredClone(doc), ops));
         const frozen = deepFreeze(structuredClone(doc));
         const got = run(() => applyStatePatch(frozen, ops));
         expect(got, JSON.stringify({ doc, ops })).toEqual(expected);
         expect(frozen).toEqual(doc);
      }
   });
});

describe("applyStatePatch structural sharing", () => {
   const doc = deepFreeze({
      big: { x: [1, 2, 3], y: { z: 1 } },
      other: { list: [{ id: 1 }, { id: 2 }] },
      n: 1,
   }) as {
      big: { x: number[]; y: { z: number } };
      other: { list: { id: number }[] };
      n: number;
   };

   it("copies only the path of an op", () => {
      const next = applyStatePatch(doc, [
         { op: "replace", path: "/big/y/z", value: 2 },
      ]) as typeof doc;
      expect(next).not.toBe(doc);
      expect(next.big).not.toBe(doc.big);
      expect(next.big.y).not.toBe(doc.big.y);
      expect(next.big.y.z).toBe(2);
      expect(next.big.x).toBe(doc.big.x);
      expect(next.other).toBe(doc.other);
   });

   it("array ops copy the array and keep its untouched items", () => {
      const next = applyStatePatch(doc, [
         { op: "add", path: "/other/list/-", value: { id: 3 } },
      ]) as typeof doc;
      expect(next.other.list).toHaveLength(3);
      expect(next.other.list[0]).toBe(doc.other.list[0]);
      expect(next.big).toBe(doc.big);
      const rm = applyStatePatch(doc, [{ op: "remove", path: "/other/list/0" }]) as typeof doc;
      expect(rm.other.list[0]).toBe(doc.other.list[1]);
      expect(doc.other.list).toHaveLength(2);
   });

   it("a no-op remove and a passing test keep the whole document", () => {
      expect(applyStatePatch(doc, [{ op: "remove", path: "/nope/x" }])).toBe(doc);
      expect(applyStatePatch(doc, [{ op: "test", path: "/n", value: 1 }])).toBe(doc);
      expect(applyStatePatch(doc, [])).toBe(doc);
   });

   it("a failing op leaves the input untouched", () => {
      expect(() =>
         applyStatePatch(doc, [
            { op: "replace", path: "/big/y/z", value: 9 },
            { op: "test", path: "/n", value: 2 },
         ]),
      ).toThrow("test failed");
      expect(doc.big.y.z).toBe(1);
   });
});

// ---- the previous implementation (oracle) ----

/**
 * Session State (ADR 0015): applies `ops` to `doc` and returns the new document (all or nothing;
 * throws on failure). Mirrors `apply` (and `set`, `remove`, `tokens`) in `crates/harness-core/src/state.rs`; change them together. Same lenient JSON Patch rules: `add`/`replace`
 * create missing parent objects, `replace` at an array's length appends, `-` appends, `remove` of a
 * missing path does nothing. UI writes use `replace` (an `add` at an array index inserts).
 */
export function legacyApply(doc: unknown, ops: StatePatchOp[]): unknown {
   let out: unknown = structuredClone(doc ?? {});
   for (const op of ops) {
      if (op.op === "test") {
         const found = getAtL(out, op.path);
         if (!deepEqual(found, op.value)) throw new Error(`test failed at ${op.path}`);
      } else if (op.op === "remove") out = removeAt(out, op.path);
      else out = setAt(out, op.path, structuredClone(op.value), op.op === "add");
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
function getAtL(doc: unknown, path: string): unknown {
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
         if (!Number.isInteger(i) || i < 0 || i >= cur.length)
            throw new Error(`${path}: ${t} is not an index`);
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
         if (!Number.isInteger(i) || i < 0 || i > target.length)
            throw new Error(`${path}: index ${last} is out of range`);
         if (insert) target.splice(i, 0, value);
         else target[i] = value;
      }
   } else throw new Error(`${path}: the parent is not an object or array`);
   return root.v;
}

function removeAt(doc: unknown, path: string): unknown {
   const ts = tokens(path);
   if (ts.length === 0) return {};
   // (the previous code looked a top-level key's parent up at "/", i.e. the key "", so it never
   // removed top-level keys; the core does. The oracle is fixed to match the core.)
   const parent =
      ts.length === 1
         ? doc
         : getAtL(
              doc,
              "/" +
                 ts
                    .slice(0, -1)
                    .map((t) => t.replace(/~/g, "~0").replace(/\//g, "~1"))
                    .join("/"),
           );
   const last = ts.at(-1)!;
   if (Array.isArray(parent)) {
      const i = Number(last);
      if (Number.isInteger(i) && i >= 0 && i < parent.length) parent.splice(i, 1);
   } else if (isObj(parent)) delete parent[last];
   return doc;
}
