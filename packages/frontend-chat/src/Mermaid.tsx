import { useEffect, useId, useState } from "react";
import { useIsDark } from "./DiffViewer";

/** A ```mermaid fence: the diagram, drawn by mermaid (loaded on first use, strict security). */
export function Mermaid({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const dark = useIsDark();
  const [out, setOut] = useState<{ svg: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: "inherit" });
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, source);
        if (live) setOut({ svg });
      } catch (e) {
        if (live) setOut({ error: e instanceof Error ? e.message : String(e) });
      }
    });
    return () => {
      live = false;
    };
  }, [source, dark, id]);
  if (out && "error" in out) {
    return (
      <div className="grid grid-cols-1 gap-1">
        <pre><code>{source}</code></pre>
        <p className="text-xs text-destructive">Diagram error: {out.error.split("\n")[0]}</p>
      </div>
    );
  }
  if (!out) return <div className="h-24 animate-pulse rounded-md bg-muted" />;
  // mermaid's strict mode sanitizes the SVG.
  return <div className="not-typeset overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: out.svg }} />;
}
