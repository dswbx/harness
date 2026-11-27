import { isModeOption } from "../../derive/mode";
import { CommandError } from "../../errors";
import type { Command, CommandResult, PermissionRule } from "../../generated";
import type { MockTransport } from "../mock";
import { ASKING_MODE } from "../sideMode";
import type { Handlers } from "./types";

const setOption = (
   mock: MockTransport,
   cmd: Extract<Command, { type: "SetConfigOption" | "SetMode" }>,
): CommandResult => {
   const sid = cmd.session_id;
   const log = mock.logs.get(sid)!;
   const main = log.find((e) => e.kind.type === "ThreadStarted" && e.kind.main)?.thread_id;
   type Opt = { id: string; category?: string; currentValue: string };
   const latest = (t: string | null | undefined) => {
      for (let i = log.length - 1; i >= 0; i--) {
         const k = log[i]!.kind;
         if (
            k.type === "ConfigOptionsChanged" &&
            log[i]!.thread_id === t &&
            Array.isArray(k.options)
         )
            return k.options as Opt[];
      }
      return null;
   };
   const mainOpts = latest(main);
   const id = cmd.type === "SetMode" ? mainOpts?.find(isModeOption)?.id : cmd.config_id;
   const value = cmd.type === "SetMode" ? cmd.mode_id : cmd.value;
   if (!mainOpts || !id) return { type: "Ok" };
   const apply = (opts: Opt[]) =>
      opts.map((o) => (o.id === id ? { ...o, currentValue: value } : o));
   if (cmd.thread_id && cmd.thread_id !== main) {
      // A Side Thread owns only its mode; everything else follows Main.
      const mine = latest(cmd.thread_id);
      const target = mine?.find((o) => o.id === id);
      if (!mine || !target || !isModeOption(target))
         throw new CommandError(
            "internal",
            "Side Threads follow the Main Thread's config, except for the mode",
         );
      mock.emit(sid, { type: "ConfigOptionsChanged", options: apply(mine) }, cmd.thread_id);
      return { type: "Ok" };
   }
   const mode = mainOpts.find((o) => o.id === id);
   // Main's mode stays in Main; other options reach every Side Thread (which keeps its own mode).
   mock.emit(sid, { type: "ConfigOptionsChanged", options: apply(mainOpts) }, main);
   if (mode && isModeOption(mode)) return { type: "Ok" };
   for (const t of new Set(log.map((e) => e.thread_id))) {
      if (t === main) continue;
      const mine = latest(t);
      if (mine) mock.emit(sid, { type: "ConfigOptionsChanged", options: apply(mine) }, t);
   }
   return { type: "Ok" };
};

/** The Main Thread's latest config options (what Side Threads mirror). */
export function mainOptions(mock: MockTransport, sid: string): unknown[] | null {
   const log = mock.logs.get(sid)!;
   const main = log.find((e) => e.kind.type === "ThreadStarted" && e.kind.main)?.thread_id;
   for (let i = log.length - 1; i >= 0; i--) {
      const k = log[i]!.kind;
      if (
         k.type === "ConfigOptionsChanged" &&
         log[i]!.thread_id === main &&
         Array.isArray(k.options)
      )
         return k.options;
   }
   return null;
}

