import { cn } from "@harness/ui";
import { s } from "jsonv-ts";
import { lazy, Suspense, useMemo } from "react";
import type { UiNode } from "../tools";
import { type Renderers, type Tone, tip, tones } from "./runtime";
import { type Entry, tone, tooltip } from "./shared";

/** Numbers and charts: Stat, Progress, Chart, Trace. */

export const specs = {
   Stat: {
      description: "One number or short value with a label, e.g. a count, a total or a status.",
      children: false,
      props: s.object({
         label: s.string(),
         value: s.anyOf([s.string(), s.number()]),
         hint: s.string().optional(),
         tone: tone.optional(),
         tooltip: tooltip.optional(),
      }),
      example: {
         node: {
            type: "Stat",
            props: {
               label: "Tests passing",
               value: { $template: "${/tests/passed} / ${/tests/total}" },
               hint: "2 failing in api/",
            },
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

/** recharts is large: loaded the first time a Chart shows. */
const UiChart = lazy(() => import("../UiChart"));

/** Solid fills for bars; the card tones are too light for thin shapes. */
const barTone: Record<Tone, string> = {
   neutral: "bg-primary/35",
   info: "bg-sky-500/70",
   success: "bg-emerald-500/70",
   warning: "bg-amber-500/70",
   error: "bg-destructive/70",
};

function Trace({ node }: { node: Extract<UiNode, { type: "Trace" }> }) {
   const spans = node.props.spans;
   const unit = node.props.unit ?? "ms";
   // Tree order: children under their parent, by start.
   const rows = useMemo(() => {
      const ids = new Set(spans.map((x) => x.id));
      const kids = new Map<string | undefined, typeof spans>();
      for (const x of spans) {
         const p = x.parent && ids.has(x.parent) ? x.parent : undefined;
         kids.set(p, [...(kids.get(p) ?? []), x]);
      }
      const out: { span: (typeof spans)[number]; depth: number }[] = [];
      const walk = (p: string | undefined, depth: number) => {
         for (const x of [...(kids.get(p) ?? [])].sort((a, b) => a.start - b.start)) {
            out.push({ span: x, depth });
            if (depth < 20) walk(x.id, depth + 1);
         }
      };
      walk(undefined, 0);
      return out;
   }, [spans]);
   const t0 = Math.min(...spans.map((x) => x.start));
   const total = Math.max(...spans.map((x) => x.start + x.duration)) - t0 || 1;
   const fmt = (n: number) => `${Math.round(n * 10) / 10}${unit}`;
   return (
      <div className="grid grid-cols-1 gap-1 text-ui-sm">
         {rows.map(({ span: x, depth }) => {
            const t = tones[x.tone ?? "neutral"];
            const bar = (
               <div className="relative h-5 min-w-0 flex-1 rounded bg-muted/40">
                  <div
                     className={cn("absolute inset-y-0.5 rounded-sm", barTone[x.tone ?? "neutral"])}
                     style={{
                        left: `${((x.start - t0) / total) * 100}%`,
                        width: `max(2px, ${(x.duration / total) * 100}%)`,
                     }}
                  />
               </div>
            );
            return (
               <div key={x.id} className="flex items-center gap-2">
                  <span
                     className="w-40 shrink-0 truncate font-mono"
                     style={{ paddingLeft: depth * 12 }}
                     title={x.name}
                  >
                     {x.name}
                  </span>
                  {tip(x.meta, bar)}
                  <span
                     className={cn(
                        "w-16 shrink-0 text-right tabular-nums text-muted-foreground",
                        x.tone && x.tone !== "neutral" && t.fg,
                     )}
                  >
                     {fmt(x.duration)}
                  </span>
               </div>
            );
         })}
      </div>
   );
}

export const renderers = {
   Stat: ({ node }) => {
      const t = tones[node.props.tone ?? "neutral"];
      return tip(
         node.props.tooltip,
         <div className="min-w-0">
            <div className="text-ui-sm text-muted-foreground">{node.props.label}</div>
            <div
               className={cn(
                  "text-ui-xl font-semibold tabular-nums",
                  node.props.tone && node.props.tone !== "neutral" && t.fg,
               )}
            >
               {String(node.props.value ?? "")}
            </div>
            {node.props.hint && (
               <div className="text-ui-sm text-muted-foreground">{node.props.hint}</div>
            )}
         </div>,
         true,
      );
   },
   Progress: ({ node }) => {
      const max = Number(node.props.max ?? 100) || 100;
      const pct = Math.max(0, Math.min(100, (Number(node.props.value ?? 0) / max) * 100));
      return (
         <div className="grid grid-cols-1 gap-1.5">
            {node.props.label && (
               <div className="flex justify-between text-ui-sm text-muted-foreground">
                  <span>{node.props.label}</span>
                  <span className="tabular-nums">{Math.round(pct)}%</span>
               </div>
            )}
            <div
               className="h-1.5 overflow-hidden rounded-full bg-muted"
               role="progressbar"
               aria-valuenow={Number(node.props.value ?? 0)}
               aria-valuemax={max}
            >
               <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${pct}%` }}
               />
            </div>
         </div>
      );
   },
   Chart: ({ node }) => {
      const data = Array.isArray(node.props.data)
         ? (node.props.data as Record<string, unknown>[])
         : [];
      return (
         <Suspense fallback={<div className="h-56 animate-pulse rounded-md bg-muted" />}>
            <UiChart
               type={node.props.type as "bar"}
               data={data}
               x={node.props.x}
               series={node.props.series}
               stacked={node.props.stacked}
               height={node.props.height}
            />
         </Suspense>
      );
   },
   Trace: ({ node }) => {
      return <Trace node={node} />;
   },
} satisfies Renderers;
