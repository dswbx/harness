import { describe, expect, it } from "vitest";
import type { KnownRepo, RepoId } from "./generated";
import { displayRef, findPrRefs, fuzzyRank, parsePrRef, qualify, resolveRepo, type PrRefContext } from "./prRefs";

const repo = (full: string): RepoId => {
  const [owner, name] = full.split("/") as [string, string];
  return { owner, name };
};
const known = (full: string, score: number): KnownRepo => ({ repo: repo(full), sessions: 1, score, last_ms: 0 });
const ctx: PrRefContext = {
  sessionRepo: repo("dswbx/harness"),
  knownRepos: [known("dswbx/harness", 4.2), known("supabase/spark", 2.1), known("supabase/supabase", 1.1), known("supabase/lite", 0.6), known("dswbx/spikes", 0.1)],
};
const raws = (text: string, c = ctx) => findPrRefs(text, c).map((m) => m.raw);

describe("findPrRefs", () => {
  it("finds every syntax with its repo as typed", () => {
    const text = "see #23, spark#17 and supabase/spark#12 (https://github.com/supabase/spark/pull/9/files#diff-1)";
    expect(findPrRefs(text, ctx).map(({ repo, number }) => [repo, number])).toEqual([
      [null, 23], ["spark", 17], ["supabase/spark", 12], ["supabase/spark", 9],
    ]);
    const [m] = findPrRefs("x #23.", ctx);
    expect(m).toMatchObject({ start: 2, end: 5, raw: "#23" });
    expect(raws("https://github.com/o/r/pull/3")).toEqual(["https://github.com/o/r/pull/3"]);
  });

  it("needs a boundary on both sides", () => {
    expect(raws("#1 (#2) x#3 #4x #5.5 #6! [#7] #8/x")).toEqual(["#1", "#2", "#6"]);
    expect(raws("a\n#9")).toEqual(["#9"]);
  });

  it("keeps C#, words that are no known repo, and non-PR URLs as text", () => {
    expect(raws("a#3 har#3 C# hrns#3 spar#3")).toEqual([]);
    expect(raws("harness#3 spark#17")).toEqual(["harness#3", "spark#17"]);
    // Fuzzy is opt-in (prompt autocomplete).
    expect(findPrRefs("har#3", ctx, { fuzzy: true }).map((m) => m.raw)).toEqual(["har#3"]);
    expect(raws("C# and F#, issue#3, step#2 #0")).toEqual([]);
    expect(raws("https://example.com/page#23 https://github.com/o/r/issues/5 https://github.com/o/r#5 x.com/a#3")).toEqual([]);
    // Without context only explicit refs count.
    expect(raws("spark#17 #4 o/r#5", { sessionRepo: null, knownRepos: [] })).toEqual(["#4", "o/r#5"]);
  });
});

describe("resolveRepo", () => {
  const one = (t: string) => {
    const r = resolveRepo(t, ctx, { fuzzy: true });
    return r.kind === "one" ? `${r.repo.owner}/${r.repo.name}` : r.kind;
  };
  it("goes by tier: exact, prefix, substring, subsequence", () => {
    expect(one("spark")).toBe("supabase/spark");
    expect(one("Har")).toBe("dswbx/harness");
    expect(one("abase")).toBe("supabase/supabase");
    expect(one("hrns")).toBe("dswbx/harness");
    expect(one("supabase/lite")).toBe("supabase/lite");
    expect(one("zzz")).toBe("none");
  });
  it("breaks ties by score; close scores are ambiguous", () => {
    // spark 2.1, supabase 1.1, spikes 0.1: spark clearly leads.
    expect(one("s")).toBe("supabase/spark");
    const close = { ...ctx, knownRepos: [known("a/lite", 1), known("b/lite", 0.8), known("c/lite", 0.1)] };
    const r = resolveRepo("lite", close, { fuzzy: true });
    expect(r).toEqual({ kind: "ambiguous", repos: [repo("a/lite"), repo("b/lite"), repo("c/lite")] });
    expect(resolveRepo("lite", { ...close, knownRepos: [known("a/lite", 1), known("b/lite", 0.74)] }, { fuzzy: true })).toMatchObject({ kind: "one", repo: repo("a/lite") });
  });
  it("counts the Session repo when it is not known", () => {
    expect(resolveRepo("solo", { sessionRepo: repo("me/solo"), knownRepos: [] }, { fuzzy: true })).toEqual({ kind: "one", repo: repo("me/solo") });
  });
});

