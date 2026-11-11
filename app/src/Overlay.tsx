import type { AgentInfo, AgentSwitch, Transport } from "@harness/api";
import { HarnessClient as Client } from "@harness/api";
import { Badge, Button, cn, Tooltip } from "@harness/ui";
import { ChevronUp, Maximize2, Minus, X, Zap } from "lucide-react";
import {
   type ReactNode,
   useCallback,
   useEffect,
   useMemo,
   useReducer,
   useRef,
   useState,
} from "react";
import { QUICK_TITLE, quickAgent } from "./composer";
import { listenHost, overlayHost } from "./overlayHost";
import { INITIAL_OVERLAY, overlayReducer } from "./overlayMode";
import { useReportError } from "./toast";
import { ViewHost } from "./ViewHost";

/** The Agent of the last Session sent from the overlay; the next draft starts with it. */
const AGENT_KEY = "harness.overlay.agent";

function savedAgent(): string | null {
   try {
      return localStorage.getItem(AGENT_KEY);
   } catch {
      return null;
   }
}

function saveAgent(id: string) {
   try {
      localStorage.setItem(AGENT_KEY, id);
   } catch {
      /* the next draft falls back to quickAgent */
   }
}

type Draft = { id: string; frontendId: string; agentId: string };

/**
 * The Quick overlay window (`?overlay=1`, ADR 0022): a draft Quick Session's prompt box, then the
 * pinned chat, or the mini bar. One more Frontend window of the core; `overlay.rs` places it.
 */
