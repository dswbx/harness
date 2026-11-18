/**
 * The Files panel's open files. A file opened by browsing (a click in the tree, a file ref) takes the one preview
 * tab (shown in italics), so browsing does not pile up tabs; a double-click pins it. `source`: a Markdown file shows
 * its source instead of the rendered page.
 */
export type FileTab = { path: string; pinned: boolean; source?: boolean };

/** `path` open: an open tab stays where it is (pinned if `pin`); else a pinned tab goes last, a preview replaces the
 * preview tab. */
export function openTab(tabs: FileTab[], path: string, pin = false): FileTab[] {
   const at = tabs.findIndex((t) => t.path === path);
   if (at >= 0) return pin && !tabs[at]?.pinned ? patchTab(tabs, path, { pinned: true }) : tabs;
   const tab: FileTab = { path, pinned: pin };
   const preview = pin ? -1 : tabs.findIndex((t) => !t.pinned);
   return preview >= 0 ? tabs.map((t, i) => (i === preview ? tab : t)) : [...tabs, tab];
}

/** Closes `path`; returns the tabs and the path to show next (the tab that took its place, else the one before). */
export function closeTab(
   tabs: FileTab[],
   path: string,
   active: string | null,
): { tabs: FileTab[]; active: string | null } {
   const at = tabs.findIndex((t) => t.path === path);
   if (at < 0) return { tabs, active };
   const rest = tabs.filter((_, i) => i !== at);
   if (active !== path) return { tabs: rest, active };
   return { tabs: rest, active: rest[Math.min(at, rest.length - 1)]?.path ?? null };
}

/** Changes the tab of `path`. */
export const patchTab = (tabs: FileTab[], path: string, patch: Partial<FileTab>): FileTab[] =>
   tabs.map((t) => (t.path === path ? { ...t, ...patch } : t));

/** Saved tabs, dropping anything malformed. */
export function parseTabs(v: unknown): FileTab[] {
   if (!Array.isArray(v)) return [];
   return v.flatMap((t) =>
      t && typeof t === "object" && typeof t.path === "string"
         ? [{ path: t.path, pinned: !!t.pinned, ...(t.source ? { source: true } : {}) }]
         : [],
   );
}

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/** Moves the tab of `path` in front of the tab of `before` (null: to the end). */
export function moveTab(tabs: FileTab[], path: string, before: string | null): FileTab[] {
   const from = tabs.findIndex((t) => t.path === path);
   const tab = tabs[from];
   if (!tab || path === before) return tabs;
   const rest = tabs.filter((_, i) => i !== from);
   const at = before === null ? rest.length : rest.findIndex((t) => t.path === before);
   if (at < 0 || at === from) return tabs;
   return [...rest.slice(0, at), tab, ...rest.slice(at)];
}
