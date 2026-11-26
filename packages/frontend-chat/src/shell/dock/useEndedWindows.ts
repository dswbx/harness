import { forgetPanelWindow, useEndedPanelWindows } from "@harness/api";
import { useEffect, useRef } from "react";
import { hide, isOpen, type Layout, show, zoneOf } from "./model";

/**
 * Main view only: applies the panel windows of `sessionId` that ended. Closed (red X): the panel is
 * hidden in its zone. Docked back: it shows in its zone. Once the layout has that (and saved it:
 * `useDockLayout`'s effect runs first) the keys go. An end while the main window showed another
 * Session, or was not running, is applied when this Session's view mounts.
 */
export function useEndedWindows(
   sessionId: string,
   on: boolean,
   lay: Layout,
   update: (f: (l: Layout) => Layout) => void,
) {
   const key = useEndedPanelWindows(sessionId)
      .map((w) => `${w.end}:${w.panel}`)
      .join("\n");
   // The ends already applied to the layout: applied once only (two docked panels of one zone both
   // show, the last one wins, and the first must not be shown again).
   const applied = useRef("");
   useEffect(() => {
      if (!on || !key) return;
      const ends = key.split("\n").map((line) => {
         const i = line.indexOf(":");
         return { end: line.slice(0, i), id: line.slice(i + 1) };
      });
      const pending = ends.filter(({ end, id }) =>
         end === "closed" ? isOpen(lay, id) : !isOpen(lay, id) && zoneOf(lay, id) !== null,
      );
      if (pending.length > 0 && applied.current !== key) {
         applied.current = key;
         update((l) =>
            pending.reduce((acc, { end, id }) => (end === "closed" ? hide : show)(acc, id), l),
         );
         return;
      }
      for (const { id } of ends) forgetPanelWindow(sessionId, id);
   }, [on, key, lay, sessionId, update]);
}
