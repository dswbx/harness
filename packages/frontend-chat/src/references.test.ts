import type { PrEntry, PrInfo, PrRefKey, RepoId } from "@harness/api";
import { describe, expect, it } from "vitest";
import type { FileRef } from "./fileRefs";
import type { Item } from "./reducer";
import {
   byRecency,
   collectReferences,
   filterReferences,
   groupReferences,
   type Reference,
   resolveReferences,
} from "./references";

const repo: RepoId = { owner: "dswbx", name: "harness" };
const ctx = { sessionRepo: repo, knownRepos: [] };
const user = (id: string, text: string, ts = 0): Item => ({
   type: "user",
   id,
   text,
   ts,
   attachments: [],
   context: null,
});
const agent = (id: string, text: string, ts = 1): Item => ({ type: "agent", id, text, ts });
const pr = (r: RepoId, number: number, state: PrInfo["state"] = "merged"): PrInfo => ({
   repo: r,
   number,
   title: `PR ${number}`,
   author: "a",
   state,
   checks: "none",
   checks_passed: 0,
   checks_total: 0,
   additions: 1,
   deletions: 2,
   changed_files: 1,
   updated_at: "2026-11-04T00:00:00Z",
   url: `https://github.com/${r.owner}/${r.name}/pull/${number}`,
});
const lookups = (
   files: Record<string, string | null> = {},
   prs: Record<number, PrEntry> = {},
   changed: string[] = [],
) => ({
   pr: (k: PrRefKey) => prs[k.number] ?? null,
   file: (f: FileRef) =>
      f.path in files ? (files[f.path] === null ? null : { path: files[f.path]! }) : undefined,
   changed: new Set(changed),
});

describe("collectReferences", () => {
   it("finds the same refs as the chat: code, links, PRs, not in fences", () => {
      const c = collectReferences(
         [
            user("u1", "See `src/a.ts:12-20` and dswbx/harness#3, step #4."),
            agent(
               "a1",
               "[Docs](https://x.dev/docs) at https://y.dev/z.\n```\n`src/no.ts` dswbx/harness#9\n```\nhttps://github.com/dswbx/harness/pull/5 and [file](src/b.ts#L3)",
            ),
         ],
         ctx,
      );
      expect(c.map((x) => `${x.kind}:${x.key}`)).toEqual([
         "file:12:20:src/a.ts",
         "pr:dswbx/harness#3",
         "link:https://x.dev/docs",
         "link:https://y.dev/z",
         "pr:dswbx/harness#5",
         "file:3:3:src/b.ts",
      ]);
   });
   it("keeps Turn, who and a quote per mention, deduped by target", () => {
      const c = collectReferences(
         [
            user("u1", "Look at `a.ts`."),
            agent("a1", "Yes, `a.ts` is it."),
            user("u2", "`a.ts` again"),
         ],
         ctx,
      );
      expect(c).toHaveLength(1);
      expect(c[0]!.mentions.map((m) => [m.turn, m.who, m.rowId])).toEqual([
         [1, "you", "u1"],
         [1, "agent", "a1"],
         [2, "you", "u2"],
      ]);
      expect(c[0]!.mentions[1]).toMatchObject({ before: "Yes, ", hit: "a.ts", after: " is it." });
   });
   it("skips tool output, headings for PRs, images and {:lang} code", () => {
      const tool = { type: "thought", id: "t", text: "`a.ts`", ts: 0 } as Item;
      const c = collectReferences(
         [tool, agent("a1", "# dswbx/harness#1\n![i](https://x.dev/i.png)\n`{:ts} a.ts`")],
         ctx,
      );
      expect(c).toEqual([]);
   });
   it("a named link to a PR stays a link; trailing punctuation is not in the URL", () => {
      const c = collectReferences(
         [agent("a", "[the PR](https://github.com/dswbx/harness/pull/5), https://x.dev/a.")],
         ctx,
      );
      expect(c.map((x) => x.key)).toEqual([
         "https://github.com/dswbx/harness/pull/5",
         "https://x.dev/a",
      ]);
      expect(c[0]).toMatchObject({ kind: "link", title: "the PR" });
   });
});

