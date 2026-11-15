import { forgetSession, type HarnessClient, type SessionSummary } from "@harness/api";

/** `id` and its Sub Sessions, however deep (the core deletes them together). */
export function withSubSessions(list: readonly SessionSummary[], id: string): string[] {
   const out = [id];
   for (let i = 0; i < out.length; i++)
      for (const s of list)
         if (s.parent?.session_id === out[i] && !out.includes(s.id)) out.push(s.id);
   return out;
}

/** Forgets the local state of those `ids` the core no longer lists (it may have removed some of them, or none). */
export async function forgetGone(client: HarnessClient, ids: string[]): Promise<void> {
   try {
      const alive = new Set((await client.listSessions()).map((s) => s.id));
      for (const id of ids) if (!alive.has(id)) forgetSession(id);
   } catch {
      // Unknown which are gone: keep everything.
   }
}

/** Asks the core to remove the Quick Session if nobody wrote in it; its local state goes if it did. */
export async function discardEmpty(client: HarnessClient, id: string): Promise<void> {
   await client.discardEmptySession(id);
   await forgetGone(client, [id]);
}
