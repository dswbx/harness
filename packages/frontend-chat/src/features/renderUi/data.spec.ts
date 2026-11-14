import { s } from "jsonv-ts";
import { type Entry, icon, mono, tone, tooltip } from "./shared";

/** Lists and tables: Table, List, Timeline. */

/** A Table cell: inline Markdown text, or an object for a tone, monospace or an icon. Sort and filter use `text`. */
export const cell = s.anyOf([
   s.string(),
   s.object({
      text: s.string(),
      tone: tone.optional(),
      mono: mono.optional(),
      icon: icon.optional(),
      tooltip: tooltip.optional(),
   }),
]);

export const specs = {
   Table: {
      description:
         "A table: column headings and rows. A row is an array of cells, or {cells, tone} to tint the row. A cell is text, or {text, tone?, mono?, icon?, tooltip?}. `sortable` sorts by a clicked column; `filter` adds a search box (both use the cell text).",
      children: false,
      props: s.object({
         columns: s.array(s.string()),
         rows: s.array(
            s.anyOf([s.array(cell), s.object({ cells: s.array(cell), tone: tone.optional() })]),
         ),
         sortable: s.boolean().optional(),
         filter: s.boolean().optional(),
      }),
      example: {
         node: {
            type: "Table",
            props: {
               sortable: true,
               filter: true,
               columns: ["Suite", "Result", "Time (s)", "Owner"],
               rows: [
                  [
                     "checkout",
                     { text: "passed", tone: "success", icon: "check" },
                     { text: "72", mono: true },
                     "@ana",
                  ],
                  {
                     cells: [
                        "search",
                        { text: "failed", tone: "error", icon: "x" },
                        { text: "48", mono: true },
                        "@li",
                     ],
                     tone: "error",
                  },
                  {
                     cells: [
                        "payments",
                        {
                           text: "flaky",
                           tone: "warning",
                           icon: "alert",
                           tooltip: "Failed 2 of the last 10 runs",
                        },
                        { text: "123", mono: true },
                        "@sam",
                     ],
                     tone: "warning",
                  },
                  [
                     "profile",
                     { text: "passed", tone: "success", icon: "check" },
                     { text: "9", mono: true },
                     "*nobody*",
                  ],
               ],
            },
         },
      },
   },
   List: {
      description:
         "Rich rows: title, description, meta text, icon, badge, tooltip. `status` (done, running, waiting, blocked, failed) shows a status icon in place of `icon`. With `check` ($bindState to an object), each row gets a checkbox that writes `{ [id]: true|false }` there, e.g. a todo list; `on.change` runs after a toggle. Status and check are independent: the checkbox comes first, the status icon after it.",
      children: false,
      props: s.object({
         items: s.array(
            s.object({
               id: s.string(),
               title: s.string(),
               description: s.string().optional(),
               meta: s
                  .string({ description: "Short text on the right, e.g. a time or a size." })
                  .optional(),
               icon: icon.optional(),
               badge: s.string().optional(),
               tone: tone.optional(),
               status: s
                  .string({ enum: ["done", "running", "waiting", "blocked", "failed"] })
                  .optional(),
               tooltip: tooltip.optional(),
            }),
            { minItems: 1 },
         ),
         check: s.any().optional(),
      }),
      bind: ["check"],
      events: ["change"],
      example: {
         node: {
            type: "Stack",
            children: [
               {
                  type: "List",
                  props: {
                     check: { $bindState: "/todos" },
                     items: [
                        {
                           id: "schema",
                           title: "Add the migration",
                           description: "users.email gets a unique index",
                           icon: "database",
                           meta: "5 min",
                        },
                        {
                           id: "api",
                           title: "Update the signup handler",
                           description: "Return 409 on a duplicate email",
                           icon: "code",
                           badge: "next",
                           tone: "info",
                        },
                        { id: "tests", title: "Cover the duplicate case", icon: "test" },
                     ],
                  },
               },
               {
                  type: "List",
                  props: {
                     items: [
                        { id: "ios", title: "Build the iOS app", status: "done", meta: "12 min" },
                        {
                           id: "review",
                           title: "App Store review",
                           status: "running",
                           description: "Submitted 09:20",
                        },
                        {
                           id: "play",
                           title: "Play Store review",
                           status: "waiting",
                           tooltip: "Starts after the App Store review",
                        },
                        {
                           id: "notes",
                           title: "Release notes",
                           status: "blocked",
                           description: "Waiting for the copy from marketing",
                        },
                        {
                           id: "android",
                           title: "Build the Android app",
                           status: "failed",
                           badge: "retry",
                           tone: "error",
                        },
                     ],
                  },
               },
            ],
         },
         state: { todos: { schema: true } },
      },
   },
   Timeline: {
      description:
         "Events in order: title, description, time, tone, icon. E.g. a deploy history or the steps of an investigation.",
      children: false,
      props: s.object({
         items: s.array(
            s.object({
               title: s.string(),
               description: s.string().optional(),
               time: s.string().optional(),
               tone: tone.optional(),
               icon: icon.optional(),
            }),
            { minItems: 1 },
         ),
      }),
      example: {
         node: {
            type: "Timeline",
            props: {
               items: [
                  {
                     title: "Reproduced the bug",
                     description: "Fails on an empty cart",
                     time: "10:02",
                     icon: "bug",
                     tone: "error",
                  },
                  {
                     title: "Found the cause",
                     description: "`total()` divides by the item count",
                     time: "10:14",
                     icon: "search",
                  },
                  { title: "Fix merged", time: "10:31", icon: "git-merge", tone: "success" },
               ],
            },
         },
      },
   },
} as const satisfies Record<string, Entry>;
