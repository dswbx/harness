import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "@/components/ui/button";
import { execute, subscribe } from "./api";
import type { Event } from "./generated";

const label = getCurrentWindow().label;

export default function App() {
  const [count, setCount] = useState(0);
  const [last, setLast] = useState<Event | null>(null);
  const [report, setReport] = useState("");

  useEffect(() => {
    let unsub: (() => Promise<unknown>) | undefined;
    let cancelled = false;
    (async () => {
      const pong = await execute<{ pong: string }>({ type: "Ping", text: label });
      console.log(`[${label}] round-trip`, pong);
      if (cancelled) return; // StrictMode double-mount: avoid orphan subscription
      const s = { n: 0, lastSeq: 0, outOfOrder: 0, t0: 0, burstMs: -1 };
      s.t0 = performance.now();
      const sub = await subscribe(0, (e) => {
        if (cancelled) return;
        s.n++;
        if (e.seq !== s.lastSeq + 1) s.outOfOrder++;
        s.lastSeq = e.seq;
        if (s.n === 1000) {
          s.burstMs = performance.now() - s.t0;
          const r = `[${label}] burst 1000 events in ${s.burstMs.toFixed(1)}ms, outOfOrder=${s.outOfOrder}`;
          console.log(r);
          setReport(r);
          execute({ type: "Ping", text: r }); // surfaces timing in Rust stderr
        }
        setCount(s.n);
        setLast(e);
      });
      if (cancelled) sub.unsubscribe(); else unsub = sub.unsubscribe;
      // main window opens the second window from Rust
      if (label === "main") await execute({ type: "CreateSession", name: "open-window" });
    })();
    return () => { cancelled = true; unsub?.(); };
  }, []);

  return (
    <main className="p-6 space-y-3 font-mono text-sm">
      <h1 className="text-xl font-bold">window: {label}</h1>
      <div>events: <b>{count}</b></div>
      <div>{report}</div>
      <pre className="bg-neutral-100 p-2 rounded">{JSON.stringify(last, null, 1)}</pre>
      <Button onClick={() => execute({ type: "Ping", text: "click" }).then(console.log)}>Ping</Button>
    </main>
  );
}
