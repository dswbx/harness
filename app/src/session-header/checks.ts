import type { PrInfo } from "@harness/api";

/** Checks are running or may be about to start: an open PR with pending checks, or none yet and just updated. */
export const watchingChecks = (pr: PrInfo | null, now = Date.now()) =>
   !!pr &&
   (pr.state === "open" || pr.state === "draft") &&
   (pr.checks === "pending" ||
      (pr.checks_total === 0 && now - Date.parse(pr.updated_at) < 5 * 60_000));
