import type { AgentInfo, AgentSwitch, PanelWidth, Transport } from "@harness/api";
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
import { listenHost, type OverlayAnchor, overlayHost } from "./overlayHost";
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

/** Transparent margin around the card for its shadow (logical px); `SHADOW` in `overlay.rs`. */
const SHADOW = 20;

/**
 * Open menus, popovers and lists (Radix portals them into `body`; the prompt's "/" and "#" menus
 * are lists in the box). Tooltips do not count: they fit and should not move the window.
 */
const MENU =
   "[data-radix-popper-content-wrapper]:has([role=menu],[role=listbox],[role=dialog]), [role=listbox]";

/** True while a menu is open in this page (checked once per frame after DOM changes). */
function useMenuOpen(): boolean {
   const [open, setOpen] = useState(false);
   useEffect(() => {
      let frame = 0;
      const check = () => {
         frame = 0;
         setOpen(!!document.querySelector(MENU));
      };
      const mo = new MutationObserver(() => {
         if (!frame) frame = requestAnimationFrame(check);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      return () => {
         mo.disconnect();
         cancelAnimationFrame(frame);
      };
   }, []);
   return open;
}

type Draft = { id: string; frontendId: string; agentId: string };

const NO_PANELS: PanelWidth = { left: 0, right: 0 };
const samePanels = (a: PanelWidth, b: PanelWidth) => a.left === b.left && a.right === b.right;

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
   // `shown` counts the host's shows: each one drops the menu room (the host did too).
   const [shown, setShown] = useState(0);
   const [anchor, setAnchor] = useState<OverlayAnchor>("top");
   useEffect(
      () =>
         listenHost("overlay-shown", (a) => {
            setAnchor(a === "bottom" ? "bottom" : "top");
            setShown((n) => n + 1);
            dispatch({ type: "shown" });
         }),
      [],
   );
   useEffect(() => listenHost("overlay-shortcut", () => dispatch({ type: "shortcut" })), []);

   // The host follows the state: the window size per mode, hidden when `visible` turns false.
   useEffect(() => overlayHost.setMode(s.mode), [s.mode]);
   const wasVisible = useRef(false);
   useEffect(() => {
      if (wasVisible.current && !s.visible) overlayHost.hide();
      wasVisible.current = s.visible;
   }, [s.visible]);

   // A web page cannot draw outside its window: while a menu is open the host grows the window
   // right and down (its top-left stays, so the card does not move). The card keeps its size: it is
   // pinned to the window size from before, then unpinned once the window is back.
   const want = useMenuOpen() && s.visible;
   const [pin, setPin] = useState<{ w: number; h: number } | null>(null);
   // One host call at a time; `held`: no new room until the menus close (after a show or mode change).
   const room = useRef({ busy: false, grown: false, held: false });
   const [synced, setSynced] = useState(0);
   // biome-ignore lint/correctness/useExhaustiveDependencies: a show or a mode change drops the room on the host side.
   useEffect(() => {
      room.current.grown = false;
      room.current.held = true;
      setPin(null);
   }, [s.mode, shown]);
   // biome-ignore lint/correctness/useExhaustiveDependencies: `synced` re-runs it after each host call.
   useEffect(() => {
      const r = room.current;
      if (!want) r.held = false;
      if (r.busy) return;
      const call = (open: boolean) => {
         r.busy = true;
         overlayHost
            .setMenuRoom(open)
            .catch((e) => console.error("overlay_set_menu_room failed", e))
            .finally(() => {
               r.busy = false;
               r.grown = open;
               if (!open) setPin(null);
               setSynced((n) => n + 1);
            });
      };
      if (want && !r.grown && !r.held) {
         // The pin is on the page before the window grows.
         if (pin) call(true);
         else setPin({ w: window.innerWidth, h: window.innerHeight });
      } else if (!want && r.grown) call(false);
      else if (!want && pin) setPin(null);
   }, [want, pin, synced]);

   // Side panels (Phase 2): the View says how much room its panels and stripes want beside the chat;
   // the host widens the window by that much, the card stays put. One host call at a time.
   const [panelsWant, setPanelsWant] = useState<PanelWidth>(NO_PANELS);
   const [panelsHost, setPanelsHost] = useState<PanelWidth>(NO_PANELS);
   const panelsBusy = useRef(false);
   const onPanelWidth = useCallback(
      (w: PanelWidth) => setPanelsWant((p) => (samePanels(p, w) ? p : w)),
      [],
   );
   useEffect(() => {
      if (panelsBusy.current || samePanels(panelsWant, panelsHost)) return;
      panelsBusy.current = true;
      const w = panelsWant;
      overlayHost
         .setPanels(w.left, w.right)
         .catch((e) => console.error("overlay_set_panels failed", e))
         .finally(() => {
            panelsBusy.current = false;
            setPanelsHost(w);
         });
   }, [panelsWant, panelsHost]);

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
      setPanelsWant(NO_PANELS);
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
            setPanelsWant(NO_PANELS);
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
   // The same Agent · model chip before and after the first message; after it the Agent is fixed.
   const agentSwitch = useMemo<AgentSwitch | undefined>(
      () =>
         draft
            ? {
                 agents: agents.map((a) => ({ id: a.id, name: a.name })),
                 current: draft.agentId,
                 onPick: pickAgent,
                 locked: s.mode !== "prompt",
              }
            : undefined,
      [s.mode, draft, agents, pickAgent],
   );
   // Below the mouse the prompt box is at the top of its window (it grows down); at the bottom of
   // the screen it is at the bottom.
   const promptAtTop = s.mode === "prompt" && anchor === "top";

   const chat = s.mode === "chat";
   // Until the host has the new width, the View's row keeps the width it wants and stays on the side
   // that does not change, so the card does not move: a left panel grows the window to the left
   // (the row sits at the right edge meanwhile), a right one to the right.
   const moving = chat && !samePanels(panelsWant, panelsHost);
   const inner = (pin?.w ?? window.innerWidth) - 2 * SHADOW;
   const rowWidth = inner - panelsHost.left - panelsHost.right + panelsWant.left + panelsWant.right;
   const atRight = panelsWant.left !== panelsHost.left && panelsWant.right === panelsHost.right;
   // The chat card: header, the View's chat column, resize grip. The View puts its panels outside it.
   const chatFrame = (column: ReactNode) => (
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-overlay">
         <div
            data-tauri-drag-region
            className="flex h-11 shrink-0 items-center gap-2 border-b pl-3 pr-1.5"
         >
            <Badge variant="secondary" data-tauri-drag-region className="gap-1">
               <Zap className="size-3" /> Quick
            </Badge>
            <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-sm font-medium">
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
         {column}
         {chat && <ResizeGrip />}
      </div>
   );

   return (
      <div
         className="h-full overflow-hidden"
         style={{ padding: SHADOW, ...(pin && { width: pin.w, height: pin.h }) }}
      >
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
               "flex h-full",
               chat ? atRight && moving && "justify-end" : "flex-col",
               s.mode === "mini" && "hidden",
            )}
         >
            <div
               className={cn(
                  chat
                     ? cn("h-full min-w-0", moving ? "shrink-0" : "flex-1")
                     : cn("min-h-0", !promptAtTop && "flex-1"),
               )}
               style={moving ? { width: rowWidth } : undefined}
            >
               {draft ? (
                  <ViewHost
                     transport={transport}
                     sessionId={draft.id}
                     frontendId={draft.frontendId}
                     variant="overlay"
                     agentSwitch={agentSwitch}
                     chatFrame={chatFrame}
                     onPanelWidth={onPanelWidth}
                  />
               ) : (
                  error && (
                     <div
                        className={cn(
                           "flex h-full px-6 pb-3.5",
                           promptAtTop ? "items-start" : "items-end",
                        )}
                     >
                        <p
                           role="alert"
                           className="w-full rounded-2xl border bg-card p-3 text-sm text-destructive shadow-overlay"
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

/**
 * The chat's resize corner. A borderless macOS window has no resize edges, so the drag is here:
 * screen deltas from the card's size (plus its shadow margin) at the start, one host call per
 * frame (top-left kept). Side panels keep their widths; the host adds them.
 */
function ResizeGrip() {
   const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
   const next = useRef<[number, number] | null>(null);
   const frame = useRef(0);
   const send = () => {
      frame.current = 0;
      if (next.current) overlayHost.resize(...next.current);
      next.current = null;
   };
   const end = () => {
      drag.current = null;
      cancelAnimationFrame(frame.current);
      send();
   };
   return (
      <div
         role="separator"
         aria-label="Resize"
         className="absolute right-0 bottom-0 z-10 flex size-4 cursor-nwse-resize touch-none items-end justify-end p-0.5 text-muted-foreground/60 hover:text-muted-foreground"
         onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            const card = e.currentTarget.parentElement!;
            drag.current = {
               x: e.screenX,
               y: e.screenY,
               w: card.offsetWidth + 2 * SHADOW,
               h: card.offsetHeight + 2 * SHADOW,
            };
         }}
         onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            next.current = [d.w + e.screenX - d.x, d.h + e.screenY - d.y];
            if (!frame.current) frame.current = requestAnimationFrame(send);
         }}
         onPointerUp={end}
         onPointerCancel={end}
      >
         <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true">
            <path
               d="M9 3 3 9M9 6.5 6.5 9"
               stroke="currentColor"
               strokeWidth="1.2"
               strokeLinecap="round"
            />
         </svg>
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
         className="flex h-[52px] items-center gap-2 rounded-xl border bg-background px-2 shadow-overlay"
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
