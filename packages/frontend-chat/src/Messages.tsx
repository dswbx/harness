import type { Attachment, SessionApi } from "@harness/api";
import { groupSubagents, type Subagent } from "@harness/api";
import {
   cn,
   Dialog,
   DialogContent,
   DialogTitle,
   Popover,
   PopoverContent,
   PopoverTrigger,
   Tooltip,
   VirtualList,
   type VirtualListHandle,
} from "@harness/ui";
import {
   AlertTriangle,
   ChevronRight,
   Diff,
   FileText,
   Info,
   Loader2,
   ShieldCheck,
   ShieldX,
} from "lucide-react";
import { memo, type Ref, useEffect, useMemo, useState } from "react";
import { AuthCard } from "./Auth";
import { CommentChips } from "./CommentChip";
import type { DiffScope } from "./DiffPanel";
import { splitDetails } from "./errors";
import { FrontendToolRow } from "./FrontendToolCard";
import { Markdown } from "./Markdown";
import { MessageFooter } from "./MessageFooter";
import { PermissionCard } from "./Permission";
import {
   hasArrived,
   type PendingMessage,
   pendingActions,
   usePendingMessages,
   useSlow,
} from "./pendingMessages";
import type { UiEnv } from "./RenderUi";
import type { ChatState, Item } from "./reducer";
import { composerKey, parseReviewComments } from "./reviewComments";
import { quotableAttrs } from "./SelectionComment";
import { SideReplyFooter } from "./SideReplyFooter";
import { splitRenderUi } from "./slots";
import { formatDuration } from "./time";
import { groupTools, type ToolGroup, type ToolGroupProps, useToolDisplay } from "./toolDisplay";
import { NoticeStep } from "./toolDisplay/NoticeStep";
import type { RawNode } from "./tools";

type Tool = Extract<Item, { type: "tool" }>;

/** One line under a Turn: totals and file names; opens the diff scoped to that Turn. */
function ChangesRow({
   item,
   onOpen,
}: {
   item: Extract<Item, { type: "changes" }>;
   onOpen: () => void;
}) {
   const n = item.files.length;
   const sum = (key: "additions" | "deletions") =>
      item.files.reduce((total, f) => total + (f[key] ?? 0), 0);
   const additions = sum("additions");
   const deletions = sum("deletions");
   const names = item.files.map((f) => f.path.slice(f.path.lastIndexOf("/") + 1)).join(", ");
   return (
      <button
         type="button"
         className="group flex w-full flex-wrap items-start gap-x-2.5 gap-y-1 border-t pt-3 text-left text-[13px] text-muted-foreground hover:text-foreground"
         onClick={onOpen}
      >
         <Diff className="mt-0.5 size-4 shrink-0" />
         <span className="shrink-0 font-medium text-foreground">
            {n} {n === 1 ? "file" : "files"} changed
         </span>
         {(additions > 0 || deletions > 0) && (
            <span className="mt-px flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
               <span className="text-emerald-600">+{additions}</span>
               <span className="text-red-600">-{deletions}</span>
            </span>
         )}
         <span className="mt-px min-w-40 flex-1 truncate font-mono text-xs group-hover:whitespace-normal group-hover:break-words">
            {names}
         </span>
         <ChevronRight className="mt-0.5 size-3.5 shrink-0" />
      </button>
   );
}

function Notice({ item }: { item: Extract<Item, { type: "notice" }> }) {
   if (item.level === "error") {
      const { head, details } = splitDetails(item.text);
      return (
         <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
         >
            <div className="flex items-start gap-2">
               <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
               <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{head}</span>
            </div>
            {details && (
               <details className="mt-1.5 pl-5">
                  <summary className="cursor-pointer select-none">Details</summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[11px] text-foreground">
                     {details}
                  </pre>
               </details>
            )}
         </div>
      );
   }
   return (
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
         <div className="h-px flex-1 bg-border" />
         <span className="flex items-center gap-1 whitespace-pre-wrap text-center">
            {item.text}
            {item.info && (
               <Popover>
                  <PopoverTrigger asChild>
                     <button
                        type="button"
                        aria-label="About this notice"
                        className="grid size-4 place-items-center rounded hover:text-foreground"
                     >
                        <Info className="size-3.5" />
                     </button>
                  </PopoverTrigger>
                  <PopoverContent align="center" className="w-72 p-3 text-xs">
                     {item.info}
                  </PopoverContent>
               </Popover>
            )}
         </span>
         <div className="h-px flex-1 bg-border" />
      </div>
   );
}

