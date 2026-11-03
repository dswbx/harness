import {
   HarnessClient,
   inTauri,
   MockTransport,
   type Transport,
   tauriTransport,
} from "@harness/api";
import { registry } from "./registry";

/** Real IPC inside Tauri; otherwise a MockTransport replaying a fixture, for plain-browser development. */
export async function makeTransport(): Promise<Transport> {
   if (inTauri()) return tauriTransport;
   const { mockEvents } = await import("./mock/events");
   // `?stress`: a long synthetic Session, for profiling.
   const stress = new URLSearchParams(location.search).has("stress");
   return new MockTransport(
      stress ? (await import("./mock/stressEvents")).stressEvents() : mockEvents(),
      Object.values(registry).map((f) => f.manifest),
   );
}

export async function makeClient() {
   return new HarnessClient(await makeTransport());
}
