import { createContext, lazy, Suspense, useEffect, useMemo, useContext, useReducer, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, CheckCircle2, ChevronLeft, ChevronRight, FileCode, ImageOff, Info, Search, XCircle } from "lucide-react";
import { applyStatePatch, getAt, type StatePatchOp } from "@harness/api";
import { Button, Input, Select, Textarea, Tooltip, cn } from "@harness/ui";
import { Dialog, DialogContent, DialogTitle } from "@harness/ui";
import { Markdown } from "./Markdown";
import { splitPatch } from "./diff";
import { DiffViewer } from "./DiffViewer";
import { Diff as FileDiff } from "./ToolCard";
import { uiIcons } from "./uiIcons";
import { AnsiText } from "./AnsiText";
import { InlineMarkdown as Md } from "./InlineMarkdown";
import { jsReady, loadJs, onJsReady, runJs } from "./sandbox";

/** recharts is large: loaded the first time a Chart shows. */
const UiChart = lazy(() => import("./UiChart"));
import { components, type RawNode, type UiAction, type UiNode, type Visible } from "./tools";

type Tone = "neutral" | "info" | "success" | "warning" | "error";
type Img = { src: string; alt: string; caption?: string };

const tones: Record<Tone, { icon: typeof Info | null; box: string; fg: string }> = {
  neutral: { icon: null, box: "bg-card", fg: "text-muted-foreground" },
  info: { icon: Info, box: "border-sky-500/40 bg-sky-500/5", fg: "text-sky-600 dark:text-sky-400" },
  success: { icon: CheckCircle2, box: "border-emerald-500/40 bg-emerald-500/5", fg: "text-emerald-600 dark:text-emerald-400" },
  warning: { icon: AlertTriangle, box: "border-amber-500/40 bg-amber-500/5", fg: "text-amber-600 dark:text-amber-400" },
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
};
const Env = createContext<UiEnv | null>(null);
const useEnv = () => useContext(Env)!;
const imageCache = new Map<string, Promise<string>>();

/** `{ $state }` and `{ $template }` read from `state`; other values stay as they are. */
export function resolveValue(v: unknown, state: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$state === "string") return getAt(state, o.$state);
  if (typeof o.$js === "string") {
    const r = runJs(o.$js, state);
    if (r && "error" in r) console.warn(`render_ui $js: ${r.error}`);
    return r && "value" in r ? r.value : undefined;
  }
  if (typeof o.$computed === "string") {
    const args = (o.args ?? {}) as { values?: unknown; eq?: unknown };
    const raw = resolveValue(args.values, state);
    const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
    if (o.$computed === "count") {
      const eq = args.eq === undefined ? true : resolveValue(args.eq, state);
      return values.filter((x) => JSON.stringify(x) === JSON.stringify(eq)).length;
    }
    if (o.$computed === "length") return values.length;
    if (o.$computed === "sum") return values.reduce((n: number, x) => n + (typeof x === "number" ? x : Number(x) || 0), 0);
    return undefined;
  }
  if (typeof o.$template === "string") {
    return o.$template.replace(/\$\{([^}]*)\}/g, (_, p: string) => {
      const x = getAt(state, p);
      return x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x);
    });
  }
  return v;
}

/** json-render's visibility: `$state` is truthy (non-empty, non-zero, true), or `eq`/`neq` it; `not` flips. */
export function isVisible(v: Visible | undefined, state: unknown): boolean {
  if (v === undefined || v === true) return true;
  if (v === false) return false;
  if ("$and" in v) return v.$and.every((x) => isVisible(x, state));
  if ("$or" in v) return v.$or.some((x) => isVisible(x, state));
  const x = getAt(state, v.$state);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const ok = "eq" in v ? same(x, v.eq) : "neq" in v ? !same(x, v.neq) : Array.isArray(x) ? x.length > 0 : !!x;
  return v.not ? !ok : ok;
}

/** Binds a node's props: expressions read from `state`, `$bindState` props read their path. */
export function resolveNode(raw: RawNode, state: unknown): UiNode {
  const bind: readonly string[] = (components[raw.type] as { bind?: readonly string[] }).bind ?? [];
  const bindings: Record<string, string> = {};
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw.props ?? {})) {
    const path = bind.includes(k) && typeof v === "object" && v !== null ? (v as { $bindState?: unknown }).$bindState : undefined;
    if (typeof path === "string") {
      bindings[k] = path;
      props[k] = getAt(state, path);
    } else props[k] = resolveValue(v, state);
  }
  return { ...raw, props, bindings, children: undefined } as unknown as UiNode;
}

