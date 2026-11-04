import { useEffect, useState } from "react";
import type { Artifact } from "./artifacts";
import type { Shoot } from "./Capture";
import {
   type ExportFormat,
   fileName,
   markdownTableRows,
   mermaidFormats,
   mermaidSvg,
   tableFormats,
   uiFormats,
} from "./exportFormats";
import { Markdown } from "./Markdown";
import { RenderUi, type UiEnv } from "./RenderUi";
import { dataUrl, svgToPng } from "./toPng";

/** The artifact itself, as the chat shows it. */
export function ArtifactPreview({ a, env }: { a: Artifact; env: UiEnv }) {
   if (a.ui) return <RenderUi root={a.ui.root} env={{ ...env, files: a.ui.files }} />;
   return (
      <Markdown>{a.kind === "diagram" ? `\`\`\`mermaid\n${a.source}\n\`\`\`` : a.source}</Markdown>
   );
}

/** A copy for taking its picture: scripts in its frames run again and must not change or send anything. */
const silent = (env: UiEnv): UiEnv => ({
   ...env,
   patch: async () => {},
   send: async () => {},
});

/** The artifact as a PNG. `errors`: what went wrong in its frames. */
export async function artifactPng(
   a: Artifact,
   env: UiEnv,
   shoot: Shoot,
   opts?: Parameters<Shoot>[1],
): Promise<{ png: Blob; errors: string[] }> {
   if (a.kind === "diagram")
      return { png: await svgToPng(await mermaidSvg(a.source), opts), errors: [] };
   return shoot(
      (report) => (
         <ArtifactPreview
            a={a}
            env={{ ...silent(env), item: "capture", report: (_, m) => report(m) }}
         />
      ),
      opts,
   );
}

export function artifactFormats(a: Artifact, env: UiEnv, shoot: Shoot): ExportFormat[] {
   const name = fileName(a.title);
   if (a.kind === "diagram") return mermaidFormats(name, a.source);
   const png: ExportFormat = {
      label: "PNG",
      file: `${name}.png`,
      blob: async () => (await artifactPng(a, env, shoot)).png,
   };
   if (a.kind === "table")
      return [png, ...tableFormats(name, markdownTableRows(a.source), a.source)];
   return [png, ...(a.ui ? uiFormats(name, a.ui.root) : [])];
}

/** The artifact drawn as an image, as it would download. */
export function ArtifactImage({ a, env, shoot }: { a: Artifact; env: UiEnv; shoot: Shoot }) {
   const [url, setUrl] = useState<string | null>(null);
   const [error, setError] = useState<string | null>(null);
   // biome-ignore lint/correctness/useExhaustiveDependencies: a new picture only when the artifact changes
   useEffect(() => {
      let live = true;
      setUrl(null);
      setError(null);
      artifactPng(a, env, shoot).then(
         // A data URL: the app's CSP allows no blob images.
         async ({ png }) => {
            const u = await dataUrl(png);
            if (live) setUrl(u);
         },
         (e) => live && setError(e instanceof Error ? e.message : String(e)),
      );
      return () => {
         live = false;
      };
   }, [a.key, a.source, shoot]);
   if (error) return <p className="text-xs text-destructive">{error}</p>;
   if (!url) return <div className="h-40 animate-pulse rounded-md bg-muted" />;
   return <img src={url} alt={a.title} className="max-w-full rounded-md border" />;
}
