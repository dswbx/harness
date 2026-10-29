import { describe, expect, it } from "vitest";
import type { Commit } from "@harness/api";
import { ALL, ALL_CHANGES, UNCOMMITTED, WIP, selectionScope, toggleSelection } from "./scope";

const c = (sha: string, subject = `subject ${sha}`): Commit => ({ sha, short: sha.slice(0, 3), subject, author: "a", author_email: "", committer: "a", body: "", time: 0 });
// Newest first.
const commits = [c("ccc111"), c("bbb222"), c("aaa333")];

describe("toggleSelection", () => {
  it("plain click selects one item", () => {
    expect(toggleSelection(["bbb222", WIP], "ccc111", false)).toEqual(["ccc111"]);
  });
  it("multi click adds and removes, dropping All; empty falls back to All", () => {
    expect(toggleSelection([ALL], "ccc111", true)).toEqual(["ccc111"]);
    expect(toggleSelection(["ccc111"], WIP, true)).toEqual(["ccc111", WIP]);
    expect(toggleSelection(["ccc111"], "ccc111", true)).toEqual([ALL]);
  });
  it("All never combines", () => {
    expect(toggleSelection(["ccc111"], ALL, true)).toEqual([ALL]);
  });
});

describe("selectionScope", () => {
  it("All and Uncommitted", () => {
    expect(selectionScope([ALL], commits)).toBe(ALL_CHANGES);
    expect(selectionScope([WIP], commits)).toBe(UNCOMMITTED);
  });
  it("one commit diffs against its parent", () => {
    expect(selectionScope(["bbb222"], commits)).toEqual({ from: "bbb222^", to: "bbb222", label: "bbb subject bbb222", sel: ["bbb222"] });
  });
  it("several commits span oldest parent to newest, in log order", () => {
    expect(selectionScope(["ccc111", "aaa333"], commits)).toMatchObject({ from: "aaa333^", to: "ccc111", label: "ccc + aaa", sel: ["ccc111", "aaa333"] });
  });
  it("with Uncommitted the range ends at the working tree", () => {
    expect(selectionScope([WIP, "bbb222"], commits)).toMatchObject({ from: "bbb222^", to: null, label: "Uncommitted + bbb" });
  });
  it("unknown shas fall back", () => {
    expect(selectionScope(["zzz"], commits)).toBe(ALL_CHANGES);
  });
});
