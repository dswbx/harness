import type { Event } from "@harness/api";

export type State = { events: Event[] };
export const init = (): State => ({ events: [] });

/** Appends a batch with one copy (replay of large logs stays linear). */
export const reduceBatch = (s: State, es: readonly Event[]): State =>
  es.length === 0 ? s : { events: s.events.concat(es as Event[]) };
export const reduce = (s: State, e: Event): State => reduceBatch(s, [e]);
