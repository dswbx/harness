import type { Transport } from "../../transport/transport";
import { subscribeResilient } from "../../transport/transport";
import { archiveSession, deleteSession, unarchiveSession } from "../commands";
import { expectResult, run } from "../expect";
import type { SessionApi } from "../session";

type Core = Pick<
   SessionApi,
   | "subscribe"
   | "readLogPage"
   | "prompt"
   | "cancel"
   | "warmUp"
   | "continueWithSummary"
   | "startSideThread"
   | "resolvePermission"
   | "setConfigOption"
   | "setMode"
   | "workspace"
   | "archive"
   | "unarchive"
   | "delete"
   | "authenticate"
   | "openAuthTerminal"
   | "authInTerminal"
>;

/** Prompting, Threads, permissions, Session lifecycle and sign-in. */
export const coreApi = (transport: Transport, sessionId: string): Core => ({
   subscribe: (onEvent, fromSeq = 0, signal) =>
      subscribeResilient(transport, sessionId, fromSeq, onEvent, { signal }),
   readLogPage: (fromSeq, toSeq = null) => transport.readLogPage(sessionId, fromSeq, toSeq),
   prompt: (text, attachments = [], threadId = null, commentIds = []) =>
      run(transport, {
         type: "Prompt",
         session_id: sessionId,
         thread_id: threadId,
         text,
         attachments,
         ...(commentIds.length > 0 && { comment_ids: commentIds }),
      }),
   continueWithSummary: (text, threadId = null, attachments = []) =>
      run(transport, {
         type: "ContinueWithSummary",
         session_id: sessionId,
         thread_id: threadId,
         text,
         attachments,
      }),
   startSideThread: async ({ seed = null, source, mode = null } = {}) => {
      const r = await expectResult(
         transport,
         { type: "StartSideThread", session_id: sessionId, seed, source, mode },
         "ThreadStarted",
      );
      return { thread_id: r.thread_id, forked: r.forked };
   },
   cancel: (threadId = null) =>
      run(transport, { type: "Cancel", session_id: sessionId, thread_id: threadId }),
   warmUp: () => run(transport, { type: "WarmUp", session_id: sessionId }),
   resolvePermission: (request_id, option_id, global = false) =>
      run(transport, {
         type: "ResolvePermission",
         session_id: sessionId,
         request_id,
         option_id,
         global,
      }),
   setConfigOption: (config_id, value, threadId = null) =>
      run(transport, {
         type: "SetConfigOption",
         session_id: sessionId,
         thread_id: threadId,
         config_id,
         value,
      }),
   setMode: (mode_id, threadId = null) =>
      run(transport, { type: "SetMode", session_id: sessionId, thread_id: threadId, mode_id }),
   workspace: async () => {
      const r = await expectResult(transport, { type: "ListSessions" }, "Sessions");
      return r.sessions.find((s) => s.id === sessionId)?.workspace ?? null;
   },
   archive: () => archiveSession(transport, sessionId),
   unarchive: () => unarchiveSession(transport, sessionId),
   delete: (force = false) => deleteSession(transport, sessionId, force),
   authenticate: (method_id) =>
      run(transport, { type: "Authenticate", session_id: sessionId, method_id }),
   openAuthTerminal: (method_id) =>
      run(transport, { type: "OpenAuthTerminal", session_id: sessionId, method_id }),
   authInTerminal: async (method_id, threadId = null) =>
      (
         await expectResult(
            transport,
            { type: "AuthInTerminal", session_id: sessionId, thread_id: threadId, method_id },
            "TerminalOpened",
         )
      ).terminal_id,
});
