import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelPlace } from "../usePanelHost";
import { defaultLayout, type Layout, reconcile, show } from "./model";
import { overlayProfile } from "./overlay";
import { loadLayout, saveLayout } from "./persist";

/**
 * Which window the layout is for. `main`: the Session's stored layout. `overlay`: the Quick overlay, only the
 * side zones (`overlayProfile`). `window`: a panel window, `panel` always shown. Only `main` saves.
 */
export type DockMode = "main" | "overlay" | "window";

/**
 * Where the panels sit and their sizes. Kept per Session. The Quick overlay and a panel window keep their
 * layout in memory: the main window's stored layout of the Session stays as it is.
 * `lay` is the layout with every hosted panel placed; `update` takes a change to it.
 */
export function useDockLayout(sessionId: string, mode: DockMode, panel?: string) {
   const fit = useCallback(
      (l: Layout) =>
         mode === "overlay" ? overlayProfile(l) : mode === "window" && panel ? show(l, panel) : l,
      [mode, panel],
   );
   const [layout, setLayout] = useState<Layout>(() =>
      fit(mode === "overlay" ? defaultLayout() : loadLayout(sessionId)),
   );
   useEffect(() => {
      if (mode === "main") saveLayout(sessionId, layout);
   }, [mode, sessionId, layout]);
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
