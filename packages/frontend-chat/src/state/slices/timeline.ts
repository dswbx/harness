import { type Event, type PermissionRule, toolFacts, toolFactsOfCall } from "@harness/api";
import { groupConfigOptions, valueName } from "../configGroups";
import { type Ctx, notice, own, permIndex, push, toolIndex } from "../draft";
import type { ChatState, ContentBlock, Item, SubagentMeta, Tool, ToolCallRef } from "../types";
import { addPlan, resolvePlan } from "./plans";

/** The subagent (its starting tool call) an item belongs to, when that call is known. */
function subagentOf(it: Item, idx: Map<string, number>): string | null {
   const parent =
      it.type === "tool"
         ? it.report == null
            ? it.parent
            : null
         : it.type === "agent" || it.type === "thought"
           ? it.parent
           : null;
   return parent && idx.has(parent) ? parent : null;
}

/**
 * Adds a chunk to the last message or thought of its type.
 * - A subagent's chunk (`parent`) joins that subagent's last item when it is of the same type, else
 *   starts a new one. Its steps render in order inside the subagent.
 * - The Thread's own chunk looks past a running subagent's items: they arrive between the parent's
 *   chunks but render inside the subagent, so they must not split the text. A subagent's report
 *   still does: text after it is a new reply.
 */
function appendText(
   c: Ctx,
   type: "agent" | "thought",
   text: string,
   id: string,
   ts: number,
   parent: string | null,
) {
   const items = own(c);
   const idx = toolIndex(c);
   const task = parent !== null ? idx.get(parent) : undefined;
   if (parent !== null && task !== undefined) {
      for (let n = items.length - 1; n > task; n--) {
         const it = items[n]!;
         if (subagentOf(it, idx) !== parent) continue;
         if (it.type === type) {
            items[n] = { ...it, text: it.text + text };
            return;
         }
         break;
      }
      items.push({ type, id, text, ts, parent });
      return;
   }
   let n = items.length - 1;
   while (n >= 0 && subagentOf(items[n]!, idx) !== null) n--;
   const last = items[n];
   if (last && last.type === type) items[n] = { ...last, text: last.text + text };
   else items.push({ type, id, text, ts, parent: null });
}

/** A subagent's type, model and effort, from its call, else from the Thread's current options. */
function subagentMeta(d: ChatState, agentType: string | null, model: string | null): SubagentMeta {
   const g = groupConfigOptions(d.configOptions);
   const effort = g.effort ?? d.configOptions.find((o) => o.category === "thought_level");
   const threadModel = g.model ? valueName(g.model) : null;
   return {
      type: agentType,
      model: model ?? threadModel,
      modelInherited: model == null && threadModel != null,
      effort: effort ? valueName(effort) : null,
   };
}

const ended = (status: string | null | undefined) => status === "completed" || status === "failed";

/** Puts the Turn's duration on its last agent message (none if the Turn produced no text). */
function stampDuration(c: Ctx, durationMs: number) {
   const items = c.d.items;
   for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.type === "user") return;
      if (it.type === "agent" && !it.parent) {
         own(c)[i] = { ...it, durationMs };
         return;
      }
   }
}

function asBlocks(v: unknown): ContentBlock[] {
   return Array.isArray(v) ? (v as ContentBlock[]) : [];
}

/** e.g. "allow `echo hi`", "deny all edit", "allow everything". */
function describeRule(r: PermissionRule): string {
   const target = r.pattern
      ? `\`${r.pattern}\``
      : r.tool_kind
        ? `all ${r.tool_kind}`
        : "everything";
   return `${r.decision} ${target}`;
}

/**
 * The Thread's items: messages, tool calls, permission requests, notices, Frontend Tool output.
 * Runs before `turnSlice`: `TurnEnded` reads `turnStartedAt` before it is cleared.
 *
 * Kept whole here although they write a second concern: `ToolCallUpdate` (it also adds a background
 * job from the call it just built), `PermissionRequested` (a plan entry is added before its item is
 * pushed, and both read the permission index) and `PermissionResolved` (the plan entry, the tool's
 * approval and the item share what was looked up).
 */
