import { type KeyScope, matchKey } from "./storageKeys";

/**
 * The one place that touches localStorage. A stored value reads safely (storage blocked or the
 * data bad: the parser's default), writes safely (a failure, mostly a full quota, is returned and
 * reported once), follows other windows through the `storage` event unless told not to, and must
 * be declared in `STORAGE_KEYS`. Formats stay as the callers define them: `parse`/`serialize`.
 */
export type Scope = "app" | { session: string };

export type StoredOptions<T> = {
   key: string;
   scope: Scope;
   /** The stored text (null: nothing stored) to a value. Return the default for bad data. */
   parse: (raw: string | null) => T;
   /** Default: JSON. */
   serialize?: (v: T) => string;
   /** New keys only: the value is kept as `{"v":N,"d":<serialized>}`; another version reads as unset. */
   version?: number;
   /** Follow writes from other windows (default true). Off for per-window state. */
   sync?: boolean;
};

export type Stored<T> = {
   readonly key: string;
   get(): T;
   /** Whether anything is stored under the key (even bad data). */
   has(): boolean;
   /** False when the write failed (storage blocked or full). */
   set(v: T): boolean;
   remove(): boolean;
   /** Calls `l` when the value may have changed. */
   subscribe(l: () => void): () => void;
};

export type StorageFailure = { key: string; quota: boolean; error: unknown };

type Source = "local" | "remote";
type ChangeListener = (key: string | null, source: Source) => void;
const changeListeners = new Set<ChangeListener>();
const failureListeners = new Set<(f: StorageFailure) => void>();
const failing = new Set<string>();
let windowHooked = false;
let reported = false;

const storage = (): Storage | null => {
   try {
      return globalThis.localStorage ?? null;
   } catch {
      return null;
   }
};

/** The Storage in use (a test may swap it): lets an index notice and rebuild. */
export const storageIdentity = (): unknown => storage();

/** All keys in storage: one scan, for building an index or `forgetSession`. */
export function storedKeys(): string[] {
   const st = storage();
   const out: string[] = [];
   try {
      for (let i = 0; st && i < st.length; i++) {
         const k = st.key(i);
         if (k !== null) out.push(k);
      }
   } catch {
      // Storage blocked: no keys.
   }
   return out;
}

/** Removes the keys (one failure does not stop the rest); the keys removed. */
export function removeStoredKeys(keys: string[]): string[] {
   const removed: string[] = [];
   for (const k of keys) {
      try {
         storage()?.removeItem(k);
         removed.push(k);
      } catch {
         // Storage blocked: nothing to remove.
      }
   }
   for (const k of removed) emit(k, "local");
   return removed;
}

export function hasStoredKey(key: string): boolean {
   try {
      return storage()?.getItem(key) != null;
   } catch {
      return false;
   }
}

function hookWindow() {
   if (windowHooked || typeof window === "undefined" || !window.addEventListener) return;
   windowHooked = true;
   window.addEventListener("storage", (e: StorageEvent) => emit(e.key, "remote"));
}

function emit(key: string | null, source: Source) {
   for (const l of [...changeListeners]) l(key, source);
}

/** Every change of any key (null: storage was cleared), from this window or another. */
export function onStoredChange(l: ChangeListener): () => void {
   hookWindow();
   changeListeners.add(l);
   return () => void changeListeners.delete(l);
}

/** Tells this window's stores a key was removed by `forgetSession`. */
export function notifyStoredChange(key: string) {
   emit(key, "local");
}

/** A write failed (reported once per window, not per key): the host may show it. */
export function onStorageFailure(l: (f: StorageFailure) => void): () => void {
   failureListeners.add(l);
   return () => void failureListeners.delete(l);
}

const isQuota = (e: unknown) =>
   e instanceof Error &&
   (e.name === "QuotaExceededError" ||
      e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      (e as { code?: number }).code === 22);

function failed(key: string, error: unknown) {
   if (failing.has(key)) return;
   failing.add(key);
   const quota = isQuota(error);
   console.warn(`localStorage write failed for ${key}${quota ? " (quota)" : ""}`, error);
   // One report per window until it reloads: the host should not nag.
   if (reported) return;
   reported = true;
   for (const l of failureListeners) l({ key, quota, error });
}

