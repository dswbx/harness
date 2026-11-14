import { codec, onOffText, storedValue, useStoredValue } from "@harness/api";

/** A per-viewer on/off choice (Settings > Appearance) kept in localStorage; every chat follows it, across windows too. */
export function localPref(key: string, fallback: boolean) {
   const store = storedValue<boolean>({
      key,
      scope: "app",
      parse: codec.onOff(fallback),
      serialize: onOffText,
   });
   return { use: () => useStoredValue(store), set: (on: boolean) => void store.set(on) };
}
