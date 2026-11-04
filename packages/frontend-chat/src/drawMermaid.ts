export type Drawn = { svg: string } | { error: string };

/**
 * Drawn diagrams by theme and source. The chat's virtual list remounts rows as they scroll back
 * in; drawing again would start from the placeholder and change the row's height under the reader.
 */
const drawn = new Map<string, Drawn>();
const remember = (key: string, out: Drawn) => {
   if (drawn.size >= 100) drawn.delete(drawn.keys().next().value!);
   drawn.set(key, out);
   return out;
};

export const knownDiagram = (dark: boolean, source: string) => drawn.get(`${dark}:${source}`);

let next = 0;

/** The diagram, drawn by mermaid (loaded on first use, strict security). */
export async function drawMermaid(dark: boolean, source: string): Promise<Drawn> {
   const key = `${dark}:${source}`;
   const known = drawn.get(key);
   if (known) return known;
   const { default: mermaid } = await import("mermaid");
   mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      fontFamily: "inherit",
   });
   try {
      const { svg } = await mermaid.render(`mermaid-${next++}`, source);
      return remember(key, { svg });
   } catch (e) {
      return remember(key, { error: e instanceof Error ? e.message : String(e) });
   }
}
