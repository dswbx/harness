import { cn, Tooltip } from "@harness/ui";
import { Pencil } from "lucide-react";
import {
   createContext,
   type HTMLAttributes,
   type ReactNode,
   type RefObject,
   useCallback,
   useContext,
   useEffect,
   useLayoutEffect,
   useMemo,
   useRef,
   useState,
} from "react";
import { findQuote, type TextQuote } from "../../lib/textQuote";
import type { InlineModel, InlineStatus } from "./model";

/** A quote to find and paint in one agent message: an open Inline Thread or a draft. */
type AnchorEntry = { id: string; quote: TextQuote; draft: boolean };

export const isDraftAnchor = (id: string) => id.startsWith("draft:");

/** CSS Custom Highlights (styles.css): Inline Threads, the ones the popover shows, and drafts. */
const CLASSES = {
   thread: "inline-thread",
   active: "inline-thread-active",
   draft: "inline-thread-draft",
} as const;

/**
 * The ranges the mounted agent messages found, by Thread or draft id, painted as CSS Custom Highlights.
 * Rows of the virtual list come and go: each adds its ranges when it mounts and takes them back when it
 * unmounts. The hit test, the popover's position and the highlights all read from here.
 */
export class AnchorRegistry {
   private ranges = new Map<string, { range: Range; row: Element }>();
   private active = new Set<string>();
   private listeners = new Set<() => void>();
   private version = 0;
   private queued = false;

   set(id: string, range: Range, row: Element) {
      this.ranges.set(id, { range, row });
      this.changed();
   }
   /** Removes `id`'s range, only if it is still `range` (another row may have taken over). */
   remove(id: string, range: Range) {
      if (this.ranges.get(id)?.range !== range) return;
      this.ranges.delete(id);
      this.changed();
   }
   get(id: string) {
      return this.ranges.get(id) ?? null;
   }
   setActive(ids: readonly string[]) {
      const next = new Set(ids);
      if (next.size === this.active.size && ids.every((id) => this.active.has(id))) return;
      this.active = next;
      this.changed();
   }
   /** The ids whose text is under the point (client px). */
   hits(x: number, y: number): string[] {
      const out: string[] = [];
      for (const [id, { range }] of this.ranges)
         for (const r of range.getClientRects())
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
               out.push(id);
               break;
            }
      return out;
   }
   subscribe = (l: () => void) => {
      this.listeners.add(l);
      return () => void this.listeners.delete(l);
   };
   getVersion = () => this.version;

   private changed() {
      this.version++;
      for (const l of this.listeners) l();
      if (this.queued) return;
      this.queued = true;
      queueMicrotask(() => {
         this.queued = false;
         this.paint();
      });
   }
   private paint() {
      if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
      const sets = { thread: [] as Range[], active: [] as Range[], draft: [] as Range[] };
      for (const [id, { range }] of this.ranges)
         sets[isDraftAnchor(id) ? "draft" : this.active.has(id) ? "active" : "thread"].push(range);
      for (const [kind, ranges] of Object.entries(sets) as [keyof typeof sets, Range[]][]) {
         const h = new Highlight(...ranges);
         // Drafts over the open thread over the others, where they overlap.
         h.priority = kind === "draft" ? 2 : kind === "active" ? 1 : 0;
         if (ranges.length) CSS.highlights.set(CLASSES[kind], h);
         else CSS.highlights.delete(CLASSES[kind]);
      }
   }
   /** Clears the highlights (the chat unmounted). */
   dispose() {
      this.ranges.clear();
      this.changed();
   }
}

type AnchorsCtx = {
   byItem: ReadonlyMap<string, readonly AnchorEntry[]>;
   registry: AnchorRegistry;
   statusOf: (id: string) => InlineStatus;
   open: (ids: string[]) => unknown;
   markFound: (id: string, found: boolean) => void;
};

const InlineAnchors = createContext<AnchorsCtx | null>(null);

