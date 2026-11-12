/**
 * The Quick overlay's state (ADR 0022), a pure reducer. The host (`overlay.rs`) only follows it:
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
