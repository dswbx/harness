import { localDay } from "../../derive/tasks";
import type { Task, TaskPriority, TaskStatus } from "../../generated";

const DAY = 86_400_000;

/** `YYYY-MM-DD`, `days` from today. */
const day = (days: number) => localDay(new Date(Date.now() + days * DAY));

/**
 * The mock's Tasks (ADR 0028): three topics with subtasks (one nested two deep), upstream links, overdue
 * Tasks, a cancelled one and some loose ones. Origins are fixture Sessions (`t18`'s was deleted); `t3` was
 * started in `mock-1`, which also has a done task.
 */
export function mockTasks(): Task[] {
   const now = Date.now();
   const task = (
      n: number,
      title: string,
      o: {
         status?: TaskStatus;
         priority?: TaskPriority;
         parent?: number;
         order?: number;
         due?: string;
         body?: string;
         origin?: [string, string];
         age?: number;
      } = {},
   ): Task => {
      const created = now - (o.age ?? Math.abs(10 - n)) * DAY;
      return {
         v: 1,
         id: `t${n}`,
         title,
         body: o.body ?? "",
         status: o.status ?? "todo",
         priority: o.priority ?? "none",
         due: o.due ?? null,
         upstream: null,
         parent_id: o.parent ? `t${o.parent}` : null,
         order: o.order ?? n,
         origin_session_id: o.origin?.[0] ?? null,
         origin_title: o.origin?.[1] ?? null,
         sessions: [],
         assets: [],
         created_ms: created,
         updated_ms: created,
         body_updated_ms: created,
         activity: [
            {
               at_ms: created,
               by: "user",
               session_id: o.origin?.[0] ?? null,
               kind: { type: "created" },
            },
         ],
      };
   };
   const s1: [string, string] = ["mock-s1", "Compact header layout"];
   const s2: [string, string] = ["mock-s2", "Schema refs"];
   const s3: [string, string] = ["mock-s3", "Ping and pong greeting"];
   const m1: [string, string] = ["mock-1", "Split the router module"];
   const tasks = [
      task(1, "Release v2026.12", {
         priority: "high",
         body: "Ship the December release.\n\n- Changelog\n- Signed build",
         origin: s1,
      }),
      task(2, "Write the changelog", { parent: 1, order: 1, status: "done", origin: s1 }),
      task(3, "Fix the updater signature check", {
         parent: 1,
         order: 2,
         status: "in_progress",
         priority: "urgent",
         due: day(-2),
         origin: s1,
      }),
      task(4, "Tag and publish the build", { parent: 1, order: 3, due: day(3), origin: s1 }),
      task(5, "Header polish", {
         origin: m1,
         body: "Small fixes found while reviewing the header.",
      }),
      task(6, "Align the session title baseline", { parent: 5, order: 1, origin: m1 }),
      task(7, "Truncate long branch names", {
         parent: 5,
         order: 2,
         status: "in_review",
         origin: m1,
      }),
      task(8, "Try the new Biome rules", { status: "backlog", priority: "low" }),
      task(9, "Read the ACP registry RFC", { due: day(0), priority: "medium", origin: m1 }),
      task(10, "Measure the header render time", {
         parent: 5,
         order: 3,
         status: "done",
         origin: m1,
      }),
      // A third topic with a nested subtask, Sessions in other states and a deleted origin.
      task(11, "Worktree reliability", {
         status: "in_progress",
         priority: "high",
         due: day(10),
         body: "Make fresh worktrees fast and safe: shared build cache, fewer reinstalls, no orphan folders.",
      }),
      task(12, "Cache `target/` across worktrees", {
         parent: 11,
         order: 1,
         status: "in_progress",
         priority: "high",
         due: day(5),
         origin: s1,
         body: "Each worktree builds from cold. Point all worktrees of a repo at one shared `CARGO_TARGET_DIR`.",
      }),
      task(13, "Measure cold vs warm build", {
         parent: 12,
         order: 1,
         status: "done",
         origin: s1,
      }),
      task(14, "Shared `CARGO_TARGET_DIR` in the dev script", {
         parent: 12,
         order: 2,
         status: "in_review",
         priority: "high",
         origin: s2,
      }),
      task(15, "Check disk use after a week", { parent: 12, order: 3, due: day(7), origin: s1 }),
      task(16, "Skip `bun install` when the lockfile is unchanged", {
         parent: 11,
         order: 2,
         priority: "medium",
         due: day(2),
         origin: s1,
      }),
      task(17, "Investigate `SQLITE_BUSY` on parallel builds", {
         parent: 11,
         order: 3,
         status: "blocked",
         priority: "high",
         origin: s2,
      }),
      task(18, "Clean up orphan worktrees on app exit", {
         parent: 11,
         order: 4,
         status: "in_review",
         priority: "medium",
         due: day(-1),
         origin: ["mock-gone", "Old worktree cleanup"],
      }),
      task(19, "Write an ADR for a shared build cache", {
         status: "backlog",
         priority: "low",
         origin: s3,
      }),
      task(20, "Show attached artifacts in the session header", {
         priority: "medium",
         due: day(13),
      }),
      task(21, "Try sccache for CI", { status: "cancelled", origin: s1 }),
   ];
   const t1 = tasks[0] as Task;
   t1.upstream = { url: "https://linear.app/harness/issue/HAR-42/release-v2026-12", label: null };
   const link = (n: number, url: string) => {
      (tasks[n - 1] as Task).upstream = { url, label: null };
   };
   link(11, "https://linear.app/harness/issue/HAR-480/worktree-reliability");
   link(12, "https://linear.app/harness/issue/HAR-482/cache-target");
   link(14, "https://github.com/dswbx/harness/pull/201");
   link(17, "https://linear.app/harness/issue/HAR-487/sqlite-busy");
   (tasks[16] as Task).sessions = [
      { session_id: "mock-p1-b", title: "Check supalite RLS cases", started_ms: now - DAY / 2 },
   ];
   const t3 = tasks[2] as Task;
   t3.sessions = [
      { session_id: "mock-1", title: "Split the router module", started_ms: now - DAY },
   ];
   t3.activity.push(
      {
         at_ms: now - DAY,
         by: "user",
         session_id: "mock-1",
         kind: { type: "session_started", session_id: "mock-1" },
      },
      {
         at_ms: now - DAY,
         by: "agent",
         session_id: "mock-1",
         kind: { type: "status_changed", from: "todo", to: "in_progress" },
      },
   );
   return tasks;
}

/** Session Notes by Session id: `mock-1` has one, written 12 minutes ago. */
export function mockNotes(): [
   string,
   { content: string; updated_ms: number | null; images: string[] },
][] {
   return [
      [
         "mock-1",
         {
            content:
               "**Build timings**\n\n- `cargo build` cold 3m12s, warm 41s\n- `bun install` 38s, lockfile unchanged\n- sccache is not set up\n\nAsk about a shared `CARGO_TARGET_DIR` per repo. Check disk use first.",
            updated_ms: Date.now() - 12 * 60_000,
            images: [],
         },
      ],
   ];
}