/** Drafts first, then the Threads newest first. */
function orderIds(ids: readonly string[], inline: InlineModel): string[] {
   const rank = (id: string) =>
      isDraftAnchor(id) ? -1 : inline.threads.findIndex((t) => t.id === id);
   return [...ids].sort((a, b) => rank(a) - rank(b));
}

/**
 * The Main Thread's message list with its Inline Threads: tells the agent messages which quotes to find,
 * and opens the popover on a click on highlighted text (one listener for the whole list).
 */
export function InlineAnchorsProvider({
   inline,
   registry,
   children,
}: {
   inline: InlineModel;
   registry: AnchorRegistry;
   children: ReactNode;
}) {
   const byItem = useMemo(() => {
      const m = new Map<string, AnchorEntry[]>();
      const add = (itemId: string, e: AnchorEntry) => m.set(itemId, [...(m.get(itemId) ?? []), e]);
      for (const [id, d] of Object.entries(inline.drafts))
         add(d.itemId, { id, quote: d.anchor, draft: true });
      // Resolved Threads have no highlight.
      for (const t of inline.threads)
         if (!t.resolved) add(t.itemId, { id: t.id, quote: t.anchor, draft: false });
      return m;
   }, [inline.drafts, inline.threads]);
   const inlineRef = useRef(inline);
   inlineRef.current = inline;
   // After the click is done: an open popover closes on that same click (Radix dismisses on it), then this opens.
   const open = useCallback(
      (ids: string[]) => setTimeout(() => inlineRef.current.open(orderIds(ids, inlineRef.current))),
      [],
   );
   const ctx = useMemo<AnchorsCtx>(
      () => ({
         byItem,
         registry,
         statusOf: inline.statusOf,
         open,
         markFound: inline.markFound,
      }),
      [byItem, registry, inline.statusOf, open, inline.markFound],
   );
   useEffect(() => registry.setActive(inline.openIds ?? []), [registry, inline.openIds]);
   useEffect(() => () => registry.dispose(), [registry]);
   const onClick = (e: React.MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      if ((e.target as Element).closest?.("a, button, input, textarea, [contenteditable]")) return;
      const ids = registry.hits(e.clientX, e.clientY);
      if (ids.length) open(ids);
   };
   return (
      <InlineAnchors value={ctx}>
         {/* `contents`: no box of its own; only listens. The markers are the keyboard way in. */}
         <div className="contents" onClick={onClick}>
            {children}
         </div>
      </InlineAnchors>
   );
}

/** Markers that share a line: where it is in the message (px from its top), and the ids. */
type Marker = { top: number; ids: string[] };
const EMPTY: readonly AnchorEntry[] = [];
/** Rects closer than this (px) are on the same line. */
const SAME_LINE = 6;

/**
 * Finds the quotes anchored in agent message `itemId` under `ref` and registers their ranges, again when the
 * Markdown commits new nodes or the message changes size, and takes them back on unmount (virtualized rows
 * leave and return). Returns the markers for the right gutter.
 */
