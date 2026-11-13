import {
   cn,
   Stat,
   StatDescription,
   StatIndicator,
   StatLabel,
   StatTrend,
   StatValue,
} from "@harness/ui";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import type { UiNode } from "../tools";
import { IconOf, type Renderers, type Tone, tip, tones } from "./runtime";

const trendIcon = { up: ArrowUp, down: ArrowDown, neutral: ArrowRight };

export * from "./charts.spec";

/** Renderers of this group; its specs (schema, description, example) are in `charts.spec.ts`. */
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
      const p = node.props;
      const tone = p.tone ?? "neutral";
      const color = tone === "neutral" ? "default" : tone;
      const trend = (p.trend ?? "neutral") as "up" | "down" | "neutral";
      const Arrow = trendIcon[trend];
      return tip(
         p.tooltip,
         <Stat>
            <StatLabel>{p.label}</StatLabel>
            {p.badge ? (
               <StatIndicator variant="badge" color={color}>
                  {p.badge}
               </StatIndicator>
            ) : p.icon ? (
               <StatIndicator variant="icon" color={color}>
                  <IconOf name={p.icon} />
               </StatIndicator>
            ) : null}
            <StatValue className={cn(!p.badge && !p.icon && tone !== "neutral" && tones[tone].fg)}>
               {String(p.value ?? "")}
            </StatValue>
            {p.change && (
               <StatTrend trend={trend}>
                  <Arrow />
                  {p.change}
               </StatTrend>
            )}
            {p.hint && <StatDescription>{p.hint}</StatDescription>}
         </Stat>,
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
