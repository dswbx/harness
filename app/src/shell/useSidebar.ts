import { useResizableWidth } from "@harness/ui";
import { useCallback, useState } from "react";

const SIDEBAR_KEY = "harness.sidebarOpen";

export function useSidebarOpen() {
   const [open, setOpen] = useState(() => {
      try {
         return localStorage.getItem(SIDEBAR_KEY) !== "0";
      } catch {
         return true;
      }
   });
   const toggle = useCallback(() => {
      setOpen((o) => {
         try {
            localStorage.setItem(SIDEBAR_KEY, o ? "0" : "1");
         } catch {
            /* per-window convenience only */
         }
         return !o;
      });
   }, []);
   return [open, toggle] as const;
}

/** Sidebar width, dragged from its right edge (double-click resets). */
export const useSidebarWidth = () =>
   useResizableWidth({
      storageKey: "harness.sidebarWidth",
      initial: 256,
      min: 200,
      max: 480,
      edge: "right",
   });
