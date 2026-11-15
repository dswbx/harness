import { applyStatePatch } from "../../derive/state";
import { CommandError } from "../../errors";
import type { SharedArtifactEntry, SharedKind } from "../../generated";
import { MOCK_PANEL_SOURCES } from "../fixtures/panels";
import { type MockShared, mockHash, sharedId } from "../fixtures/shared";
import type { MockTransport } from "../mock";
import type { Handlers } from "./types";

export function sharedArtifact(mock: MockTransport, id: string): MockShared {
   const a = mock.shared.get(id);
   if (!a) throw new CommandError("not_found", `no Shared Artifact "${id}"`);
   return a;
}

/** A new Shared Artifact made by Session `sid`, attached to it. */
export function createShared(
   mock: MockTransport,
   sid: string,
   title: string,
   kind: SharedKind,
   content: string,
   state: unknown,
   origin?: string | null,
): MockShared {
   const now = Date.now();
   const s = mock.session(sid);
   const a: MockShared = {
      meta: {
         v: 1,
         id: sharedId(title),
         title,
         kind,
         created_ms: now,
         updated_ms: now,
         created_by: { session_id: sid, session_title: s.title, ...(origin && { origin }) },
         attached: [sid],
      },
      content,
      state: structuredClone(state),
      mtime: now,
   };
   mock.shared.set(a.meta.id, a);
   return a;
}

/** The core's listing: newest first; a query matches title or content, title matches first, at most 20. */
export function listShared(mock: MockTransport, query: string | null): SharedArtifactEntry[] {
   const all = [...mock.shared.values()].sort((a, b) => b.meta.updated_ms - a.meta.updated_ms);
   const q = query?.trim().toLowerCase();
   if (!q) return all.map((a) => ({ meta: structuredClone(a.meta) }));
   const title = all.filter((a) => a.meta.title.toLowerCase().includes(q));
   const text = all.filter((a) => !title.includes(a) && a.content.toLowerCase().includes(q));
   return [...title, ...text].slice(0, 20).map((a) => {
      const at = a.content.toLowerCase().indexOf(q);
      const snippet =
         at < 0
            ? null
            : a.content
                 .slice(Math.max(0, at - 30), at + q.length + 30)
                 .replace(/\s+/g, " ")
                 .trim();
      return { meta: structuredClone(a.meta), snippet };
   });
}

