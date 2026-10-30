import { createContext, useContext, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, ImageOff, Info, XCircle } from "lucide-react";
import { getAt, type StatePatchOp } from "@harness/api";
import { Button, Input, cn } from "@harness/ui";
import { Dialog, DialogContent, DialogTitle } from "@harness/ui";
import { Markdown } from "./Markdown";
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
  /** Cache key prefix for read images (e.g. the Session id). */
  scope?: string;
};
const Env = createContext<UiEnv | null>(null);
const useEnv = () => useContext(Env)!;
const imageCache = new Map<string, Promise<string>>();

/** `{ $state }` and `{ $template }` read from `state`; other values stay as they are. */
export function resolveValue(v: unknown, state: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$state === "string") return getAt(state, o.$state);
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

/** Runs `actions`: state actions become one patch (applied in order), then messages are sent. */
export async function runActions(actions: UiAction | UiAction[] | undefined, env: Pick<UiEnv, "state" | "patch" | "send">) {
  const list = actions == null ? [] : Array.isArray(actions) ? actions : [actions];
  const ops: StatePatchOp[] = [];
  const texts: string[] = [];
  for (const a of list) {
    if (a.action === "setState") ops.push({ op: "replace", path: a.params.statePath, value: resolveValue(a.params.value, env.state) });
    else if (a.action === "pushState") {
      if (!Array.isArray(getAt(env.state, a.params.statePath))) ops.push({ op: "add", path: a.params.statePath, value: [] });
      ops.push({ op: "add", path: `${a.params.statePath}/-`, value: resolveValue(a.params.value, env.state) });
    } else if (a.action === "removeState") ops.push({ op: "remove", path: a.params.index == null ? a.params.statePath : `${a.params.statePath}/${a.params.index}` });
    else if (a.action === "sendMessage") texts.push(String(resolveValue(a.params.text, env.state) ?? ""));
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
      <div className={cn("flex items-center justify-center gap-2 bg-muted text-xs text-muted-foreground", className)}>
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
            {img.caption && <figcaption className="mt-2 text-center text-xs text-muted-foreground">{img.caption}</figcaption>}
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
      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-2 py-0.5 text-xs tabular-nums">{label}</span>
    </>
  );
}

