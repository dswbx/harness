import type { VirtualListHandle } from "@harness/ui";
import { type RefObject, useCallback, useMemo, useState } from "react";
import { placeSteps } from "../features/toolDisplay/group";
import type { OpenStepRequest } from "../features/toolDisplay/openStep";
import { flash } from "../lib/flash";

/**
 * Jumping in the Main Thread's message list: to a row (scrolled to, then what `pick` finds in it flashed)
 * and to a subagent's step (nested ones through their parents: `openStep` asks them to open).
 */
export function useJump(
   list: RefObject<VirtualListHandle | null>,
   rows: Parameters<typeof placeSteps>[0],
   subagents: Parameters<typeof placeSteps>[1],
) {
   /** Scrolls the chat to a row; once the virtual list renders it, flashes what `pick` finds in it. */
   const jumpToRow = useCallback(
      (rowId: string, pick: (row: Element) => Element | null | undefined) => {
         if (!list.current?.scrollToKey(rowId)) return;
         let tries = 0;
         const find = () => {
            const row = document.querySelector(`[data-key="${CSS.escape(rowId)}"]`);
            const el = row && pick(row);
            if (el) {
               el.scrollIntoView({ block: "center" });
               flash(el);
            } else if (tries++ < 30) requestAnimationFrame(find);
         };
         requestAnimationFrame(find);
      },
      [list],
   );
   // A click in the Subagents panel opens the subagent's step in the chat (nested ones through their parents).
   const stepPlaces = useMemo(() => placeSteps(rows, subagents), [rows, subagents]);
   const [openStep, setOpenStep] = useState<OpenStepRequest | null>(null);
   const jumpToStep = useCallback(
      (id: string) => {
         const place = stepPlaces.get(id);
         if (!place) return;
         setOpenStep((o) => ({ path: place.path, nonce: (o?.nonce ?? 0) + 1 }));
         const { path } = place;
         const at = (row: Element, id: string) =>
            row.querySelector(`[data-step="${CSS.escape(id)}"]`);
         let tries = 0;
         // The step itself once its parents opened; Cards show only the outer subagent, so after a
         // while the deepest step shown. Its first child is the line (Trace) or header (Cards).
         jumpToRow(place.row, (row) => {
            let el = at(row, path.at(-1)!);
            if (!el && tries++ > 10)
               for (let i = path.length - 2; i >= 0 && !el; i--) el = at(row, path[i]!);
            return el && (el.firstElementChild ?? el);
         });
      },
      [stepPlaces, jumpToRow],
   );
   return { jumpToRow, jumpToStep, openStep };
}