export const sharedHandlers = {
   ListSharedArtifacts: (mock, cmd) => {
      return { type: "SharedArtifactList", artifacts: listShared(mock, cmd.query ?? null) };
   },
   SharedArtifactRead: (mock, cmd) => {
      const a = sharedArtifact(mock, cmd.id);
      return {
         type: "SharedArtifact",
         meta: structuredClone(a.meta),
         content: a.content,
         hash: mockHash(a.content),
         mtime_ms: a.mtime,
         state: structuredClone(a.state),
         dir: `/Users/me/.harness/shared/${a.meta.id}`,
      };
   },
   ShareArtifact: (mock, cmd) => {
      const sid = cmd.session_id;
      const out = [...(mock.logs.get(sid) ?? [])]
         .reverse()
         .find(
            (e) =>
               e.kind.type === "FrontendToolOutput" &&
               e.kind.tool === "render_ui" &&
               (e.kind.input as { id?: unknown } | null)?.id === cmd.item_id,
         );
      if (out?.kind.type !== "FrontendToolOutput")
         throw new CommandError("not_found", `no render_ui item with id "${cmd.item_id}"`);
      const input = out.kind.input as Record<string, unknown>;
      const title = typeof input.title === "string" ? input.title : cmd.item_id;
      const sessionState = mock.states.get(sid) ?? {};
      let a: MockShared;
      if (typeof input.source === "string") {
         if (input.source.startsWith("shared:"))
            throw new CommandError("conflict", `${cmd.item_id} is already shared`);
         const content =
            mock.panelFiles.get(sid)?.get(input.source) ?? MOCK_PANEL_SOURCES[input.source];
         if (content === undefined)
            throw new CommandError(
               "not_found",
               `source "${input.source}" does not exist in panels_dir`,
            );
         const html = input.source.endsWith(".html");
         const ui = input.source.endsWith(".json");
         a = createShared(
            mock,
            sid,
            title,
            html ? "html" : ui ? "ui" : "md",
            content,
            html || ui ? sessionState : {},
         );
         mock.panelFiles.get(sid)?.delete(input.source);
      } else {
         a = createShared(
            mock,
            sid,
            title,
            "ui",
            JSON.stringify({ root: input.root, files: {} }),
            sessionState,
         );
      }
      const { root: _, ...rest } = input;
      const call = `mock-share-${++mock.cardN}`;
      mock.emit(
         sid,
         {
            type: "FrontendToolOutput",
            tool: "render_ui",
            call_id: call,
            path: `tools/render_ui/${call}.json`,
            input: { ...rest, source: `shared:${a.meta.id}` },
         },
         out.thread_id,
      );
      mock.emit(sid, { type: "ArtifactAttached", id: a.meta.id, by: "user" }, null);
      mock.emitApp({ type: "SharedArtifactsChanged" });
      return { type: "SharedArtifactInfo", meta: structuredClone(a.meta) };
   },
   ShareMarkdown: (mock, cmd) => {
      if (!cmd.markdown.trim()) throw new CommandError("invalid", "the Markdown is empty");
      const title =
         cmd.title?.trim() || /^#+\s*(.+)$/m.exec(cmd.markdown)?.[1]?.trim() || "Shared snippet";
      const a = createShared(mock, cmd.session_id, title, "md", cmd.markdown, {}, cmd.origin);
      mock.emit(cmd.session_id, { type: "ArtifactAttached", id: a.meta.id, by: "user" }, null);
      mock.emitApp({ type: "SharedArtifactsChanged" });
      return { type: "SharedArtifactInfo", meta: structuredClone(a.meta) };
   },
   AttachSharedArtifact: (mock, cmd) => {
      mock.session(cmd.session_id);
      const a = sharedArtifact(mock, cmd.id);
      if (!a.meta.attached?.includes(cmd.session_id)) {
         a.meta.attached = [...(a.meta.attached ?? []), cmd.session_id];
         mock.emit(cmd.session_id, { type: "ArtifactAttached", id: cmd.id, by: "user" }, null);
         mock.emitApp({ type: "SharedArtifactsChanged" });
      }
      return { type: "SharedArtifactInfo", meta: structuredClone(a.meta) };
   },
   DetachSharedArtifact: (mock, cmd) => {
      mock.session(cmd.session_id);
      const a = mock.shared.get(cmd.id);
      if (a) a.meta.attached = (a.meta.attached ?? []).filter((x) => x !== cmd.session_id);
      mock.emit(cmd.session_id, { type: "ArtifactDetached", id: cmd.id, by: "user" }, null);
      mock.emitApp({ type: "SharedArtifactsChanged" });
      return { type: "Ok" };
   },
   RenameSharedArtifact: (mock, cmd) => {
      const a = sharedArtifact(mock, cmd.id);
      const title = cmd.title.trim();
      if (!title) throw new CommandError("invalid", "a title is required");
      a.meta.title = title;
      a.meta.updated_ms = Date.now();
      mock.emitApp({ type: "SharedArtifactsChanged" });
      mock.emitApp({ type: "SharedArtifactChanged", id: cmd.id });
      return { type: "SharedArtifactInfo", meta: structuredClone(a.meta) };
   },
   DeleteSharedArtifact: (mock, cmd) => {
      sharedArtifact(mock, cmd.id);
      mock.shared.delete(cmd.id);
      mock.emitApp({ type: "SharedArtifactsChanged" });
      mock.emitApp({ type: "SharedArtifactChanged", id: cmd.id });
      return { type: "Ok" };
   },
   OpenSharedInEditor: (mock, cmd) => {
      const a = sharedArtifact(mock, cmd.id);
      if (!mock.editor) throw new CommandError("invalid", "choose an editor in Settings first");
      const file = { md: "content.md", html: "content.html", ui: "ui.json" }[a.meta.kind];
      const path = `/Users/me/.harness/shared/${a.meta.id}/${file}`;
      mock.opened.push({ path, line: null });
      console.info("[mock] open in editor", mock.editor.type, path);
      return { type: "Ok" };
   },
   PatchArtifactState: (mock, cmd) => {
      const a = sharedArtifact(mock, cmd.id);
      if (cmd.session_id && !a.meta.attached?.includes(cmd.session_id))
         throw new CommandError(
            "conflict",
            `shared artifact ${cmd.id} is not attached to this Session: attach it first (artifact_attach)`,
         );
      a.state = applyStatePatch(a.state, cmd.ops);
      a.meta.updated_ms = Date.now();
      if (cmd.session_id)
         mock.emit(
            cmd.session_id,
            { type: "ArtifactStateChanged", id: cmd.id, ops: cmd.ops, by: "user" },
            null,
         );
      mock.emitApp({ type: "SharedArtifactChanged", id: cmd.id });
      return { type: "State", state: structuredClone(a.state) };
   },
} satisfies Partial<Handlers>;