/** Runs `actions`: state actions become one patch (applied in order, each seeing the ones before), then messages are sent. */
export async function runActions(actions: UiAction | UiAction[] | undefined, env: Pick<UiEnv, "state" | "patch" | "send" | "onError">) {
  const list = actions == null ? [] : Array.isArray(actions) ? actions : [actions];
  if (list.some((a) => a.action === "js") && !jsReady()) await loadJs();
  const ops: StatePatchOp[] = [];
  const texts: string[] = [];
  let cur = env.state;
  const push = (...more: StatePatchOp[]) => {
    ops.push(...more);
    try {
      cur = applyStatePatch(cur, more);
    } catch { /* the core decides; later actions read the state as it was */ }
  };
  for (const a of list) {
    if (a.action === "setState") push({ op: "replace", path: a.params.statePath, value: resolveValue(a.params.value, cur) });
    else if (a.action === "pushState") {
      if (!Array.isArray(getAt(cur, a.params.statePath))) push({ op: "add", path: a.params.statePath, value: [] });
      push({ op: "add", path: `${a.params.statePath}/-`, value: resolveValue(a.params.value, cur) });
    } else if (a.action === "removeState") push({ op: "remove", path: a.params.index == null ? a.params.statePath : `${a.params.statePath}/${a.params.index}` });
    else if (a.action === "js") {
      const r = runJs(a.params.code, cur);
      // A failing script changes nothing and sends nothing.
      if (!r || "error" in r) return env.onError?.(r ? r.error : "The script engine did not load.");
      push({ op: "replace", path: a.params.statePath, value: r.value });
    } else if (a.action === "sendMessage") texts.push(String(resolveValue(a.params.text, cur) ?? ""));
  }
  if (ops.length) await env.patch(ops);
  for (const t of texts) if (t.trim()) await env.send(t);
}

function useImage(src: string): { url: string | null; failed: boolean } {
  const env = useContext(Env);
  const copy = env?.files[src];
  const read = env?.readImage;
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    if (!copy || !read) {
      setState(/^(https:|data:image\/)/.test(src) ? { url: src, failed: false } : { url: null, failed: true });
      return;
    }
    const key = `${env?.scope ?? ""}:${copy}`;
    let p = imageCache.get(key);
    if (!p) {
      p = read(copy).then((r) => `data:${r.mime};base64,${r.data}`);
      p.catch(() => imageCache.delete(key));
      imageCache.set(key, p);
    }
    let live = true;
    p.then((url) => live && setState({ url, failed: false }), () => live && setState({ url: null, failed: true }));
    return () => {
      live = false;
    };
  }, [copy, read, src, env?.scope]);
  return state;
}

/** `imgClassName` sizes the image itself; by default it fills the box `className` sizes. */
function Picture({ img, className, imgClassName = "size-full object-contain", onOpen }: { img: Img; className?: string; imgClassName?: string; onOpen?: () => void }) {
  const { url, failed } = useImage(img.src);
  const [broken, setBroken] = useState(false);
  if (failed || broken) {
    return (
      <div className={cn("flex items-center justify-center gap-2 bg-muted text-ui-sm text-muted-foreground", className)}>
        <ImageOff className="size-4" /> {img.alt}
      </div>
    );
  }
  const el = url ? <img src={url} alt={img.alt} onError={() => setBroken(true)} className={imgClassName} /> : null;
  if (!onOpen) return <div className={cn("bg-muted", className)}>{el}</div>;
  return (
    <button className={cn("block bg-muted", className)} onClick={onOpen} aria-label={`Open ${img.alt}`}>
      {el}
    </button>
  );
}