export function timelineSlice(c: Ctx, e: Event) {
   const d = c.d;
   const k = e.kind;
   const id = `e${e.seq}`;
   switch (k.type) {
      case "TurnStarted":
         push(c, {
            type: "user",
            id,
            text: k.text,
            ts: e.ts_ms,
            attachments: k.attachments ?? [],
            context: k.context ?? null,
            from: k.origin
               ? {
                    sessionId: k.origin.session_id,
                    title: k.origin.title,
                    subSession: k.origin.kind === "sub_session",
                    reports: k.origin.reports ?? [],
                 }
               : null,
         });
         return;
      case "TurnEnded":
         if (d.turnStartedAt !== null) stampDuration(c, e.ts_ms - d.turnStartedAt);
         if (k.stop_reason !== "end_turn")
            notice(
               c,
               id,
               k.stop_reason === "error" ? "error" : "info",
               `Turn stopped: ${k.stop_reason}`,
            );
         return;
      case "AgentMessageChunk":
         appendText(c, "agent", k.text, id, e.ts_ms, k.parent_tool_call_id ?? null);
         return;
      case "AgentThoughtChunk":
         appendText(c, "thought", k.text, id, e.ts_ms, k.parent_tool_call_id ?? null);
         return;
      case "ToolCall": {
         const idx = toolIndex(c);
         const existing = idx.get(k.tool_call_id);
         const prev = existing !== undefined ? (d.items[existing] as Tool) : null;
         const facts = toolFacts({
            kind: k.kind,
            title: k.title,
            harnessTool: k.harness_tool,
            rawInput: k.raw_input,
         });
         const subagentPrompt = k.subagent?.prompt ?? facts.subagentPrompt;
         const item: Tool = {
            type: "tool",
            id: k.tool_call_id,
            title: k.title,
            kind: k.kind,
            status: k.status,
            content: asBlocks(k.content),
            locations: k.locations,
            rawInput: k.raw_input,
            rawOutput: null,
            parent:
               k.parent_tool_call_id ??
               (existing !== undefined ? (d.items[existing] as Tool).parent : null),
            background: existing !== undefined ? (d.items[existing] as Tool).background : false,
            report: k.report ?? null,
            harnessTool: k.harness_tool ?? null,
            subagentPrompt,
            subagentMeta:
               prev?.subagentMeta ??
               (subagentPrompt != null
                  ? subagentMeta(
                       d,
                       k.subagent?.agent_type ?? facts.subagentType,
                       k.subagent?.model ?? facts.subagentModel,
                    )
                  : null),
            ts: prev?.ts ?? e.ts_ms,
            endedAt: prev?.endedAt ?? (ended(k.status) ? e.ts_ms : null),
            commitMessage: k.commit_message ?? facts.commitMessage,
            ...(existing !== undefined &&
               (d.items[existing] as Tool).approval && {
                  approval: (d.items[existing] as Tool).approval,
               }),
         };
         if (existing !== undefined) own(c)[existing] = item;
         else {
            idx.set(item.id, own(c).length);
            push(c, item);
         }
         return;
      }
      case "ToolCallUpdate": {
         const idx = toolIndex(c);
         const at = idx.get(k.tool_call_id);
         const prev = at !== undefined ? (d.items[at] as Tool) : null;
         const base: Tool = prev ?? {
            type: "tool",
            id: k.tool_call_id,
            title: "Tool call",
            kind: null,
            status: null,
            content: [],
            locations: null,
            rawInput: null,
            rawOutput: null,
            parent: null,
            background: false,
            report: null,
            harnessTool: null,
            subagentPrompt: null,
            subagentMeta: null,
            ts: e.ts_ms,
            endedAt: null,
            commitMessage: null,
         };
         const facts = toolFacts({
            kind: k.kind ?? base.kind,
            title: k.title ?? base.title,
            harnessTool: k.harness_tool ?? base.harnessTool,
            rawInput: k.raw_input,
         });
         const subagentPrompt = k.subagent?.prompt ?? facts.subagentPrompt ?? base.subagentPrompt;
         const next: Tool = {
            ...base,
            title: k.title ?? base.title,
            kind: k.kind ?? base.kind,
            status: k.status ?? base.status,
            content: k.content != null ? asBlocks(k.content) : base.content,
            locations: k.locations ?? base.locations,
            rawInput: k.raw_input ?? base.rawInput,
            rawOutput: k.raw_output ?? base.rawOutput,
            parent: k.parent_tool_call_id ?? base.parent,
            background: k.background || base.background,
            harnessTool: k.harness_tool ?? base.harnessTool,
            subagentPrompt,
            subagentMeta:
               base.subagentMeta ??
               (subagentPrompt != null
                  ? subagentMeta(
                       d,
                       k.subagent?.agent_type ?? facts.subagentType,
                       k.subagent?.model ?? facts.subagentModel,
                    )
                  : null),
            endedAt: base.endedAt ?? (ended(k.status) ? e.ts_ms : null),
            commitMessage: k.commit_message ?? facts.commitMessage ?? base.commitMessage,
         };
         if (at === undefined) {
            idx.set(next.id, own(c).length);
            push(c, next);
         } else own(c)[at] = next;
         const job = k.background_job;
         if (job && !d.backgroundJobs.some((j) => j.id === job.id)) {
            const label = next.title !== "Tool call" ? next.title : job.id;
            d.backgroundJobs = [...d.backgroundJobs, { id: job.id, label, since: e.ts_ms }];
         }
         return;
      }
      case "WorkspaceChanged":
         if (k.files.length === 0) return;
         push(c, {
            type: "changes",
            id,
            turnId: k.turn_id,
            fromTree: k.from_tree,
            toTree: k.to_tree,
            files: k.files,
         });
         return;
      case "FrontendToolOutput": {
         const render = c.decodeTool(k.tool, k.input);
         push(c, {
            type: "frontend_tool",
            id,
            ts: e.ts_ms,
            tool: k.tool,
            callId: k.call_id,
            path: k.path,
            input: k.input,
            files: k.files ?? {},
            render,
         });
         return;
      }
      case "AgentNotice":
         push(c, {
            type: "agent_notice",
            id,
            severity: k.severity,
            title: k.title,
            description: k.description,
         });
         return;
      // The Agent's own commits and pushes are Trace steps already; the notice is for the user's.
      case "GitCommitted": {
         if (k.by === "agent") return;
         const [subject = "", ...rest] = k.message.trim().split("\n");
         push(c, {
            type: "notice",
            id,
            level: "info",
            text: `You committed ${k.commit.slice(0, 7)} ${subject.trim()}`,
            ...(rest.some((l) => l.trim()) && { info: k.message.trim() }),
         });
         return;
      }
      case "GitPushed":
         if (k.by === "agent") return;
         notice(c, id, "info", `You pushed ${k.branch} to origin`);
         return;
      case "Error":
         notice(c, id, "error", k.message);
         return;
      case "PermissionRequested": {
         const idx = permIndex(c);
         idx.set(k.request_id, own(c).length);
         let stepId: string | null = null;
         if (k.harness_tool) {
            for (let n = d.items.length - 1; n >= 0; n--) {
               const t = d.items[n]!;
               if (
                  t.type === "tool" &&
                  t.harnessTool === k.harness_tool &&
                  t.status !== "completed" &&
                  t.status !== "failed"
               ) {
                  stepId = t.id;
                  break;
               }
            }
         }
         const call = (k.tool_call ?? {}) as ToolCallRef;
         const facts = toolFactsOfCall(k.tool_call, k.harness_tool);
         const plan = k.plan ?? facts.plan;
         if (plan) addPlan(c, k.request_id, plan, e.ts_ms, k.mode_before);
         push(c, {
            type: "permission",
            id,
            requestId: k.request_id,
            toolCall: call,
            harnessTool: k.harness_tool ?? null,
            plan,
            commitMessage: k.commit_message ?? facts.commitMessage,
            frontendTool: k.frontend_tool ?? facts.frontendTool,
            stepId,
            options: k.options,
            resolved: false,
         });
         return;
      }
      case "PermissionResolved": {
         const at = permIndex(c).get(k.request_id);
         const i = at !== undefined ? d.items[at] : undefined;
         if (!i || i.type !== "permission") return;
         const option = i.options.find((o) => o.option_id === k.option_id);
         const kind = option?.kind ?? "";
         if (i.plan) resolvePlan(c, k.request_id, k.option_id, option, e.ts_ms);
         if (i.stepId && k.option_id !== null) {
            const ti = toolIndex(c).get(i.stepId);
            const tool = ti !== undefined ? d.items[ti] : undefined;
            if (tool?.type === "tool") {
               const approval: Tool["approval"] = kind.startsWith("reject")
                  ? "denied"
                  : !kind.startsWith("allow")
                    ? undefined
                    : k.by === "policy"
                      ? k.rule_id
                         ? "rule"
                         : "auto"
                      : "you";
               if (approval) own(c)[ti!] = { ...tool, approval };
            }
         }
         if (k.by !== "policy") own(c)[at!] = { ...i, resolved: true };
         else {
            own(c)[at!] = {
               ...i,
               resolved: true,
               auto: { allowed: kind.startsWith("allow"), ruleId: k.rule_id ?? null },
            };
         }
         return;
      }
      case "PermissionRuleAdded":
         notice(
            c,
            id,
            "info",
            `Remembered for ${k.rule.scope.type === "global" ? "all Sessions" : "this session"}: ${describeRule(k.rule)}`,
         );
         return;
   }
}
