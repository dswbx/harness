import { cn } from "@harness/ui";
import { InlineMarkdown as Md } from "../InlineMarkdown";
import type { RawNode, UiNode } from "../tools";
import { uiIcons } from "../uiIcons";
import {
   isVisible,
   itemPath,
   type RenderCtx,
   type Renderers,
   resolveValue,
   type Scope,
   ScopeCtx,
   tones,
} from "./runtime";

export * from "./layout.spec";

/** Renderers of this group; its specs (schema, description, example) are in `layout.spec.ts`. */
type Layout = Extract<UiNode, { type: "Stack" }>["props"];
/** In a row, these keep their own width; other children share it. */
const ownWidth = new Set<string>(["Badge", "Button", "Checkbox", "Switch", "FileLink", "Text"]);

/**
 * Stack classes: the container, and the cell that wraps a child sharing a row's width (null: it
 * keeps its own). A row's children share it equally (same height, unless `align` says otherwise)
 * and wrap when narrower than 12rem; `fill: false` lets all keep their width.
 */
export function stackClasses(p: Layout, type: string): { box: string; cell: string | null } {
   const gap = { sm: "gap-1.5", md: "gap-3", lg: "gap-5" }[p.gap ?? "md"];
   const align =
      p.align &&
      { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" }[
         p.align
      ];
   const justify =
      p.justify &&
      {
         start: "justify-start",
         center: "justify-center",
         end: "justify-end",
         between: "justify-between",
      }[p.justify];
   if (p.direction !== "horizontal")
      return { box: cn("flex min-w-0 flex-col", gap, align, justify), cell: null };
   const wrap = p.wrap !== false;
   return {
      box: cn(
         "flex min-w-0 flex-row",
         wrap ? "flex-wrap" : "flex-nowrap",
         align ?? "items-center",
         justify,
         gap,
      ),
      cell:
         p.fill === false || ownWidth.has(type)
            ? null
            : cn(
                 "flex flex-1 basis-0 flex-col [&>*]:flex-1",
                 wrap ? "min-w-48" : "min-w-0",
                 (!p.align || p.align === "stretch") && "self-stretch",
              ),
   };
}

/** Stack's layout (also a Repeat's copies). Each entry renders in its own Repeat scope. */
function StackLayout({
   p,
   entries,
   Node,
}: {
   p: Layout;
   Node: RenderCtx["Node"];
   entries: { key: string | number; raw: RawNode; scope?: Scope }[];
}) {
   return (
      <div className={stackClasses(p, "").box}>
         {entries.map((e) => {
            const cell = stackClasses(p, e.raw.type).cell;
            const el = (
               <ScopeCtx.Provider key={cell ? undefined : e.key} value={e.scope}>
                  <Node raw={e.raw} />
               </ScopeCtx.Provider>
            );
            return cell ? (
               <div key={e.key} className={cell}>
                  {el}
               </div>
            ) : (
               el
            );
         })}
      </div>
   );
}

/** A Repeat's items with their scopes: each item's path under the array's state path (`/tickets/2`). */
export function repeatScopes(raw: RawNode, state: unknown, scope?: Scope): Scope[] {
   const src = raw.props?.items;
   const items = resolveValue(src, state, scope);
   if (!Array.isArray(items)) return [];
   const o = (src ?? {}) as { $state?: unknown; $item?: unknown };
   const base =
      typeof o.$state === "string"
         ? o.$state
         : typeof o.$item === "string"
           ? itemPath(o.$item, scope)
           : undefined;
   return items.map((item, index) => ({
      item,
      index,
      path: base == null ? undefined : `${base}/${index}`,
   }));
}

