import { HarnessClient, MockTransport, inTauri, tauriTransport, type Transport } from "@harness/api";
import { registry } from "./registry";

/** Real IPC inside Tauri; otherwise a MockTransport replaying a fixture, for plain-browser development. */
export async function makeTransport(): Promise<Transport> {
  if (inTauri()) return tauriTransport;
  const { mockEvents } = await import("./mock/events");
  return new MockTransport(
    mockEvents(),
    Object.values(registry).map((f) => f.manifest),
  );
}

export async function makeClient() {
  return new HarnessClient(await makeTransport());
}
