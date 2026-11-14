import { diffWindowScope } from "../features/changes/DiffWindow";
import { type FileTarget, filesWindowTarget } from "../features/files/FilesPanel";

/**
 * Which window this page is: a pop-out Diff window (`pane=diff` in its URL), a pop-out Files window
 * (`pane=files`) or, with neither, the chat. Read once, when the page loads.
 */
export const diffScope =
   typeof window === "undefined" ? null : diffWindowScope(window.location.search);
export const filesWindow =
   typeof window === "undefined" ? null : filesWindowTarget(window.location.search);
export const filesWindowFirst: FileTarget | null = filesWindow?.path
   ? { path: filesWindow.path, start: filesWindow.line, end: filesWindow.line }
   : null;
