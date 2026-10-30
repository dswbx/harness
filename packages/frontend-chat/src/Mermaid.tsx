import { useEffect, useId, useState } from "react";
import { useIsDark } from "./DiffViewer";
import { Expandable } from "./Expandable";
import { ZoomView } from "./ZoomView";

/** The diagram's own size, from its viewBox. */
function svgSize(svg: string): { width: number; height: number } | null {
  const m = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

type Out = { svg: string } | { error: string };

/**
 * Drawn diagrams by theme and source. The chat's virtual list remounts rows as they scroll back
 * in; drawing again would start from the placeholder and change the row's height under the reader.
 */
const drawn = new Map<string, Out>();
const remember = (key: string, out: Out) => {
  if (drawn.size >= 100) drawn.delete(drawn.keys().next().value!);
  drawn.set(key, out);
};

/** A ```mermaid fence: the diagram, drawn by mermaid (loaded on first use, strict security). */
export function Mermaid({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const dark = useIsDark();
  const key = `${dark}:${source}`;
  const [out, setOut] = useState<Out | null>(() => drawn.get(key) ?? null);
  useEffect(() => {
    const known = drawn.get(key);
    if (known) {
      setOut(known);
      return;
    }
    let live = true;
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", fontFamily: "inherit" });
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, source);
        remember(key, { svg });
        if (live) setOut({ svg });
      } catch (e) {
        const error = { error: e instanceof Error ? e.message : String(e) };
        remember(key, error);
        if (live) setOut(error);
      }
    });
    return () => {
      live = false;
    };
  }, [key, source, dark, id]);
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
