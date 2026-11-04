import { type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InExpanded } from "./Expandable";
import { domToSvg, type PngOptions, svgToPng } from "./toPng";

export type Shot = { png: Blob; width: number; height: number; errors: string[] };
/** `report`: for content that can report errors (an Html frame's scripts), which go in the Shot. */
export type Shoot = (
   content: ReactNode | ((report: (message: string) => void) => ReactNode),
   opts?: PngOptions & { width?: number },
) => Promise<Shot>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for the content to stop changing: lazy parts loaded, size stable. Timers, as a hidden window draws no frames. */
async function settle(el: HTMLElement) {
   const end = Date.now() + 6000;
   let last = -1;
   let calm = 0;
   while (calm < 3 && Date.now() < end) {
      await sleep(100);
      const size = el.scrollHeight;
      calm = size === last && !el.querySelector(".animate-pulse") ? calm + 1 : 0;
      last = size;
   }
   // Charts draw themselves in, for at most this long.
   if (el.querySelector(".recharts-wrapper")) await sleep(1600);
}

type Job = {
   content: Parameters<Shoot>[0];
   opts: NonNullable<Parameters<Shoot>[1]>;
   done: (r: Shot | Error) => void;
};

function Stage({ job }: { job: Job }) {
   const ref = useRef<HTMLDivElement>(null);
   const errors = useRef<string[]>([]);
   const started = useRef(false);
   const report = useCallback((m: string) => void errors.current.push(m), []);
   // biome-ignore lint/correctness/useExhaustiveDependencies: one Stage per job
   useEffect(() => {
      const el = ref.current;
      if (!el || started.current) return;
      started.current = true;
      void (async () => {
         await settle(el);
         const svg = await domToSvg(el);
         const png = await svgToPng(svg, job.opts);
         return { png, width: svg.width, height: svg.height, errors: errors.current };
      })().then(job.done, (e) => job.done(e instanceof Error ? e : new Error(String(e))));
   }, []);
   return (
      <div
         ref={ref}
         aria-hidden
         inert
         className="fixed top-0 bg-background p-4 text-foreground"
         style={{ left: -100_000, width: job.opts.width ?? 900 }}
      >
         <InExpanded.Provider value={true}>
            <Suspense fallback={<div className="h-24 animate-pulse" />}>
               {typeof job.content === "function" ? job.content(report) : job.content}
            </Suspense>
         </InExpanded.Provider>
      </div>
   );
}

/**
 * Renders content off screen and takes a PNG of it. `stage` must be in the tree: a portal, so the content has the
 * contexts of where this is used, and the same look as on screen. One at a time.
 */
export function useCapture(): { stage: ReactNode; shoot: Shoot } {
   const [job, setJob] = useState<(Job & { n: number }) | null>(null);
   const queue = useRef<Promise<unknown>>(Promise.resolve());
   const count = useRef(0);
   const shoot = useCallback<Shoot>((content, opts = {}) => {
      const run = queue.current.then(
         () =>
            new Promise<Shot>((ok, fail) => {
               setJob({
                  content,
                  opts,
                  n: count.current++,
                  done: (r) => {
                     setJob(null);
                     if (r instanceof Error) fail(r);
                     else ok(r);
                  },
               });
            }),
      );
      queue.current = run.catch(() => {});
      return run;
   }, []);
   const stage = useMemo(
      () => job && createPortal(<Stage key={job.n} job={job} />, document.body),
      [job],
   );
   return { stage, shoot };
}
