import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@harness/api";
import { matches, mergeRecent, parsePrRef, relTime, sessionFolders, tildify } from "./composer";

describe("composer helpers", () => {
  it("merges recent folders newest first, one per path", () => {
    const r = mergeRecent([{ path: "/a", at: 1 }, { path: "/b/", at: 5 }], [{ path: "/a", at: 9 }, { path: "/b", at: 2 }]);
    expect(r).toEqual([{ path: "/a", at: 9 }, { path: "/b", at: 5 }]);
  });

  it("takes Session folders but not Worktree ones", () => {
    const s = (folder: string, wt: string | null, created_ms: number) =>
      ({ folder, created_ms, workspace: { repo_root: null, worktree_branch: wt, base_branch: null } }) as SessionSummary;
    expect(sessionFolders([s("/x", null, 3), s("/data/wt/x", "harness/a", 4)])).toEqual([{ path: "/x", at: 3 }]);
  });

  it("formats ages and paths", () => {
    const now = Date.UTC(2026, 9, 30, 12);
    expect([30e3, 5 * 60e3, 3 * 3600e3, 30 * 3600e3, 4 * 86400e3, 15 * 86400e3].map((d) => relTime(now - d, now))).toEqual(
      ["now", "5m", "3h", "Yesterday", "4d", "2w"],
    );
    expect([tildify("/Users/me/x/y"), tildify("/Users/me"), tildify("/opt/x")]).toEqual(["~/x/y", "~", "/opt/x"]);
  });

  it("reads PR refs", () => {
    expect(["142", "#7", "https://github.com/o/r/pull/31/files", "abc", "0"].map(parsePrRef)).toEqual([142, 7, 31, null, null]);
  });

  it("matches every word", () => {
    expect(matches("feat comp", "feat/composer-v2")).toBe(true);
    expect(matches("feat x", "feat/composer-v2")).toBe(false);
    expect(matches("", "anything")).toBe(true);
  });
});
