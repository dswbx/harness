import { localDay } from "../../derive/tasks";
import type { Task, TaskPriority, TaskStatus } from "../../generated";

const DAY = 86_400_000;

/** `YYYY-MM-DD`, `days` from today. */
const day = (days: number) => localDay(new Date(Date.now() + days * DAY));

/**
 * The mock's Tasks (ADR 0028): two topics with subtasks, one upstream link, one overdue Task and
 * some loose ones. Origins are fixture Sessions; `t3` was started in `mock-1`.
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
      const created = now - (o.age ?? 10 - n) * DAY;
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
   const m1: [string, string] = ["mock-1", "Mock session (fixture replay)"];
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
   ];
   const t1 = tasks[0] as Task;
   t1.upstream = { url: "https://linear.app/harness/issue/HAR-42/release-v2026-12", label: null };
   const t3 = tasks[2] as Task;
   t3.sessions = [
      { session_id: "mock-1", title: "Mock session (fixture replay)", started_ms: now - DAY },
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
