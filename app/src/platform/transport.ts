import { inTauri, type StartupNotice, type Transport, tauriTransport } from "@harness/api";
import { registry } from "./registry";

/** Real IPC inside Tauri; otherwise a MockTransport replaying a fixture, for plain-browser development. */
export async function makeTransport(): Promise<Transport> {
   if (inTauri()) return tauriTransport;
   const { MockTransport } = await import("@harness/api/mock");
   const { mockEvents } = await import("../mock/events");
   // `?stress`: a long synthetic Session, for profiling.
   const stress = new URLSearchParams(location.search).has("stress");
   const mock = new MockTransport(
      stress ? (await import("../mock/stressEvents")).stressEvents() : mockEvents(),
      Object.values(registry).map((f) => f.manifest),
   );
   mock.notices = mockNotices(new URLSearchParams(location.search).get("notice"));
   // `?replay=<session id>`: a real Session Log streamed into a mock Session (dev server only).
   if (new URLSearchParams(location.search).has("replay"))
      await (await import("../mock/replay")).startReplay(
         mock,
         new URLSearchParams(location.search),
      );
   return mock;
}

/** `?notice=corrupt|unreadable|stuck` previews a reset settings file. */
function mockNotices(kind: string | null): StartupNotice[] {
   const dir = "/Users/me/.harness";
   const path = `${dir}/permissions.json`;
   const what = "Permission rules were reset.";
   if (kind === "corrupt")
      return [
         {
            file: "permissions.json",
            kind: "corrupt",
            path,
            copy: `${path}.corrupt-1760000000000`,
            message: `${what} permissions.json is not valid JSON. The file is kept as ${path}.corrupt-1760000000000.`,
         },
      ];
   if (kind === "unreadable")
      return [
         {
            file: "permissions.json",
            kind: "unreadable",
            path,
            copy: `${path}.unreadable-1760000000000`,
            message: `${what} permissions.json could not be read. It may have been written by a newer version of Harness. The file is kept as ${path}.unreadable-1760000000000.`,
         },
      ];
   if (kind === "stuck")
      return [
         {
            file: "agents.json",
            kind: "corrupt",
            path: `${dir}/agents.json`,
            copy: null,
            message:
               "Installed Agents were reset. agents.json is not valid JSON. The file could not be moved aside, so it stays where it is and will not be overwritten while Harness runs.",
         },
      ];
   return [];
}
