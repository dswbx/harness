import type { PermissionOption, SessionApi } from "@harness/api";
import { errText, toolDetail } from "@harness/api";
import {
   Button,
   cn,
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuRadioGroup,
   DropdownMenuRadioItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
   Trace,
   TraceDescription,
   TraceDetail,
   TraceIcon,
   TraceLine,
   TraceTitle,
   TraceVerb,
} from "@harness/ui";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type Item, permissionTitle } from "../../state/reducer";
import { Block, PlusMinus } from "../toolDisplay/blocks";
import { CodeFrame } from "../toolDisplay/CodeFrame";
import type { Tool } from "../toolDisplay/group";
import { askVerb } from "../toolDisplay/label";
import { inputOf, json, present } from "../toolDisplay/raw";
import { STEP_ICONS } from "../toolDisplay/stepIcons";
import { stepView } from "../toolDisplay/stepView";

type Perm = Extract<Item, { type: "permission" }>;

/** Requests whose title says what is asked (Harness tools, mode switches): not the kind's question. */
const OWN_TITLE = new Set(["git_commit", "git_push", "frontend_tool", "switch_mode"]);

/** A pending approval of a step stands in for it (plans have their own note). */
export const isStepApproval = (item: Perm) => !!item.stepId && !item.plan;

/** The call the request is about: its step, else what the request itself says. */
function toolOf(item: Perm): Tool {
   if (item.step) return item.step;
   const c = item.toolCall;
   return {
      type: "tool",
      id: item.stepId ?? item.id,
      title: c.title ?? "",
      kind: c.kind ?? null,
      status: "pending",
      content: c.content ?? [],
      locations: null,
      rawInput: null,
      rawOutput: null,
      parent: null,
      background: false,
      report: null,
      harnessTool: item.harnessTool,
      subagentPrompt: null,
      subagentMeta: null,
      ts: 0,
      endedAt: null,
      commitMessage: item.commitMessage,
   };
}

/** Lines of a preview shown before "Show all". */
const PREVIEW_LINES = 4;

/** Height (px from `el`'s top) that ends after the first `PREVIEW_LINES` lines of code or diff rows. */
function cutOf(el: HTMLElement): number {
   const top = el.getBoundingClientRect().top;
   const rows = Array.from(el.querySelectorAll("tr")).filter(
      (r) => r.getBoundingClientRect().height > 0,
   );
   if (rows.length > 0) {
      const last = rows[Math.min(rows.length, PREVIEW_LINES) - 1]!;
      return last.getBoundingClientRect().bottom - top;
   }
   const code = el.querySelector("pre code") ?? el.querySelector("pre");
   if (code) {
      // A little air under the last line, not so much that the next one peeks in.
      const bottom = linesBottom(code, PREVIEW_LINES);
      if (bottom !== null) return bottom - top + 4;
   }
   return 120;
}

/** Bottom (viewport px) of the first `n` lines of `code`'s text, wrapped lines included; null when it has fewer. */
function linesBottom(code: Element, n: number): number | null {
   const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
   let seen = 0;
   for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
         if (++seen < n) continue;
         const range = document.createRange();
         range.setStart(code, 0);
         range.setEnd(node, i);
         return range.getBoundingClientRect().bottom;
      }
   }
   return null;
}

/** Shows the first `PREVIEW_LINES` lines of a preview, with a "Show all" row when more is hidden. */
function Clamp({ children }: { children: ReactNode }) {
   const ref = useRef<HTMLDivElement>(null);
   const [all, setAll] = useState(false);
   const [cut, setCut] = useState<number | null>(null);
   useLayoutEffect(() => {
      const el = ref.current;
      if (!el || all) return;
      const measure = () => {
         const c = Math.ceil(cutOf(el));
         setCut(el.scrollHeight > c + 2 ? c : null);
      };
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      for (const c of Array.from(el.children)) ro.observe(c);
      return () => ro.disconnect();
   }, [all]);
   return (
      <div className="overflow-hidden rounded-lg border bg-card">
         <div
            ref={ref}
            className={cn(
               "flex flex-col gap-px bg-border [&>*]:shrink-0 [&>*]:rounded-none [&>*]:border-0 [&>*]:bg-card",
               !all && "overflow-hidden",
            )}
            style={!all && cut !== null ? { maxHeight: cut } : undefined}
         >
            {children}
         </div>
         {cut !== null && !all && (
            <button
               type="button"
               className="w-full border-t px-3 py-1 text-left font-mono text-ui-sm text-muted-foreground hover:text-foreground"
               onClick={() => setAll(true)}
            >
               Show all
            </button>
         )}
      </div>
   );
}

