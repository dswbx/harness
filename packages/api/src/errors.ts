import type { ErrorCode, HarnessError } from "./generated";

/**
 * What a failed Command rejects with. `code` says why (branch on it, never on `message`);
 * `message` is for the user. Every transport turns its own failures into this.
 */
export class CommandError extends Error implements HarnessError {
   readonly code: ErrorCode;
   constructor(code: ErrorCode, message: string) {
      super(message);
      this.name = "CommandError";
      this.code = code;
   }
}

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
   "auth_required",
   "not_found",
   "conflict",
   "policy_denied",
   "agent_unavailable",
   "invalid",
   "internal",
]);

/** The wire shape the core sends: `{ code, message }`. */
function isWire(e: unknown): e is HarnessError {
   const w = e as Partial<HarnessError> | null;
   return (
      typeof e === "object" &&
      e !== null &&
      typeof w?.code === "string" &&
      CODES.has(w.code) &&
      typeof w.message === "string"
   );
}

/** Any rejection as a `CommandError`: the core's `{ code, message }`, or `internal` for anything else (a string, an Error). */
export function toCommandError(e: unknown): CommandError {
   if (e instanceof CommandError) return e;
   if (isWire(e)) return new CommandError(e.code, e.message);
   if (e instanceof Error) return new CommandError("internal", e.message);
   return new CommandError("internal", typeof e === "string" ? e : JSON.stringify(e));
}

/** Whether `e` is a Command failure, and (with `code`) of that code. */
export function isCommandError(e: unknown, code?: ErrorCode): e is CommandError {
   return e instanceof CommandError && (code === undefined || e.code === code);
}

/** A failure as text for the user (a Command's `message`; anything else as it reads). */
export const errText = (e: unknown): string => toCommandError(e).message;
