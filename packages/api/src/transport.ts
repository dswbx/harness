import { Channel, invoke } from "@tauri-apps/api/core";
import type { AppEvent, Command, CommandResult, Event } from "./generated";

export type Unsubscribe = () => void;

/** Boundary between the UI and the Rust core (ADR 0001): three operations only. */
export interface Transport {
  execute(cmd: Command): Promise<CommandResult>;
  /** Replays the Session Log from `fromSeq`, then streams live. */
  subscribe(sessionId: string, fromSeq: number, onEvent: (e: Event) => void): Promise<Unsubscribe>;
  /** Harness-wide notifications (session list, attention, agents). Live only, no replay. */
  subscribeApp(onEvent: (e: AppEvent) => void): Promise<Unsubscribe>;
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
};
