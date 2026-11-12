import { useEffect, useState } from "react";
import { Markdown } from "../Markdown";
import { type UiEnv, useEnv } from "./runtime";

type Shown = { content: string; hash: string } | { missing: true } | null;

/**
 * A file-backed panel (ADR 0023): the Markdown of `name` in the Session's `panels/` folder, read
 * through the core. Re-read when the core says the file changed, and on window focus (in case
 * the watch failed). `<details>`/`<summary>` work; other raw HTML is sanitized.
 */
export function SourceMarkdown({ name }: { name: string }) {
   const { readSource, watchSources } = useEnv();
   const [shown, setShown] = useState<Shown>(null);
   useEffect(() => {
      if (!readSource) return;
      let live = true;
      const read = () =>
         readSource(name).then(
            (r) => live && setShown((s) => (s && "hash" in s && s.hash === r.hash ? s : r)),
            () => live && setShown({ missing: true }),
         );
      void read();
      const onFocus = () => void read();
      window.addEventListener("focus", onFocus);
      const off = watchSources?.((changed) => {
         if (changed === name) void read();
      });
      return () => {
         live = false;
         window.removeEventListener("focus", onFocus);
         void off?.then((f) => f());
      };
   }, [name, readSource, watchSources]);
   // A placeholder while it loads: a capture (view_artifact) waits while one shows.
   if (!shown) return readSource ? <div className="h-16 animate-pulse rounded bg-muted" /> : null;
   if ("missing" in shown)
      return <p className="text-ui-sm text-muted-foreground">Source missing: {name}</p>;
   return <Markdown html>{shown.content}</Markdown>;
}

/** A source file's content hash and when it was last written (ms epoch). */
export type SourceStamp = { hash: string; mtime: number };

/**
 * The stamp of each named source file, for panel headers ("Updated 2 minutes ago") and change
 * dots. Read once, again when the core says a file changed, and on window focus. A missing file
 * has no stamp.
 */
export function useSourceStamps(
   readSource: UiEnv["readSource"],
   watchSources: UiEnv["watchSources"],
   names: readonly string[],
): Record<string, SourceStamp> {
   const [stamps, setStamps] = useState<Record<string, SourceStamp>>({});
   const key = names.join("\n");
   // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `names`
   useEffect(() => {
      if (!readSource || names.length === 0) return;
      let live = true;
      const read = (name: string) =>
         readSource(name).then(
            (r) =>
               live &&
               setStamps((s) =>
                  s[name]?.hash === r.hash && s[name]?.mtime === r.mtime_ms
                     ? s
                     : { ...s, [name]: { hash: r.hash, mtime: r.mtime_ms } },
               ),
            () =>
               live &&
               setStamps((s) => {
                  if (!(name in s)) return s;
                  const { [name]: _, ...rest } = s;
                  return rest;
               }),
         );
      const readAll = () => {
         for (const n of names) void read(n);
      };
      readAll();
      window.addEventListener("focus", readAll);
      const off = watchSources?.((changed) => {
         if (names.includes(changed)) void read(changed);
      });
      return () => {
         live = false;
         window.removeEventListener("focus", readAll);
         void off?.then((f) => f());
      };
   }, [key, readSource, watchSources]);
   return stamps;
}
