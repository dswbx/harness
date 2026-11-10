import { applyStatePatch, getAt, type StatePatchOp } from "@harness/api";
import { useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import * as charts from "./renderUi/charts";
import * as code from "./renderUi/code";
import * as data from "./renderUi/data";
import * as disclosure from "./renderUi/disclosure";
import * as forms from "./renderUi/forms";
import * as layout from "./renderUi/layout";
import * as media from "./renderUi/media";
import {
   Env,
   isVisible,
   itemPath,
   type RenderCtx,
   resolveValue,
   type Scope,
   ScopeCtx,
   type UiEnv,
   useEnv,
} from "./renderUi/runtime";
import * as text from "./renderUi/text";
import { jsReady, loadJs, onJsReady } from "./sandbox";
import { components, type RawNode, renderUiSchema, type UiNode } from "./tools";

export { tableRows } from "./renderUi/data";
export { repeatScopes, stackClasses } from "./renderUi/layout";
export {
   isVisible,
   itemPath,
   resolveValue,
   runActions,
   type Scope,
   type UiEnv,
} from "./renderUi/runtime";

/**
 * `render_ui` renderer: this file binds a tree to the Session State and dispatches each node to
 * its component's renderer. The components (spec, schema, example, renderer) live in `renderUi/`,
 * one file per group.
 */
const renderers = {
   ...layout.renderers,
   ...text.renderers,
   ...code.renderers,
   ...media.renderers,
   ...charts.renderers,
   ...data.renderers,
   ...forms.renderers,
   ...disclosure.renderers,
} satisfies { [K in keyof typeof components]: unknown };

/** Actions from an Html frame are not checked by the core: check them with the render_ui schema. */
export function checkActions(actions: unknown): string | null {
   const r = renderUiSchema.validate({
      root: { type: "Button", props: { label: "x" }, on: { press: actions } },
   });
   return r.valid ? null : `Invalid actions: ${r.errors[0]?.error ?? "unknown"}`;
}

/** Binds a node's props: expressions read from `state`, `$bindState`/`$bindItem` props read their path. */
export function resolveNode(raw: RawNode, state: unknown, scope?: Scope): UiNode {
   const bind: readonly string[] =
      (components[raw.type] as { bind?: readonly string[] }).bind ?? [];
   const bindings: Record<string, string> = {};
   const props: Record<string, unknown> = {};
   for (const [k, v] of Object.entries(raw.props ?? {})) {
      const b =
         bind.includes(k) && typeof v === "object" && v !== null
            ? (v as { $bindState?: unknown; $bindItem?: unknown })
            : undefined;
      const path =
         typeof b?.$bindState === "string"
            ? b.$bindState
            : typeof b?.$bindItem === "string"
              ? itemPath(b.$bindItem, scope)
              : undefined;
      if (path !== undefined) {
         bindings[k] = path;
         props[k] = getAt(state, path);
      } else props[k] = b && "$bindItem" in b ? undefined : resolveValue(v, state, scope);
   }
   return { ...raw, props, bindings, children: undefined } as unknown as UiNode;
}

function Node({ raw }: { raw: RawNode }) {
   const env = useEnv();
   const scope = useContext(ScopeCtx);
   if (!isVisible(raw.visible, env.state, scope)) return null;
   const node = resolveNode(raw, env.state, scope);
   const kids = raw.children?.map((c, i) => <Node key={i} raw={c} />);
   const render = renderers[node.type] as (ctx: RenderCtx) => React.ReactNode;
   return render({ node, raw, kids, env, scope, Node, checkActions });
}

type Batch = { ops: StatePatchOp[]; settled?: { at: unknown } };

const tryApply = (state: unknown, ops: StatePatchOp[]) => {
   try {
      return applyStatePatch(state, ops);
   } catch {
      return state;
   }
};

/**
 * A `render_ui` tree, bound to the Session State in `env`. The user's writes show at once: they
 * stay applied on top of `env.state` until it changes after the write settled (the core's
 * StateChanged has arrived), and each write builds on the ones before, so fast presses keep all.
 */
export function RenderUi({ root, env }: { root: RawNode; env: UiEnv }) {
   const [pending, setPending] = useState<Batch[]>([]);
   const [error, setError] = useState<string | null>(null);
   const shown = useMemo(
      () => pending.reduce((s, b) => tryApply(s, b.ops), env.state),
      [env.state, pending],
   );
   const latest = useRef(shown);
   latest.current = shown;
   const base = useRef(env.state);
   base.current = env.state;
   useEffect(
      () =>
         setPending((p) =>
            p.some((b) => b.settled && b.settled.at !== env.state)
               ? p.filter((b) => !b.settled || b.settled.at === env.state)
               : p,
         ),
      [env.state],
   );

   // Scripts ($js, js actions) load the engine; re-render once it is there.
   const scripted = useMemo(() => /"\$js"|"action":"js"/.test(JSON.stringify(root)), [root]);
   const [, rerender] = useReducer((n: number) => n + 1, 0);
   useEffect(() => {
      if (!scripted || jsReady()) return;
      const off = onJsReady(rerender);
      void loadJs();
      return off;
   }, [scripted]);

   const value = useMemo<UiEnv>(
      () => ({
         ...env,
         get state() {
            return latest.current;
         },
         patch: async (ops) => {
            const batch: Batch = { ops };
            const sent = base.current;
            latest.current = tryApply(latest.current, ops);
            setPending((p) => [...p, batch]);
            setError(null);
            try {
               await env.patch(ops);
               // The new state may have arrived before the write settled (a local patcher, or the core's
               // StateChanged first): it holds these ops, so drop them now, else removes and pushes apply twice.
               setPending((p) =>
                  base.current !== sent
                     ? p.filter((b) => b !== batch)
                     : p.map((b) => (b === batch ? { ops, settled: { at: sent } } : b)),
               );
            } catch (e) {
               setPending((p) => p.filter((b) => b !== batch));
               setError(e instanceof Error ? e.message : String(e));
            }
         },
         onError: (m) => setError(m),
      }),
      // A new object per state, so components re-render; reads go through `latest`.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [env, shown],
   );
   return (
      <Env.Provider value={value}>
         {/* Sizes (text-ui*) follow the chat font size, like Markdown in messages. */}
         <div className="min-w-0 text-ui">
            <Node raw={root} />
            {error && <p className="mt-2 text-ui-sm text-destructive">{error}</p>}
         </div>
      </Env.Provider>
   );
}