export const renderers = {
   Stack: ({ node, raw, env, scope, Node }) => {
      // Hidden children leave no gap or empty cell; keys stay their original index.
      const shown = (raw.children ?? [])
         .map((c, i) => ({ key: i, raw: c, scope }))
         .filter((e) => isVisible(e.raw.visible, env.state, scope));
      return <StackLayout p={node.props ?? {}} entries={shown} Node={Node} />;
   },
   Card: ({ node, kids }) => {
      const t = tones[node.props?.tone ?? "neutral"];
      const Icon = (node.props?.icon && uiIcons[node.props.icon]) || t.icon;
      const variant = node.props?.variant ?? "default";
      const body = (kids?.length ?? 0) > 0;
      // compact: less padding, smaller heading; plain: no box, a titled section.
      const head =
         variant === "plain"
            ? "pb-2"
            : variant === "compact"
              ? cn("bg-muted/40 px-2.5 py-1.5", body && "border-b")
              : "border-b bg-muted/40 px-3 py-2.5";
      return (
         <div
            className={cn(
               "min-w-0",
               variant !== "plain" &&
                  cn(
                     "overflow-hidden rounded-lg border",
                     t === tones.neutral ? "bg-card/50" : t.box,
                  ),
            )}
         >
            {node.props?.title && (
               <div className={head}>
                  <div
                     className={cn(
                        "flex items-center gap-2 font-semibold text-foreground",
                        variant === "compact" && "text-ui-sm",
                     )}
                  >
                     {Icon && (
                        <Icon
                           className={cn(
                              "size-4 shrink-0",
                              node.props.tone && node.props.tone !== "neutral"
                                 ? t.fg
                                 : "text-muted-foreground",
                           )}
                        />
                     )}
                     <span className="min-w-0">{node.props.title}</span>
                  </div>
                  {node.props.description && (
                     <div className="mt-0.5 text-ui-sm text-muted-foreground">
                        <Md>{node.props.description}</Md>
                     </div>
                  )}
               </div>
            )}
            {body && (
               <div
                  className={cn(
                     "space-y-2",
                     variant === "plain" ? "" : variant === "compact" ? "p-2.5" : "p-3",
                  )}
               >
                  {kids}
               </div>
            )}
         </div>
      );
   },
   Repeat: ({ node, raw, env, scope, Node }) => {
      const scopes = repeatScopes(raw, env.state, scope);
      if (!scopes.length)
         return node.props.empty ? (
            <div className="text-ui-sm text-muted-foreground">{node.props.empty}</div>
         ) : null;
      const { key } = node.props;
      // Each item renders all children in order; hidden ones leave no gap.
      const entries = scopes.flatMap((s) => {
         const id =
            key && typeof s.item === "object" && s.item !== null
               ? String((s.item as Record<string, unknown>)[key] ?? s.index)
               : s.index;
         return (raw.children ?? [])
            .map((c, j) => ({ key: `${id}:${j}`, raw: c, scope: s }))
            .filter((e) => isVisible(e.raw.visible, env.state, e.scope));
      });
      return <StackLayout p={node.props} entries={entries} Node={Node} />;
   },
   Grid: ({ node, raw, env, scope, Node }) => {
      const n = node.props.columns ?? 3;
      const shown = (raw.children ?? [])
         .map((c, i) => [c, i] as const)
         .filter(([c]) => isVisible(c.visible, env.state, scope));
      // Only Buttons: a keypad, exactly `columns` wide, keys filling their cells.
      if (shown.length && shown.every(([c]) => c.type === "Button")) {
         return (
            <div
               className="grid gap-2 [&_button]:h-10 [&_button]:w-full"
               style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
            >
               {shown.map(([c, i]) => (
                  <Node key={i} raw={c} />
               ))}
            </div>
         );
      }
      return (
         <div
            className="grid gap-3"
            style={{
               gridTemplateColumns: `repeat(auto-fill, minmax(max(10rem, calc((100% - ${n - 1} * 0.75rem) / ${n})), 1fr))`,
            }}
         >
            {shown.map(([c, i]) => (
               <Node key={i} raw={c} />
            ))}
         </div>
      );
   },
} satisfies Renderers;
