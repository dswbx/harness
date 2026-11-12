import type { Item } from "./reducer";
import { type Placement, type RawNode, sharedNode, sharedNodeId, sharedRef } from "./tools";

type FT = Extract<Item, { type: "frontend_tool" }>;
/** `ts`: when the Agent last placed it (ms epoch). `source`: its file, for a file-backed panel (ADR 0023). */
export type Slot = {
   id: string;
   title: string | null;
   icon: string | null;
   root: RawNode;
   files: Record<string, string>;
   ts: number;
   source: string | null;
};

/**
 * What a slot shows, as a string that changes when it does: its tree, and for a file-backed panel
 * the hash of its file (empty while unknown). Change dots compare it with what was seen.
 */
export function slotChangeKey(x: Slot, stamps: Record<string, { hash: string }>): string {
   return JSON.stringify(x.root) + (x.source ? `#${stamps[x.source]?.hash ?? ""}` : "");
}

/**
 * Splits `render_ui` calls by placement. A call with an `id` replaces earlier calls with that id
 * (inline: shown where it first appeared, with the latest content); `remove` hides them.
 * Calls placed top/bottom leave the chat rows and fill live areas, left/right become panels (ADR 0019), in first-seen order.
 *
 * Shared Artifacts (ADR 0024): an item showing `shared:<id>` hides while `<id>` is not in `attached`.
 * An attached artifact no shown item points at gets a right panel of its own, `shared:<id>`.
 */
export function splitRenderUi(
   items: Item[],
   attached: readonly { id: string; ts: number }[] = [],
): {
   /** Row id -> what to render there instead of its own input (latest for its id), or null to hide. */
   inline: Map<string, { root: RawNode; files: Record<string, string> } | null>;
   slots: Record<Exclude<Placement, "inline">, Slot[]>;
} {
   const inline = new Map<string, { root: RawNode; files: Record<string, string> } | null>();
   const slots: Record<Exclude<Placement, "inline">, Slot[]> = {
      top: [],
      bottom: [],
      left: [],
      right: [],
   };
   // id -> row of its first inline call, and the placement it currently lives in.
   const firstRow = new Map<string, string>();
   const where = new Map<string, Exclude<Placement, "inline"> | "inline">();
   const drop = (id: string) => {
      const w = where.get(id);
      if (w === "inline") inline.set(firstRow.get(id)!, null);
      else if (w) slots[w] = slots[w].filter((s) => s.id !== id);
      where.delete(id);
   };
   for (const it of items) {
      if (it.type !== "frontend_tool" || !it.render?.ok) continue;
      const ft = it as FT & { render: { ok: true } };
      const v = ft.render.value;
      const placement = v.placement ?? "inline";
      if (!v.id) {
         if (placement !== "inline") inline.set(it.id, null);
         continue;
      }
      inline.set(it.id, null);
      const shared = sharedRef(v.source);
      if (v.remove || !v.root || (shared && !attached.some((a) => a.id === shared))) {
         drop(v.id);
         continue;
      }
      if (placement === "inline") {
         if (where.get(v.id) !== "inline") {
            drop(v.id);
            firstRow.set(v.id, it.id);
         }
         inline.set(firstRow.get(v.id)!, { root: v.root, files: ft.files });
         where.set(v.id, "inline");
      } else {
         const slot = {
            id: v.id,
            title: v.title ?? null,
            icon: v.icon ?? null,
            root: v.root,
            files: ft.files,
            ts: ft.ts,
            source: v.source ?? null,
         };
         if (where.get(v.id) === placement)
            slots[placement] = slots[placement].map((s) => (s.id === v.id ? slot : s));
         else {
            drop(v.id);
            slots[placement] = [...slots[placement], slot];
         }
         where.set(v.id, placement);
      }
   }
   // Attached artifacts no item shows: a right panel each, in attach order.
   const shown = new Set<string>();
   for (const x of inline.values()) {
      const id = x && sharedNodeId(x.root);
      if (id) shown.add(id);
   }
   for (const list of Object.values(slots))
      for (const x of list) {
         const id = sharedRef(x.source);
         if (id) shown.add(id);
      }
   for (const a of attached) {
      if (shown.has(a.id)) continue;
      shown.add(a.id);
      slots.right.push({
         id: `shared:${a.id}`,
         title: null,
         icon: null,
         root: sharedNode(a.id),
         files: {},
         ts: a.ts,
         source: `shared:${a.id}`,
      });
   }
   return { inline, slots };
}