describe("resolveReferences", () => {
   const c = (text: string) => collectReferences([agent("a", text)], ctx);
   it("lists only what exists; pending and missing stay hidden", () => {
      const { refs, prsUnavailable } = resolveReferences(
         c("`a.ts` `no.ts` `later.ts` dswbx/harness#1 dswbx/harness#2 dswbx/harness#3"),
         lookups(
            { "a.ts": "src/a.ts", "no.ts": null },
            {
               1: { status: "found", pr: pr(repo, 1) },
               2: { status: "missing" },
               3: { status: "loading" },
            },
         ),
      );
      expect(refs.map((r) => r.key)).toEqual(["src/a.ts", "dswbx/harness#1"]);
      expect(prsUnavailable).toBe(false);
   });
   it("reports PRs it can't check", () => {
      const noStore = resolveReferences(c("dswbx/harness#1"), lookups());
      expect(noStore).toEqual({ refs: [], prsUnavailable: true });
      const failed = resolveReferences(
         c("dswbx/harness#1"),
         lookups({}, { 1: { status: "unavailable" } }),
      );
      expect(failed.prsUnavailable).toBe(true);
   });
   it("merges a file's refs by real path, with sorted ranges and the changed mark", () => {
      const { refs } = resolveReferences(
         c("`a.ts:20` `src/a.ts:3-4` `a.ts:20`"),
         lookups({ "a.ts": "src/a.ts", "src/a.ts": "src/a.ts" }, {}, ["src/a.ts"]),
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({
         kind: "code",
         name: "a.ts",
         dir: "src",
         inside: true,
         changed: true,
      });
      const f = refs[0] as Extract<Reference, { kind: "code" }>;
      expect(f.ranges.map((r) => r.start)).toEqual([3, 20]);
      expect(f.mentions).toHaveLength(3);
   });
   it("keeps unreadable absolute paths as outside, unchecked", () => {
      const { refs } = resolveReferences(
         c("`/x/spark/w.ts` `/x/here/a.ts`"),
         lookups({ "/x/spark/w.ts": null, "/x/here/a.ts": "a.ts" }),
      );
      expect(refs.map((r) => [r.key, r.kind === "code" && r.inside])).toEqual([
         ["/x/spark/w.ts", false],
         ["a.ts", true],
      ]);
   });
});

describe("groupReferences", () => {
   const code = (path: string, inside = true): Reference => {
      const i = path.lastIndexOf("/");
      return {
         kind: "code",
         key: path,
         path,
         name: path.slice(i + 1),
         dir: i < 0 ? "." : path.slice(0, i),
         inside,
         ranges: [],
         changed: false,
         ts: 0,
         mentions: [],
      };
   };
   const prRef = (p: PrInfo, ts: number): Reference => ({
      kind: "pr",
      key: `${p.repo.name}#${p.number}`,
      pr: p,
      ts,
      mentions: [],
   });
   it("code: the Session's folder first, by folder; others after", () => {
      const s = groupReferences(
         [code("/x/spark/w.ts", false), code("src/b.ts"), code("docs/c.md"), code("src/a.ts")],
         "code",
         repo,
      );
      expect(s.map((x) => [x.title, x.tag, x.note])).toEqual([
         ["harness", "Session", ""],
         ["spark", null, "/x/spark"],
      ]);
      expect(s[0]!.dirs.map((d) => d.label)).toEqual(["docs", "src"]);
      expect(s[0]!.dirs[1]!.items.map((r) => r.key)).toEqual(["src/a.ts", "src/b.ts"]);
   });
   it("PRs: the Session's repo first, open ones first", () => {
      const other = { owner: "supabase", name: "spark" };
      const s = groupReferences(
         [prRef(pr(other, 9, "open"), 9), prRef(pr(repo, 1), 5), prRef(pr(repo, 2, "open"), 1)],
         "pr",
         repo,
      );
      expect(s.map((x) => [x.title, x.tag])).toEqual([
         ["dswbx/harness", "This repo"],
         ["supabase/spark", null],
      ]);
      expect(s[0]!.items.map((r) => r.kind === "pr" && r.pr.number)).toEqual([2, 1]);
   });
   it("links by site; list order is newest first; filter matches text", () => {
      const link = (url: string, ts: number): Reference => ({
         kind: "link",
         key: url,
         url,
         site: new URL(url).hostname,
         title: url,
         ts,
         mentions: [],
      });
      const refs = [
         link("https://a.dev/1", 1),
         link("https://b.dev/2", 3),
         link("https://a.dev/3", 2),
      ];
      expect(groupReferences(refs, "link", null).map((s) => [s.title, s.items.length])).toEqual([
         ["b.dev", 1],
         ["a.dev", 2],
      ]);
      expect(byRecency(refs).map((r) => r.ts)).toEqual([3, 2, 1]);
      expect(filterReferences(refs, " B.DEV ").map((r) => r.ts)).toEqual([3]);
   });
});