/** Full-size view of `images`, starting at `index`; arrow keys and buttons step through them. */
function Lightbox({ images, index, onIndex, onClose }: { images: Img[]; index: number | null; onIndex: (i: number) => void; onClose: () => void }) {
  const img = index == null ? null : images[index];
  const step = (d: number) => index != null && onIndex((index + d + images.length) % images.length);
  return (
    <Dialog open={img != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="w-auto max-w-[90vw] p-2"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") step(-1);
          if (e.key === "ArrowRight") step(1);
        }}
      >
        <DialogTitle className="sr-only">{img?.alt ?? "Image"}</DialogTitle>
        {img && (
          <figure>
            <div className="relative">
              <Picture key={img.src} img={img} className="min-h-40 min-w-60 overflow-hidden rounded" imgClassName="block max-h-[80vh] max-w-[85vw] object-contain" />
              {images.length > 1 && <Arrows onStep={step} label={`${index! + 1} / ${images.length}`} />}
            </div>
            {img.caption && <figcaption className="mt-2 text-center text-ui-sm text-muted-foreground">{img.caption}</figcaption>}
          </figure>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Arrows({ onStep, label }: { onStep: (d: number) => void; label: string }) {
  const btn = "absolute top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-1.5 shadow hover:bg-background";
  return (
    <>
      <button className={cn(btn, "left-2")} onClick={() => onStep(-1)} aria-label="Previous image">
        <ChevronLeft className="size-4" />
      </button>
      <button className={cn(btn, "right-2")} onClick={() => onStep(1)} aria-label="Next image">
        <ChevronRight className="size-4" />
      </button>
      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-2 py-0.5 text-ui-sm tabular-nums">{label}</span>
    </>
  );
}

function ImageView({ img }: { img: Img }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <figure>
      <Picture img={img} className="max-h-80 min-h-24 w-full overflow-hidden rounded-md border" onOpen={() => setOpen(0)} />
      {img.caption && <figcaption className="mt-1 break-words text-ui-sm text-muted-foreground">{img.caption}</figcaption>}
      <Lightbox images={[img]} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </figure>
  );
}

function Carousel({ images }: { images: Img[] }) {
  const [i, setI] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const img = images[Math.min(i, images.length - 1)]!;
  const step = (d: number) => setI((i + d + images.length) % images.length);
  return (
    <figure>
      <div className="relative">
        <Picture key={img.src} img={img} className="h-64 w-full overflow-hidden rounded-md border" onOpen={() => setOpen(i)} />
        {images.length > 1 && <Arrows onStep={step} label={`${i + 1} / ${images.length}`} />}
      </div>
      {img.caption && <figcaption className="mt-1 break-words text-ui-sm text-muted-foreground">{img.caption}</figcaption>}
      <Lightbox images={images} index={open} onIndex={(n) => (setOpen(n), setI(n))} onClose={() => setOpen(null)} />
    </figure>
  );
}

function Choice({ node }: { node: Extract<UiNode, { type: "Choice" }> }) {
  const env = useEnv();
  const { options, answer } = node.props;
  const picked = node.props.value;
  const graded = answer != null && picked != null && picked !== "";
  const pick = async (value: string) => {
    const path = node.bindings.value;
    if (!path || graded) return;
    const ops: StatePatchOp[] = [{ op: "replace", path, value }];
    let next = structuredCloneSet(env.state, path, value);
    const result = node.bindings.result;
    if (result && answer != null) {
      ops.push({ op: "replace", path: result, value: value === answer });
      next = structuredCloneSet(next, result, value === answer);
    }
    await env.patch(ops);
    await runActions(node.on?.change, { ...env, state: next });
  };
  // Picked by value: duplicate values would pick several options at once.
  if (new Set(options.map((o) => o.value)).size !== options.length) {
    return <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive">Choice options need distinct values.</div>;
  }
  const right = graded && picked === answer;
  const verdictOf = (v: string) => (!graded ? null : v === answer ? "right" : picked === v ? "wrong" : null);
  const variant = node.props.variant ?? "list";
  const body =
    variant === "select" ? (
      <div className="flex items-center gap-2">
        <Select className="w-auto min-w-48" value={picked == null ? "" : String(picked)} disabled={graded} onChange={(e) => void pick(e.target.value)}>
          <option value="" disabled>Choose…</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        {graded && (right ? <CheckCircle2 className="size-4 text-emerald-500" aria-label="correct" /> : <XCircle className="size-4 text-destructive" aria-label="wrong" />)}
      </div>
    ) : variant === "buttons" ? (
      <div role="radiogroup" className="inline-flex w-fit max-w-full flex-wrap rounded-md border p-0.5">
        {options.map((o) => {
          const on = picked === o.value;
          const verdict = verdictOf(o.value);
          return (
            <button
              key={o.value}
              role="radio"
              aria-checked={on}
              disabled={graded && !on}
              onClick={() => void pick(o.value)}
              className={cn(
                "rounded px-3 py-1 text-ui transition-colors disabled:cursor-default",
                verdict === "right" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : verdict === "wrong" ? "bg-destructive/15 text-destructive" : on ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    ) : null;
  return (
    <div className="grid grid-cols-1 gap-2">
    {body ?? <div role="radiogroup" className={cn("grid grid-cols-1 gap-1.5", node.props.columns === 2 && "sm:grid-cols-2")}>
      {options.map((o) => {
        const on = picked === o.value;
        const verdict = !graded ? null : o.value === answer ? "right" : on ? "wrong" : null;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={on}
            disabled={graded && !on}
            onClick={() => void pick(o.value)}
            className={cn(
              "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-ui transition-colors disabled:cursor-default",
              verdict === "right" ? "border-emerald-500/60 bg-emerald-500/10" : verdict === "wrong" ? "border-destructive/60 bg-destructive/10" : on ? "border-primary bg-primary/10 font-medium" : !graded && "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <span className={cn("grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground/50", on && "border-primary")}>
              {on && <span className="size-2 rounded-full bg-primary" />}
            </span>
            <span className="min-w-0 flex-1"><Md>{o.label}</Md></span>
            {verdict === "right" && <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-label="correct" />}
            {verdict === "wrong" && <XCircle className="size-4 shrink-0 text-destructive" aria-label="wrong" />}
          </button>
        );
      })}
    </div>}
    {graded && node.props.explanation && (
      <div role="note" className={cn("rounded-md border px-3 py-2", right ? tones.success.box : tones.error.box)}>
        <div className={cn("mb-1 text-ui-sm font-medium", right ? tones.success.fg : tones.error.fg)}>{right ? "Correct" : "Not quite"}</div>
        <Markdown>{node.props.explanation}</Markdown>
      </div>
    )}
    </div>
  );
}

/** Index from a bound `value`, else local; writes go to the bound path when there is one. */
function useIndex(node: { props: { value?: unknown }; bindings: Record<string, string> }, count: number): [number, (i: number) => void] {
  const env = useEnv();
  const [local, setLocal] = useState(0);
  const path = node.bindings.value;
  const bound = Number(node.props.value);
  const index = Math.max(0, Math.min(count - 1, path && Number.isInteger(bound) ? bound : local));
  const set = (i: number) => (path ? void env.patch([{ op: "replace", path, value: i }]) : setLocal(i));
  return [index, set];
}

function Tabs({ node, kids }: { node: Extract<UiNode, { type: "Tabs" }>; kids: React.ReactNode[] }) {
  const [i, setI] = useIndex(node, node.props.tabs.length);
  return (
    <div className="grid grid-cols-1 gap-3">
      {/* Scrolls sideways only; the bottom line is drawn inside, so the active underline doesn't overflow. */}
      <div role="tablist" className="flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--border)]">
        {node.props.tabs.map((t, j) => (
          <button
            key={j}
            role="tab"
            aria-selected={i === j}
            onClick={() => setI(j)}
            className={cn("shrink-0 border-b-2 px-3 py-1.5 text-ui", i === j ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel">{kids[i]}</div>
    </div>
  );
}

function Stepper({ node, kids }: { node: Extract<UiNode, { type: "Stepper" }>; kids: React.ReactNode[] }) {
  const env = useEnv();
  const steps = node.props.steps;
  const [i, setI] = useIndex(node, steps.length);
  const last = i === steps.length - 1;
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <span className="tabular-nums">Step {i + 1} of {steps.length}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{steps[i]}</span>
        <div className="flex gap-1">
          {steps.map((_, j) => (
            <button key={j} aria-label={`Go to step ${j + 1}`} onClick={() => setI(j)} className={cn("size-2 rounded-full", j === i ? "bg-primary" : "bg-muted-foreground/30 hover:bg-muted-foreground/60")} />
          ))}
        </div>
      </div>
      <div>{kids[i]}</div>
      <div className="flex justify-between gap-2">
        <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => setI(i - 1)}>Back</Button>
        {last ? (
          node.on?.finish && <Button size="sm" onClick={() => void runActions(node.on?.finish, env)}>Finish</Button>
        ) : (
          <Button size="sm" onClick={() => setI(i + 1)}>Next</Button>
        )}
      </div>
    </div>
  );
}

/** `state` with `value` at `path`, for actions that run right after a bound write. */
function structuredCloneSet(state: unknown, path: string, value: unknown): unknown {
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

function TextInput({ node }: { node: Extract<UiNode, { type: "Input" }> }) {
  const env = useEnv();
  const path = node.bindings.value;
  const stored = node.props.value == null ? "" : String(node.props.value);
  const [text, setText] = useState(stored);
  useEffect(() => setText(stored), [stored]);
  const commit = async (submit: boolean) => {
    if (path && text !== stored) await env.patch([{ op: "replace", path, value: text }]);
    if (submit) await runActions(node.on?.submit, { ...env, state: path ? structuredCloneSet(env.state, path, text) : env.state });
  };
  return (
    <label className="grid grid-cols-1 gap-1.5">
      {node.props.label && <span className="text-ui-sm text-muted-foreground">{node.props.label}</span>}
      {node.props.multiline ? (
        <Textarea
          value={text}
          rows={4}
          placeholder={node.props.placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit(false)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void commit(true)}
        />
      ) : (
        <Input
          value={text}
          placeholder={node.props.placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit(false)}
          onKeyDown={(e) => e.key === "Enter" && void commit(true)}
        />
      )}
    </label>
  );
}

const tip = (text: string | undefined, el: React.ReactElement) => (text ? <Tooltip content={text}>{el}</Tooltip> : el);
const IconOf = ({ name, className }: { name?: string; className?: string }) => {
  const I = name ? uiIcons[name as keyof typeof uiIcons] : undefined;
  return I ? <I className={cn("size-4 shrink-0", className)} /> : null;
};

/** A boolean bound to state; writes it, then runs `on.change` with the new state. */
function useToggle(node: { props: { value?: unknown }; bindings: Record<string, string>; on?: RawNode["on"] }) {
  const env = useEnv();
  const on = node.props.value === true;
  const toggle = async () => {
    const path = node.bindings.value;
    if (!path) return;
    await env.patch([{ op: "replace", path, value: !on }]);
    await runActions(node.on?.change, { ...env, state: structuredCloneSet(env.state, path, !on) });
  };
  return [on, toggle] as const;
}

function CheckBox({ on, label }: { on: boolean; label?: string }) {
  return (
    <span role="checkbox" aria-checked={on} aria-label={label} className={cn("grid size-4 shrink-0 place-items-center rounded border border-muted-foreground/50", on && "border-primary bg-primary text-primary-foreground")}>
      {on && <Check className="size-3" strokeWidth={3} />}
    </span>
  );
}

function Toggle({ node, kind }: { node: Extract<UiNode, { type: "Checkbox" | "Switch" }>; kind: "checkbox" | "switch" }) {
  const [on, toggle] = useToggle(node);
  return (
    <button type="button" onClick={() => void toggle()} className="flex w-fit max-w-full items-start gap-2.5 text-left">
      {kind === "checkbox" ? (
        <span className="mt-0.5"><CheckBox on={on} /></span>
      ) : (
        <span role="switch" aria-checked={on} className={cn("mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}>
          <span className={cn("size-3 rounded-full bg-background transition-transform", on && "translate-x-3")} />
        </span>
      )}
      <span className="min-w-0">
        <span className="block text-ui">{node.props.label}</span>
        {node.props.description && <span className="block text-ui-sm text-muted-foreground">{node.props.description}</span>}
      </span>
    </button>
  );
}

function List({ node }: { node: Extract<UiNode, { type: "List" }> }) {
  const env = useEnv();
  const path = node.bindings.check;
  const checked = (node.props.check ?? {}) as Record<string, unknown>;
  const toggle = async (id: string) => {
    if (!path) return;
    const value = checked[id] !== true;
    const ops: StatePatchOp[] = typeof node.props.check === "object" && node.props.check !== null ? [] : [{ op: "replace", path, value: {} }];
    ops.push({ op: "replace", path: `${path}/${id.replace(/~/g, "~0").replace(/\//g, "~1")}`, value });
    await env.patch(ops);
    await runActions(node.on?.change, { ...env, state: structuredCloneSet(env.state, path, { ...checked, [id]: value }) });
  };
  return (
    <ul className="divide-y rounded-lg border">
      {node.props.items.map((it) => {
        const done = checked[it.id] === true;
        const t = tones[it.tone ?? "neutral"];
        const row = (
          <>
            {path && <span className="mt-0.5"><CheckBox on={done} label={it.title} /></span>}
            {it.icon && <IconOf name={it.icon} className={cn("mt-0.5 text-muted-foreground", it.tone && it.tone !== "neutral" && t.fg)} />}
            <span className="min-w-0 flex-1">
              <span className={cn("block text-ui", done && "text-muted-foreground line-through")}><Md>{it.title}</Md></span>
              {it.description && <span className="block text-ui-sm text-muted-foreground"><Md>{it.description}</Md></span>}
            </span>
            {it.badge && <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-ui-sm", t.box, t.fg)}>{it.badge}</span>}
            {it.meta && <span className="shrink-0 text-ui-sm text-muted-foreground tabular-nums">{it.meta}</span>}
          </>
        );
        return (
          <li key={it.id}>
            {path ? (
              <button type="button" onClick={() => void toggle(it.id)} className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-accent/50">{row}</button>
            ) : (
              <div className="flex items-start gap-2.5 px-3 py-2">{row}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Accordion({ node, kids }: { node: Extract<UiNode, { type: "Accordion" }>; kids: ReactNode[] }) {
  const [open, setOpen] = useState<number[]>(() => node.props.open ?? []);
  const flip = (i: number) => setOpen(open.includes(i) ? open.filter((x) => x !== i) : node.props.multiple ? [...open, i] : [i]);
  return (
    <div className="divide-y rounded-lg border">
      {node.props.items.map((title, i) => (
        <div key={i}>
          <button type="button" aria-expanded={open.includes(i)} onClick={() => flip(i)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui font-medium hover:bg-accent/50">
            <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open.includes(i) && "rotate-90")} />
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </button>
          {open.includes(i) && <div className="px-3 pb-3 pl-9">{kids[i]}</div>}
        </div>
      ))}
    </div>
  );
}

function Timeline({ node }: { node: Extract<UiNode, { type: "Timeline" }> }) {
  return (
    <ol className="grid grid-cols-1">
      {node.props.items.map((it, i) => {
        const t = tones[it.tone ?? "neutral"];
        const last = i === node.props.items.length - 1;
        return (
          <li key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border bg-background", it.tone && it.tone !== "neutral" ? t.fg : "text-muted-foreground")}>
                {it.icon ? <IconOf name={it.icon} className="size-3.5" /> : <span className="size-1.5 rounded-full bg-current" />}
              </span>
              {!last && <span className="w-px flex-1 bg-border" />}
            </div>
            <div className={cn("min-w-0 flex-1", !last && "pb-4")}>
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-ui font-medium">{it.title}</span>
                {it.time && <span className="shrink-0 text-ui-sm text-muted-foreground tabular-nums">{it.time}</span>}
              </div>
              {it.description && <Markdown className="text-ui-sm text-muted-foreground">{it.description}</Markdown>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DataTable({ node }: { node: Extract<UiNode, { type: "Table" }> }) {
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const [q, setQ] = useState("");
  const columns = node.props.columns ?? [];
  const rows = useMemo(() => {
    let out = node.props.rows ?? [];
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter((r) => r.some((c) => String(c).toLowerCase().includes(needle)));
    if (sort) {
      const num = (x: string) => Number.parseFloat(x.replace(/[^\d.-]/g, ""));
      out = [...out].sort((a, b) => {
        const x = String(a[sort.col] ?? ""), y = String(b[sort.col] ?? "");
        const nx = num(x), ny = num(y);
        const c = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y, undefined, { numeric: true }) : nx - ny;
        return sort.desc ? -c : c;
      });
    }
    return out;
  }, [node.props.rows, q, sort]);
  const click = (col: number) => setSort(sort?.col === col ? (sort.desc ? null : { col, desc: true }) : { col, desc: false });
  return (
    <div className="grid grid-cols-1 gap-2">
      {node.props.filter && (
        <div className="relative w-full max-w-64">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-7 text-ui" placeholder="Filter rows" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-ui">
          <thead className="bg-muted/50 text-left">
            <tr>
              {columns.map((c, i) => (
                <th key={i} className="px-3 py-2 font-medium" aria-sort={sort?.col === i ? (sort.desc ? "descending" : "ascending") : undefined}>
                  {node.props.sortable ? (
                    <button type="button" onClick={() => click(i)} className="inline-flex items-center gap-1 hover:text-foreground">
                      <Md>{c}</Md>
                      {sort?.col === i && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                    </button>
                  ) : <Md>{c}</Md>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t">
                {r.map((c, j) => <td key={j} className="px-3 py-2 align-top"><Md>{c}</Md></td>)}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={columns.length} className="px-3 py-3 text-center text-muted-foreground">No rows</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A workspace path that opens in the user's editor; plain text where nothing can open it. */
function OpenFile({ path, line, label, className }: { path: string; line?: number; label?: string; className?: string }) {
  const env = useEnv();
  const [error, setError] = useState<string | null>(null);
  const text = label ?? `${path}${line ? `:${line}` : ""}`;
  if (!env.open) return <span className={cn("font-mono", className)}>{text}</span>;
  return (
    <Tooltip content={error ?? `Open ${path}${line ? ` at line ${line}` : ""} in your editor`}>
      <button
        type="button"
        onClick={() => env.open!(path, line).then(() => setError(null), (e) => setError(e instanceof Error ? e.message : String(e)))}
        className={cn("inline-flex min-w-0 items-center gap-1 font-mono underline-offset-2 hover:underline", error ? "text-destructive" : "text-sky-600 dark:text-sky-400", className)}
      >
        <span className="truncate">{text}</span>
      </button>
    </Tooltip>
  );
}

function DiffBlock({ node }: { node: Extract<UiNode, { type: "Diff" }> }) {
  const p = node.props;
  const files = useMemo(() => (p.patch ? splitPatch(p.patch) : []), [p.patch]);
  if (!p.patch) {
    return p.path && p.new != null ? (
      <div className="grid grid-cols-1 gap-1">
        <OpenFile path={p.path} className="w-fit text-ui-sm" />
        <FileDiff path={p.path} oldText={p.old ?? null} newText={p.new} />
      </div>
    ) : null;
  }
  return (
    <div className="grid grid-cols-1 gap-2">
      {files.map((f) => (
        <div key={f.path} className="overflow-hidden rounded border">
          <div className="flex gap-2 border-b bg-muted px-2 py-1 font-mono text-ui-sm text-muted-foreground">
            <span className="flex min-w-0 flex-1"><OpenFile path={f.path} /></span>
            <span className="text-emerald-600 dark:text-emerald-400">+{f.additions}</span>
            <span className="text-destructive">-{f.deletions}</span>
          </div>
          <DiffViewer file={f} mode="unified" fontSize={11} wrap />
        </div>
      ))}
      {files.length === 0 && <Markdown>{"```diff\n" + p.patch + "\n```"}</Markdown>}
    </div>
  );
}

function LogBox({ node }: { node: Extract<UiNode, { type: "Log" }> }) {
  const [el, setEl] = useState<HTMLPreElement | null>(null);
  const text = String(node.props.text ?? "");
  // Starts at the end, like a terminal.
  useEffect(() => {
    if (el) el.scrollTop = el.scrollHeight;
  }, [el, text]);
  return (
    <div className="overflow-hidden rounded-md border">
      {node.props.title && <div className="border-b bg-muted px-2 py-1 font-mono text-ui-sm text-muted-foreground">{node.props.title}</div>}
      <pre ref={setEl} className="max-h-72 overflow-auto bg-muted/40 p-2 font-mono text-ui-sm leading-relaxed whitespace-pre-wrap break-words">
        <AnsiText text={text} />
      </pre>
    </div>
  );
}

/** Solid fills for bars; the card tones are too light for thin shapes. */
const barTone: Record<Tone, string> = {
  neutral: "bg-primary/35",
  info: "bg-sky-500/70",
  success: "bg-emerald-500/70",
  warning: "bg-amber-500/70",
  error: "bg-destructive/70",
};

function Trace({ node }: { node: Extract<UiNode, { type: "Trace" }> }) {
  const spans = node.props.spans;
  const unit = node.props.unit ?? "ms";
  // Tree order: children under their parent, by start.
  const rows = useMemo(() => {
    const ids = new Set(spans.map((x) => x.id));
    const kids = new Map<string | undefined, typeof spans>();
    for (const x of spans) {
      const p = x.parent && ids.has(x.parent) ? x.parent : undefined;
      kids.set(p, [...(kids.get(p) ?? []), x]);
    }
    const out: { span: (typeof spans)[number]; depth: number }[] = [];
    const walk = (p: string | undefined, depth: number) => {
      for (const x of [...(kids.get(p) ?? [])].sort((a, b) => a.start - b.start)) {
        out.push({ span: x, depth });
        if (depth < 20) walk(x.id, depth + 1);
      }
    };
    walk(undefined, 0);
    return out;
  }, [spans]);
  const t0 = Math.min(...spans.map((x) => x.start));
  const total = Math.max(...spans.map((x) => x.start + x.duration)) - t0 || 1;
  const fmt = (n: number) => `${Math.round(n * 10) / 10}${unit}`;
  return (
    <div className="grid grid-cols-1 gap-1 text-ui-sm">
      {rows.map(({ span: x, depth }) => {
        const t = tones[x.tone ?? "neutral"];
        const bar = (
          <div className="relative h-5 min-w-0 flex-1 rounded bg-muted/40">
            <div
              className={cn("absolute inset-y-0.5 rounded-sm", barTone[x.tone ?? "neutral"])}
              style={{ left: `${((x.start - t0) / total) * 100}%`, width: `max(2px, ${(x.duration / total) * 100}%)` }}
            />
          </div>
        );
        return (
          <div key={x.id} className="flex items-center gap-2">
            <span className="w-40 shrink-0 truncate font-mono" style={{ paddingLeft: depth * 12 }} title={x.name}>{x.name}</span>
            {tip(x.meta, bar)}
            <span className={cn("w-16 shrink-0 text-right tabular-nums text-muted-foreground", x.tone && x.tone !== "neutral" && t.fg)}>{fmt(x.duration)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Node({ raw }: { raw: RawNode }) {
  const env = useEnv();
  if (!isVisible(raw.visible, env.state)) return null;
  const node = resolveNode(raw, env.state);
  const kids = raw.children?.map((c, i) => <Node key={i} raw={c} />);
  switch (node.type) {
    case "Stack": {
      const gap = { sm: "gap-1.5", md: "gap-3", lg: "gap-5" }[node.props?.gap ?? "md"];
      // Hidden children leave no gap or empty cell; keys stay their original index.
      const shown = (raw.children ?? []).map((c, i) => [c, i] as const).filter(([c]) => isVisible(c.visible, env.state));
      if (node.props?.direction !== "horizontal") return <div className={cn("flex min-w-0 flex-col", gap)}>{shown.map(([c, i]) => <Node key={i} raw={c} />)}</div>;
      // A row: badges and buttons keep their width; other children share it equally (same height)
      // and wrap when narrower than 12rem.
      return (
        <div className={cn("flex min-w-0 flex-row flex-wrap items-center", gap)}>
          {shown.map(([c, i]) =>
            c.type === "Badge" || c.type === "Button" || c.type === "Checkbox" || c.type === "Switch" || c.type === "FileLink" ? (
              <Node key={i} raw={c} />
            ) : (
              <div key={i} className="flex min-w-48 flex-1 basis-0 flex-col self-stretch [&>*]:flex-1">
                <Node raw={c} />
              </div>
            ),
          )}
        </div>
      );
    }
    case "Card": {
      const t = tones[node.props?.tone ?? "neutral"];
      const Icon = (node.props?.icon && uiIcons[node.props.icon]) || t.icon;
      return (
        <div className={cn("min-w-0 overflow-hidden rounded-lg border", t.box)}>
          {node.props?.title && (
            <div className="border-b bg-muted/40 px-3 py-2.5">
              <div className="flex items-center gap-2 font-semibold text-foreground">
                {Icon && <Icon className={cn("size-4 shrink-0", node.props.tone && node.props.tone !== "neutral" ? t.fg : "text-muted-foreground")} />}
                <span className="min-w-0">{node.props.title}</span>
              </div>
              {node.props.description && <div className="mt-0.5 text-ui-sm text-muted-foreground"><Md>{node.props.description}</Md></div>}
            </div>
          )}
          {(kids?.length ?? 0) > 0 && <div className="space-y-2 p-3">{kids}</div>}
        </div>
      );
    }
    case "Markdown":
      return <Markdown>{String(node.props.text ?? "")}</Markdown>;
    case "KeyValue":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {(node.props.items ?? []).map((it, i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground"><Md>{it.label}</Md></dt>
              <dd className="min-w-0 break-words"><Md>{it.value}</Md></dd>
            </div>
          ))}
        </dl>
      );
    case "Table":
      return <DataTable node={node} />;
    case "Badge": {
      const t = tones[node.props.tone ?? "neutral"];
      return tip(
        node.props.tooltip,
        <span className={cn("inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-ui-sm font-medium", t.box, t.fg)}>
          {node.props.icon && <IconOf name={node.props.icon} className="size-3" />}
          {String(node.props.text ?? "")}
        </span>,
      );
    }
    case "Code":
      return <Markdown>{"```" + (node.props.language ?? "") + "\n" + String(node.props.code ?? "") + "\n```"}</Markdown>;
    case "Image":
      return <ImageView img={node.props} />;
    case "Carousel":
      return (node.props.images ?? []).length ? <Carousel images={node.props.images} /> : null;
    case "Stat": {
      const t = tones[node.props.tone ?? "neutral"];
      return tip(
        node.props.tooltip,
        <div className="min-w-0">
          <div className="text-ui-sm text-muted-foreground">{node.props.label}</div>
          <div className={cn("text-ui-xl font-semibold tabular-nums", node.props.tone && node.props.tone !== "neutral" && t.fg)}>{String(node.props.value ?? "")}</div>
          {node.props.hint && <div className="text-ui-sm text-muted-foreground">{node.props.hint}</div>}
        </div>,
      );
    }
    case "Progress": {
      const max = Number(node.props.max ?? 100) || 100;
      const pct = Math.max(0, Math.min(100, (Number(node.props.value ?? 0) / max) * 100));
      return (
        <div className="grid grid-cols-1 gap-1.5">
          {node.props.label && <div className="flex justify-between text-ui-sm text-muted-foreground"><span>{node.props.label}</span><span className="tabular-nums">{Math.round(pct)}%</span></div>}
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Number(node.props.value ?? 0)} aria-valuemax={max}>
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        </div>
      );
    }
    case "Choice":
      return <Choice node={node} />;
    case "Input":
      return <TextInput node={node} />;
    case "Tabs":
      return <Tabs node={node} kids={kids ?? []} />;
    case "Stepper":
      return <Stepper node={node} kids={kids ?? []} />;
    case "Button":
      return tip(
        node.props.tooltip,
        <Button
          size="sm"
          variant={node.props.variant === "primary" || !node.props.variant ? "default" : node.props.variant}
          disabled={node.props.disabled}
          className="w-fit"
          onClick={() => void runActions(node.on?.press, env)}
        >
          {node.props.icon && <IconOf name={node.props.icon} />}
          {String(node.props.label ?? "")}
        </Button>,
      );
    case "Diff":
      return <DiffBlock node={node} />;
    case "List":
      return <List node={node} />;
    case "Checkbox":
      return <Toggle node={node} kind="checkbox" />;
    case "Switch":
      return <Toggle node={node} kind="switch" />;
    case "Accordion":
      return <Accordion node={node} kids={kids ?? []} />;
    case "Timeline":
      return <Timeline node={node} />;
    case "Grid": {
      const n = node.props.columns ?? 3;
      const shown = (raw.children ?? []).map((c, i) => [c, i] as const).filter(([c]) => isVisible(c.visible, env.state));
      // Only Buttons: a keypad, exactly `columns` wide, keys filling their cells.
      if (shown.length && shown.every(([c]) => c.type === "Button")) {
        return (
          <div className="grid gap-2 [&_button]:h-10 [&_button]:w-full" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
            {shown.map(([c, i]) => <Node key={i} raw={c} />)}
          </div>
        );
      }
      return (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(max(10rem, calc((100% - ${n - 1} * 0.75rem) / ${n})), 1fr))` }}>
          {shown.map(([c, i]) => <Node key={i} raw={c} />)}
        </div>
      );
    }
    case "Log":
      return <LogBox node={node} />;
    case "FileLink":
      return (
        <span className="inline-flex w-fit max-w-full items-center gap-1.5 text-ui">
          <FileCode className="size-4 shrink-0 text-muted-foreground" />
          <OpenFile path={node.props.path} line={node.props.line} label={node.props.label} />
        </span>
      );
    case "Trace":
      return <Trace node={node} />;
    case "Chart": {
      const data = Array.isArray(node.props.data) ? (node.props.data as Record<string, unknown>[]) : [];
      return (
        <Suspense fallback={<div className="h-56 animate-pulse rounded-md bg-muted" />}>
          <UiChart type={node.props.type as "bar"} data={data} x={node.props.x} series={node.props.series} stacked={node.props.stacked} height={node.props.height} />
        </Suspense>
      );
    }
  }
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
  const shown = useMemo(() => pending.reduce((s, b) => tryApply(s, b.ops), env.state), [env.state, pending]);
  const latest = useRef(shown);
  latest.current = shown;
  const base = useRef(env.state);
  base.current = env.state;
  useEffect(() => setPending((p) => (p.some((b) => b.settled && b.settled.at !== env.state) ? p.filter((b) => !b.settled || b.settled.at === env.state) : p)), [env.state]);

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
        latest.current = tryApply(latest.current, ops);
        setPending((p) => [...p, batch]);
        setError(null);
        try {
          await env.patch(ops);
          setPending((p) => p.map((b) => (b === batch ? { ops, settled: { at: base.current } } : b)));
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
