import { useEffect, useId, useState } from "react";
import { useIsDark } from "./DiffViewer";
import { Expandable } from "./Expandable";
import { ZoomView } from "./ZoomView";

/** The diagram's own size, from its viewBox. */
function svgSize(svg: string): { width: number; height: number } | null {
  const m = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

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
  const size = svgSize(out.svg);
  // mermaid's strict mode sanitizes the SVG.
  const inline = <div className="overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: out.svg }} />;
  if (!size) return <div className="not-typeset">{inline}</div>;
  return (
    <Expandable
      label="diagram"
      className="not-typeset"
      expanded={
        <ZoomView {...size}>
          <div className="h-full w-full [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none" dangerouslySetInnerHTML={{ __html: out.svg }} />
        </ZoomView>
      }
    >
      {inline}
    </Expandable>
  );
}