/** What the call would do: its command, commit message, diffs and text, else its raw input. Null: nothing to show. */
function preview(tool: Tool, item: Perm): ReactNode {
   const message = item.commitMessage ?? tool.commitMessage;
   if (message) return <CodeFrame label="commit message" code={message} />;
   const command = toolDetail(tool).command;
   if (command) return <CodeFrame label="command" code={command} lang="bash" />;
   if (tool.content.length > 0)
      return tool.content.map((b, i) => <Block key={i} b={b} tool={tool} />);
   const input = inputOf(tool);
   if (present(input) && !tool.harnessTool && !OWN_TITLE.has(item.toolCall.kind ?? ""))
      return (
         <CodeFrame
            label="input"
            code={json(input)}
            lang={typeof input === "string" ? "" : "json"}
         />
      );
   return null;
}

type Choice = "once" | "always" | "global";

/** Agent option names that only say "always allow", nothing about what is remembered. */
const GENERIC_ALWAYS =
   /^(always( allow)?|allow always|yes,? always|yes,? and don'?t ask again)\.?$/i;

/** What an "always" answer remembers (`remembered_rule`): the exact command, else every call of the kind. */
const scopeOf = (kind: string | null | undefined) =>
   kind === "execute" ? "this exact command" : `all ${kind ?? "tool"} calls`;

/**
 * The answers to a permission request. Allow is a split button: its menu picks how long (once, this
 * Session, all Sessions), the next click answers. Deny answers the reject option; the menu also has
 * "Always deny" and "Dismiss".
 */
export function PermissionActions({ item, api }: { item: Perm; api: SessionApi }) {
   const [error, setError] = useState<string | null>(null);
   const [picked, setPicked] = useState<Choice | null>(null);
   const [confirm, setConfirm] = useState(false);
   const answer = (optionId: string | null, global = false) => {
      setError(null);
      api.resolvePermission(item.requestId, optionId, global).catch((e) => setError(errText(e)));
   };
   const find = (kind: string) => item.options.find((o) => o.kind === kind);
   const once = find("allow_once");
   const always = item.toolCall.kind === "switch_mode" ? undefined : find("allow_always");
   const reject = find("reject_once") ?? find("reject_always");
   const rejectAlways = find("reject_always");
   const optionOf = (c: Choice): PermissionOption | undefined => (c === "once" ? once : always);
   const fallback: Choice | null = once ? "once" : always ? "always" : null;
   const choice = picked && optionOf(picked) ? picked : fallback;
   const chosen = choice ? optionOf(choice) : undefined;
   const text =
      choice === "always"
         ? "Allow · always"
         : choice === "global"
           ? "Allow · all Sessions"
           : "Allow";
   const submit = () => {
      if (!chosen) return;
      if (choice === "global") setConfirm(true);
      else answer(chosen.option_id);
   };
   const scope = scopeOf(item.toolCall.kind);
   // The Agent's own name for its always option, when it says more than "Always allow" (what the Agent remembers).
   const agentNote = always && !GENERIC_ALWAYS.test(always.name.trim()) ? always.name : null;
   const alwaysItem = (value: Choice, label: string, note: string | null) =>
      always && (
         <DropdownMenuRadioItem value={value}>
            <span className="flex min-w-0 flex-col">
               <span>{label}</span>
               <span className="text-xs text-muted-foreground">{scope}</span>
               {note && <span className="text-xs text-muted-foreground">{note}</span>}
            </span>
         </DropdownMenuRadioItem>
      );
   const hasMenu = !!always || !!rejectAlways;
   return (
      <>
         <div className="flex flex-wrap gap-2">
            <div className="flex">
               <Button
                  size="sm"
                  className={hasMenu ? "rounded-r-none" : undefined}
                  disabled={!chosen}
                  onClick={submit}
               >
                  {text}
               </Button>
               {hasMenu && (
                  <DropdownMenu>
                     <DropdownMenuTrigger asChild>
                        <Button
                           size="sm"
                           className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
                           aria-label="More ways to allow"
                        >
                           <ChevronDown className="size-3.5" />
                        </Button>
                     </DropdownMenuTrigger>
                     <DropdownMenuContent align="start" className="w-72">
                        <DropdownMenuLabel>Allow</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                           value={choice ?? ""}
                           onValueChange={(v) => setPicked(v as Choice)}
                        >
                           {once && (
                              <DropdownMenuRadioItem value="once">Once</DropdownMenuRadioItem>
                           )}
                           {alwaysItem("always", "Always, this Session", agentNote)}
                           {alwaysItem("global", "Always, all Sessions…", null)}
                        </DropdownMenuRadioGroup>
                        <DropdownMenuSeparator />
                        {rejectAlways && (
                           <DropdownMenuItem onSelect={() => answer(rejectAlways.option_id)}>
                              Always deny
                           </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => answer(null)}>Dismiss</DropdownMenuItem>
                     </DropdownMenuContent>
                  </DropdownMenu>
               )}
            </div>
            {reject && (
               <Button size="sm" variant="outline" onClick={() => answer(reject.option_id)}>
                  Deny
               </Button>
            )}
            {!hasMenu && (
               <Button size="sm" variant="ghost" onClick={() => answer(null)}>
                  Dismiss
               </Button>
            )}
         </div>
         {error && (
            <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">
               {error}
            </p>
         )}
         <Dialog open={confirm} onOpenChange={setConfirm}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>Allow in all Sessions?</DialogTitle>
                  <DialogDescription>
                     Every Session runs this without asking. You can remove the rule later.
                  </DialogDescription>
               </DialogHeader>
               <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirm(false)}>
                     Cancel
                  </Button>
                  <Button
                     onClick={() => {
                        setConfirm(false);
                        if (always) answer(always.option_id, true);
                     }}
                  >
                     Allow everywhere
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </>
   );
}

/**
 * A pending permission request: a Trace line in amber, in place of its tool's step (kind icon, the
 * question, the target), with a preview of what it would do and the answers below.
 * Plans (Plan Mode approvals) render as a `PlanNote` instead.
 */
export function PermissionCard({ item, api }: { item: Perm; api: SessionApi }) {
   const tool = toolOf(item);
   const v = useMemo(() => stepView({ tool, active: true, waiting: false }), [tool]);
   const kind = item.toolCall.kind ?? "";
   const verb = OWN_TITLE.has(kind)
      ? (permissionTitle(item.toolCall, item, true) ?? "Permission requested")
      : askVerb(tool);
   const mcp = toolDetail(tool).mcp;
   const detail =
      item.commitMessage?.split("\n")[0] ?? (mcp ? `${mcp.server} ${mcp.tool}` : v.detail);
   const Icon = STEP_ICONS[kind === "frontend_tool" ? "blocks" : v.icon];
   const body = preview(tool, item);
   return (
      <Trace className="text-ui-step">
         <TraceLine className="text-amber-500">
            <TraceIcon className="text-amber-500">
               <Icon />
            </TraceIcon>
            <TraceTitle>
               <TraceVerb className="text-amber-500">{verb}</TraceVerb>
               {detail && <TraceDetail>{detail}</TraceDetail>}
            </TraceTitle>
            {v.metas.map(
               (m, i) =>
                  typeof m !== "string" && (
                     <TraceDescription key={i}>
                        <PlusMinus add={m.add} del={m.del} />
                     </TraceDescription>
                  ),
            )}
            <TraceDescription className="text-amber-500">waiting for you</TraceDescription>
         </TraceLine>
         <div className="mb-1 ml-[calc(--spacing(2)-1px)] flex min-w-0 flex-col gap-2 border-l border-amber-500/50 pl-4">
            {body && <Clamp>{body}</Clamp>}
            <PermissionActions item={item} api={api} />
         </div>
      </Trace>
   );
}