function AgentNotice({ item }: { item: Extract<Item, { type: "agent_notice" }> }) {
   if (item.severity === "info")
      return <NoticeStep title={item.title} description={item.description} />;
   const warn = item.severity === "warning" || item.severity === "error";
   const Icon = warn ? AlertTriangle : Info;
   return (
      <div
         role={item.severity === "error" ? "alert" : "note"}
         className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
            item.severity === "error"
               ? "border-destructive/30 bg-destructive/5 text-destructive"
               : warn
                 ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                 : "bg-muted/40 text-muted-foreground",
         )}
      >
         <Icon className="mt-0.5 size-3.5 shrink-0" />
         <div className="min-w-0 flex-1">
            <div className="font-medium">{item.title}</div>
            {item.description && (
               <div className="mt-0.5 whitespace-pre-wrap break-words">{item.description}</div>
            )}
         </div>
      </div>
   );
}

/** Always takes its height, so the layout doesn't shift as Turns start and end. */
export function Working({ since }: { since: number | null }) {
   const [now, setNow] = useState(Date.now);
   useEffect(() => {
      if (since === null) return;
      setNow(Date.now());
      const t = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(t);
   }, [since]);
   return (
      <div className="flex h-5 items-center gap-2 text-sm text-muted-foreground" role="status">
         {since !== null && (
            <>
               <Loader2 className="size-4 animate-spin" /> Working...{" "}
               <span className="tabular-nums">{formatDuration(now - since)}</span>
            </>
         )}
      </div>
   );
}

/** Stored image path -> data URL, so thumbnails load once per window. */
const imageCache = new Map<string, Promise<string>>();

function AttachmentImage({ api, a }: { api: SessionApi; a: Attachment }) {
   const [url, setUrl] = useState<string | null>(null);
   const [failed, setFailed] = useState(false);
   const [open, setOpen] = useState(false);
   useEffect(() => {
      let p = imageCache.get(a.path);
      if (!p) {
         p = api.readAttachment(a.path).then((r) => `data:${r.mime};base64,${r.data}`);
         p.catch(() => imageCache.delete(a.path));
         imageCache.set(a.path, p);
      }
      let live = true;
      p.then(
         (u) => live && setUrl(u),
         () => live && setFailed(true),
      );
      return () => {
         live = false;
      };
   }, [api, a.path]);
   if (failed) return <FileChip a={a} />;
   return (
      <>
         <Tooltip content={a.name}>
            <button
               className="size-20 overflow-hidden rounded-lg border bg-muted"
               aria-label={`Open ${a.name}`}
               onClick={() => setOpen(true)}
            >
               {url && <img src={url} alt={a.name} className="size-full object-cover" />}
            </button>
         </Tooltip>
         <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="w-auto max-w-[90vw] p-2">
               <DialogTitle className="sr-only">{a.name}</DialogTitle>
               {url && (
                  <img
                     src={url}
                     alt={a.name}
                     className="max-h-[85vh] max-w-full rounded object-contain"
                  />
               )}
            </DialogContent>
         </Dialog>
      </>
   );
}

function FileChip({ a }: { a: Attachment }) {
   return (
      <Tooltip content={a.path}>
         <span className="flex max-w-64 items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs">
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{a.name}</span>
         </span>
      </Tooltip>
   );
}

function UserAttachments({ api, items }: { api: SessionApi; items: Attachment[] }) {
   return (
      <div className="mb-1.5 flex max-w-[80%] flex-wrap justify-end gap-1.5">
         {items.map((a) =>
            a.kind === "image" ? (
               <AttachmentImage key={a.path} api={api} a={a} />
            ) : (
               <FileChip key={a.path} a={a} />
            ),
         )}
      </div>
   );
}

/** A sent prompt's bubble: its review comments as chips (like the prompt box), then the typed text. */
function UserText({ text }: { text: string }) {
   const p = useMemo(() => parseReviewComments(text), [text]);
   return (
      <div className="max-w-[80%] rounded-2xl border bg-card px-4.5 dark:border-transparent py-2.5 text-card-foreground">
         {p.comments.length > 0 && (
            <CommentChips comments={p.comments} className={p.text ? "pb-1.5" : undefined} />
         )}
         {p.text && <Markdown breaks>{p.text}</Markdown>}
      </div>
   );
}

/** What the core sent the Agent before this message (`<harness_context>`), on request. */
function HarnessContext({ text }: { text: string }) {
   const [open, setOpen] = useState(false);
   const body = text.replace(/^<harness_context>\n?/, "").replace(/\n?<\/harness_context>$/, "");
   return (
      <>
         <Tooltip content="Context the Harness sent the Agent with this message" delay={100}>
            <button
               type="button"
               onClick={() => setOpen(true)}
               className="flex h-6 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-accent-foreground"
            >
               <Info className="size-3.5" /> Harness context
            </button>
         </Tooltip>
         <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-w-2xl">
               <DialogTitle>Harness context</DialogTitle>
               <p className="text-xs text-muted-foreground">
                  Sent to the Agent before this message, inside a {"<harness_context>"} block.
               </p>
               <Markdown className="max-h-[60vh] overflow-y-auto rounded-md bg-muted p-3 text-sm">
                  {body}
               </Markdown>
            </DialogContent>
         </Dialog>
      </>
   );
}

