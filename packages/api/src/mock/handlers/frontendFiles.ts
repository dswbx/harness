import { applyStatePatch } from "../../derive/state";
import { CommandError } from "../../errors";
import { MOCK_PANEL_SOURCES } from "../fixtures/panels";
import { mockHash } from "../fixtures/shared";
import type { Handlers } from "./types";

export const frontendFilesHandlers = {
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
