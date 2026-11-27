/**
 * Diff range; `null` bounds mean "where the changes start" / "the working tree now".
 * `sel` is the commits-pane selection it came from (commit shas, "all", "wip"); absent for other ranges (a Turn's changes).
 */
export type DiffScope = { from: string | null; to: string | null; label: string; sel?: string[] };

/** Every change since where the changes start, the working tree included. */
export const ALL_CHANGES: DiffScope = { from: null, to: null, label: "All changes", sel: ["all"] };

/** What a diff window shows: a Session's Workspace, or a folder with no Session (Folder Diff; `folder` absolute). */
export type DiffWindowTarget = { sessionId: string } | { folder: string };

/**
 * URL of a pop-out diff window. It boots through the app entry: a Session's like any solo View window, a folder's
 * through the host's Folder Diff route. Stored in window state and reloads, so keep the format.
 */
export function diffWindowUrl(target: DiffWindowTarget, scope: DiffScope): string {
   const q = new URLSearchParams(
      "sessionId" in target
         ? { session: target.sessionId, solo: "1", pane: "diff", label: scope.label }
         : { folder: target.folder, pane: "diff", label: scope.label },
   );
   if (scope.from) q.set("from", scope.from);
   if (scope.to) q.set("to", scope.to);
   if (scope.sel) q.set("sel", scope.sel.join(","));
   return `/?${q}`;
}

/** The diff window's scope, or null when this page is no diff window. */
export function diffWindowScope(search: string): DiffScope | null {
   const q = new URLSearchParams(search);
   if (q.get("pane") !== "diff") return null;
   const sel = q.get("sel");
   return {
      from: q.get("from"),
      to: q.get("to"),
      label: q.get("label") ?? "Changes",
      ...(sel && { sel: sel.split(",") }),
   };
}

/** The folder of a Folder Diff window, or null when this page is none. */
export function folderDiffWindow(search: string): string | null {
   const q = new URLSearchParams(search);
   return q.get("pane") === "diff" ? q.get("folder") || null : null;
}
