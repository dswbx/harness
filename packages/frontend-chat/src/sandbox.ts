import type { QuickJSRuntime } from "quickjs-emscripten-core";

/**
 * render_ui's `$js` and `js` (ADR 0016): Agent code runs in QuickJS (wasm), never in the webview.
 * Each run gets a fresh context with only `state` in scope: no DOM, network, timers or storage,
 * 50 ms and 16 MB at most. Loaded on first use; `runJs` returns undefined until then.
 */
let runtime: QuickJSRuntime | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const LIMIT_MS = 50;

export function loadJs(): Promise<void> {
  loading ??= Promise.all([import("quickjs-emscripten-core"), import("@jitl/quickjs-singlefile-mjs-release-sync")]).then(async ([core, variant]) => {
    const mod = await core.newQuickJSWASMModuleFromVariant(variant.default);
    runtime = mod.newRuntime();
    runtime.setMemoryLimit(16 << 20);
    runtime.setMaxStackSize(1 << 20);
    for (const l of listeners) l();
  });
  return loading;
}

export const jsReady = () => runtime !== null;

/** Calls `fn` once the engine has loaded (for a re-render). */
export function onJsReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type JsResult = { value: unknown } | { error: string };

/** Code is an expression, or a function body when it has a `return`. */
export function wrap(code: string, state: unknown): string {
  const body = /\breturn\b/.test(code) ? code : `return (${code}\n);`;
  return `JSON.stringify((function (state) {\n${body}\n})(${JSON.stringify(state ?? {})}))`;
}

/** Runs `code` against `state`; the result must be JSON (undefined becomes null). */
export function runJs(code: string, state: unknown): JsResult | undefined {
  if (!runtime) {
    void loadJs();
    return undefined;
  }
  const deadline = Date.now() + LIMIT_MS;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const ctx = runtime.newContext();
  try {
    const r = ctx.evalCode(wrap(code, state));
    if (r.error) {
      const e = ctx.dump(r.error) as { name?: string; message?: string } | string;
      r.error.dispose();
      return { error: typeof e === "string" ? e : `${e?.name ?? "Error"}: ${e?.message ?? ""}` };
    }
    const out = ctx.dump(r.value) as string | undefined;
    r.value.dispose();
    return { value: typeof out === "string" ? JSON.parse(out) : null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    ctx.dispose();
  }
}
