import { baseName } from "../../derive/paths";
import { CommandError } from "../../errors";
import type { InstructionsEntry, InstructionsScope } from "../../generated";
import type { MockTransport } from "../mock";
import type { Handlers } from "./types";

// Core: `instructions.rs`. Saved texts by scope key ("global" or the repository folder).

const key = (scope: InstructionsScope) => (scope.type === "global" ? "global" : scope.path);
const lineCount = (text: string) => (text.trim() ? text.trim().split("\n").length : 0);

/** Folders that "no longer exist" in the mock. */
const MISSING = new Set(["/Users/me/old-site"]);

/** Made-up starting texts, so the Settings list shows each case. */
export function mockInstructions(): Map<string, string> {
   return new Map([
      ["global", "Answer briefly.\nAsk before you add a dependency."],
      ["/Users/me/harness", "Run `bun run test` before you say a change is done."],
      ["/Users/me/old-site", "Use the `content/` folder for posts."],
   ]);
}

function list(mock: MockTransport): InstructionsEntry[] {
   const folders = new Set<string>();
   for (const s of mock.sessions) if (!s.quick) folders.add(s.workspace.repo_root ?? s.folder);
   for (const k of mock.instructions.keys()) if (k !== "global") folders.add(k);
   const repos = [...folders]
      .map(
         (path): InstructionsEntry => ({
            scope: { type: "repo", path },
            name: baseName(path),
            lines: lineCount(mock.instructions.get(path) ?? ""),
            folder_exists: !MISSING.has(path),
         }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
   const global: InstructionsEntry = {
      scope: { type: "global" },
      name: "Global",
      lines: lineCount(mock.instructions.get("global") ?? ""),
      folder_exists: true,
   };
   return [global, ...repos];
}

export const instructionsHandlers = {
   ListInstructions: (mock) => ({ type: "Instructions", entries: list(mock) }),
   GetInstructions: (mock, cmd) => ({
      type: "InstructionsText",
      text: (mock.instructions.get(key(cmd.scope)) ?? "").trim(),
   }),
   SetInstructions: (mock, cmd) => {
      if (cmd.scope.type === "repo" && !cmd.scope.path.startsWith("/"))
         throw new CommandError("invalid", `${cmd.scope.path}: not an absolute path`);
      if (cmd.text.trim()) mock.instructions.set(key(cmd.scope), cmd.text);
      else mock.instructions.delete(key(cmd.scope));
      return { type: "Ok" };
   },
   MoveInstructions: (mock, cmd) => {
      const text = mock.instructions.get(cmd.from);
      if (text === undefined)
         throw new CommandError("not_found", `no instructions for ${cmd.from}`);
      if (mock.instructions.has(cmd.to))
         throw new CommandError("conflict", `${cmd.to} already has instructions`);
      mock.instructions.delete(cmd.from);
      mock.instructions.set(cmd.to, text);
      return { type: "Ok" };
   },
} satisfies Partial<Handlers>;
