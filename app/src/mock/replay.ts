import type { Event } from "@harness/api";
import type { MockTransport } from "@harness/api/mock";

/**
 * `?replay=<session id>[&speed=10][&from=0.5]`: streams a real Session Log from this machine (served by the dev
 * server, see `vite.config.ts`) into a new mock Session, with its own pacing sped up `speed` times (default 10;
 * gaps capped at 5 s). `from` (0 to 1): that share of the log is there at once, the rest streams. For profiling
 * the chat with real data. Its panel files come along, reloaded whenever the log shows the Agent writing one.
 * Nothing leaves the machine.
 */
export async function startReplay(mock: MockTransport, params: URLSearchParams): Promise<void> {
   const id = params.get("replay");
   if (!id) return;
   const res = await fetch(`/__harness/session-log/${encodeURIComponent(id)}`);
   if (!res.ok) {
      console.error(`replay: no Session Log for ${id} (${res.status})`);
      return;
   }
   const log = (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Event);
   const speed = Number(params.get("speed") ?? 10);
   const from = Math.floor(log.length * Number(params.get("from") ?? 0));
   const created = log.find((e) => e.kind.type === "SessionCreated")?.kind;
   const mainId = log.find((e) => e.kind.type === "ThreadStarted" && e.kind.main)?.thread_id;
   const sid = `replay-${id.slice(0, 8)}`;
   mock.addSession(
      sid,
      `Replay: ${created?.type === "SessionCreated" ? created.title : id}`,
      "chat",
      false,
   );
   const main = mock.mainThread(sid);
   // Its panel files, rewritten (so reloaded) whenever the log shows the Agent writing one.
   const panels = (await fetch(`/__harness/session-panels/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))) as Record<string, string>;
   for (const [name, content] of Object.entries(panels))
      mock.panelFiles.set(sid, (mock.panelFiles.get(sid) ?? new Map()).set(name, content));
   const panelOf = new Map<string, string>();
   const events = log.filter(
      (e) => e.kind.type !== "SessionCreated" && !(e.kind.type === "ThreadStarted" && e.kind.main),
   );
   const emit = (e: Event) => {
      mock.emit(sid, e.kind, e.thread_id === mainId ? main : (e.thread_id ?? null));
      const k = e.kind;
      if (k.type === "ToolCall" || k.type === "ToolCallUpdate") {
         const path = JSON.stringify(k.locations ?? "").match(
            /\/panels\/([^"/]+\.(?:md|html|json))"/,
         )?.[1];
         if (path) panelOf.set(k.tool_call_id, path);
         const name = panelOf.get(k.tool_call_id);
         if (k.status === "completed" && name && panels[name] !== undefined)
            window.__harnessMockPanelWrite?.(sid, name, panels[name]);
      }
   };
   const head = Math.max(0, from - (log.length - events.length));
   for (const e of events.slice(0, head)) emit(e);
   const rest = events.slice(head);
   // Each Event's time after the first one streamed, sped up, with long pauses cut short.
   let t = 0;
   const at = rest.map((e, i) => {
      if (i > 0) t += Math.min(5000, Math.max(0, e.ts_ms - rest[i - 1]!.ts_ms)) / speed;
      return t;
   });
   const t0 = performance.now();
   let i = 0;
   const tick = () => {
      const now = performance.now() - t0;
      while (i < rest.length && at[i]! <= now) emit(rest[i++]!);
      if (i < rest.length) setTimeout(tick, Math.max(0, at[i]! - now));
      else console.info(`replay: ${rest.length} Events streamed in ${Math.round(now / 1000)} s`);
   };
   console.info(`replay: ${head} Events at once, ${rest.length} over ${Math.round(t / 1000)} s`);
   setTimeout(tick, 0);
}
