import { ALL_CHANGES, type Commit, type DiffScope } from "@harness/api";

/** Commits-pane items besides the commits themselves. */
export const ALL = "all";
export const WIP = "wip";

// The range type and ALL_CHANGES live in `@harness/api`: the host opens Folder Diff windows with them too.
export { ALL_CHANGES, type DiffScope };
export const UNCOMMITTED: DiffScope = {
   from: "HEAD",
   to: null,
   label: "Uncommitted changes",
   sel: [WIP],
};

/** Click on a commits-pane item; `multi` (⌘/Ctrl/⇧) adds or removes it. ALL never combines. */
export function toggleSelection(sel: readonly string[], id: string, multi: boolean): string[] {
   if (!multi || id === ALL) return [id];
   const base = sel.filter((s) => s !== ALL);
   const next = base.includes(id) ? base.filter((s) => s !== id) : [...base, id];
   return next.length ? next : [ALL];
}

/**
 * The range a selection shows: from the parent of the oldest selected commit to the newest one, or to the working
 * tree when Uncommitted is selected too. Commits in between are included (a git range, not a cherry-pick).
 * `commits` is newest first, as GitLog returns them.
 */
export function selectionScope(sel: readonly string[], commits: readonly Commit[]): DiffScope {
   if (!sel.length || sel.includes(ALL)) return ALL_CHANGES;
   const wip = sel.includes(WIP);
   const picked = commits.filter((c) => sel.includes(c.sha));
   if (!picked.length) return wip ? UNCOMMITTED : ALL_CHANGES;
   const newest = picked[0]!;
   const oldest = picked.at(-1)!;
   const parts = [...(wip ? ["Uncommitted"] : []), ...picked.map((c) => c.short)];
   return {
      from: `${oldest.sha}^`,
      to: wip ? null : newest.sha,
      label:
         picked.length === 1 && !wip
            ? `${newest.short} ${newest.subject}`
            : parts.length <= 3
              ? parts.join(" + ")
              : `${parts.length} selected`,
      sel: [...(wip ? [WIP] : []), ...picked.map((c) => c.sha)],
   };
}
