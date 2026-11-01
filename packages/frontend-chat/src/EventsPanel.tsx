import type { Event, SessionApi } from "@harness/api";
import { eventFamily, useSessionEvents } from "@harness/api";
import { EventLog } from "@harness/ui";
import { PanelHeader } from "./PanelHeader";

type Log = { events: Event[] };
const init = (): Log => ({ events: [] });
const reduceBatch = (s: Log, es: readonly Event[]): Log => (es.length === 0 ? s : { events: s.events.concat(es as Event[]) });
const reduce = (s: Log, e: Event): Log => reduceBatch(s, [e]);

/** The raw Session Log in a panel (its own subscription, only while open). Expand comes from the panel menu. */
export function EventsPanel({ api }: { api: SessionApi }) {
  const { events } = useSessionEvents(api, reduce, init, reduceBatch);
  return (
    <EventLog
      events={events}
      title={null}
      family={eventFamily}
      header={(controls) => <PanelHeader title="Events" className="gap-1.5">{controls}</PanelHeader>}
      className="h-auto flex-1"
    />
  );
}