export function Overlay({ transport }: { transport: Transport }) {
   const [client] = useState(() => new Client(transport));
   const report = useReportError();
   const [s, dispatch] = useReducer(overlayReducer, INITIAL_OVERLAY);
   const [draft, setDraft] = useState<Draft | null>(null);
   const [title, setTitle] = useState(QUICK_TITLE);
   const [agents, setAgents] = useState<AgentInfo[]>([]);
   const [error, setError] = useState<string | null>(null);
   const creating = useRef(false);
   const draftRef = useRef(draft);
   draftRef.current = draft;
   const modeRef = useRef(s.mode);
   modeRef.current = s.mode;

   // The host made this window to show it, before this page could listen for `overlay-shown`.
   useEffect(() => dispatch({ type: "shown" }), []);
   useEffect(() => listenHost("overlay-shown", () => dispatch({ type: "shown" })), []);
   useEffect(() => listenHost("overlay-shortcut", () => dispatch({ type: "shortcut" })), []);

   // The host follows the state: the window size per mode, hidden when `visible` turns false.
   useEffect(() => overlayHost.setMode(s.mode), [s.mode]);
   const wasVisible = useRef(false);
   useEffect(() => {
      if (wasVisible.current && !s.visible) overlayHost.hide();
      wasVisible.current = s.visible;
   }, [s.visible]);

   // A draft Quick Session as soon as the overlay is on screen, started right away so the prompt
   // box has the Agent's models and modes. The core removes it if nothing is sent.
   const startDraft = useCallback(async () => {
      creating.current = true;
      setError(null);
      try {
         const [list, frontends, sessions] = await Promise.all([
            client.listAgents(),
            client.listFrontends(),
            client.listSessions(),
         ]);
         setAgents(list);
         const saved = savedAgent();
         const agent = list.find((a) => a.id === saved) ?? quickAgent(sessions, list);
         const frontend = frontends.find((f) => f.id === "chat") ?? frontends[0];
         if (!agent || !frontend) {
            setError("No Agent installed. Add one in the main window's Settings.");
            return;
         }
         const id = await client.createQuickSession({
            agentId: agent.id,
            frontendId: frontend.id,
         });
         setTitle(QUICK_TITLE);
         setDraft({ id, frontendId: frontend.id, agentId: agent.id });
         client
            .sessionApi(id)
            .warmUp()
            .catch(() => {});
      } catch (e) {
         report("Could not start a Quick Session", e);
      } finally {
         creating.current = false;
      }
   }, [client, report]);
   useEffect(() => {
      if (s.visible && !draft && !creating.current) void startDraft();
   }, [s.visible, draft, startDraft]);

   // The first message changes the title: the chat opens. A Turn that ends while mini marks it.
   useEffect(() => {
      let stop = false;
      let off: (() => void) | undefined;
      client
         .subscribeApp((e) => {
            const d = draftRef.current;
            if (!d || stop) return;
            if (e.type === "SessionStatus" && e.session_id === d.id) {
               setTitle(e.title);
               if (e.title !== QUICK_TITLE) {
                  saveAgent(d.agentId);
                  dispatch({ type: "sent" });
               }
            } else if (e.type === "TurnFinished" && e.session_id === d.id) {
               dispatch({ type: "turnFinished" });
            }
         })
         .then((u) => (stop ? u() : (off = u)))
         .catch((e) => report("Live updates unavailable", e));
      return () => {
         stop = true;
         off?.();
      };
   }, [client, report]);

   // Cmd+M switches chat and mini; Esc minimizes (on the prompt: hides). Open menus keep their Esc.
   useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
         if (e.defaultPrevented) return;
         if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "m") {
            e.preventDefault();
            dispatch({ type: modeRef.current === "mini" ? "expand" : "minimize" });
         } else if (
            e.key === "Escape" &&
            !document.querySelector("[data-radix-popper-content-wrapper], [role=dialog]")
         ) {
            dispatch({ type: "minimize" });
         }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
   }, []);

   /** Close: the core removes the Session if nobody wrote in it; the next show starts a new draft. */
   const close = () => {
      const d = draft;
      dispatch({ type: "reset" });
      setDraft(null);
      setTitle(QUICK_TITLE);
      if (d)
         client
            .discardEmptySession(d.id)
            .catch((e) => report("Could not remove the empty Quick Session", e));
   };
   const merge = () => {
      if (!draft) return;
      overlayHost.merge(draft.id).then(
         () => {
            dispatch({ type: "reset" });
            setDraft(null);
            setTitle(QUICK_TITLE);
         },
         (e) => report("Could not open the main window", e),
      );
   };
   /** Another Agent: its models are known only once it runs, so the draft is replaced. */
   const pickAgent = useCallback(
      (agentId: string) => {
         const d = draftRef.current;
         if (!d || d.agentId === agentId) return;
         saveAgent(agentId);
         setDraft(null);
         client.discardEmptySession(d.id).catch(() => {});
      },
      [client],
   );
   const agentSwitch = useMemo<AgentSwitch | undefined>(
      () =>
         s.mode === "prompt" && draft
            ? {
                 agents: agents.map((a) => ({ id: a.id, name: a.name })),
                 current: draft.agentId,
                 onPick: pickAgent,
              }
            : undefined,
      [s.mode, draft, agents, pickAgent],
   );

   return (
      <div className="h-full p-2">
         {s.mode === "mini" && (
            <MiniBar
               title={title}
               newReply={s.newReply}
               onClose={close}
               onExpand={() => dispatch({ type: "expand" })}
            />
         )}
         <div
            className={cn(
               "flex h-full flex-col",
               s.mode === "chat" && "overflow-hidden rounded-xl border bg-background shadow-2xl",
               s.mode === "mini" && "hidden",
            )}
         >
            {s.mode === "chat" && (
               <div
                  data-tauri-drag-region
                  className="flex h-11 shrink-0 items-center gap-2 border-b pl-3 pr-1.5"
               >
                  <Badge variant="secondary" data-tauri-drag-region className="gap-1">
                     <Zap className="size-3" /> Quick
                  </Badge>
                  <span
                     data-tauri-drag-region
                     className="min-w-0 flex-1 truncate text-sm font-medium"
                  >
                     {title}
                  </span>
                  <IconButton label="Minimize (⌘M)" onClick={() => dispatch({ type: "minimize" })}>
                     <Minus />
                  </IconButton>
                  <IconButton label="Open in main window" onClick={merge}>
                     <Maximize2 />
                  </IconButton>
                  <IconButton label="Close" onClick={close}>
                     <X />
                  </IconButton>
               </div>
            )}
            <div className="min-h-0 flex-1">
               {draft ? (
                  <ViewHost
                     transport={transport}
                     sessionId={draft.id}
                     frontendId={draft.frontendId}
                     variant="overlay"
                     agentSwitch={agentSwitch}
                  />
               ) : (
                  error && (
                     <div className="flex h-full items-end px-6 pb-3.5">
                        <p
                           role="alert"
                           className="w-full rounded-2xl border bg-card p-3 text-sm text-destructive shadow-xl"
                        >
                           {error}
                        </p>
                     </div>
                  )
               )}
            </div>
         </div>
      </div>
   );
}

function IconButton({
   label,
   onClick,
   children,
}: {
   label: string;
   onClick: () => void;
   children: ReactNode;
}) {
   return (
      <Tooltip content={label} side="bottom">
         <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-foreground"
            aria-label={label}
            onClick={onClick}
         >
            {children}
         </Button>
      </Tooltip>
   );
}

/** The minimized overlay: one bar to drag, no input. */
function MiniBar({
   title,
   newReply,
   onClose,
   onExpand,
}: {
   title: string;
   newReply: boolean;
   onClose: () => void;
   onExpand: () => void;
}) {
   return (
      <div
         data-tauri-drag-region
         className="flex h-[52px] items-center gap-2 rounded-xl border bg-background px-2 shadow-2xl"
      >
         <IconButton label="Close" onClick={onClose}>
            <X />
         </IconButton>
         <div data-tauri-drag-region className="h-5 w-px shrink-0 bg-border" />
         <Zap data-tauri-drag-region className="size-4 shrink-0 text-muted-foreground" />
         <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-sm font-medium">
            {title}
         </span>
         {newReply && (
            <Badge data-tauri-drag-region className="shrink-0">
               New reply
            </Badge>
         )}
         <IconButton label="Expand (⌘M)" onClick={onExpand}>
            <ChevronUp />
         </IconButton>
      </div>
   );
}
