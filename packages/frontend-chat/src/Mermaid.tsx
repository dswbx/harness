import { useEffect, useState } from "react";
import { useIsDark } from "./DiffViewer";
import { type Drawn, drawMermaid, knownDiagram } from "./drawMermaid";
import { Expandable } from "./Expandable";
import { fileName, mermaidFormats } from "./exportFormats";
import { ZoomView } from "./ZoomView";

/** The diagram's own size, from its viewBox. */
function svgSize(svg: string): { width: number; height: number } | null {
   const m = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
   return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** A ```mermaid fence: the diagram. */
export function Mermaid({ source, title }: { source: string; title?: string }) {
   const dark = useIsDark();
   const [out, setOut] = useState<Drawn | null>(() => knownDiagram(dark, source) ?? null);
   useEffect(() => {
      let live = true;
      void drawMermaid(dark, source).then((o) => {
         if (live) setOut(o);
      });
      return () => {
         live = false;
      };
   }, [source, dark]);
   if (out && "error" in out) {
      return (
         <div className="grid grid-cols-1 gap-1">
            <pre>
               <code>{source}</code>
            </pre>
            <p className="text-xs text-destructive">Diagram error: {out.error.split("\n")[0]}</p>
         </div>
      );
   }
   if (!out) return <div className="h-24 animate-pulse rounded-md bg-muted" />;
   const size = svgSize(out.svg);
   // mermaid's strict mode sanitizes the SVG.
   const inline = (
      <div
         className="overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
         dangerouslySetInnerHTML={{ __html: out.svg }}
      />
   );
   if (!size) return <div className="not-typeset">{inline}</div>;
   return (
      <Expandable
         label="diagram"
         className="not-typeset"
         title={title}
         formats={() => mermaidFormats(fileName(title ?? "diagram"), source)}
         expanded={
            <ZoomView {...size}>
               <div
                  className="h-full w-full [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none"
                  dangerouslySetInnerHTML={{ __html: out.svg }}
               />
            </ZoomView>
         }
      >
         {inline}
      </Expandable>
   );
}
