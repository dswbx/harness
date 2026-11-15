import { CommandError } from "../errors";
import type { Command, CommandResult } from "../generated";
import type { Transport } from "../transport/transport";

/** Runs a Command and returns its result, which must be `type`; anything else is a bug and rejects with `internal`. */
export async function expectResult<T extends CommandResult["type"]>(
   transport: Transport,
   cmd: Command,
   type: T,
): Promise<Extract<CommandResult, { type: T }>> {
   const r = await transport.execute(cmd);
   if (r.type !== type)
      throw new CommandError("internal", `unexpected result: ${r.type} for ${cmd.type}`);
   return r as Extract<CommandResult, { type: T }>;
}

/** Runs a Command whose result is not read. */
export async function run(transport: Transport, cmd: Command): Promise<void> {
   await transport.execute(cmd);
}
