import { Channel, invoke } from "@tauri-apps/api/core";
import type { AppEvent, Command, CommandResult, Event } from "./generated";

export type Unsubscribe = () => void;

/**
 * Terminal output (ADR 0017): first `replay` (once, may be empty: earlier output to redraw, whose
 * terminal queries must not be answered), then live bytes, then the shell's end.
 */
export type TerminalOutput = Uint8Array | { replay: Uint8Array } | { exit: number | null };

/** Boundary between the UI and the Rust core (ADR 0001): Commands, Session Logs, AppEvents, and the Terminal byte stream. */
export interface Transport {
  execute(cmd: Command): Promise<CommandResult>;
  /** Replays the Session Log from `fromSeq`, then streams live. */
  subscribe(sessionId: string, fromSeq: number, onEvent: (e: Event) => void): Promise<Unsubscribe>;
  /** Harness-wide notifications (session list, attention, agents). Live only, no replay. */
  subscribeApp(onEvent: (e: AppEvent) => void): Promise<Unsubscribe>;
  /** A Terminal tab of the Session (shell started if none runs): its replay buffer, then live output. Input, resize and acks are Commands. */
  attachTerminal(sessionId: string, terminalId: number, cols: number, rows: number, onOutput: (o: TerminalOutput) => void): Promise<Unsubscribe>;
}

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const tauriTransport: Transport = {
  execute: (cmd) => invoke<CommandResult>("execute", { cmd }),
  async subscribe(sessionId, fromSeq, onEvent) {
    const channel = new Channel<Event>();
    channel.onmessage = onEvent;
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
    const id = await invoke<number>("terminal_attach", { sessionId, terminalId, cols, rows, channel });
    return () => {
      live = false;
      void invoke("terminal_detach", { sessionId, terminalId, id }).catch(() => {});
    };
  },
};
