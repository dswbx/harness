import { invoke, Channel } from "@tauri-apps/api/core";
import type { Command, Event } from "./generated";

export const execute = <T = unknown>(cmd: Command) => invoke<T>("execute", { cmd });

/** returns subscription id + unsubscribe fn */
export async function subscribe(fromSeq: number, onEvent: (e: Event) => void) {
  const channel = new Channel<Event>();
  channel.onmessage = onEvent;
  const id = await invoke<number>("subscribe", { fromSeq, channel });
  return { id, unsubscribe: () => invoke("unsubscribe", { id }) };
}
