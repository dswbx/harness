// PR info for PR references, looked up in batches and cached like the Host does (`github_refs.rs`).
import type { PrInfo, PrRefKey } from "./generated";
import type { SessionApi } from "./client";
import { prKey } from "./prRefs";

/** `missing`: no such PR. `unavailable`: the lookup failed (no `gh`, offline); shown as plain text, retried later. */
export type PrEntry =
  | { status: "loading" }
  | { status: "found"; pr: PrInfo }
  | { status: "missing" }
  | { status: "unavailable" };

export type PrStore = {
  /** The cached entry; never fetches (a stable object until it changes, for `useSyncExternalStore`). */
  peek(key: PrRefKey): PrEntry;
  /** Queues a lookup when the entry is absent or expired; lookups within `delay` go out as one batch. */
  request(key: PrRefKey): void;
  subscribe(listener: () => void): () => void;
};

const MIN = 60_000;
/** Same TTLs as the Host cache. */
export function prTtl(pr: PrInfo | null): number {
  if (!pr) return 10 * MIN;
  return pr.state === "open" || pr.state === "draft" ? MIN : 24 * 60 * MIN;
}
/** Refs per `lookupPrs` call: one GraphQL query each. */
export const PR_BATCH = 25;
const LOADING: PrEntry = { status: "loading" };
const UNAVAILABLE: PrEntry = { status: "unavailable" };
const MISSING: PrEntry = { status: "missing" };

export function createPrStore(
  api: Pick<SessionApi, "lookupPrs">,
  { delay = 30, now = Date.now }: { delay?: number; now?: () => number } = {},
): PrStore {
  const cache = new Map<string, { entry: PrEntry; expires: number }>();
  const queued = new Map<string, PrRefKey>();
  /** Queued or being looked up. */
  const inflight = new Set<string>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  const notify = () => listeners.forEach((l) => l());
  const set = (id: string, entry: PrEntry, ttl: number) => cache.set(id, { entry, expires: now() + ttl });

  async function lookup(keys: PrRefKey[]) {
    const ids = keys.map(prKey);
    try {
      const prs = await api.lookupPrs(keys);
      failures = 0;
      ids.forEach((id, i) => {
        const pr = prs[i] ?? null;
        set(id, pr ? { status: "found", pr } : MISSING, prTtl(pr));
      });
    } catch {
      // Retry soon, backing off to a minute; a PR already shown stays shown.
      const backoff = Math.min(MIN, 5_000 * 2 ** failures++);
      for (const id of ids) {
        const old = cache.get(id)?.entry;
        set(id, old?.status === "found" ? old : UNAVAILABLE, backoff);
      }
    } finally {
      ids.forEach((id) => inflight.delete(id));
      notify();
    }
  }

  function flush() {
    timer = null;
    const keys = [...queued.values()];
    queued.clear();
    for (let i = 0; i < keys.length; i += PR_BATCH) void lookup(keys.slice(i, i + PR_BATCH));
  }

  return {
    peek: (key) => cache.get(prKey(key))?.entry ?? LOADING,
    request(key) {
      const id = prKey(key);
      const hit = cache.get(id);
      if ((hit && hit.expires > now()) || inflight.has(id)) return;
      queued.set(id, key);
      inflight.add(id);
      timer ??= setTimeout(flush, delay);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
