import { htmlFrameUrl, type StatePatchOp } from "@harness/api";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { InExpanded } from "./Expandable";
import { buildSrcdoc, currentTheme, type FrameMessage, onceEach } from "./htmlBridge";
import { PanelContext } from "./PanelHeader";

const MAX_HEIGHT = 2000;
/** Set in Tauri: the frame loads this and asks for its document. Otherwise the document goes in `srcdoc`. */
const FRAME_URL = htmlFrameUrl();
/** Last height by HTML: the chat's virtual list remounts rows; keep their height. */
const heights = new Map<string, number>();

type Props = {
   html: string;
   /** Maximum height; the frame otherwise fits its content. */
   height?: number;
   title?: string;
   state: unknown;
   patch: (ops: StatePatchOp[]) => Promise<void>;
   send: (text: string) => Promise<void>;
   /** Runs render_ui actions (RenderUi's runActions). */
   run: (actions: unknown) => Promise<void>;
   /** Tells the core about an error (script, invalid action or patch), so the Agent learns about it. */
   report?: (message: string) => void;
   /** Actions from the frame are not checked by the core: an error message when invalid, else null. */
   checkActions: (actions: unknown) => string | null;
};

const isOps = (x: unknown): x is StatePatchOp[] =>
   Array.isArray(x) &&
   x.every(
      (o) =>
         o &&
         typeof o === "object" &&
         ["add", "replace", "remove", "test"].includes((o as StatePatchOp).op) &&
         typeof (o as StatePatchOp).path === "string",
   );

/** render_ui `Html`: Agent HTML in a sandboxed frame, connected to the Session State by a bridge. */
export function UiHtml(p: Props) {
   const frame = useRef<HTMLIFrameElement>(null);
   // The expanded view is for seeing all of it: no maximum height there.
   const expanded = useContext(InExpanded);
   const inPanel = useContext(PanelContext) !== null;
   const latest = useRef(p);
   latest.current = p;
   const [auto, setAuto] = useState(() => heights.get(p.html) ?? 120);
   const [error, setShown] = useState<string | null>(null);
   // Per document: new HTML may fix the errors, so it reports again.
   // biome-ignore lint/correctness/useExhaustiveDependencies: one reporter per document
   const report = useMemo(() => onceEach((m: string) => latest.current.report?.(m)), [p.html]);
   const reportRef = useRef(report);
   reportRef.current = report;
   const setError = useCallback((m: string) => {
      setShown(m);
      reportRef.current(m);
   }, []);
   // A new document only for new HTML; state and theme then go in by message.
   const srcdoc = useMemo(
      () => buildSrcdoc(p.html, currentTheme(inPanel), latest.current.state),
      [p.html, inPanel],
   );

   const doc = useRef(srcdoc);
   doc.current = srcdoc;
   // The document the frame has asked for: its first load event is only the loader's.
   const sent = useRef<string | null>(null);

   // A frame paints white until its document loads (its first, empty document has no dark color scheme).
   const [loaded, setLoaded] = useState<string | null>(null);

   const post = (m: unknown) => frame.current?.contentWindow?.postMessage(m, "*");

   // biome-ignore lint/correctness/useExhaustiveDependencies: post reads the ref
   useEffect(() => {
      const onMessage = (e: MessageEvent) => {
         if (!frame.current || e.source !== frame.current.contentWindow) return;
         const m = e.data as FrameMessage;
         const cur = latest.current;
         const fail = (x: unknown) => setError(x instanceof Error ? x.message : String(x));
         if (m?.type === "ready") {
            sent.current = doc.current;
            post({ type: "doc", html: doc.current });
         } else if (m?.type === "height" && typeof m.px === "number") {
            const px = Math.min(Math.max(m.px, 20), MAX_HEIGHT);
            heights.set(cur.html, px);
            setAuto(px);
         } else if (m?.type === "error") setError(String(m.message));
         else if (m?.type === "actions") {
            const bad = latest.current.checkActions(m.actions);
            if (bad) setError(bad);
            else cur.run(m.actions).catch(fail);
         } else if (m?.type === "patch") {
            if (isOps(m.ops)) cur.patch(m.ops).catch(fail);
            else setError("Invalid patch: an array of {op, path, value?}");
         } else if (m?.type === "send" && typeof m.text === "string" && m.text.trim())
            cur.send(m.text).catch(fail);
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
   }, [setError]);

   // biome-ignore lint/correctness/useExhaustiveDependencies: post reads the ref
   useEffect(() => post({ type: "state", state: p.state }), [p.state]);

   // Theme changes (light/dark, presets) reach the frame without a reload.
   // biome-ignore lint/correctness/useExhaustiveDependencies: post reads the ref
   useEffect(() => {
      const o = new MutationObserver(() => post({ type: "theme", css: currentTheme(inPanel) }));
      o.observe(document.documentElement, {
         attributes: true,
         attributeFilter: ["class", "style"],
      });
      return () => o.disconnect();
   }, []);

   return (
      <div className="min-w-0">
         <iframe
            // New HTML, new frame: once the loader has written the document, nothing there takes another.
            key={srcdoc}
            ref={frame}
            title={p.title ?? "HTML"}
            sandbox="allow-scripts"
            {...(FRAME_URL ? { src: FRAME_URL } : { srcDoc: srcdoc })}
            onLoad={() => {
               if (FRAME_URL && sent.current !== srcdoc) return;
               setLoaded(srcdoc);
               post({ type: "state", state: latest.current.state });
            }}
            className="block w-full border-0"
            style={{
               height: p.height && !expanded ? Math.min(auto, p.height) : auto,
               visibility: loaded === srcdoc ? undefined : "hidden",
            }}
         />
         {error && <p className="mt-1 text-ui-sm text-destructive">{error}</p>}
      </div>
   );
}
