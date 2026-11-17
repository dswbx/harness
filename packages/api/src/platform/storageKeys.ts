/**
 * Every localStorage key (or key family) the app writes, in one list: the pin test fails when one
 * is added, renamed or dropped, so a change shows up in review. Keys are never renamed: users have
 * data under them. Old formats are read as they are; new keys use the `harness.` prefix.
 *
 * Pattern placeholders: `{session}` (a Session id: the key is per Session and `forgetSession`
 * removes it), `{thread}` and `{name}` (the rest of the key).
 */
export type KeyScope = "app" | "session";
export type KeyDef = {
   pattern: string;
   scope: KeyScope;
   /** Who reads and writes it. */
   owner: string;
   /** Kept only to clean up or migrate: nothing writes it any more. */
   legacy?: boolean;
};

const app = (pattern: string, owner: string, legacy?: boolean): KeyDef => ({
   pattern,
   scope: "app",
   owner,
   ...(legacy ? { legacy } : {}),
});
const session = (pattern: string, owner: string, legacy?: boolean): KeyDef => ({
   pattern,
   scope: "session",
   owner,
   ...(legacy ? { legacy } : {}),
});

export const STORAGE_KEYS: readonly KeyDef[] = [
   app("harness.appearance", "app/appearance"),
   app("harness.themes", "app/appearance"),
   app("harness.sidebarOpen", "app/shell"),
   app("harness.sidebarWidth", "app/shell"),
   app("harness.recentFolders", "app/composer"),
   app("harness.composer.worktree", "app/composer"),
   app("harness.overlay.agent", "app/quick"),
   app("harness.sessionList.sort", "app/sessions"),
   app("harness.sessionList.display", "app/sessions"),
   app("harness.sessionList.group", "app/sessions"),
   app("harness.sessionList.collapsed", "app/sessions"),
   app("harness.sessionList.folderOrder", "app/sessions"),
   app("harness.sharedArtifacts.seen", "app/shared-artifacts"),
   app("harness.sharedArtifacts.collapsed", "app/shared-artifacts"),
   app("harness.terminal.optionIsMeta", "frontend-chat/terminal"),
   app("harness.chat.references.list.pr", "frontend-chat/references"),
   app("harness.chat.references.list.code", "frontend-chat/references"),
   app("harness.chat.references.list.link", "frontend-chat/references"),
   app("harness.chat.guessInlineCode", "frontend-chat/markdown"),
   app("harness.chat.wrapCode", "frontend-chat/markdown"),
   app("harness.chat.toolDisplay", "frontend-chat", true),
   app("harness:shared-artifact-side-width", "frontend-chat/artifacts"),
   app("harness:diff-split", "frontend-chat/changes"),
   app("harness:diff-file-view", "frontend-chat/changes"),
   app("harness:diff-wrap", "frontend-chat/changes"),
   app("harness:diff-sidebar-width", "frontend-chat/changes"),
   app("harness:commits-pane-height", "frontend-chat/changes"),
   app("harness:files-tree-width", "frontend-chat/files"),
   app("harness:window-frame:{name}", "api/platform/window"),
   session("harness.chat.layout.{session}", "frontend-chat/shell/dock"),
   session("harness.chat.sideThreads.{session}", "frontend-chat/sideChats"),
   session("harness.chat.panel.{session}", "frontend-chat/shell/dock", true),
   session("harness.files.{session}", "frontend-chat/files"),
   session("harness.changes.seen.{session}", "frontend-chat/changes"),
   session("harness.review-comments.{session}", "frontend-chat/review"),
   session("harness.review-comments.{session}#{thread}", "frontend-chat/review"),
   session("harness.draft.{session}", "api/contract/drafts"),
   session("harness.draft.{session}#{thread}", "api/contract/drafts"),
];

export type KeyMatch = { def: KeyDef; session: string | null };

const compiled = STORAGE_KEYS.map((def) => {
   const re = def.pattern
      .split(/(\{session\}|\{thread\}|\{name\})/)
      .map((p) =>
         p === "{session}" ? "([^#]+)" : p === "{thread}" || p === "{name}" ? "(.+)" : escapeRe(p),
      )
      .join("");
   return { def, re: new RegExp(`^${re}$`), hasSession: def.pattern.includes("{session}") };
});

function escapeRe(s: string): string {
   return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The registry entry a concrete key belongs to (and its Session id); null when unregistered. */
export function matchKey(key: string): KeyMatch | null {
   for (const { def, re, hasSession } of compiled) {
      const m = re.exec(key);
      if (m) return { def, session: hasSession ? (m[1] ?? null) : null };
   }
   return null;
}
