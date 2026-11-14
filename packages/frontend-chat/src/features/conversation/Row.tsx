import type { SessionApi } from "@harness/api";
import { cn } from "@harness/ui";
import { ShieldCheck, ShieldX } from "lucide-react";
import { memo } from "react";
import type { Item } from "../../state/reducer";
import type { DiffScope } from "../changes/DiffPanel";
import { AuthCard } from "../interaction/Auth";
import { PermissionCard } from "../interaction/Permission";
import { Markdown } from "../markdown/Markdown";
import { PlanNote } from "../plan/PlanNote";
import { FrontendToolRow } from "../renderUi/FrontendToolCard";
import type { UiEnv } from "../renderUi/RenderUi";
import type { RawNode } from "../renderUi/tools";
import { quotableAttrs } from "../review/SelectionComment";
import { SideReplyFooter } from "../sideChats/SideReplyFooter";
import {
   type ChatSubagent,
   type ToolGroup,
   type ToolGroupProps,
   useToolDisplay,
} from "../toolDisplay";
import { ChangesRow } from "./items/ChangesRow";
import { AgentNotice, Notice } from "./items/Notices";
import { UserMessage } from "./items/UserMessage";
import { MessageFooter } from "./MessageFooter";

/**
 * Artifacts (`chat-wide`) stand out past the text to the prompt box's edges. Their Expand
 * button sits in the gutter when the list (a container) is wide enough, else inside.
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
   subagents: Map<string, ChatSubagent>;
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
         return <UserMessage item={item} api={api} />;
      case "agent":
         return (
            <div className={cn("group", bleed)}>
               <div {...quotableAttrs(threadId, side)}>
                  <Markdown streaming={streaming}>{item.text}</Markdown>
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
            <div className={bleed}>
               <FrontendToolRow
                  item={item}
                  env={env}
                  view={view ?? undefined}
                  threadId={threadId}
                  side={side}
               />
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
         if (item.plan) return <PlanNote item={item} api={api} />;
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
