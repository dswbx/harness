import { CommandError } from "../../errors";
import type { McpServerDef, PermissionRule } from "../../generated";
import { MOCK_THEME } from "../fixtures/theme";
import type { Handlers } from "./types";

export const settingsHandlers = {
   ListMcpServers: (mock) => {
      return { type: "McpServers", servers: [...mock.mcp] };
   },
   SaveMcpServer: (mock, cmd) => {
      const slug = cmd.server.name
         .toLowerCase()
         .replace(/[^a-z0-9]+/g, "-")
         .replace(/^-|-$/g, "");
      const id = cmd.server.id || slug;
      // Core: `McpLibrary::save`. A new server (no id) whose slug is taken is a `conflict`; the
      // rest are plain (internal) errors.
      if (!cmd.server.name.trim()) throw new CommandError("internal", "the server needs a name");
      if (id === "harness")
         throw new CommandError("internal", '"harness" is reserved for the Harness MCP');
      if (!cmd.server.id && mock.mcp.some((x) => x.id === id))
         throw new CommandError(
            "conflict",
            `an MCP server named ${JSON.stringify(cmd.server.name.trim())} already exists`,
         );
      // Secret values never come back: keep only the key names.
      const server: McpServerDef = {
         ...cmd.server,
         id,
         secret_keys: cmd.server.secret_keys ?? [],
      };
      mock.mcp = [...mock.mcp.filter((s) => s.id !== id), server];
      return { type: "McpServerSaved", server };
   },
   RemoveMcpServer: (mock, cmd) => {
      mock.mcp = mock.mcp.filter((s) => s.id !== cmd.server_id);
      return { type: "Ok" };
   },
   GetAppSetting: (mock, cmd) => {
      return { type: "Json", value: mock.appSettings[cmd.key] ?? null };
   },
   SetAppSetting: (mock, cmd) => {
      mock.appSettings[cmd.key] = cmd.value;
      return { type: "Ok" };
   },
   FetchJson: (_mock, cmd) => {
      // No network in the mock: any tweakcn theme URL gets a small sample registry item.
      if (!/tweakcn\.com\/r\/themes\//.test(cmd.url))
         throw new CommandError(
            "internal",
            `fetch ${cmd.url}: The requested URL returned error: 404`,
         );
      return { type: "Json", value: MOCK_THEME };
   },
   GetWorktreeDir: (mock) => {
      return { type: "WorktreeDir", dir: mock.worktreeDir };
   },
   SetWorktreeDir: (mock, cmd) => {
      mock.worktreeDir = cmd.dir?.trim() || ".harness";
      return { type: "Ok" };
   },
   GetEditor: (mock) => {
      return { type: "Editor", editor: mock.editor };
   },
   SetEditor: (mock, cmd) => {
      mock.editor = cmd.editor;
      return { type: "Ok" };
   },
   ExportPlan: (mock, cmd) => {
      if (cmd.open_in_editor && !mock.editor)
         throw new CommandError("invalid", "choose an editor in Settings first");
      const name = cmd.name.toLowerCase().replace(/[^a-z0-9-]/g, "");
      return { type: "PlanFile", path: `/mock/plans/${name}.md` };
   },
   OpenInEditor: (mock, cmd) => {
      if (!mock.editor) throw new CommandError("invalid", "choose an editor in Settings first");
      mock.opened.push({ path: cmd.path ?? null, line: cmd.line ?? null });
      console.info(
         "[mock] open in editor",
         mock.editor.type,
         cmd.path ?? "(folder)",
         cmd.line ?? "",
      );
      return { type: "Ok" };
   },
   ListPermissionRules: (mock) => {
      return { type: "PermissionRules", rules: [...mock.rules] };
   },
   AddPermissionRule: (mock, cmd) => {
      const rule: PermissionRule = { ...cmd.rule, id: `rule-${++mock.ruleN}` };
      mock.rules.push(rule);
      return { type: "PermissionRuleAdded", rule };
   },
   RemovePermissionRule: (mock, cmd) => {
      mock.rules = mock.rules.filter((r) => r.id !== cmd.rule_id);
      return { type: "Ok" };
   },
} satisfies Partial<Handlers>;
