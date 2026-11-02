import { describe, expect, it } from "vitest";
import type { SessionSummary, WorkspaceInfo } from "@harness/api";
import { folderName, groupSessions, highlight, matches, refTitle, relativeTime, viewChanges } from "./sessionGroups";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 12);
const ws = (o: Partial<WorkspaceInfo> = {}): WorkspaceInfo =>
  ({ repo_root: "/r", worktree_branch: null, base_branch: null, branch: "main", pr: null, ...o });
const s = (id: string, folder: string, createdH: number, updatedH: number, o: Partial<SessionSummary> = {}) =>
  ({ id, title: id, folder, created_ms: NOW - createdH * H, updated_ms: NOW - updatedH * H, status: "idle", workspace: ws(), ...o }) as SessionSummary;
const ids = (l: SessionSummary[]) => l.map((x) => x.id);

const list = [
  s("a", "/p/harness", 10, 1),
  s("b", "/p/jsonv", 1, 100),
  s("c", "/p/harness", 200, 200, { status: "needs_attention" }),
  s("d", "/p/jsonv", 1000, 900),
];

describe("groupSessions", () => {
  it("sorts by recent activity, attention first", () =>
    expect(ids(groupSessions(list, { sort: "recent", group: "none" }, NOW)[0]!.sessions)).toEqual(["c", "a", "b", "d"]));
  it("sorts by created", () =>
    expect(ids(groupSessions(list, { sort: "created", group: "none" }, NOW)[0]!.sessions)).toEqual(["c", "b", "a", "d"]));
  it("groups by folder in order of each folder's newest Session", () => {
    const g = groupSessions(list, { sort: "created", group: "folder" }, NOW);
    expect(g.map((x) => [x.id, ids(x.sessions)])).toEqual([["folder:jsonv", ["b", "d"]], ["folder:harness", ["c", "a"]]]);
  });
  it("groups by date of the sort field, skipping empty groups", () => {
    const g = groupSessions(list, { sort: "recent", group: "date" }, NOW);
    expect(g.map((x) => [x.label, ids(x.sessions)])).toEqual([["Recent", ["a"]], ["This week", ["b"]], ["This month", ["c"]], ["Older", ["d"]]]);
    expect(groupSessions(list, { sort: "created", group: "date" }, NOW).map((x) => x.id)).toEqual(["date:recent", "date:month", "date:older"]);
  });
});

describe("search", () => {
  const pr = s("x", "/p/supalite", 1, 1, { title: "Fix RLS", workspace: ws({ branch: "rls-cases", pr: 16 }) });
  it("matches title, folder, branch and #pr", () => {
    for (const q of ["rls", "supalite", "cases", "#16"]) expect(matches(pr, q)).toBe(true);
    expect(matches(pr, "#17")).toBe(false);
    expect(matches(pr, "")).toBe(true);
  });
  it("highlights the first match in the title", () => {
    expect(highlight("Fix RLS policy", "rls")).toEqual(["Fix ", "RLS", " policy"]);
    expect(highlight("Fix", "zz")).toBeNull();
  });
});

describe("labels", () => {
  it("relativeTime", () => {
    expect(relativeTime(NOW - 12 * 60_000, NOW)).toBe("12m");
    expect(relativeTime(NOW - 5 * H, NOW)).toBe("5h");
    expect(relativeTime(NOW - 50 * H, NOW)).toBe("2d");
    expect(relativeTime(NOW - 22 * 24 * H, NOW)).toBe("3w");
    expect(relativeTime(Date.UTC(2026, 8, 12, 12), NOW)).toBe("Sep 12");
  });
  it("refTitle", () => {
    expect(refTitle(ws({ worktree_branch: "opt-in-update", branch: "opt-in-update", pr: 16 }))).toBe("Worktree · opt-in-update · PR #16");
    expect(refTitle(ws())).toBe("Checked out in folder · main");
  });
  it("folderName and viewChanges", () => {
    expect(folderName("/Users/me/harness/")).toBe("harness");
    expect(viewChanges({ sort: "created", display: "condensed", group: "date" })).toBe(2);
  });
});
