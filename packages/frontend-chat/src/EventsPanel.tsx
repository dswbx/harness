import { useEffect, useState } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import type { Event, SessionApi } from "@harness/api";
import { useSessionEvents } from "@harness/api";
import { Button, EventLog, Tooltip, cn } from "@harness/ui";

type Log = { events: Event[] };
const init = (): Log => ({ events: [] });
const reduceBatch = (s: Log, es: readonly Event[]): Log => (es.length === 0 ? s : { events: s.events.concat(es as Event[]) });
const reduce = (s: Log, e: Event): Log => reduceBatch(s, [e]);

/**
 * The raw Session Log beside the chat (its own subscription, only while open). Expand grows the
 * same panel to near full-screen, so filters and opened rows stay; Escape or the backdrop shrinks it.
 */
export function EventsPanel({ api, onClose }: { api: SessionApi; onClose: () => void }) {
  const { events } = useSessionEvents(api, reduce, init, reduceBatch);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);
  return (
    <>
      {expanded && <div className="fixed inset-0 z-50 bg-black/50" onClick={() => setExpanded(false)} />}
      <aside
        aria-label="Events"
        className={cn(
          "flex h-full w-full flex-col bg-background",
          expanded ? "fixed inset-x-[3vw] inset-y-[5vh] z-50 h-auto w-auto overflow-hidden rounded-lg border shadow-lg" : "border-l",
        )}
      >
        <EventLog
          events={events}
          title="Events"
          actions={
            <>
              <Tooltip content={expanded ? "Shrink (Esc)" : "Expand"} side="bottom">
                <Button size="icon" variant="ghost" className="size-7" aria-label={expanded ? "Shrink events" : "Expand events"} onClick={() => setExpanded(!expanded)}>
                  {expanded ? <Minimize2 /> : <Maximize2 />}
                </Button>
              </Tooltip>
              <Button size="icon" variant="ghost" className="size-7" aria-label="Close panel" onClick={onClose}>
                <X />
              </Button>
            </>
          }
        />
      </aside>
    </>
  );
}
