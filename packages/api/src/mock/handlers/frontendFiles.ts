import { applyStatePatch } from "../../derive/state";
import { CommandError } from "../../errors";
import { MOCK_PANEL_SOURCES } from "../fixtures/panels";
import { mockHash } from "../fixtures/shared";
import type { MockTransport } from "../mock";
import type { Handlers } from "./types";

/** The input of the live `render_ui` item `id` in a mock Session, like the core's projection. */
const liveItem = (mock: MockTransport, sessionId: string, id: string): Record<string, unknown> => {
   let live: Record<string, unknown> | null = null;
   for (const e of mock.logs.get(sessionId) ?? []) {
      const k = e.kind;
      if (k.type === "FrontendToolOutput" && k.tool === "render_ui") {
         const input = (k.input ?? {}) as Record<string, unknown>;
         if (input.id !== id) continue;
         live = input.remove === true ? null : input;
      } else if (k.type === "PanelDeleted" && k.tool === "render_ui" && k.id === id) {
         live = null;
      }
   }
   if (!live) throw new CommandError("not_found", `no render_ui item with id "${id}"`);
   return live;
};

const isShared = (input: Record<string, unknown>) =>
   typeof input.source === "string" && input.source.startsWith("shared:");

/** User title: trimmed, whitespace collapsed, at most 80 characters; empty is none. */
const cleanTitle = (t: string | null | undefined) =>
   t?.split(/\s+/).filter(Boolean).join(" ").slice(0, 80) || null;

export const frontendFilesHandlers = {
   EditPanel: (mock, cmd) => {
      mock.session(cmd.session_id);
      const input = liveItem(mock, cmd.session_id, cmd.item_id);
      if (isShared(input))
         throw new CommandError("invalid", `${cmd.item_id} is a shared artifact: rename it there`);
      mock.emit(cmd.session_id, {
         type: "PanelEdited",
         tool: "render_ui",
         id: cmd.item_id,
         title: cleanTitle(cmd.title),
         icon: cmd.icon?.trim().slice(0, 40) || null,
      });
      return { type: "Ok" };
   },
   DeletePanel: (mock, cmd) => {
      mock.session(cmd.session_id);
      const input = liveItem(mock, cmd.session_id, cmd.item_id);
      if (isShared(input))
         throw new CommandError(
            "invalid",
            `${cmd.item_id} is a shared artifact: detach it instead`,
         );
      if (typeof input.source === "string")
         mock.panelFiles.get(cmd.session_id)?.delete(input.source);
      mock.emit(cmd.session_id, { type: "PanelDeleted", tool: "render_ui", id: cmd.item_id });
      return { type: "Ok" };
   },
   AnswerFrontendRequest: (mock, cmd) => {
      mock.frontendRequests.get(cmd.request_id)?.(cmd.answer);
      mock.frontendRequests.delete(cmd.request_id);
      return { type: "Ok" };
   },
   FrontendRead: (mock, cmd) => {
      const c = mock.frontendFiles.get(cmd.session_id)?.get(cmd.path);
      if (c === undefined) throw new CommandError("internal", `no such file: ${cmd.path}`);
      return { type: "FileContent", content: c };
   },
   PanelSourceRead: (mock, cmd) => {
      const content =
         mock.panelFiles.get(cmd.session_id)?.get(cmd.name) ?? MOCK_PANEL_SOURCES[cmd.name];
      if (content === undefined)
         throw new CommandError("not_found", `source "${cmd.name}" does not exist in panels_dir`);
      const mtime_ms =
         mock.panelMtimes.get(`${cmd.session_id}/${cmd.name}`) ?? Date.now() - 3 * 3_600_000;
      const path = `/Users/mock/.harness-dev/sessions/${cmd.session_id}/panels/${cmd.name}`;
      return { type: "PanelSource", content, hash: mockHash(content), mtime_ms, path };
   },
   GetState: (mock, cmd) => {
      return { type: "State", state: mock.states.get(cmd.session_id) ?? {} };
   },
   PatchState: (mock, cmd) => {
      const next = applyStatePatch(mock.states.get(cmd.session_id) ?? {}, cmd.ops);
      mock.states.set(cmd.session_id, next);
      mock.emit(cmd.session_id, { type: "StateChanged", ops: cmd.ops, by: "user" });
      return { type: "Ok" };
   },
   FrontendReadImage: (mock, cmd) => {
      const c = mock.frontendFiles.get(cmd.session_id)?.get(cmd.path);
      if (c === undefined) throw new CommandError("internal", `no such image: ${cmd.path}`);
      return { type: "Attachment", mime: "image/svg+xml", data: btoa(c) };
   },
   FrontendWrite: (mock, cmd) => {
      mock.session(cmd.session_id);
      const m = mock.frontendFiles.get(cmd.session_id) ?? new Map();
      m.set(cmd.path, cmd.content);
      mock.frontendFiles.set(cmd.session_id, m);
      return { type: "Ok" };
   },
   FrontendList: (mock, cmd) => {
      const dir = (cmd.dir ?? "").replace(/^\/|\/$/g, "");
      const files = [...(mock.frontendFiles.get(cmd.session_id)?.keys() ?? [])].filter(
         (p) => !dir || p.startsWith(`${dir}/`),
      );
      return { type: "Files", files };
   },
   ReportFrontendError: (mock, cmd) => {
      mock.session(cmd.session_id);
      // Like the core, a repeat of the same error is ignored.
      const repeat = mock.logs
         .get(cmd.session_id)!
         .some(
            (e) =>
               e.kind.type === "FrontendError" &&
               e.kind.tool === cmd.tool &&
               e.kind.item === cmd.item &&
               e.kind.message === cmd.message,
         );
      if (!repeat) {
         mock.emit(cmd.session_id, {
            type: "FrontendError",
            tool: cmd.tool,
            item: cmd.item,
            message: cmd.message,
         });
      }
      return { type: "Ok" };
   },
} satisfies Partial<Handlers>;
