import { inTauri } from "@harness/api";
import {
   Button,
   cn,
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
   DropdownMenuTrigger,
   Tooltip,
} from "@harness/ui";
import {
   Check,
   Maximize2,
   MessageSquare,
   Minimize2,
   Minus,
   MoreVertical,
   MoveUpRight,
} from "lucide-react";
import { createContext, type PointerEvent, type ReactNode, useContext } from "react";

/** What the host tells the panel it is in, for its header: where it can move and what the header can do. */
export type PanelChrome = {
   id: string;
   label: string;
   /** The places Move to offers, in order; `current` is where the panel sits now. */
   moves: { id: string; label: string; current: boolean }[];
   /** Offers Expand in the menu. */
   expandable: boolean;
   expanded: boolean;
   onExpand: () => void;
   onMove: (id: string) => void;
   onHide: () => void;
   /** Pointer down on the header: drags the panel to another zone. */
   onDragStart: (e: PointerEvent) => void;
   /** Opens the panel in a window of its own ("Open in window", Move to › New window). Absent: not offered. */
   onPopOut?: () => void;
   /** The panel fills a panel window of its own: the header is that window's title bar. */
   window?: PanelWindowChrome;
};

/** What a panel window's header shows besides the panel: its icon, the Session it belongs to, Dock back. */
export type PanelWindowChrome = {
   icon?: ReactNode;
   sessionTitle: string;
   /** The Session's folder name (or "Quick"), for the session chip's tooltip. */
   project?: string;
   /** Shows the Session in the main window. */
   onShowSession: () => void;
   /** Puts the panel back in its zone of the main window and closes this window. */
   onDockBack: () => void;
   /** Shown under the header (e.g. "Session archived"). */
   notice?: ReactNode;
};

export const PanelContext = createContext<PanelChrome | null>(null);

/**
 * The header every panel shares: `title`, the panel's own controls (`children`), a menu (the panel's own
 * entries in `menu`, then Expand, Move to), Open in window (when offered) and the hide button. Dragging the header drags the panel to another zone.
 */
export function PanelHeader({
   title,
   titleHint,
   children,
   menu,
   className,
}: {
   title?: ReactNode;
   titleHint?: string;
   children?: ReactNode;
   menu?: ReactNode;
   className?: string;
}) {
   const p = useContext(PanelContext);
   if (p?.window)
      return (
         <WindowHeader
            p={p}
            w={p.window}
            title={title}
            titleHint={titleHint}
            menu={menu}
            className={className}
         >
            {children}
         </WindowHeader>
      );
   return (
      <div
         className={cn("flex shrink-0 items-center gap-1.5 border-b h-10 pr-2 pl-2.5", className)}
         onPointerDown={(e) =>
            !p?.expanded &&
            !(e.target as Element).closest("button, input, select, a, label, [role=tab]") &&
            p?.onDragStart(e)
         }
      >
         {title != null && (
            <Tooltip content={titleHint}>
               <span className="min-w-0 truncate text-sm font-medium">{title}</span>
            </Tooltip>
         )}
         {children}
         {p && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
               {p.onPopOut && (
                  <Tooltip content="Open in window" side="bottom">
                     <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label={`Open ${p.label} in window`}
                        onClick={p.onPopOut}
                     >
                        <Maximize2 />
                     </Button>
                  </Tooltip>
               )}
               <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                     <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 data-[state=open]:bg-accent"
                        aria-label={`${p.label} options`}
                     >
                        <MoreVertical />
                     </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                     {menu && (
                        <>
                           {menu}
                           <DropdownMenuSeparator />
                        </>
                     )}
                     {p.expandable && (
                        <>
                           <DropdownMenuItem onSelect={p.onExpand}>
                              {p.expanded ? <Minimize2 /> : <Maximize2 />}{" "}
                              {p.expanded ? "Collapse" : "Expand"}
                           </DropdownMenuItem>
                           <DropdownMenuSeparator />
                        </>
                     )}
                     <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                           <MoveUpRight /> Move to
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-44">
                           {p.moves.map((m) => (
                              <DropdownMenuItem
                                 key={m.id}
                                 onSelect={() => !m.current && p.onMove(m.id)}
                              >
                                 {m.label}
                                 {m.current && <Check className="ml-auto" />}
                              </DropdownMenuItem>
                           ))}
                           {p.onPopOut && (
                              <>
                                 <DropdownMenuSeparator />
                                 <DropdownMenuItem onSelect={p.onPopOut}>
                                    <Maximize2 /> New window
                                 </DropdownMenuItem>
                              </>
                           )}
                        </DropdownMenuSubContent>
                     </DropdownMenuSub>
                  </DropdownMenuContent>
               </DropdownMenu>
               <Tooltip content="Hide" side="bottom">
                  <Button
                     size="icon"
                     variant="ghost"
                     className="size-7"
                     aria-label={`Hide ${p.label}`}
                     onClick={p.onHide}
                  >
                     <Minus />
                  </Button>
               </Tooltip>
            </div>
         )}
      </div>
   );
}

