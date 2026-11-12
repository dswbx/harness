import type { FrontendRequestProps, SessionApi } from "@harness/api";
import { useEffect } from "react";
import { artifactPng } from "./ArtifactExport";
import { type Artifact, collectArtifacts } from "./artifacts";
import { useCapture } from "./Capture";
import { mermaidSvg } from "./exportFormats";
import { checkActions, type UiEnv } from "./RenderUi";
import { type ChatState, initialState, reduceBatch } from "./reducer";
import { svgToPng } from "./toPng";
import { UiHtml } from "./UiHtml";

/** Claude scales larger images down anyway, and an image over 5 MB is refused. */
const MAX_EDGE = 1568;
const MAX_BYTES = 3_500_000;

type Input = { id?: string; kind?: string; mermaid?: string; html?: string; width?: number };

/** The Session Log up to `lastSeq`: this also runs for a Session no window shows. */
function replay(api: SessionApi, lastSeq: number): Promise<ChatState> {
   return new Promise((ok, fail) => {
      const events: Parameters<typeof reduceBatch>[1][number][] = [];
      let off: (() => void) | null = null;
      let done = false;
      const finish = () => {
         done = true;
         off?.();
         clearTimeout(limit);
         ok(reduceBatch(initialState(), events));
      };
      const limit = setTimeout(() => {
         done = true;
         off?.();
         fail(new Error("Could not read the Session Log in time."));
      }, 15_000);
      api.subscribe((e) => {
         if (done) return;
         (events as unknown[]).push(e);
         if (e.seq >= lastSeq) finish();
      }, 0)
         .then((u) => {
            if (done) u();
            else off = u;
         })
         .catch(fail);
   });
}

function pick(list: Artifact[], input: Input): Artifact {
   const a = input.id
      ? list.find((x) => x.slotId === input.id || x.key === input.id)
      : list.filter((x) => !input.kind || x.kind === input.kind).at(-1);
   if (a) return a;
   const known = list
      .slice(-20)
      .map((x) => `- ${x.key}: ${x.title} (${x.sub})`)
      .join("\n");
   const what = input.id ? `"${input.id}"` : input.kind ? `of kind ${input.kind}` : "yet";
   throw new Error(`No artifact ${what}.${known ? ` Artifacts:\n${known}` : ""}`);
}

const b64 = async (b: Blob) => {
   const bytes = new Uint8Array(await b.arrayBuffer());
   let s = "";
   for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
   return btoa(s);
};

const noEnv = (api: SessionApi, state: ChatState): UiEnv => ({
   state: state.uiState,
   patch: async () => {},
   send: async () => {},
   files: {},
   readImage: (p) => api.frontendReadImage(p),
   readSource: (name) => api.panelSourceRead(name),
   scope: api.sessionId,
});

/** Answers `view_artifact`: renders what was asked in this window, off screen, and sends the PNG to the core. */
export function ArtifactRequest({ api, request, onDone }: FrontendRequestProps) {
   const { stage, shoot } = useCapture();
   // biome-ignore lint/correctness/useExhaustiveDependencies: one component per request
   useEffect(() => {
      const input = (request.input ?? {}) as Input;
      const opts = { maxEdge: MAX_EDGE, width: input.width };
      void (async () => {
         /** Draws at a lower resolution while the file is too large for the Agent. */
         const fit = async (draw: (edge: number) => Promise<{ png: Blob; errors: string[] }>) => {
            let edge = MAX_EDGE;
            let out = await draw(edge);
            while (out.png.size > MAX_BYTES && edge > 400) {
               edge = Math.round(edge * 0.7);
               out = await draw(edge);
            }
            return out;
         };
         let label: string;
         let shot: { png: Blob; errors: string[] };
         if (input.mermaid) {
            label = "The Mermaid diagram";
            const svg = await mermaidSvg(input.mermaid);
            shot = await fit(async (maxEdge) => ({
               png: await svgToPng(svg, { maxEdge }),
               errors: [],
            }));
         } else if (input.html) {
            label = "The HTML";
            const html = input.html;
            // As a render_ui Html node would show it: with the Session State its bindings read.
            const { uiState } = await replay(api, request.last_seq);
            shot = await fit((maxEdge) =>
               shoot(
                  (report) => (
                     <UiHtml
                        html={html}
                        state={uiState}
                        patch={async () => {}}
                        send={async () => {}}
                        run={async () => {}}
                        report={report}
                        checkActions={checkActions}
                     />
                  ),
                  { ...opts, maxEdge },
               ),
            );
         } else {
            const state = await replay(api, request.last_seq);
            const a = pick(collectArtifacts(state.items), input);
            const env = noEnv(api, state);
            label = `${a.title} (${a.sub}, key ${a.key})`;
            shot = await fit((maxEdge) => artifactPng(a, env, shoot, { ...opts, maxEdge }));
         }
         const errors = shot.errors.length ? `\nErrors in it:\n- ${shot.errors.join("\n- ")}` : "";
         return {
            text: `${label}, rendered.${errors}`,
            image: { mime: "image/png", data: await b64(shot.png) },
            error: null,
         };
      })()
         .catch((e) => ({
            text: null,
            image: null,
            error: e instanceof Error ? e.message : String(e),
         }))
         .then((answer) => api.answerFrontendRequest(request.request_id, answer))
         .catch((e) => console.error("view_artifact", e))
         .finally(onDone);
   }, []);
   return <>{stage}</>;
}
