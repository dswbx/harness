import { expect, test } from "vitest";
import {
   fileRefKey,
   lineLabel,
   parseFileRef,
   parseFileRefKey,
   refWindow,
   rehypeFileRefs,
} from "./fileRefs";

const ref = (path: string, start: number | null = null, end = start) => ({ path, start, end });

test("paths with lines and ranges", () => {
   expect(parseFileRef("crates/engine/src/lib.rs")).toEqual(ref("crates/engine/src/lib.rs"));
   expect(parseFileRef("src/a.ts:12")).toEqual(ref("src/a.ts", 12));
   expect(parseFileRef("src/a.ts:220-230")).toEqual(ref("src/a.ts", 220, 230));
   expect(parseFileRef("src/a.ts:220–230")).toEqual(ref("src/a.ts", 220, 230));
   expect(parseFileRef("src/a.ts:12:5")).toEqual(ref("src/a.ts", 12));
   expect(parseFileRef("src/a.ts#L12-L20")).toEqual(ref("src/a.ts", 12, 20));
   expect(parseFileRef("./src/a.ts")).toEqual(ref("./src/a.ts"));
   expect(parseFileRef("/Users/me/proj/a.rs:3")).toEqual(ref("/Users/me/proj/a.rs", 3));
   expect(parseFileRef("README.md")).toEqual(ref("README.md"));
   expect(parseFileRef("Makefile")).toEqual(ref("Makefile"));
   expect(parseFileRef("packages/@scope/x/index.tsx")).toEqual(ref("packages/@scope/x/index.tsx"));
   expect(parseFileRef("src/foo.weird")).toEqual(ref("src/foo.weird"));
});

test("trailing punctuation is ignored", () => {
   expect(parseFileRef("src/a.ts:12.")).toEqual(ref("src/a.ts", 12));
   expect(parseFileRef("src/a.ts,")).toEqual(ref("src/a.ts"));
   expect(parseFileRef("src/a.ts:12-20);")).toEqual(ref("src/a.ts", 12, 20));
   expect(parseFileRef("lib.rs:")).toEqual(ref("lib.rs"));
});

test("things that are not file refs", () => {
   for (const t of [
      "a.b",
      "auth.user.change",
      "foo()",
      "foo.bar()",
      "useAuth.update(x)",
      "https://example.com/a.ts",
      "http://localhost:3000/src/a.ts",
      "www.example.com",
      "example.com",
      "github.com/owner/repo",
      "owner/repo",
      "v1.2.3",
      "1.5",
      "src/",
      "..",
      "~/notes.md",
      "a b.ts",
      "src/*.ts",
      "{ a: 1 }",
      "x = 1",
      "src/a.ts:0",
      "src/a.ts:20-10",
      "",
   ]) {
      expect(parseFileRef(t), t).toBeNull();
   }
});

test("window, label and key", () => {
   expect(refWindow(ref("a.rs"))).toEqual({ from: 1, to: 11 });
   expect(refWindow(ref("a.rs", 3))).toEqual({ from: 1, to: 8 });
   expect(refWindow(ref("a.rs", 220, 230))).toEqual({ from: 215, to: 235 });
   expect(refWindow(ref("a.rs", 10, 500))).toEqual({ from: 5, to: 64 });
   expect(lineLabel(ref("a.rs", 220, 230))).toBe("L220–230");
   expect(lineLabel(ref("a.rs", 12))).toBe("L12");
   expect(lineLabel(ref("a.rs"))).toBeNull();
   for (const r of [ref("a:b.rs", 1, 2), ref("src/x.ts")])
      expect(parseFileRefKey(fileRefKey(r))).toEqual(r);
});

test("rehype plugin marks inline code and links, not code blocks or URLs", () => {
   type N = Parameters<ReturnType<typeof rehypeFileRefs>>[0];
   const text = (value: string): N => ({ type: "text", value });
   const el = (tagName: string, children: N[], properties: Record<string, unknown> = {}): N => ({
      type: "element",
      tagName,
      properties,
      children,
   });
   const inline = el("code", [text("src/a.ts:3")]);
   const plain = el("code", [text("foo()")]);
   const block = el("code", [text("src/a.ts")]);
   const link = el("a", [text("lib.rs")], { href: "crates/x/src/lib.rs#L4" });
   const url = el("a", [text("lib.rs")], { href: "https://github.com/o/r/blob/main/lib.rs" });
   const prefixed = el("code", [text("{:rust}src/a.rs")]);
   rehypeFileRefs()({
      type: "root",
      children: [el("p", [inline, plain, link, url, prefixed]), el("pre", [block])],
   });
   expect(inline.properties?.dataFileRef).toBe("3:3:src/a.ts");
   expect(link.properties?.dataFileRef).toBe("4:4:crates/x/src/lib.rs");
   for (const n of [plain, block, url, prefixed]) expect(n.properties?.dataFileRef).toBeUndefined();
});