/**
 * In the Main Thread, artifacts (`chat-wide`) stand out past the text to the prompt box's edges. Their Expand
 * button sits in the gutter when the list (a container) is wide enough, else inside. The side panel has no
 * gutter for either.
 */
const bleed = "[--chat-bleed:1rem] @min-[52rem]:[--expand-out:1]";

export const Row = memo(function Row({
   item,
   api,
   env,
   view,
   onOpenDiff,
   subagents,
   active,
   streaming,
   threadId,
   side,
}: {
   item: Item | ToolGroup;
   api: SessionApi;
   env: UiEnv;
   view?: { root: RawNode; files: Record<string, string> } | null;
   /** The Thread this row belongs to; `side`: it is a Side Thread (its comments go to its own composer). */
   threadId: string;
   side: boolean;
   onOpenDiff: (s: DiffScope) => void;
   subagents: Map<string, Subagent<Tool>>;
   /** A Turn is running. */
   active: boolean;
   /** The last row while a Turn runs: an agent message is still coming in. */
   streaming?: boolean;
}) {
   switch (item.type) {
      case "changes":
         return (
            <ChangesRow
               item={item}
               onOpen={() =>
                  onOpenDiff({
                     from: item.fromTree,
                     to: item.toTree,
                     label: `Turn changes (${item.files.length})`,
                  })
               }
            />
         );
      case "user":
         return (
            <div className="group flex flex-col items-end">
               {item.attachments.length > 0 && (
                  <UserAttachments api={api} items={item.attachments} />
               )}
               {item.text && <UserText text={item.text} />}
               <MessageFooter text={item.text} ts={item.ts} align="end">
                  {item.context && <HarnessContext text={item.context} />}
               </MessageFooter>
            </div>
         );
      case "agent":
         return (
            <div className={cn("group", !side && bleed)}>
               <div {...quotableAttrs(threadId, side)}>
                  <Markdown>{item.text}</Markdown>
               </div>
               {/* Only a Turn's final message (it carries the duration); the streaming one keeps the space. */}
               {(item.durationMs !== undefined || streaming) && !side && (
                  <MessageFooter
                     text={item.text}
                     ts={item.ts}
                     durationMs={item.durationMs}
                     hidden={streaming}
                  />
               )}
               {side && item.durationMs !== undefined && !streaming && (
                  <SideReplyFooter sessionId={api.sessionId} text={item.text} />
               )}
            </div>
         );
      case "thought":
         return (
            <ToolGroupRow
               steps={[item]}
               subagents={subagents}
               active={active}
               streaming={streaming}
            />
         );
      case "frontend_tool":
         return (
            <div className={cn(!side && bleed)}>
               <FrontendToolRow item={item} env={env} view={view ?? undefined} />
            </div>
         );
      case "tools":
         return (
            <ToolGroupRow
               steps={item.steps}
               subagents={subagents}
               active={active}
               streaming={streaming}
            />
         );
      case "tool":
         return <ToolGroupRow steps={[item]} subagents={subagents} active={active} />;
      case "permission":
         if (item.auto) {
            return (
               <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {item.auto.allowed ? (
                     <ShieldCheck className="size-3.5 text-emerald-500" />
                  ) : (
                     <ShieldX className="size-3.5 text-destructive" />
                  )}
                  <span>
                     {item.auto.allowed ? "Auto-allowed" : "Auto-denied"}{" "}
                     {item.auto.ruleId ? "by rule" : "by default"}
                     {item.toolCall.title ? `: ${item.toolCall.title}` : ""}
                  </span>
               </div>
            );
         }
         return item.resolved ? null : <PermissionCard item={item} api={api} />;
      case "auth":
         return <AuthCard item={item} api={api} />;
      case "notice":
         return <Notice item={item} />;
      case "agent_notice":
         return <AgentNotice item={item} />;
   }
});

function ToolGroupRow(props: ToolGroupProps) {
   const { Group } = useToolDisplay();
   return <Group {...props} />;
}

