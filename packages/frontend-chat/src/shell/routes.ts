import { diffWindowScope } from "@harness/api";
import { type FileTarget, filesWindowTarget } from "../features/files/FilesPanel";

/**
 * Which window this page is: a pop-out Diff window (`pane=diff` in its URL), a pop-out Files window
 * (`pane=files`), a panel window (`pane=panel&panel=<id>`: one panel of the Session) or, with none, the
 * chat. Read once, when the page loads.
 */
export const diffScope =
   typeof window === "undefined" ? null : diffWindowScope(window.location.search);
export const filesWindow =
   typeof window === "undefined" ? null : filesWindowTarget(window.location.search);
export const filesWindowFirst: FileTarget | null = filesWindow?.path
   ? { path: filesWindow.path, start: filesWindow.line, end: filesWindow.line }
   : null;

/** The panel id of a panel window URL (`pane=panel&panel=<id>`), else null. */
export function panelWindowOf(search: string): string | null {
   const q = new URLSearchParams(search);
   return (q.get("pane") === "panel" && q.get("panel")) || null;
}
export const panelWindowId =
   typeof window === "undefined" ? null : panelWindowOf(window.location.search);
