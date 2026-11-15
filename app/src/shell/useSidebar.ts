import { storedNumber, storedValue } from "@harness/api";
import { useResizableWidth } from "@harness/ui";
import { useCallback, useState } from "react";

const openStore = storedValue<boolean>({
   key: "harness.sidebarOpen",
   scope: "app",
   parse: (raw) => raw !== "0",
   serialize: (v) => (v ? "1" : "0"),
   sync: false,
});
const widthStore = storedNumber("harness.sidebarWidth");

export function useSidebarOpen() {
   const [open, setOpen] = useState(openStore.get);
   const toggle = useCallback(() => {
      setOpen((o) => {
         openStore.set(!o);
         return !o;
      });
   }, []);
   return [open, toggle] as const;
}

/** Sidebar width, dragged from its right edge (double-click resets). */
export const useSidebarWidth = () =>
   useResizableWidth({
      store: widthStore,
      initial: 256,
      min: 200,
      max: 480,
      edge: "right",
   });
