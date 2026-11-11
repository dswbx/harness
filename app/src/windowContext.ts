/**
 * The Quick overlay's window context (ADR 0022 Phase 3): what the user was looking at when the
 * shortcut opened the overlay. The host captures it (`context.rs`); this formats the prompt box's
 * chip and the line sent with the first message.
 */

/** `WindowContext` in `crates/harness-tauri/src/context.rs`. */
export type WindowContext = {
   app: string;
   bundleId: string;
   windowTitle?: string;
   url?: string;
   pageTitle?: string;
   documentPath?: string;
   selectedText?: string;
   folder?: string;
   files?: string[];
   /** Permissions that would give more context. */
   missing: ("accessibility" | "automation")[];
};

/** Longest selected text sent (characters); the host keeps at most as much. */
const SELECTED_MAX = 2000;
/** Longest part after the app name in the chip label. */
const LABEL_MAX = 60;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** `https://www.github.com/a/b?x#y` -> `github.com/a/b`. */
export function shortUrl(url: string): string {
   try {
      const u = new URL(url);
      const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
      return `${u.host.replace(/^www\./, "")}${path}`;
   } catch {
      return url;
   }
}

/** A window title without the app's own name at its end ("App.tsx — harness — Cursor"). */
export function windowTitle(title: string, app: string): string {
   for (const sep of [" — ", " - ", " – ", " | "]) {
      const suffix = `${sep}${app}`;
      if (title.endsWith(suffix) && title.length > suffix.length)
         return title.slice(0, -suffix.length);
   }
   return title;
}

/** The chip's text: the app, then the most telling detail. */
export function contextLabel(c: WindowContext): string {
   const finder =
      c.folder && `${basename(c.folder)}${c.files?.length ? ` · ${c.files.length} selected` : ""}`;
   const title = c.windowTitle && windowTitle(c.windowTitle, c.app);
   const detail = c.url
      ? shortUrl(c.url)
      : c.documentPath
        ? basename(c.documentPath)
        : finder || title;
   return detail ? `${c.app} · ${cut(detail, LABEL_MAX)}` : c.app;
}

/** The chip's tooltip: everything that is sent. */
export function contextDetail(c: WindowContext): string {
   const lines = [c.app];
   if (c.windowTitle) lines.push(`Window: ${c.windowTitle}`);
   if (c.pageTitle) lines.push(`Page: ${c.pageTitle}`);
   if (c.url) lines.push(c.url);
   if (c.documentPath) lines.push(`File: ${c.documentPath}`);
   if (c.folder) lines.push(`Folder: ${c.folder}`);
   if (c.files?.length) lines.push(`Selected: ${c.files.map(basename).join(", ")}`);
   if (c.selectedText) lines.push(`Selected text: "${cut(c.selectedText, 200)}"`);
   if (c.missing.includes("accessibility"))
      lines.push("Allow Accessibility for the window title and selected text.");
   if (c.missing.includes("automation"))
      lines.push(`Allow Harness to control ${c.app} (Privacy & Security > Automation) for more.`);
   return lines.join("\n");
}

/** One compact line for the Agent, sent after the first message. */
export function contextPrompt(c: WindowContext): string {
   const title = c.url ? (c.pageTitle ?? c.windowTitle) : c.windowTitle;
   const parts = [`the user is looking at ${c.app}`];
   if (title) parts.push(`"${windowTitle(title, c.app)}"`);
   if (c.url) parts.push(c.url);
   if (c.documentPath) parts.push(`file ${c.documentPath}`);
   if (c.folder) parts.push(`folder ${c.folder}`);
   if (c.files?.length) parts.push(`selected files: ${c.files.join(", ")}`);
   let line = `Context: ${parts.join(", ")}.`;
   if (c.selectedText) line += ` Selected text: "${cut(c.selectedText, SELECTED_MAX)}"`;
   return line;
}
