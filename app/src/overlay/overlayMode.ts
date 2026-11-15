/**
 * The Quick overlay's state (ADR 0022), a pure reducer. The host (`overlay/`) only follows it:
 * each `mode` sets the window size, and `visible` going false hides the window.
 *
 * - `prompt`: a draft Session, only its prompt box.
 * - `chat`: the pinned chat, after the first message.
 * - `mini`: one bar; `newReply` is set when a Turn ends while it is mini.
 */
export type OverlayMode = "prompt" | "chat" | "mini";

export type OverlayState = { mode: OverlayMode; visible: boolean; newReply: boolean };

export type OverlayAction =
   /** The host put the window on screen (the shortcut, while hidden). */
   | { type: "shown" }
   /** The shortcut, while the window is on screen. */
   | { type: "shortcut" }
   /** The draft's first message went out (its title changed). */
   | { type: "sent" }
   /** Cmd+M, Esc or the minimize button. */
   | { type: "minimize" }
   /** The mini bar's expand button. */
   | { type: "expand" }
   /** A Turn of the Session ended. */
   | { type: "turnFinished" }
   /** Close or merge: hidden, and the next show starts a new draft. */
   | { type: "reset" };

export const INITIAL_OVERLAY: OverlayState = { mode: "prompt", visible: false, newReply: false };

export function overlayReducer(s: OverlayState, a: OverlayAction): OverlayState {
   switch (a.type) {
      case "shown":
         return s.visible ? s : { ...s, visible: true };
      case "shortcut":
         // Only opens: a mini bar expands; the prompt and the chat stay (Esc and Cmd+M hide or minimize).
         return s.mode === "mini" ? { ...s, mode: "chat", newReply: false } : s;
      case "sent":
         return s.mode === "prompt" ? { ...s, mode: "chat" } : s;
      case "minimize":
         if (s.mode === "prompt") return { ...s, visible: false };
         return s.mode === "chat" ? { ...s, mode: "mini" } : s;
      case "expand":
         return s.mode === "mini" ? { ...s, mode: "chat", newReply: false } : s;
      case "turnFinished":
         return s.mode === "mini" && !s.newReply ? { ...s, newReply: true } : s;
      case "reset":
         return INITIAL_OVERLAY;
   }
}

/**
 * Which window edge the chat row keeps to while the window goes from room `from` to `to`: the right
 * edge when only the left side changes (the window's left edge moves), else the left edge.
 */
export function rowEdge(
   from: { left: number; right: number },
   to: { left: number; right: number },
): "left" | "right" {
   return from.left !== to.left && from.right === to.right ? "right" : "left";
}

type Room = { left: number; right: number };

/** The two side widths are the same. */
export const samePanels = (a: Room, b: Room) => a.left === b.left && a.right === b.right;

/** The menu room (the window grows right and down while a menu is open): what the host call chain has done so far. */
export type MenuRoom = { busy: boolean; grown: boolean; held: boolean };

/** What the menu room does next: pin the card to its size, grow or shrink the window, or unpin it. */
export type MenuRoomAct = "none" | "pin" | "open" | "close" | "unpin";

/**
 * One step of the menu room. `want`: a menu is open and the overlay is on screen. `pinned`: the card
 * is pinned to the old window size. `held` (after a show or mode change) means no new room until the
 * menus close; it drops as soon as nothing wants room, also while a host call is running.
 * The pin is on the page before the window grows (`pin`, then `open` on the next step).
 */
export function menuRoomStep(
   r: MenuRoom,
   want: boolean,
   pinned: boolean,
): { held: boolean; act: MenuRoomAct } {
   const held = want ? r.held : false;
   if (r.busy) return { held, act: "none" };
   if (want && !r.grown && !held) return { held, act: pinned ? "open" : "pin" };
   if (!want && r.grown) return { held, act: "close" };
   if (!want && pinned) return { held, act: "unpin" };
   return { held, act: "none" };
}

/** What the side panels' room does next: the row moves to the edge that stays, or the host resizes the window. */
export type PanelRoomAct =
   | { type: "none" }
   | { type: "edge"; edge: "left" | "right" }
   | { type: "resize"; to: Room };

/**
 * One step of the panel room. `want`: what the View asks for; `host`: what the window has now. The
 * row is on its edge before the window changes; one host call at a time (`busy`).
 */
export function panelRoomStep(o: {
   busy: boolean;
   want: Room;
   host: Room;
   edge: "left" | "right";
}): PanelRoomAct {
   if (o.busy || samePanels(o.want, o.host)) return { type: "none" };
   const next = rowEdge(o.host, o.want);
   if (next !== o.edge) return { type: "edge", edge: next };
   return { type: "resize", to: o.want };
}
