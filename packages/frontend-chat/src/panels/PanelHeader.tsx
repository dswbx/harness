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
   AppWindow,
   Check,
   Maximize2,
   MessageSquare,
   Minimize2,
   Minus,
   MoreVertical,
   MoveUpRight,
} from "lucide-react";
import {
   createContext,
   type PointerEvent,
   type ReactNode,
   useContext,
   useLayoutEffect,
   useSyncExternalStore,
} from "react";

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

/** The host's part of a panel's menu (after the panel's own entries): Expand, Move to and the window entries. */
export type PanelMenuModel = {
   /** The places Move to offers, in order; `current` is where the panel sits now. */
   moves: { id: string; label: string; current: boolean }[];
   onMove: (id: string) => void;
   /** Offers Expand (Collapse while expanded). Absent: not offered. */
   expand?: { expanded: boolean; onToggle: () => void };
   /** Offers Move to › New window. */
   onPopOut?: () => void;
   /** The panel is open in a window of its own: Show window and Dock back, no Expand and no New window. */
   window?: { onShow: () => void; onDockBack: () => void };
};

/**
 * A panel's menu entries: its own (`own`), then the host's (`model`). One list for the panel's ⋮ menu and its
 * rail icon's context menu, so the two never differ. The `DropdownMenu*` item parts also fill a context menu.
 */
export function PanelMenuItems({ model, own }: { model: PanelMenuModel; own?: ReactNode }) {
   const w = model.window;
   return (
      <>
         {own != null && own !== false && (
            <>
               {own}
               <DropdownMenuSeparator />
            </>
         )}
         {w ? (
            <>
               <DropdownMenuItem onSelect={w.onShow}>
                  <AppWindow /> Show window
               </DropdownMenuItem>
               <DropdownMenuItem onSelect={w.onDockBack}>
                  <Minimize2 /> Dock back
               </DropdownMenuItem>
               <DropdownMenuSeparator />
            </>
         ) : (
            model.expand && (
               <>
                  <DropdownMenuItem onSelect={model.expand.onToggle}>
                     {model.expand.expanded ? <Minimize2 /> : <Maximize2 />}{" "}
                     {model.expand.expanded ? "Collapse" : "Expand"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
               </>
            )
         )}
         <DropdownMenuSub>
            <DropdownMenuSubTrigger>
               <MoveUpRight /> Move to
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
               {model.moves.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => !m.current && model.onMove(m.id)}>
                     {m.label}
                     {m.current && <Check className="ml-auto" />}
                  </DropdownMenuItem>
               ))}
               {!w && model.onPopOut && (
                  <>
                     <DropdownMenuSeparator />
                     <DropdownMenuItem onSelect={model.onPopOut}>
                        <Maximize2 /> New window
                     </DropdownMenuItem>
                  </>
               )}
            </DropdownMenuSubContent>
         </DropdownMenuSub>
      </>
   );
}

/** The panels' own menu entries by panel id, as their mounted headers last rendered them (for the rail menus). */
export type PanelMenus = {
   get: (id: string) => ReactNode;
   set: (id: string, menu: ReactNode) => void;
   subscribe: (listener: () => void) => () => void;
};

export function createPanelMenus(): PanelMenus {
   const menus = new Map<string, ReactNode>();
   const listeners = new Set<() => void>();
   return {
      get: (id) => menus.get(id),
      set: (id, menu) => {
         if (menus.get(id) === menu) return;
         if (menu === undefined) menus.delete(id);
         else menus.set(id, menu);
         for (const l of listeners) l();
      },
      subscribe: (l) => {
         listeners.add(l);
         return () => listeners.delete(l);
      },
   };
}

/** Where the mounted panel headers put their own menu entries. Absent: they put them nowhere. */
export const PanelMenusContext = createContext<PanelMenus | null>(null);

/** The menu of panel `id` outside its header (a rail icon's context menu): its own entries while it is mounted, then `model`. */
export function RegisteredPanelMenuItems({ id, model }: { id: string; model: PanelMenuModel }) {
   const menus = useContext(PanelMenusContext);
   const own = useSyncExternalStore(
      menus?.subscribe ?? noSubscribe,
      () => menus?.get(id),
      () => menus?.get(id),
   );
   return <PanelMenuItems model={model} own={own} />;
}

const noSubscribe = () => () => {};

/** The host part of the ⋮ menu of a panel in a zone. */
const chromeMenu = (p: PanelChrome): PanelMenuModel => ({
   moves: p.moves,
   onMove: p.onMove,
   expand: p.expandable ? { expanded: p.expanded, onToggle: p.onExpand } : undefined,
   onPopOut: p.onPopOut,
});

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
   // The rail icon's context menu shows the panel's own entries too (the main window's headers only).
   const menus = useContext(PanelMenusContext);
   const registerAs = p && !p.window ? p.id : undefined;
   useLayoutEffect(() => {
      if (!menus || !registerAs) return;
      menus.set(registerAs, menu);
   });
   useLayoutEffect(() => {
      if (!menus || !registerAs) return;
      return () => menus.set(registerAs, undefined);
   }, [menus, registerAs]);
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
                     <PanelMenuItems model={chromeMenu(p)} own={menu} />
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
         {/* "deep": a press anywhere in the header drags the window, except on clickable parts (buttons, links, inputs, tabs). */}
         <div
            data-tauri-drag-region="deep"
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
