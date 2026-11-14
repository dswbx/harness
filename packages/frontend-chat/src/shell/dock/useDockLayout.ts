import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelPlace } from "../usePanelHost";
import { defaultLayout, type Layout, reconcile } from "./model";
import { overlayProfile } from "./overlay";
import { loadLayout, saveLayout } from "./persist";

/**
 * Where the panels sit and their sizes. Kept per Session. The Quick overlay has only the side zones
 * (`overlayProfile`) and keeps its layout in memory: the main window's stored layout of the Session stays as it is.
 * `lay` is the layout with every hosted panel placed; `update` takes a change to it.
 */
export function useDockLayout(sessionId: string, overlay: boolean) {
   const fit = useCallback((l: Layout) => (overlay ? overlayProfile(l) : l), [overlay]);
   const [layout, setLayout] = useState<Layout>(() =>
      overlay ? overlayProfile(defaultLayout()) : loadLayout(sessionId),
   );
   useEffect(() => {
      if (!overlay) saveLayout(sessionId, layout);
   }, [overlay, sessionId, layout]);
   /** Every change goes through reconcile first, so a panel that just appeared (a slot) has its place. */
   const placesRef = useRef<PanelPlace[]>([]);
   const update = useCallback(
      (f: (l: Layout) => Layout) => setLayout((l) => fit(f(fit(reconcile(l, placesRef.current))))),
      [fit],
   );
   // The panels the host runs (it lists them after the layout): each gets a place once.
   const [places, setPlaces] = useState<PanelPlace[]>([]);
   const lay = useMemo(() => fit(reconcile(layout, places)), [fit, layout, places]);
   useEffect(() => {
      if (lay !== layout) setLayout(lay);
   }, [lay, layout]);
   return { lay, update, placesRef, setPlaces };
}

/** The panels the host lists get a place in the layout (a frame later, through `places`). */
export function useHostPlaces(
   dock: Pick<ReturnType<typeof useDockLayout>, "placesRef" | "setPlaces">,
   hosted: PanelPlace[],
) {
   dock.placesRef.current = hosted;
   const { setPlaces } = dock;
   useEffect(() => setPlaces(hosted), [setPlaces, hosted]);
}