/** Whether storage can be read at all (not in a sandbox that blocks it): writing is not attempted otherwise. */
function readable(): boolean {
   try {
      const st = storage();
      if (!st) return false;
      st.getItem("harness.probe");
      return true;
   } catch {
      return false;
   }
}

function checkRegistered(key: string, scope: Scope) {
   const m = matchKey(key);
   if (!m) throw new Error(`localStorage key not in STORAGE_KEYS: ${key}`);
   const want: KeyScope = scope === "app" ? "app" : "session";
   if (m.def.scope !== want) throw new Error(`${key} is declared ${m.def.scope}, used as ${want}`);
   if (scope !== "app" && m.session !== scope.session)
      throw new Error(`${key} does not belong to Session ${scope.session}`);
}

export function storedValue<T>(o: StoredOptions<T>): Stored<T> {
   checkRegistered(o.key, o.scope);
   const { key, version } = o;
   const sync = o.sync ?? true;
   const ser = o.serialize ?? ((v: T) => JSON.stringify(v));
   const decode = (raw: string | null): T => {
      try {
         if (version === undefined || raw === null) return o.parse(raw);
         const w: unknown = JSON.parse(raw);
         if (typeof w !== "object" || w === null) return o.parse(null);
         const { v, d } = w as { v?: unknown; d?: unknown };
         return v === version && typeof d === "string" ? o.parse(d) : o.parse(null);
      } catch {
         return o.parse(null);
      }
   };
   let cachedRaw: string | null | undefined;
   let cached: T;
   const read = (): string | null => {
      try {
         return storage()?.getItem(key) ?? null;
      } catch {
         return null;
      }
   };
   return {
      key,
      has: () => read() !== null,
      get() {
         const raw = read();
         // Same text, same object: useSyncExternalStore needs a stable snapshot.
         if (cachedRaw !== raw || cachedRaw === undefined) {
            cached = decode(raw);
            cachedRaw = raw;
         }
         return cached;
      },
      set(v) {
         try {
            const s = ser(v);
            const text = version === undefined ? s : JSON.stringify({ v: version, d: s });
            // Blocked storage: nothing to keep and nothing worth reporting.
            if (!readable()) return false;
            storage()?.setItem(key, text);
            failing.delete(key);
         } catch (e) {
            failed(key, e);
            return false;
         }
         emit(key, "local");
         return true;
      },
      remove() {
         try {
            if (!readable()) return true;
            storage()?.removeItem(key);
         } catch (e) {
            failed(key, e);
            return false;
         }
         emit(key, "local");
         return true;
      },
      subscribe(l) {
         return onStoredChange((k, source) => {
            if ((k === null || k === key) && (source === "local" || sync)) l();
         });
      },
   };
}

/** Parse helpers for the formats the app already stores. */
export const codec = {
   /** JSON checked by `valid`; anything else is `fallback`. */
   json:
      <T>(valid: (v: unknown) => v is T, fallback: T) =>
      (raw: string | null): T => {
         if (raw === null) return fallback;
         try {
            const v: unknown = JSON.parse(raw);
            return valid(v) ? v : fallback;
         } catch {
            return fallback;
         }
      },
   /** "on" / "off" (the Appearance toggles). */
   onOff: (fallback: boolean) => (raw: string | null) => (raw === null ? fallback : raw === "on"),
   /** A finite number kept as its decimal text; unset or bad is `fallback`. */
   number: (fallback: number) => (raw: string | null) => {
      const n = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
      return Number.isFinite(n) ? n : fallback;
   },
};
/** A number kept as its decimal text (panel sizes); 0 when unset or bad. Per window. */
export const storedNumber = (key: string): Stored<number> =>
   storedValue<number>({
      key,
      scope: "app",
      parse: codec.number(0),
      serialize: String,
      sync: false,
   });

export const onOffText = (on: boolean) => (on ? "on" : "off");
