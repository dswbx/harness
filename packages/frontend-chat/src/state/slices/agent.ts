import type { Event, TranscriptSize } from "@harness/api";
import { type Ctx, notice, own, push, sideCtx } from "../draft";

/** The Agent process no longer runs (its background jobs ended with it). */
const agentGone = (state: string) =>
   state === "stopped" || state === "exited" || state === "failed";

/** The Agent process is gone, and its background jobs with it: in every Side Thread. */
export function endSideJobs(c: Ctx, e: Event) {
   const k = e.kind;
   if (k.type === "AgentProcessState" && agentGone(k.state)) {
      for (const [id, t] of Object.entries(c.d.threads))
         if (t.backgroundJobs.length > 0) sideCtx(c, id).d.backgroundJobs = [];
   }
}

/**
 * The Agent process and its Agent Session: state, recovery, restoring, what a prompt may carry,
 * how the Session started, background jobs, sign-in.
 *
 * `AgentProcessState` is kept whole here, though it also clears `lastTurnErrored` (a Turn field)
 * and adds a notice: its notice depends on the Turn state it read before clearing it.
 */
export function agentSlice(c: Ctx, e: Event) {
   const d = c.d;
   const k = e.kind;
   const id = `e${e.seq}`;
   switch (k.type) {
      case "AgentCapabilities":
         d.promptCaps = { image: k.image, embeddedContext: k.embedded_context };
         return;
      case "BackgroundJobEnded":
         d.backgroundJobs = d.backgroundJobs.filter((j) => j.id !== k.job_id);
         return;
      case "AgentProcessState": {
         const wasTurn = d.turnId !== null || d.lastTurnErrored;
         d.process = { state: k.state, message: k.message };
         if (agentGone(k.state) && d.backgroundJobs.length > 0) d.backgroundJobs = [];
         // A stop needs no action: the header's status dot shows it.
         if (k.state === "stopped") return;
         if ((k.state === "failed" || k.state === "exited") && wasTurn) {
            d.lastTurnErrored = false;
            // The message may hold multi-line agent stderr after a blank line (rendered as Details).
            notice(
               c,
               id,
               "error",
               k.message
                  ? `Agent process ended unexpectedly\n\n${k.message}`
                  : "Agent process ended unexpectedly",
            );
         } else if (k.state === "failed" && k.message) {
            notice(c, id, "error", `Agent failed\n\n${k.message}`);
         }
         return;
      }
      case "ThreadReadOnly": {
         const retryable = k.retryable ?? false;
         d.readOnly = !retryable;
         d.recovery = { retryable, errors: k.errors ?? [], transcript: k.transcript ?? null };
         d.restoring = null;
         return;
      }
      case "AgentSessionRestoring":
         d.restoring = { attempt: k.attempt, of: k.of };
         return;
      case "AgentSessionStarted":
         d.readOnly = false;
         d.recovery = null;
         d.restoring = null;
         if (d.side && d.startBoundary === null) {
            // A Side Thread's list opens with how it started.
            d.startBoundary = k.boundary;
            if (k.boundary === "forked")
               notice(
                  c,
                  id,
                  "boundary",
                  d.forkedFrom
                     ? `Forked from main at turn ${d.forkedFrom.turn}`
                     : "Forked from main",
               );
            else if (k.boundary === "initial")
               notice(
                  c,
                  id,
                  "boundary",
                  d.forkedFrom
                     ? "Started with a summary of main"
                     : "Started fresh, without the conversation",
               );
            else notice(c, id, "boundary", boundaryText(k.boundary));
            return;
         }
         d.startBoundary ??= k.boundary;
         // Show a boundary only when what the Agent knows changed.
         if (["initial", "forked", "resumed", "loaded"].includes(k.boundary)) return;
         push(c, {
            type: "notice",
            id,
            level: "boundary",
            text: boundaryText(k.boundary),
            ...(k.boundary === "continued_with_summary" && {
               info: transcriptInfo(k.transcript ?? null),
            }),
         });
         return;
      case "AuthRequired": {
         // Mid-Turn: the Turn's own message (when the user sent it) is what to send again after sign-in.
         let n = d.turnId === null ? -1 : d.items.length - 1;
         while (n >= 0 && d.items[n]!.type !== "user") n--;
         const user =
            n >= 0 ? (d.items[n] as Extract<(typeof d.items)[number], { type: "user" }>) : null;
         push(c, {
            type: "auth",
            id,
            message: k.message,
            methods: k.methods,
            ...(k.agent_name && { agentName: k.agent_name }),
            ...(user &&
               !user.from && { resend: { text: user.text, attachments: user.attachments } }),
         });
         return;
      }
      case "AuthFinished": {
         // It answers the latest sign-in card.
         const items = d.items;
         let n = items.length - 1;
         while (n >= 0 && items[n]!.type !== "auth") n--;
         if (n < 0) return;
         const it = items[n] as Extract<(typeof items)[number], { type: "auth" }>;
         own(c)[n] = {
            ...it,
            finished: {
               id,
               methodId: k.method_id,
               methodName: k.method_name,
               outcome: k.outcome,
               exitCode: k.exit_code ?? null,
            },
         };
         return;
      }
   }
}

function transcriptInfo(t: TranscriptSize | null): string {
   const got = !t
      ? "a transcript of this conversation"
      : t.kept_turns < t.total_turns
        ? `the last ${t.kept_turns} of ${t.total_turns} turns`
        : `all ${t.total_turns} turns`;
   return `The earlier session could not be reopened, so a new agent session started. It got ${got}, without tool inputs, tool outputs or its earlier thoughts.`;
}

function boundaryText(b: string): string {
   switch (b) {
      case "resumed":
         return "Agent session resumed";
      case "loaded":
         return "Agent session reloaded";
      case "continued_with_summary":
         return "Continued from transcript";
      case "reseeded":
         return "New Agent session started with the earlier context";
      case "agent_switched":
         return "Switched to a different Agent in a new session";
      default:
         return `New Agent session (${b.replace(/_/g, " ")})`;
   }
}
