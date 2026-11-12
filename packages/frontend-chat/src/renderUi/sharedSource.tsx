import type { SharedArtifactData, StatePatchOp } from "@harness/api";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Markdown } from "../Markdown";
import type { RawNode, UiAction } from "../tools";
import { UiHtml } from "../UiHtml";
import { runActions, type UiEnv, useEnv } from "./runtime";

/** A Shared Artifact as shown: null while it loads. */
export type SharedShown = { data: SharedArtifactData } | { missing: true } | null;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The next read, keeping the previous content, state and meta objects where they did not change. */
function merge(s: SharedShown, r: SharedArtifactData): SharedShown {
   if (!s || !("data" in s)) return { data: r };
   const d = s.data;
   const content = d.hash === r.hash;
   const state = same(d.state, r.state);
   const meta = same(d.meta, r.meta);
   if (content && state && meta && d.dir === r.dir) return s;
   return {
      data: {
         ...r,
         content: content ? d.content : r.content,
         state: state ? d.state : r.state,
         meta: meta ? d.meta : r.meta,
      },
   };
}

/**
 * A Shared Artifact (ADR 0024), read with `read`. Read again when `watch` says it changed and on
 * window focus (in case the watch failed). Unchanged parts keep their objects (hash and state
 * compared), so an Html frame keeps its document and a tree does not re-render for nothing.
 */
export function useSharedArtifact(
   id: string,
   read: UiEnv["readShared"],
   watch: UiEnv["watchShared"],
): SharedShown {
   const [shown, setShown] = useState<SharedShown>(null);
   useEffect(() => {
      if (!read) return;
      let live = true;
      setShown(null);
      const load = () =>
         read(id).then(
            (r) => live && setShown((s) => merge(s, r)),
            () => live && setShown({ missing: true }),
         );
      void load();
      const onFocus = () => void load();
      window.addEventListener("focus", onFocus);
      const off = watch?.((changed) => {
         if (changed === id) void load();
      });
      return () => {
         live = false;
         window.removeEventListener("focus", onFocus);
         void off?.then((f) => f());
      };
   }, [id, read, watch]);
   return shown;
}

/** `ui.json` of a `ui` artifact: the tree, or why it cannot show. */
function parseTree(content: string): { root: RawNode } | { error: string } {
   try {
      const ui = JSON.parse(content) as { root?: unknown };
      if (ui.root && typeof ui.root === "object" && "type" in ui.root)
         return { root: ui.root as RawNode };
      return { error: "ui.json has no root" };
   } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
   }
}

/**
 * Shows a Shared Artifact by its kind (ADR 0024): `md` as Markdown, `html` in a frame, `ui` as a
 * render_ui tree (`renderTree`). Its state is the artifact's, not the Session State: reads come from
 * the artifact and writes go to `patchShared`. Works with no Session (only `readShared` is needed).
 */
export function SharedSourceView({
   id,
   renderTree,
   checkActions,
}: {
   id: string;
   renderTree: (root: RawNode, env: UiEnv) => ReactNode;
   checkActions: (actions: unknown) => string | null;
}) {
   const env = useEnv();
   const shown = useSharedArtifact(id, env.readShared, env.watchShared);
   const data = shown && "data" in shown ? shown.data : null;
   const state = data?.state;
   const artifactEnv = useMemo<UiEnv>(
      () => ({
         ...env,
         state: state ?? {},
         patch: (ops: StatePatchOp[]) =>
            env.patchShared
               ? env.patchShared(id, ops)
               : Promise.reject(new Error("This view cannot change the artifact.")),
         // Image copies of a shared tree live in its folder, which the Session cannot read (yet).
         files: {},
         // File-backed panel names are the Session's, not the artifact's.
         readSource: undefined,
         watchSources: undefined,
      }),
      [env, id, state],
   );
   const tree = useMemo(
      () => (data?.meta.kind === "ui" ? parseTree(data.content) : null),
      [data?.meta.kind, data?.content],
   );
   if (!env.readShared) return null;
   // A placeholder while it loads: a capture (view_artifact) waits while one shows.
   if (!shown) return <div className="h-16 animate-pulse rounded bg-muted" />;
   if (!data)
      return <p className="text-ui-sm text-muted-foreground">Shared artifact missing: {id}</p>;
   if (data.meta.kind === "md") return <Markdown html>{data.content}</Markdown>;
   if (data.meta.kind === "html")
      return (
         <UiHtml
            html={data.content}
            title={data.meta.title}
            state={artifactEnv.state}
            patch={artifactEnv.patch}
            send={env.send}
            run={(a) => runActions(a as UiAction[], artifactEnv)}
            checkActions={checkActions}
            report={env.item && env.report ? (m) => env.report!(env.item!, m) : undefined}
         />
      );
   if (tree && "error" in tree)
      return <p className="text-ui-sm text-destructive">This artifact cannot show: {tree.error}</p>;
   return tree ? renderTree(tree.root, artifactEnv) : null;
}
