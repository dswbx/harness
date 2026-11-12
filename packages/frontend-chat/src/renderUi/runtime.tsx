import { applyStatePatch, getAt, type StatePatchOp } from "@harness/api";
import { cn, Tooltip } from "@harness/ui";
import { AlertTriangle, Check, CheckCircle2, Info, XCircle } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { jsError, jsReady, loadJs, runJs } from "../sandbox";
import type { ComponentType, RawNode, StatePath, UiAction, UiNode, Visible } from "../tools";
import { uiIcons } from "../uiIcons";

export type Tone = "neutral" | "info" | "success" | "warning" | "error";

export const tones: Record<Tone, { icon: typeof Info | null; box: string; fg: string }> = {
   neutral: { icon: null, box: "bg-card", fg: "text-muted-foreground" },
   info: {
      icon: Info,
      box: "border-sky-500/40 bg-sky-500/5",
      fg: "text-sky-600 dark:text-sky-400",
   },
   success: {
      icon: CheckCircle2,
      box: "border-emerald-500/40 bg-emerald-500/5",
      fg: "text-emerald-600 dark:text-emerald-400",
   },
   warning: {
      icon: AlertTriangle,
      box: "border-amber-500/40 bg-amber-500/5",
      fg: "text-amber-600 dark:text-amber-400",
   },
   error: { icon: XCircle, box: "border-destructive/40 bg-destructive/5", fg: "text-destructive" },
};

/** What a `render_ui` tree renders against: the Session State and how to change it. */
export type UiEnv = {
   state: unknown;
   /** Changes the Session State as the user (all or nothing). */
   patch: (ops: StatePatchOp[]) => Promise<void>;
   /** Sends a message to the Agent as the user. */
   send: (text: string) => Promise<void>;
   /** Image srcs resolve through the core's copies of local files (`files`), else the URL as given. */
   files: Record<string, string>;
   readImage?: (path: string) => Promise<{ mime: string; data: string }>;
   /** Opens a workspace file (at a line) in the user's editor; absent: file links are plain text. */
   open?: (path: string, line?: number) => Promise<void>;
   /** Cache key prefix for read images (e.g. the Session id). */
   scope?: string;
   /** A `js` action failed (RenderUi shows it under the tree). */
   onError?: (message: string) => void;
   /** The call this tree is from: its `id`, else its call id (for `report`). */
   item?: string;
   /** Tells the core an item failed (e.g. an Html frame's script error), so the Agent learns about it. */
   report?: (item: string, message: string) => void;
   /** Reads a file-backed panel's Markdown (`source`, ADR 0023); absent: such panels show nothing. */
   readSource?: (name: string) => Promise<{ content: string; hash: string; mtime_ms: number }>;
   /** Calls back with the name of each panel source file that changed. Returns an unsubscribe. */
   watchSources?: (onChange: (name: string) => void) => Promise<() => void>;
};
export const Env = createContext<UiEnv | null>(null);
export const useEnv = () => useContext(Env)!;

/**
 * json-render's repeat scope: the Repeat item a node renders for. `$item`/`$index` read it,
 * `$bindItem` and an action's `{ $item }` path write under `path` (absent: items are not from state).
 */
export type Scope = { item: unknown; index: number; path?: string };
export const ScopeCtx = createContext<Scope | undefined>(undefined);

/** A field of the scope's item (`""`: the whole item; nested fields with `/`). */
export function readItem(field: string, scope: Scope | undefined): unknown {
   if (!scope) return undefined;
   return field === ""
      ? scope.item
      : getAt(scope.item, field.startsWith("/") ? field : `/${field}`);
}

/** The state path of an item field, for writes; undefined outside a Repeat over state. */
export function itemPath(field: string, scope: Scope | undefined): string | undefined {
   if (scope?.path == null) return undefined;
   return field === "" ? scope.path : `${scope.path}/${field.replace(/^\//, "")}`;
}

export const pathOf = (p: StatePath, scope: Scope | undefined) =>
   typeof p === "string" ? p : itemPath(p.$item, scope);

/** `{ $state }`, `{ $template }` and the rest read from `state` (and the Repeat item); other values stay as they are. */
export function resolveValue(v: unknown, state: unknown, scope?: Scope): unknown {
   if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
   const o = v as Record<string, unknown>;
   if (typeof o.$state === "string") return getAt(state, o.$state);
   if (typeof o.$item === "string") return readItem(o.$item, scope);
   if (o.$index === true) return scope?.index;
   if (typeof o.$js === "string") {
      const r = runJs(o.$js, state);
      if (r && "error" in r) console.warn(`render_ui $js: ${r.error}`);
      return r && "value" in r ? r.value : undefined;
   }
   if (typeof o.$computed === "string") {
      const args = (o.args ?? {}) as { values?: unknown; eq?: unknown };
      const raw = resolveValue(args.values, state, scope);
      const values = Array.isArray(raw)
         ? raw
         : raw && typeof raw === "object"
           ? Object.values(raw)
           : [];
      if (o.$computed === "count") {
         const eq = args.eq === undefined ? true : resolveValue(args.eq, state, scope);
         return values.filter((x) => JSON.stringify(x) === JSON.stringify(eq)).length;
      }
      if (o.$computed === "length") return values.length;
      if (o.$computed === "sum")
         return values.reduce(
            (n: number, x) => n + (typeof x === "number" ? x : Number(x) || 0),
            0,
         );
      return undefined;
   }
   if (typeof o.$template === "string") {
      // `${/path}` reads the state; a bare `${field}` the Repeat item first, then `/field` (json-render).
      return o.$template.replace(/\$\{([^}]*)\}/g, (_, p: string) => {
         const bare = p !== "" && !p.startsWith("/");
         const x = bare ? (readItem(p, scope) ?? getAt(state, `/${p}`)) : getAt(state, p);
         return x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x);
      });
   }
   return v;
}

