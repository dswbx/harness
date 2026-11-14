import type { Command, CommandResult } from "../../generated";
import type { MockTransport } from "../mock";

/** What the mock does for one Command. */
export type Handler<K extends Command["type"]> = (
   mock: MockTransport,
   cmd: Extract<Command, { type: K }>,
) => Promise<CommandResult> | CommandResult;

/** One handler per Command: a Command without one does not compile. */
export type Handlers = { [K in Command["type"]]: Handler<K> };
