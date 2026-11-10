import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AppEvent, Command, CommandResult, Event, SessionMessage } from "./generated";

export type Unsubscribe = () => void;

/**
 * Terminal output (ADR 0017): first `replay` (once, may be empty: earlier output to redraw, whose
 * terminal queries must not be answered), then live bytes, then the shell's end.
 */
export type TerminalOutput = Uint8Array | { replay: Uint8Array } | { exit: number | null };

/** Boundary between the UI and the Rust core (ADR 0001): Commands, Session Logs, AppEvents, and the Terminal byte stream. */
export interface Transport {
   execute(cmd: Command): Promise<CommandResult>;
   /**
    * Replays the Session Log from `fromSeq`, then streams live. When the core drops the
    * subscription because this View fell too far behind it calls `onLagged` once and sends
    * nothing more: subscribe again (see `subscribeResilient`).
    */
   subscribe(
      sessionId: string,
      fromSeq: number,
      onEvent: (e: Event) => void,
      onLagged?: () => void,
   ): Promise<Unsubscribe>;
   /** Harness-wide notifications (session list, attention, agents). Live only, no replay. */
   subscribeApp(onEvent: (e: AppEvent) => void): Promise<Unsubscribe>;
   /** A Terminal tab of the Session (shell started if none runs): its replay buffer, then live output. Input, resize and acks are Commands. */
   attachTerminal(
      sessionId: string,
      terminalId: number,
      cols: number,
      rows: number,
      onOutput: (o: TerminalOutput) => void,
   ): Promise<Unsubscribe>;
}

/**
 * Subscribes to a Session Log and keeps the stream whole: when the core drops this View for
 * lagging, it subscribes again from the next `seq` it has not seen, so the UI catches up on its
 * own with no gaps and no duplicates. Returns an unsubscribe function.
 */
export async function subscribeResilient(
   transport: Transport,
   sessionId: string,
   fromSeq: number,
   onEvent: (e: Event) => void,
   retryMs = 250,
): Promise<Unsubscribe> {
   let next = fromSeq;
   let stopped = false;
   let off: Unsubscribe | null = null;
   const open = async (): Promise<void> => {
      const handle = await transport.subscribe(
         sessionId,
         next,
         (e) => {
            // A late Event of a dropped subscription, or a replay overlap: already delivered.
            if (stopped || e.seq < next) return;
            next = e.seq + 1;
            onEvent(e);
         },
         () => {
            if (stopped) return;
            off?.();
            off = null;
            void reopen(0);
         },
      );
      if (stopped) handle();
      else off = handle;
   };
   const reopen = async (attempt: number): Promise<void> => {
      try {
         await open();
      } catch (err) {
         if (stopped || attempt >= 5) {
            console.error("could not resubscribe to the Session Log", err);
            return;
         }
         await new Promise((r) => setTimeout(r, retryMs * 2 ** attempt));
         if (!stopped) await reopen(attempt + 1);
      }
   };
   await open();
   return () => {
      stopped = true;
      off?.();
      off = null;
   };
}

export function inTauri(): boolean {
   return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Where an Html frame loads in Tauri: a document of its own with its own CSP (harness-tauri `frame_response`).
 * A `srcdoc` frame inherits the app's CSP, which blocks its scripts. `null` outside Tauri: `srcdoc` works there.
 */
export function htmlFrameUrl(): string | null {
   return inTauri() ? convertFileSrc("", "harness-frame") : null;
}

export const tauriTransport: Transport = {
   execute: (cmd) => invoke<CommandResult>("execute", { cmd }),
   async subscribe(sessionId, fromSeq, onEvent, onLagged) {
      const channel = new Channel<SessionMessage>();
      channel.onmessage = (m) => {
         if ("kind" in m) onEvent(m);
         else onLagged?.();
      };
      const id = await invoke<number>("subscribe", { sessionId, fromSeq, channel });
      return () => {
         void invoke("unsubscribe", { sessionId, id }).catch(() => {});
      };
   },
   async subscribeApp(onEvent) {
      const channel = new Channel<AppEvent>();
      let live = true;
      channel.onmessage = (e) => live && onEvent(e);
      await invoke<number>("subscribe_app", { channel });
      // The core has no explicit unsubscribe (dropped with the webview): just stop delivering.
      return () => {
         live = false;
      };
   },
   async attachTerminal(sessionId, terminalId, cols, rows, onOutput) {
      // Raw bytes arrive as an ArrayBuffer, markers as JSON. Bytes before `replayed` are the replay.
      const channel = new Channel<ArrayBuffer | { replayed: true } | { exit: number | null }>();
      let live = true;
      let replay: Uint8Array | null = new Uint8Array();
      channel.onmessage = (m) => {
         if (!live) return;
         if (m instanceof ArrayBuffer) {
            if (replay) replay = new Uint8Array(m);
            else onOutput(new Uint8Array(m));
         } else if ("replayed" in m) {
            onOutput({ replay: replay ?? new Uint8Array() });
            replay = null;
         } else onOutput(m);
      };
      const id = await invoke<number>("terminal_attach", {
         sessionId,
         terminalId,
         cols,
         rows,
         channel,
      });
      return () => {
         live = false;
         void invoke("terminal_detach", { sessionId, terminalId, id }).catch(() => {});
      };
   },
};