describe("resolveRepo strict (default)", () => {
  it("needs an exact, unique name", () => {
    expect(resolveRepo("harness", ctx)).toEqual({ kind: "one", repo: repo("dswbx/harness") });
    expect(resolveRepo("Spark", ctx)).toEqual({ kind: "one", repo: repo("supabase/spark") });
    expect(resolveRepo("supabase/lite", ctx)).toEqual({ kind: "one", repo: repo("supabase/lite") });
    for (const t of ["a", "har", "abase", "hrns", "zzz", "s"]) expect(resolveRepo(t, ctx).kind).toBe("none");
    expect(resolveRepo("me", { sessionRepo: repo("me/me"), knownRepos: [] })).toEqual({ kind: "one", repo: repo("me/me") });
  });
  it("is ambiguous when two known repos share the name", () => {
    const two = { ...ctx, knownRepos: [...ctx.knownRepos, known("me/spark", 0.5)] };
    expect(resolveRepo("spark", two).kind).toBe("ambiguous");
    expect(raws("spark#1", two)).toEqual([]);
    expect(qualify("spark#1", two)).toBeNull();
  });
});

describe("fuzzyRank", () => {
  it("returns tiers and matched positions", () => {
    expect(fuzzyRank("sk", ["spikes", "sk", "task", "skip"]).map((h) => [h.item, h.tier, h.positions])).toEqual([
      ["sk", 0, [0, 1]], ["skip", 1, [0, 1]], ["task", 2, [2, 3]], ["spikes", 3, [0, 3]],
    ]);
  });
});

describe("qualify and displayRef", () => {
  it("qualifies refs against the context", () => {
    expect(qualify("#23", ctx)).toEqual({ repo: repo("dswbx/harness"), number: 23 });
    expect(qualify("spark#17", ctx)).toEqual({ repo: repo("supabase/spark"), number: 17 });
    expect(qualify("Supabase/Spark#17", ctx)).toEqual({ repo: repo("supabase/spark"), number: 17 });
    expect(qualify("https://github.com/o/r/pull/3/files", ctx)).toEqual({ repo: repo("o/r"), number: 3 });
    expect(qualify("#23", { ...ctx, sessionRepo: null })).toBeNull();
    expect(qualify("nope#1", ctx)).toBeNull();
    expect(qualify("spar#17", ctx)).toBeNull();
    expect(qualify("spar#17", ctx, { fuzzy: true })).toEqual({ repo: repo("supabase/spark"), number: 17 });
    expect(qualify("#23 and more", ctx)).toBeNull();
  });
  it("shows #N for the Session repo, else the full name", () => {
    const k = (full: string, number: number) => ({ repo: repo(full), number });
    expect(displayRef(k("dswbx/harness", 17), ctx)).toBe("#17");
    expect(displayRef(k("supabase/spark", 17), ctx)).toBe("supabase/spark#17");
    expect(displayRef(k("other/elsewhere", 1), ctx)).toBe("other/elsewhere#1");
    const twoLites = { ...ctx, knownRepos: [...ctx.knownRepos, known("me/lite", 0.5)] };
    expect(displayRef(k("supabase/lite", 2), twoLites)).toBe("supabase/lite#2");
    // A shown `repo#N` resolves back to the same repo.
    expect(qualify(displayRef(k("supabase/spark", 17), ctx), ctx)).toEqual(k("supabase/spark", 17));
  });
});

it("parsePrRef reads a number, #number or PR URL", () => {
  expect(["142", "#7", " #8 ", "https://github.com/o/r/pull/31/files", "abc", "0", "#-1"].map(parsePrRef)).toEqual([142, 7, 8, 31, null, null, null]);
});
