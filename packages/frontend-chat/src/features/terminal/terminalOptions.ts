import { codec, onOffText, storedValue, useStoredValue } from "@harness/api";

// Per-viewer choice (Settings > Appearance), off by default like VS Code: Option types the layout's characters
// (@ [ ] { } on many layouts). On, Option is Meta (Esc prefix) for shell shortcuts such as Opt+B. Every terminal follows it, across windows too.
const store = storedValue<boolean>({
   key: "harness.terminal.optionIsMeta",
   scope: "app",
   parse: codec.onOff(false),
   serialize: onOffText,
});
export const readOptionIsMeta = store.get;
export const onOptionIsMetaChange = store.subscribe;
export const setOptionIsMeta = (on: boolean) => void store.set(on);

/** Whether the terminal's Option key is Meta instead of typing characters (macOS). */
export const useOptionIsMeta = () => useStoredValue(store);
