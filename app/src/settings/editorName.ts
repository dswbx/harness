import type { Editor } from "@harness/api";

/** Menu label of an editor. */
export const editorName = (e: Editor): string =>
   ({
      vscode: "VS Code",
      cursor: "Cursor",
      windsurf: "Windsurf",
      zed: "Zed",
      custom: "your editor",
      system: "the default app",
   })[e.type];