/** A Thread's items split into rows: render_ui calls moved to slots, resolved permissions and subagent calls folded away. */
export function useRows(items: Item[]) {
   const ui = useMemo(() => splitRenderUi(items), [items]);
   // Resolved permission cards render nothing; keep them out of the virtual list. So do render_ui
   // calls that moved to a slot or were replaced by a later call with their id.
   // Subagent tool calls go inside their Task call's card.
   const { rows, subagents } = useMemo(() => {
      const g = groupSubagents(
         items.filter(
            (i) =>
               !(i.type === "permission" && !i.auto && i.resolved) && ui.inline.get(i.id) !== null,
         ),
         (i) => (i.type === "tool" ? i : null),
      );
      return { rows: groupTools(g.rows), subagents: g.subagents };
   }, [items, ui]);
   return { ui, rows, subagents };
}

function pendingStage(state: ChatState): string {
   if (state.restoring)
      return `Reopening session, attempt ${state.restoring.attempt} of ${state.restoring.of}...`;
   if (state.process?.state === "starting") return "Starting agent...";
   return "Sending...";
}

/** A message on its way: where its row will be, laid out like it, so nothing moves when that row arrives. */
function PendingRow({
   item,
   state,
   composer,
}: {
   item: PendingMessage;
   state: ChatState;
   composer: string;
}) {
   const slow = useSlow(true);
   const failed = item.status === "failed";
   const actions = pendingActions(composer);
   return (
      <div className="flex flex-col items-end pb-6">
         <div
            className={cn(
               "flex w-full flex-col items-end",
               (failed || (item.status === "sending" && slow)) && "opacity-60",
            )}
         >
            <UserText text={item.prompt} />
         </div>
         <div className="mt-1 flex h-6 items-center gap-2 text-xs text-muted-foreground">
            {failed ? (
               <>
                  <span className="text-destructive">Not sent</span>
                  {!state.recovery && (
                     <button
                        type="button"
                        className="underline hover:text-foreground"
                        onClick={actions?.retry}
                     >
                        Retry
                     </button>
                  )}
                  <button
                     type="button"
                     className="underline hover:text-foreground"
                     onClick={() => actions?.edit(item)}
                  >
                     Edit
                  </button>
               </>
            ) : (
               item.status === "sending" && slow && <span>{pendingStage(state)}</span>
            )}
            {item.files.length > 0 && (failed || slow) && (
               <span>{item.files.length === 1 ? "1 file" : `${item.files.length} files`}</span>
            )}
         </div>
      </div>
   );
}

/** The message list of one Thread (the Main Thread's, or a Side Thread's in the panel). */
export function MessageList({
   handle,
   api,
   state,
   threadId,
   side,
   env,
   ui,
   rows,
   subagents,
   onOpenDiff,
   empty,
   inset = 0,
}: {
   api: SessionApi;
   state: ChatState;
   threadId: string;
   side: boolean;
   env: UiEnv;
   ui: ReturnType<typeof splitRenderUi>;
   rows: ReturnType<typeof useRows>["rows"];
   subagents: Map<string, Subagent<Tool>>;
   onOpenDiff: (s: DiffScope) => void;
   empty: string;
   handle?: Ref<VirtualListHandle>;
   /** Height of the bar over the list's bottom (`ScrollUnder`), kept free at the end. */
   inset?: number;
}) {
   const running = state.turnId !== null;
   const composer = composerKey(api.sessionId, side ? threadId : null);
   const userCount = useMemo(
      () => state.items.filter((i) => i.type === "user").length,
      [state.items],
   );
   // Filtered here, not after the fact, so a message never shows twice for a frame.
   const pending = usePendingMessages(composer).filter((p) => !hasArrived(p, userCount));
   return (
      <VirtualList
         handle={handle}
         count={rows.length}
         getKey={(i) => rows[i]!.id}
         estimateSize={72}
         gap={24}
         className="@container"
         scrollbarClassName="z-10 [&>*]:bg-[color-mix(in_oklch,var(--border),var(--foreground)_6%)]"
         innerClassName={cn("mx-auto px-10 pb-3 pt-4", side ? "px-4" : "max-w-3xl")}
         empty={
            pending.length === 0 && (
               <p className="py-16 text-center text-sm text-muted-foreground">{empty}</p>
            )
         }
         renderRow={(i) => (
            <Row
               item={rows[i]!}
               api={api}
               env={env}
               view={ui.inline.get(rows[i]!.id)}
               onOpenDiff={onOpenDiff}
               subagents={subagents}
               active={running}
               streaming={running && i === rows.length - 1}
               threadId={threadId}
               side={side}
            />
         )}
         footer={
            <>
               {/* With no rows yet, the list's top padding is not there. */}
               {rows.length === 0 && pending.length > 0 && <div className="h-4" />}
               {pending.map((p) => (
                  <PendingRow key={p.id} item={p} state={state} composer={composer} />
               ))}
               <Working since={state.turnStartedAt} />
               <div style={{ height: inset }} />
            </>
         }
      />
   );
}
