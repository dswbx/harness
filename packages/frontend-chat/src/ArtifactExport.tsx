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
      <Markdown title={a.title}>
         {a.kind === "diagram" ? `\`\`\`mermaid\n${a.source}\n\`\`\`` : a.source}
      </Markdown>
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
      blob: async () => (await drawImage(a, env, shoot)).png,
   };
   if (a.kind === "table")
      return [png, ...tableFormats(name, markdownTableRows(a.source), a.source)];
   return [png, ...(a.ui ? uiFormats(name, a.ui.root) : [])];
}

type Drawn = { png: Blob; url: string };
/** Drawn images, in the panel's own settings. A tab switch unmounts the image: it must not draw again. */
const images = new Map<string, { draw: Promise<Drawn>; done?: Drawn }>();

/** What the picture depends on: the content, the theme, and the state a render_ui tree reads. */
function imageKey(a: Artifact, env: UiEnv): string {
   const root = document.documentElement;
   const state = a.ui ? JSON.stringify(env.state ?? null) : "";
   return JSON.stringify([root.className, root.getAttribute("style"), a.source, state]);
}

function drawImage(a: Artifact, env: UiEnv, shoot: Shoot, key = imageKey(a, env)) {
   const known = images.get(key);
   if (known) return known.draw;
   const entry: { draw: Promise<Drawn>; done?: Drawn } = {
      draw: artifactPng(a, env, shoot).then(async ({ png }) => {
         entry.done = { png, url: await dataUrl(png) };
         return entry.done;
      }),
   };
   entry.draw.catch(() => images.delete(key));
   if (images.size >= 30) images.delete(images.keys().next().value!);
   images.set(key, entry);
   return entry.draw;
}

/** The artifact drawn as an image, as it would download. */
export function ArtifactImage({ a, env, shoot }: { a: Artifact; env: UiEnv; shoot: Shoot }) {
   const key = imageKey(a, env);
   const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
   const [error, setError] = useState<string | null>(null);
   // biome-ignore lint/correctness/useExhaustiveDependencies: a new picture only when the key changes
   useEffect(() => {
      let live = true;
      setError(null);
      drawImage(a, env, shoot, key).then(
         ({ url }) => live && setShown({ key, url }),
         (e) => live && setError(e instanceof Error ? e.message : String(e)),
      );
      return () => {
         live = false;
      };
   }, [key, shoot]);
   if (error) return <p className="text-xs text-destructive">{error}</p>;
   // Known already: at once, without a placeholder in between.
   const url = shown?.key === key ? shown.url : images.get(key)?.done?.url;
   if (!url) return <div className="h-40 animate-pulse rounded-md bg-muted" />;
   return <img src={url} alt={a.title} className="max-w-full rounded-md border" />;
}
