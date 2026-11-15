import { useSyncExternalStore } from "react";
import type { Stored } from "../platform/storage";

/** A stored value as React state of the window: follows `set` and (unless `sync: false`) other windows. */
export const useStoredValue = <T>(store: Stored<T>): T =>
   useSyncExternalStore(store.subscribe, store.get, store.get);
