import { storedValue } from "@harness/api";

export type FileView = "list" | "tree";
export const viewStore = storedValue<FileView>({
   key: "harness:diff-file-view",
   scope: "app",
   parse: (raw) => (raw === "list" ? "list" : "tree"),
   serialize: (v) => v,
   sync: false,
});
export const wrapStore = storedValue<boolean>({
   key: "harness:diff-wrap",
   scope: "app",
   parse: (raw) => raw === "1",
   serialize: (v) => (v ? "1" : "0"),
   sync: false,
});
