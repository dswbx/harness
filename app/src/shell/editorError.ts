import { isCommandError } from "@harness/api";

/**
 * Opening in the editor failed because none is chosen yet. The core answers that with `invalid`
 * (a shared artifact's id is never malformed here), so Settings opens instead of an error toast.
 */
export const needsEditor = (e: unknown): boolean => isCommandError(e, "invalid");
