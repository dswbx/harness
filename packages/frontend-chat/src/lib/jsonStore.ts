import { type Stored, storedValue } from "@harness/api";

/** A Session's stored JSON, as parsed (`undefined`: nothing stored or not JSON). Per window: not followed across windows. */
export const sessionJson = (key: string, sessionId: string): Stored<unknown> =>
   storedValue<unknown>({
      key,
      scope: { session: sessionId },
      parse: (raw) => {
         if (raw === null) return undefined;
         try {
            return JSON.parse(raw);
         } catch {
            return undefined;
         }
      },
      sync: false,
   });
