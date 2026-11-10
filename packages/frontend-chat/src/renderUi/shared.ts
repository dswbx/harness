import { type Schema, s } from "jsonv-ts";

/** Pieces of the render_ui catalog shared by the component groups. */
export const tone = s.string({
   enum: ["neutral", "info", "success", "warning", "error"],
   description: "Accent. Default neutral.",
});
/** The core copies local image files named here into the Session (ADR 0012, level 1). */
export const imageSrc = s.string({
   format: "harness-image",
   description: "Image file path (relative to the workspace, or absolute) or an https URL.",
});
export const image = s.object({
   src: imageSrc,
   alt: s.string({ description: "What the image shows." }),
   caption: s.string().optional(),
});

/** Icons components may show (lucide icons, by these names). */
export const ICONS = [
   "check",
   "x",
   "alert",
   "info",
   "help",
   "file",
   "folder",
   "code",
   "terminal",
   "bug",
   "test",
   "package",
   "git-branch",
   "git-commit",
   "git-pull-request",
   "git-merge",
   "rocket",
   "server",
   "database",
   "globe",
   "lock",
   "key",
   "user",
   "users",
   "clock",
   "calendar",
   "search",
   "link",
   "settings",
   "star",
   "zap",
   "list",
   "message",
   "chart",
] as const;
export const icon = s.string({ enum: ICONS, description: "Icon name." });
export const tooltip = s.string({
   description:
      "Extra detail shown on hover or keyboard focus. Not on touch screens: never the only place for important information.",
});
export const mono = s.boolean({ description: "Monospace, e.g. ids, hashes, durations." });
export type Example = { node: unknown; state?: unknown };
export type Entry = {
   description: string;
   children: boolean;
   props: Schema;
   /** Props that write to the Session State: `{ "$bindState": "/path" }`. */
   bind?: readonly string[];
   /** Events this component fires (`on`). */
   events?: readonly string[];
   /** Shown in the gallery and tested. */
   example: Example;
};

export const demoImage = (label: string, hue: number) =>
   "data:image/svg+xml;base64," +
   btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="hsl(${hue} 60% 45%)"/><text x="320" y="212" font-family="sans-serif" font-size="32" fill="white" text-anchor="middle">${label}</text></svg>`,
   );
