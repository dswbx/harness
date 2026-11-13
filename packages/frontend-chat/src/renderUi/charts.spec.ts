import { s } from "jsonv-ts";
import { type Entry, icon, tone, tooltip } from "./shared";

/** Numbers and charts: Stat, Progress, Chart, Trace. */

export const specs = {
   Stat: {
      description:
         'One number or short value with a label, e.g. a count, a total or a status, in a small box. `change` with `trend` (up green, down red, neutral grey) shows a change with an arrow, e.g. "+20.1% from last month". `icon` or `badge` (short text, e.g. "+24") shows at the top right, tinted by `tone`; without them `tone` tints the value. `hint` is a muted line below. Put several in a Grid.',
      children: false,
      props: s.object({
         label: s.string(),
         value: s.anyOf([s.string(), s.number()]),
         hint: s.string().optional(),
         change: s.string({ description: 'A change, e.g. "+20.1% from last month".' }).optional(),
         trend: s
            .string({
               enum: ["up", "down", "neutral"],
               description: "Arrow and color of `change`.",
            })
            .optional(),
         icon: icon.optional(),
         badge: s.string({ description: 'Short text at the top right, e.g. "+24".' }).optional(),
         tone: tone.optional(),
         tooltip: tooltip.optional(),
      }),
      example: {
         node: {
            type: "Grid",
            props: { columns: 2 },
            children: [
               {
                  type: "Stat",
                  props: {
                     label: "Tests passing",
                     value: { $template: "${/tests/passed} / ${/tests/total}" },
                     icon: "test",
                     tone: "success",
                     change: "+4 since last run",
                     trend: "up",
                     hint: "2 failing in api/",
                  },
               },
               {
                  type: "Stat",
                  props: {
                     label: "Build time",
                     value: "42s",
                     badge: "+6s",
                     tone: "warning",
                     change: "-12% from main",
                     trend: "down",
                  },
               },
            ],
         },
         state: { tests: { passed: 46, total: 48 } },
      },
   },
   Progress: {
      description: "A progress bar from 0 to max (default 100).",
      children: false,
      props: s.object({
         value: s.number(),
         max: s.number().optional(),
         label: s.string().optional(),
      }),
      example: {
         node: {
            type: "Progress",
            props: { label: "Files migrated", value: { $state: "/migration/done" }, max: 12 },
         },
         state: { migration: { done: 7 } },
      },
   },
   Chart: {
      description:
         "A chart of `data` (rows of objects; bindable). `x` names the label key, `series` the numeric keys to plot. type: bar, line, area or pie (pie uses the first series).",
      children: false,
      props: s.object({
         type: s.string({ enum: ["bar", "line", "area", "pie"] }),
         data: s.array(s.object({})),
         x: s.string(),
         series: s.array(s.object({ key: s.string(), label: s.string().optional() }), {
            minItems: 1,
         }),
         stacked: s.boolean().optional(),
         height: s.number().optional(),
      }),
      example: {
         node: {
            type: "Chart",
            props: {
               type: "bar",
               x: "route",
               series: [
                  { key: "before", label: "Before (ms)" },
                  { key: "after", label: "After (ms)" },
               ],
               data: [
                  { route: "/", before: 180, after: 95 },
                  { route: "/search", before: 420, after: 160 },
                  { route: "/settings", before: 140, after: 120 },
               ],
            },
         },
      },
   },
   Trace: {
      description:
         "A trace waterfall: spans with `start` and `duration` (same unit, e.g. ms) and an optional `parent` id, drawn as bars on one time axis. E.g. a request's steps or a build's phases.",
      children: false,
      props: s.object({
         spans: s.array(
            s.object({
               id: s.string(),
               name: s.string(),
               start: s.number(),
               duration: s.number(),
               parent: s.string().optional(),
               tone: tone.optional(),
               meta: s.string({ description: "Shown on hover." }).optional(),
            }),
            { minItems: 1 },
         ),
         unit: s.string({ description: "Default ms." }).optional(),
      }),
      example: {
         node: {
            type: "Trace",
            props: {
               spans: [
                  { id: "req", name: "GET /search", start: 0, duration: 420 },
                  { id: "auth", name: "auth", start: 5, duration: 30, parent: "req" },
                  {
                     id: "db",
                     name: "db.query",
                     start: 40,
                     duration: 310,
                     parent: "req",
                     tone: "warning",
                     meta: "full table scan on items",
                  },
                  { id: "render", name: "render", start: 355, duration: 60, parent: "req" },
               ],
            },
         },
      },
   },
} as const satisfies Record<string, Entry>;
