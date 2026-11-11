import type { AttachmentInput } from "@harness/api";

/**
 * The Quick overlay's window context (ADR 0022 Phase 3): what the user is looking at in another app
 * while the overlay is open. The host polls it (`context.rs`, `overlay.rs`); this formats the prompt
 * box's chip and the Markdown attachment sent with each message.
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

/** Same app, window, document and page: a chip the user removed stays removed for it. */
export function contextKey(c: WindowContext): string {
   return [c.bundleId, c.windowTitle, c.documentPath, c.url].map((v) => v ?? "").join("\n");
}

const BROWSERS =
   /^(com\.apple\.Safari|com\.google\.Chrome|company\.thebrowser\.Browser|com\.brave\.Browser|com\.microsoft\.edgemac|org\.chromium\.Chromium|com\.vivaldi\.Vivaldi)/;

/** The chip's link to the System Settings pane that would give more: Automation first (the URL, the folder). */
export function contextAction(
   c: WindowContext,
): { label: string; pane: "accessibility" | "automation" } | undefined {
   if (c.missing.includes("automation"))
      return {
         label: BROWSERS.test(c.bundleId) ? "Allow browser access" : `Allow access to ${c.app}`,
         pane: "automation",
      };
   if (c.missing.includes("accessibility"))
      return { label: "Allow more context", pane: "accessibility" };
   return undefined;
}

/** Longest attachment name (characters, with ".md"). */
const NAME_MAX = 60;

/** The attachment's name, e.g. "Context - Google Chrome · github.com.md": no path characters. */
export function contextName(c: WindowContext): string {
   let host: string | undefined;
   try {
      host = c.url ? new URL(c.url).host.replace(/^www\./, "") : undefined;
   } catch {
      host = undefined;
   }
   const title = c.windowTitle && windowTitle(c.windowTitle, c.app);
   const detail =
      host ?? (c.documentPath ? basename(c.documentPath) : c.folder ? basename(c.folder) : title);
   const raw = `Context - ${c.app}${detail ? ` · ${detail}` : ""}`;
   // Path characters and control characters (all whitespace) become one space.
   const safe = raw
      .replace(/[/\\:*?"<>|\s]+/g, " ")
      .replace(/\p{Cc}/gu, "")
      .trim();
   return `${cut(safe, NAME_MAX - 3)}.md`;
}

/** What the Agent gets: a short Markdown file with everything the chip's tooltip lists. */
export function contextMarkdown(c: WindowContext): string {
   const lines = [
      "# Window context",
      "",
      "What the user is looking at in another app (from the Harness Quick overlay).",
      "",
      `- App: ${c.app}`,
   ];
   if (c.windowTitle) lines.push(`- Window: ${c.windowTitle}`);
   if (c.pageTitle) lines.push(`- Page: ${c.pageTitle}`);
   if (c.url) lines.push(`- URL: ${c.url}`);
   if (c.documentPath) lines.push(`- File: ${c.documentPath}`);
   if (c.folder) lines.push(`- Folder: ${c.folder}`);
   if (c.files?.length) lines.push("- Selected files:", ...c.files.map((f) => `  - ${f}`));
   if (c.selectedText) {
      const quoted = cut(c.selectedText, SELECTED_MAX)
         .split("\n")
         .map((l) => (l ? `> ${l}` : ">"));
      lines.push("", "Selected text:", "", ...quoted);
   }
   return `${lines.join("\n")}\n`;
}

/** Base64 of a string's UTF-8 bytes. */
export function base64(text: string): string {
   const bytes = new TextEncoder().encode(text);
   let bin = "";
   for (const b of bytes) bin += String.fromCharCode(b);
   return btoa(bin);
}

/** The context as a pasted Markdown file: the core stores it and gives it to the Agent. */
export function contextAttachment(c: WindowContext): AttachmentInput {
   return {
      type: "data",
      name: contextName(c),
      mime: "text/markdown",
      data: base64(contextMarkdown(c)),
   };
}