/** json-render's visibility: `$state` is truthy (non-empty, non-zero, true), or `eq`/`neq` it; `not` flips. */
export function isVisible(v: Visible | undefined, state: unknown, scope?: Scope): boolean {
   if (v === undefined || v === true) return true;
   if (v === false) return false;
   if ("$and" in v) return v.$and.every((x) => isVisible(x, state, scope));
   if ("$or" in v) return v.$or.some((x) => isVisible(x, state, scope));
   const x =
      "$item" in v
         ? readItem(v.$item, scope)
         : "$index" in v
           ? scope?.index
           : getAt(state, v.$state);
   const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
   const ok =
      "eq" in v
         ? same(x, v.eq)
         : "neq" in v
           ? !same(x, v.neq)
           : Array.isArray(x)
             ? x.length > 0
             : !!x;
   return v.not ? !ok : ok;
}

/**
 * Runs `actions`: state actions become one patch (applied in order, each seeing the ones before), then messages are sent.
 * In a Repeat (`scope`), `{ $item }` paths and `{ $index: true }` indexes point at the item; an item path outside one skips the action.
 */
export async function runActions(
   actions: UiAction | UiAction[] | undefined,
   env: Pick<UiEnv, "state" | "patch" | "send" | "onError">,
   scope?: Scope,
) {
   const list = actions == null ? [] : Array.isArray(actions) ? actions : [actions];
   if (list.some((a) => a.action === "js") && !jsReady()) await loadJs();
   const ops: StatePatchOp[] = [];
   const texts: string[] = [];
   let cur = env.state;
   const push = (...more: StatePatchOp[]) => {
      ops.push(...more);
      try {
         cur = applyStatePatch(cur, more);
      } catch {
         /* the core decides; later actions read the state as it was */
      }
   };
   for (const a of list) {
      if (a.action === "sendMessage") {
         texts.push(String(resolveValue(a.params.text, cur, scope) ?? ""));
         continue;
      }
      const path = pathOf(a.params.statePath, scope);
      if (path === undefined) continue;
      if (a.action === "setState")
         push({ op: "replace", path, value: resolveValue(a.params.value, cur, scope) });
      else if (a.action === "pushState") {
         if (!Array.isArray(getAt(cur, path))) push({ op: "add", path, value: [] });
         push({ op: "add", path: `${path}/-`, value: resolveValue(a.params.value, cur, scope) });
      } else if (a.action === "removeState") {
         const index = typeof a.params.index === "object" ? scope?.index : a.params.index;
         push({ op: "remove", path: index == null ? path : `${path}/${index}` });
      } else if (a.action === "js") {
         const r = runJs(a.params.code, cur);
         // A failing script changes nothing and sends nothing.
         if (!r || "error" in r)
            return env.onError?.(r ? r.error : (jsError() ?? "The script engine did not load."));
         push({ op: "replace", path, value: r.value });
      }
   }
   if (ops.length) await env.patch(ops);
   for (const t of texts) if (t.trim()) await env.send(t);
}

/** `state` with `value` at `path`, for actions that run right after a bound write. */
export function structuredCloneSet(state: unknown, path: string, value: unknown): unknown {
   const out = structuredClone(state ?? {}) as Record<string, unknown>;
   const ts = path.split("/").slice(1);
   let cur = out;
   ts.slice(0, -1).forEach((t) => {
      if (typeof cur[t] !== "object" || cur[t] === null) cur[t] = {};
      cur = cur[t] as Record<string, unknown>;
   });
   if (ts.length) cur[ts.at(-1)!] = value;
   return out;
}

/** Wraps `el` in a tooltip; `focus` lets the keyboard reach a non-interactive element to show it. */
export const tip = (text: string | undefined, el: React.ReactElement, focus = false) =>
   text ? (
      <Tooltip content={text} {...(focus && { tabIndex: 0 })}>
         {el}
      </Tooltip>
   ) : (
      el
   );
export const IconOf = ({ name, className }: { name?: string; className?: string }) => {
   const I = name ? uiIcons[name as keyof typeof uiIcons] : undefined;
   return I ? <I className={cn("size-4 shrink-0", className)} /> : null;
};

export function CheckBox({ on, label }: { on: boolean; label?: string }) {
   return (
      <span
         role="checkbox"
         aria-checked={on}
         aria-label={label}
         className={cn(
            "grid size-4 shrink-0 place-items-center rounded border border-muted-foreground/50",
            on && "border-primary bg-primary text-primary-foreground",
         )}
      >
         {on && <Check className="size-3" strokeWidth={3} />}
      </span>
   );
}

/** What a component renderer gets: its bound node, and the context to render children and run actions. */
export type RenderCtx<K extends ComponentType = ComponentType> = {
   node: Extract<UiNode, { type: K }>;
   raw: RawNode;
   /** The children rendered, in order (undefined: none). */
   kids: ReactNode[] | undefined;
   env: UiEnv;
   scope: Scope | undefined;
   /** Renders a node in the current scope. */
   Node: (p: { raw: RawNode }) => ReactNode;
   /** Checks actions from an Html frame against the render_ui schema; an error message, or null. */
   checkActions: (actions: unknown) => string | null;
};
export type Renderer<K extends ComponentType> = (ctx: RenderCtx<K>) => ReactNode;
/** One group's renderers, by component name. */
export type Renderers = { [K in ComponentType]?: Renderer<K> };