/**
 * A panel window's header (its title bar, like the Diff window's): panel icon and title, the panel's own
 * controls, the session chip, Dock back and the menu (the panel's entries, then Dock back). No Move to,
 * Expand or Hide. The session chip is icon only when the window is narrow.
 */
function WindowHeader({
   p,
   w,
   title,
   titleHint,
   children,
   menu,
   className,
}: {
   p: PanelChrome;
   w: PanelWindowChrome;
   title?: ReactNode;
   titleHint?: string;
   children?: ReactNode;
   menu?: ReactNode;
   className?: string;
}) {
   const session = w.project ? `${w.project} · ${w.sessionTitle}` : w.sessionTitle;
   return (
      <>
         <div
            data-tauri-drag-region
            className={cn(
               "@container flex shrink-0 items-center gap-1.5 border-b pr-2",
               className,
               "h-13",
               // Room for the traffic lights (overlay title bar).
               inTauri() ? "pl-[92px]" : "pl-2",
            )}
         >
            {w.icon && (
               <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">{w.icon}</span>
            )}
            {/* A panel without a title shows its own (tabs, a label) in `children`. */}
            {title != null && (
               <Tooltip content={titleHint}>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
               </Tooltip>
            )}
            {children}
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
               <Tooltip content={session} side="bottom">
                  <button
                     type="button"
                     className="flex h-7 max-w-[180px] min-w-0 items-center gap-1.5 rounded-md bg-accent px-2 text-xs text-accent-foreground hover:bg-accent/80"
                     aria-label={`Show session ${w.sessionTitle}`}
                     onClick={w.onShowSession}
                  >
                     <MessageSquare className="size-3.5 shrink-0" />
                     <span className="min-w-0 truncate @max-md:hidden">{w.sessionTitle}</span>
                  </button>
               </Tooltip>
               <div aria-hidden className="mx-1 h-4 w-px bg-border" />
               <Tooltip content="Dock back" side="bottom">
                  <Button
                     size="icon"
                     variant="ghost"
                     className="size-7"
                     aria-label={`Dock back ${p.label}`}
                     onClick={w.onDockBack}
                  >
                     <Minimize2 />
                  </Button>
               </Tooltip>
               <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                     <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 data-[state=open]:bg-accent"
                        aria-label={`${p.label} options`}
                     >
                        <MoreVertical />
                     </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                     {menu && (
                        <>
                           {menu}
                           <DropdownMenuSeparator />
                        </>
                     )}
                     <DropdownMenuItem onSelect={w.onDockBack}>
                        <Minimize2 /> Dock back
                     </DropdownMenuItem>
                  </DropdownMenuContent>
               </DropdownMenu>
            </div>
         </div>
         {w.notice}
      </>
   );
}
