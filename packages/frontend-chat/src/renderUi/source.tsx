import { useEffect, useState } from "react";
import { Markdown } from "../Markdown";
import { useEnv } from "./runtime";

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
   if (!shown) return null;
   if ("missing" in shown)
      return <p className="text-ui-sm text-muted-foreground">Source missing: {name}</p>;
   return <Markdown html>{shown.content}</Markdown>;
}