export const threadsHandlers = {
   StartSideThread: (mock, cmd) => {
      const thread_id = `side-${++mock.sideN}`;
      const sid = cmd.session_id;
      const log = mock.logs.get(sid)!;
      const main = log.find((e) => e.kind.type === "ThreadStarted" && e.kind.main);
      const mainTurns = log.filter(
         (e) => e.thread_id === main?.thread_id && e.kind.type === "TurnEnded",
      ).length;
      // Like the core: a fork needs a Main Thread that has run; else a text seed. Fresh: neither.
      const fresh = cmd.source === "fresh";
      const forked = !fresh && cmd.source !== "seed" && mainTurns > 0;
      mock.sideForked.set(thread_id, forked);
      if (fresh) mock.sideFresh.add(thread_id);
      mock.emit(
         sid,
         {
            type: "ThreadStarted",
            agent_id: "codex",
            main: false,
            ...(!fresh && {
               forked_from: {
                  thread_id: mock.mainThread(sid),
                  turn: mainTurns,
                  seq: log.length - 1,
               },
            }),
            ...(cmd.anchor && { anchor: cmd.anchor }),
         },
         thread_id,
      );
      // Side Threads follow the Main Thread's config options, but start in `cmd.mode` (else the asking mode) and own their mode.
      const opts = mainOptions(mock, sid) as
         | {
              id: string;
              category?: string;
              currentValue: string;
              options?: { value: string }[];
           }[]
         | null;
      if (opts) {
         const side = opts.map((o) => {
            if (!isModeOption(o)) return o;
            const want = [cmd.mode, ASKING_MODE].find(
               (m) => m != null && o.options?.some((v) => v.value === m),
            );
            return want ? { ...o, currentValue: want } : o;
         });
         mock.emit(sid, { type: "ConfigOptionsChanged", options: side }, thread_id);
      }
      return { type: "ThreadStarted", thread_id, forked };
   },
   ResolveSideThread: (mock, cmd) => {
      const sid = cmd.session_id;
      const log = mock.logs.get(sid) ?? [];
      if (cmd.thread_id === mock.mainThread(sid))
         throw new CommandError("invalid", "the Main Thread cannot be resolved");
      if (!log.some((e) => e.thread_id === cmd.thread_id && e.kind.type === "ThreadStarted"))
         throw new CommandError("not_found", `unknown thread ${cmd.thread_id}`);
      const last = log
         .filter((e) => e.thread_id === cmd.thread_id && e.kind.type === "SideThreadResolved")
         .at(-1)?.kind;
      const now = last?.type === "SideThreadResolved" && last.resolved;
      if (now !== cmd.resolved)
         mock.emit(sid, { type: "SideThreadResolved", resolved: cmd.resolved }, cmd.thread_id);
      return { type: "Ok" };
   },
   SetConfigOption: setOption,
   SetMode: setOption,
   ResolvePermission: (mock, cmd) => {
      const req = mock.logs
         .get(cmd.session_id)
         ?.find(
            (e) => e.kind.type === "PermissionRequested" && e.kind.request_id === cmd.request_id,
         );
      const resolved = mock.logs
         .get(cmd.session_id)
         ?.some(
            (e) => e.kind.type === "PermissionResolved" && e.kind.request_id === cmd.request_id,
         );
      if (!req || resolved)
         throw new CommandError("not_found", `permission request ${cmd.request_id} is not pending`);
      mock.emit(
         cmd.session_id,
         {
            type: "PermissionResolved",
            request_id: cmd.request_id,
            option_id: cmd.option_id,
            by: "view",
         },
         req.thread_id,
      );
      const asked = req.kind.type === "PermissionRequested" ? req.kind : null;
      const always = asked?.options.find((o) => o.option_id === cmd.option_id)?.kind;
      const tool_call = (asked?.tool_call ?? {}) as { kind?: string };
      // Like the core (`remembered_rule`): a plan approval is never remembered as a rule.
      if (always === "allow_always" && tool_call.kind !== "switch_mode") {
         const rule: PermissionRule = {
            id: `rule-${++mock.ruleN}`,
            scope: cmd.global
               ? { type: "global" }
               : { type: "session", session_id: cmd.session_id },
            tool_kind: tool_call.kind ?? null,
            pattern: null,
            decision: "allow",
         };
         mock.rules.push(rule);
         mock.emit(cmd.session_id, { type: "PermissionRuleAdded", rule }, req.thread_id);
      }
      return { type: "Ok" };
   },
   ContinueWithSummary: (mock, cmd) => {
      const sid = cmd.session_id;
      mock.readOnly.delete(sid);
      mock.emit(sid, {
         type: "AgentSessionStarted",
         acp_session_id: `acp-cont-${mock.logs.get(sid)!.length}`,
         boundary: "continued_with_summary",
      });
      if (cmd.text)
         return mock.execute({
            type: "Prompt",
            session_id: sid,
            thread_id: null,
            text: cmd.text,
            attachments: cmd.attachments ?? [],
         });
      return { type: "Ok" };
   },
} satisfies Partial<Handlers>;