function ImageView({ img }: { img: Img }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <figure>
      <Picture img={img} className="max-h-80 min-h-24 w-full overflow-hidden rounded-md border" onOpen={() => setOpen(0)} />
      {img.caption && <figcaption className="mt-1 break-words text-xs text-muted-foreground">{img.caption}</figcaption>}
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
      {img.caption && <figcaption className="mt-1 break-words text-xs text-muted-foreground">{img.caption}</figcaption>}
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
    return <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">Choice options need distinct values.</div>;
  }
  const right = graded && picked === answer;
  return (
    <div className="grid gap-2">
    <div role="radiogroup" className={cn("grid gap-1.5", node.props.columns === 2 && "sm:grid-cols-2")}>
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
              "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:cursor-default",
              verdict === "right" ? "border-emerald-500/60 bg-emerald-500/10" : verdict === "wrong" ? "border-destructive/60 bg-destructive/10" : on ? "border-primary bg-primary/10 font-medium" : !graded && "hover:bg-accent",
            )}
          >
            <span className={cn("grid size-4 shrink-0 place-items-center rounded-full border border-muted-foreground/50", on && "border-primary")}>
              {on && <span className="size-2 rounded-full bg-primary" />}
            </span>
            <span className="min-w-0 flex-1">{o.label}</span>
            {verdict === "right" && <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-label="correct" />}
            {verdict === "wrong" && <XCircle className="size-4 shrink-0 text-destructive" aria-label="wrong" />}
          </button>
        );
      })}
    </div>
    {graded && node.props.explanation && (
      <div role="note" className={cn("rounded-md border px-3 py-2", right ? tones.success.box : tones.error.box)}>
        <div className={cn("mb-1 text-xs font-medium", right ? tones.success.fg : tones.error.fg)}>{right ? "Correct" : "Not quite"}</div>
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
    <div className="grid gap-3">
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b">
        {node.props.tabs.map((t, j) => (
          <button
            key={j}
            role="tab"
            aria-selected={i === j}
            onClick={() => setI(j)}
            className={cn("-mb-px shrink-0 border-b-2 px-3 py-1.5 text-sm", i === j ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
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
    <div className="grid gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
    <label className="grid gap-1.5">
      {node.props.label && <span className="text-xs text-muted-foreground">{node.props.label}</span>}
      <Input
        value={text}
        placeholder={node.props.placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit(false)}
        onKeyDown={(e) => e.key === "Enter" && void commit(true)}
      />
    </label>
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
            c.type === "Badge" || c.type === "Button" ? (
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
      const Icon = t.icon;
      return (
        <div className={cn("min-w-0 space-y-2 rounded-lg border p-3", t.box)}>
          {node.props?.title && (
            <div className="flex items-center gap-2 font-medium">
              {Icon && <Icon className={cn("size-4 shrink-0", t.fg)} />}
              {node.props.title}
            </div>
          )}
          {kids}
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
              <dt className="text-muted-foreground">{it.label}</dt>
              <dd className="min-w-0 break-words">{it.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "Table":
      return (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-left">
              <tr>{(node.props.columns ?? []).map((c, i) => <th key={i} className="px-2 py-1.5 font-medium">{c}</th>)}</tr>
            </thead>
            <tbody>
              {(node.props.rows ?? []).map((r, i) => (
                <tr key={i} className="border-t">
                  {r.map((c, j) => <td key={j} className="px-2 py-1.5 align-top">{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "Badge": {
      const t = tones[node.props.tone ?? "neutral"];
      return <span className={cn("inline-flex w-fit rounded-full border px-2 py-0.5 text-xs font-medium", t.box, t.fg)}>{String(node.props.text ?? "")}</span>;
    }
    case "Code":
      return <Markdown>{"```" + (node.props.language ?? "") + "\n" + String(node.props.code ?? "") + "\n```"}</Markdown>;
    case "Image":
      return <ImageView img={node.props} />;
    case "Carousel":
      return (node.props.images ?? []).length ? <Carousel images={node.props.images} /> : null;
    case "Stat": {
      const t = tones[node.props.tone ?? "neutral"];
      return (
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{node.props.label}</div>
          <div className={cn("text-2xl font-semibold tabular-nums", node.props.tone && node.props.tone !== "neutral" && t.fg)}>{String(node.props.value ?? "")}</div>
          {node.props.hint && <div className="text-xs text-muted-foreground">{node.props.hint}</div>}
        </div>
      );
    }
    case "Progress": {
      const max = Number(node.props.max ?? 100) || 100;
      const pct = Math.max(0, Math.min(100, (Number(node.props.value ?? 0) / max) * 100));
      return (
        <div className="grid gap-1.5">
          {node.props.label && <div className="flex justify-between text-xs text-muted-foreground"><span>{node.props.label}</span><span className="tabular-nums">{Math.round(pct)}%</span></div>}
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
      return (
        <Button
          size="sm"
          variant={node.props.variant === "secondary" ? "secondary" : node.props.variant === "ghost" ? "ghost" : "default"}
          disabled={node.props.disabled}
          className="w-fit"
          onClick={() => void runActions(node.on?.press, env)}
        >
          {String(node.props.label ?? "")}
        </Button>
      );
  }
}

/** A `render_ui` tree, bound to the Session State in `env`. */
export function RenderUi({ root, env }: { root: RawNode; env: UiEnv }) {
  return (
    <Env.Provider value={env}>
      <div className="min-w-0 text-sm">
        <Node raw={root} />
      </div>
    </Env.Provider>
  );
}
