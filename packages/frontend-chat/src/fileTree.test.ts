import { describe, expect, it } from "vitest";
import { ancestorKeys, fileTree } from "./fileTree";

const f = (path: string, additions = 1, deletions = 0) => ({ path, additions, deletions });
const files = [
  f("packages/frontend-chat/src/diff.ts", 10, 2),
  f("bun.lock"),
  f("packages/api/src/mock.ts", 3, 4),
  f("packages/frontend-chat/src/DiffPanel.tsx", 5, 1),
  f("crates/harness-core/src/api.rs"),
];

describe("fileTree", () => {
  it("lists folders first, merges single-folder chains, sorts by name", () => {
    const { rows, order } = fileTree(files, new Set());
    expect(rows.map((r) => `${r.depth}:${r.name}`)).toEqual([
      "0:crates/harness-core/src",
      "1:api.rs",
      "0:packages",
      "1:api/src",
      "2:mock.ts",
      "1:frontend-chat/src",
      "2:diff.ts",
      "2:DiffPanel.tsx",
      "0:bun.lock",
    ]);
    expect(order.map((x) => x.path)).toEqual(rows.filter((r) => r.kind === "file").map((r) => r.key));
  });

  it("hides closed folders' contents but keeps them in order, and sums their changes", () => {
    const { rows, order } = fileTree(files, new Set(["packages"]));
    expect(rows.map((r) => r.name)).toEqual(["crates/harness-core/src", "api.rs", "packages", "bun.lock"]);
    expect(rows[2]).toMatchObject({ kind: "dir", key: "packages", open: false, additions: 18, deletions: 7 });
    expect(order).toHaveLength(5);
  });

  it("finds closed ancestors of a path", () => {
    const closed = new Set(["packages", "packages/api/src", "crates/harness-core/src"]);
    expect(ancestorKeys(closed, "packages/api/src/mock.ts").sort()).toEqual(["packages", "packages/api/src"]);
  });
});
