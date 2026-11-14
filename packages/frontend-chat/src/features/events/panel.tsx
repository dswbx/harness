import { ScrollText } from "lucide-react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { EventsPanel } from "./EventsPanel";

/** The raw Session Log. Mounted only while open (it has its own subscription). */
export const eventsPanel = definePanel<null>({
   id: "events",
   label: "Events",
   icon: ScrollText,
   placement: { edge: "bottom", end: true },
   expandable: true,
   useModel: () => null,
   status: () => ({ presence: "ready" }),
   Body: ({ ctx }: PanelBodyProps<null>) => <EventsPanel api={ctx.api} />,
});