function useAnchorRanges(
   itemId: string,
   ref: RefObject<HTMLElement | null>,
   box: RefObject<HTMLElement | null>,
   ctx: AnchorsCtx | null,
): Marker[] {
   const entries = ctx?.byItem.get(itemId) ?? EMPTY;
   const sig = entries.map((e) => `${e.id}\u0000${e.quote.quote}`).join("\u0001");
   const entriesRef = useRef(entries);
   entriesRef.current = entries;
   const [markers, setMarkers] = useState<Marker[]>([]);
   const registry = ctx?.registry;
   const markFound = ctx?.markFound;
   useLayoutEffect(() => {
      const el = ref.current;
      if (!registry || !markFound || !el || !sig) {
         setMarkers((m) => (m.length ? [] : m));
         return;
      }
      let found = new Map<string, Range>();
      const place = () => {
         const top0 = box.current?.getBoundingClientRect().top ?? 0;
         const lines: Marker[] = [];
         for (const [id, r] of found) {
            const rect = r.getClientRects()[0];
            if (!rect) continue;
            const top = rect.top - top0;
            const line = lines.find((l) => Math.abs(l.top - top) < SAME_LINE);
            if (line) line.ids.push(id);
            else lines.push({ top, ids: [id] });
         }
         setMarkers(lines.sort((a, b) => a.top - b.top));
      };
      const find = () => {
         const next = new Map<string, Range>();
         for (const e of entriesRef.current) {
            const r = findQuote(el, e.quote);
            markFound(e.id, !!r);
            if (r) {
               next.set(e.id, r);
               registry.set(e.id, r, el);
            }
         }
         for (const [id, r] of found) if (next.get(id) !== r) registry.remove(id, r);
         found = next;
         place();
      };
      find();
      let frame = 0;
      const later = (f: () => void) => () => {
         cancelAnimationFrame(frame);
         frame = requestAnimationFrame(f);
      };
      const mo = new MutationObserver(later(find));
      mo.observe(el, { childList: true, subtree: true, characterData: true });
      const ro = new ResizeObserver(later(place));
      ro.observe(el);
      return () => {
         cancelAnimationFrame(frame);
         mo.disconnect();
         ro.disconnect();
         for (const [id, r] of found) registry.remove(id, r);
      };
   }, [sig, registry, markFound, ref, box]);
   return markers;
}

/**
 * A Main Thread agent message's text with its Inline Threads: the highlights, and a marker per line in the
 * right gutter. `attrs` go on the text's element (the root quotes are taken from and looked for in).
 */
export function AnchoredText({
   itemId,
   attrs,
   children,
}: {
   itemId: string;
   attrs: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;
   children: ReactNode;
}) {
   const ctx = useContext(InlineAnchors);
   const ref = useRef<HTMLDivElement>(null);
   const box = useRef<HTMLDivElement>(null);
   const markers = useAnchorRanges(itemId, ref, box, ctx);
   return (
      <div ref={box} className="relative">
         <div ref={ref} {...attrs}>
            {children}
         </div>
         {ctx &&
            markers.map((m) => (
               <InlineMarker
                  key={m.ids.join(",")}
                  top={m.top}
                  ids={m.ids}
                  statusOf={ctx.statusOf}
                  onOpen={() => ctx.open(m.ids)}
               />
            ))}
      </div>
   );
}

/** In the right gutter at a line with anchors: how many, running (pulse), unread (dot), or a draft (pencil). */
function InlineMarker({
   top,
   ids,
   statusOf,
   onOpen,
}: {
   top: number;
   ids: string[];
   statusOf: (id: string) => InlineStatus;
   onOpen: () => void;
}) {
   const threads = ids.filter((id) => !isDraftAnchor(id));
   const draft = threads.length === 0;
   const hasDraft = threads.length < ids.length;
   const running = threads.some((id) => statusOf(id) === "running");
   const unread = threads.some((id) => statusOf(id) === "unread");
   const label = [
      threads.length > 0 &&
         `${threads.length} inline ${threads.length === 1 ? "thread" : "threads"}`,
      hasDraft && (draft ? "Draft question" : "draft question"),
   ]
      .filter(Boolean)
      .join(", ");
   return (
      <Tooltip content={label} side="right">
         <button
            type="button"
            aria-label={label}
            onClick={onOpen}
            style={{ top }}
            className={cn(
               "absolute left-[calc(100%+0.5rem)] flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium tabular-nums shadow-xs",
               draft
                  ? "border-blue-400/50 bg-blue-400/15 text-blue-600 dark:text-blue-300"
                  : "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300",
               running && "animate-pulse",
            )}
         >
            {/* Pencil only: the "Draft" label is in the tooltip, so the marker fits the gutter. */}
            {draft ? (
               <Pencil className="size-3" />
            ) : (
               <>
                  {threads.length}
                  {hasDraft && <Pencil className="size-3 text-blue-500" />}
               </>
            )}
            {unread && <span className="size-1.5 rounded-full bg-blue-500" aria-hidden />}
         </button>
      </Tooltip>
   );
}
