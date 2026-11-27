import type { ErrorCode, HarnessError } from "./generated";

/**
 * What a failed Command rejects with. `code` says why (branch on it, never on `message`);
 * `message` is for the user. Every transport turns its own failures into this. `path`: with
 * `needs_approval`, the real file an approval unlocks (`~/…` or absolute).
 */
export class CommandError extends Error implements HarnessError {
   readonly code: ErrorCode;
   readonly path?: string;
   constructor(code: ErrorCode, message: string, path?: string) {
      super(message);
      this.name = "CommandError";
      this.code = code;
      if (path !== undefined) this.path = path;
   }
}

/** Every `ErrorCode`: a new one in `generated.ts` fails the typecheck here until it is listed. */
const CODE_TABLE = {
   auth_required: true,
   not_found: true,
   conflict: true,
   policy_denied: true,
   agent_unavailable: true,
   invalid: true,
   timeout: true,
   unavailable: true,
   needs_approval: true,
   internal: true,
} satisfies Record<ErrorCode, true>;
const CODES: ReadonlySet<string> = new Set(Object.keys(CODE_TABLE));

/** The wire shape the core sends: `{ code, message, path? }`. */
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

/** Any rejection as a `CommandError`: the core's `{ code, message, path? }`, or `internal` for anything else (a string, an Error). */
export function toCommandError(e: unknown): CommandError {
   if (e instanceof CommandError) return e;
   if (isWire(e))
      return new CommandError(e.code, e.message, typeof e.path === "string" ? e.path : undefined);
   if (e instanceof Error) return new CommandError("internal", e.message);
   return new CommandError("internal", typeof e === "string" ? e : JSON.stringify(e));
}

/** Whether `e` is a Command failure, and (with `code`) of that code. */
export function isCommandError(e: unknown, code?: ErrorCode): e is CommandError {
   return e instanceof CommandError && (code === undefined || e.code === code);
}

/**
 * A failure as text for the user, the one way to show an error: a Command's `message`, an Error's
 * message, a string as is, an object with a string `message`, else its JSON (`String` when that
 * has none).
 */
export function errText(e: unknown): string {
   if (e instanceof Error) return e.message;
   if (typeof e === "string") return e;
   const m = (e as { message?: unknown } | null)?.message;
   if (typeof m === "string") return m;
   return JSON.stringify(e) ?? String(e);
}
