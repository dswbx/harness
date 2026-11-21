/**
 * Calls `fn` until it resolves: after a failure it waits `retryMs`, twice as long after each next
 * one, at most `retries` times, then rejects with the last error. Once `signal` aborts it stops
 * waiting and rejects with the last error. Not in the public entry.
 */
export async function withRetry<T>(
   fn: () => Promise<T>,
   signal: AbortSignal,
   retryMs = 250,
   retries = 5,
): Promise<T> {
   for (let attempt = 0; ; attempt++) {
      try {
         return await fn();
      } catch (err) {
         if (signal.aborted || attempt >= retries) throw err;
         await sleep(retryMs * 2 ** attempt, signal);
         if (signal.aborted) throw err;
      }
   }
}

/** Resolves after `ms`, or at once when `signal` aborts (the timer is cleared). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
   return new Promise((resolve) => {
      const done = () => {
         clearTimeout(timer);
         signal.removeEventListener("abort", done);
         resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
   });
}
