import type { FileScope, SessionApi } from "@harness/api";
import { errText, isCommandError } from "@harness/api";
import {
   Badge,
   Button,
   cn,
   Popover,
   PopoverAnchor,
   PopoverContent,
   ScrollArea,
   Tooltip,
} from "@harness/ui";
import { ChevronDown, ChevronUp, Eye, Lock, ShieldAlert } from "lucide-react";
import {
   createContext,
   type ReactNode,
   useContext,
   useEffect,
   useMemo,
   useReducer,
   useRef,
   useState,
} from "react";
import { Frame, useWrapCode, WRAP, WrapButton } from "../markdown/CodeBlock";
import { highlightLines, languageOf } from "../markdown/highlight";
import { chipClick, chipOpen, chipPopover, closedChip } from "../prRefs/prChip";
import { type FileRef, fileRefKey, lineLabel, parseFileRefKey, refWindow } from "./fileRefs";

/** Lines of a file: `lines` start at line `start`; `total` lines in all. `path`: relative to the Session folder when
 * `scope` is `inside`, else `~/…` or absolute. */
export type FileSlice = {
   path: string;
   start: number;
   lines: string[];
   total: number;
   scope: FileScope;
};

/** A read: the lines; `locked` while the file can hold secrets and is not allowed (`reason` says why; `path`: the real
 * file an approval unlocks, `~/…` or absolute, which a symlink makes differ from the path read); `none`: no such text
 * file. */
export type FileResult =
   | { kind: "ok"; slice: FileSlice }
   | { kind: "locked"; reason: string; path: string }
   | { kind: "none" };

type FileApi = Pick<
   SessionApi,
   "readSessionFile" | "openInEditor" | "approveSessionFile" | "revokeSessionFile"
>;

/** Reads files of one Session for file refs; each window is read once, until access to a file changes. */
export type FileReader = {
   /** The cached result: undefined while not read yet. */
   peek(path: string, from: number, to: number): FileResult | undefined;
   read(path: string, from: number, to: number): Promise<FileResult>;
   open(path: string, line?: number): Promise<void>;
   /** Lets the Session read a locked file (pass the result's real `path`); all reads are done again. */
   allow(path: string): Promise<void>;
   /** Takes `allow` back; all reads are done again. */
   revoke(path: string): Promise<void>;
   /** Calls `fn` when the cached reads were dropped (after `allow` or `revoke`). */
   subscribe(fn: () => void): () => void;
};

export function createFileReader(api: FileApi): FileReader {
   const done = new Map<string, FileResult>();
   const pending = new Map<string, Promise<FileResult>>();
   const listeners = new Set<() => void>();
   /** Bumped when the cache is dropped: reads started before do not land in it. */
   let generation = 0;
   const drop = () => {
      generation++;
      done.clear();
      pending.clear();
      for (const f of listeners) f();
   };
   return {
      peek: (path, from, to) => done.get(`${from}-${to}:${path}`),
      read(path, from, to) {
         const k = `${from}-${to}:${path}`;
         const hit = done.get(k);
         if (hit) return Promise.resolve(hit);
         let p = pending.get(k);
         if (!p) {
            const gen = generation;
            p = api.readSessionFile(path, from, to).then(
               (s): FileResult => ({ kind: "ok", slice: s }),
               (e): FileResult =>
                  isCommandError(e, "needs_approval")
                     ? { kind: "locked", reason: e.message, path: e.path ?? path }
                     : { kind: "none" },
            );
            p.then((r) => {
               if (gen !== generation) return;
               done.set(k, r);
               pending.delete(k);
            });
            pending.set(k, p);
         }
         return p;
      },
      open: (path, line) => api.openInEditor(path, line),
      allow: (path) => api.approveSessionFile(path).then(drop),
      revoke: (path) => api.revokeSessionFile(path).then(drop),
      subscribe(fn) {
         listeners.add(fn);
         return () => void listeners.delete(fn);
      },
   };
}

const FileRefsContext = createContext<FileReader | null>(null);
/** Shows a file ref in the app (the Files panel); absent: a click opens the editor. */
const FileViewContext = createContext<((ref: FileRef) => void) | null>(null);

/** File refs for one Session: inline code and links naming a file in its folder get a popover with the lines. Without
 * a provider (outside a Session) they stay plain. `onView`: a click shows the file in the app (Cmd/Ctrl-click: editor). */
export function FileRefProvider({
   api,
   onView,
   children,
}: {
   api: FileApi;
   onView?: (ref: FileRef) => void;
   children: ReactNode;
}) {
   const reader = useMemo(() => createFileReader(api), [api]);
   return (
      <FileRefsContext.Provider value={reader}>
         <FileViewContext.Provider value={onView ?? null}>{children}</FileViewContext.Provider>
      </FileRefsContext.Provider>
   );
}

/** Only the viewer: for a host that creates the reader above where it knows how to show a file. */
export function FileViewProvider({
   onView,
   children,
}: {
   onView: (ref: FileRef) => void;
   children: ReactNode;
}) {
   return <FileViewContext.Provider value={onView}>{children}</FileViewContext.Provider>;
}

export const useFileRefs = () => useContext(FileRefsContext);
/** Shows a file in the app (the Files panel), when the provider has a viewer. */
export const useFileView = () => useContext(FileViewContext);

/** Lines `from..=to` of `path`: undefined while reading. While another window is read (or the same one again after
 * access changed), the last result stays. */
export function useFileResult(reader: FileReader, path: string, from: number, to: number) {
   const [result, setResult] = useState(() => reader.peek(path, from, to));
   const [generation, bump] = useReducer((n: number) => n + 1, 0);
   useEffect(() => reader.subscribe(bump), [reader]);
   // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` only triggers a new read.
   useEffect(() => {
      let off = false;
      const cached = reader.peek(path, from, to);
      if (cached !== undefined) setResult(cached);
      else reader.read(path, from, to).then((r) => !off && setResult(r));
      return () => void (off = true);
   }, [reader, path, from, to, generation]);
   return result;
}

/** Inline code or a link marked by `rehypeFileRefs` (`refKey`): once the file is known to exist, a dotted link with a
 * popover of its lines; otherwise `children` as they are. */
export function FileRefLink({
   refKey,
   children,
   fallback,
}: {
   refKey: string;
   children: ReactNode;
   /** Shown instead of `children` while there is no file (default: `children`). */
   fallback?: ReactNode;
}) {
   const reader = useFileRefs();
   const ref = useMemo(() => parseFileRefKey(refKey), [refKey]);
   if (!reader || !ref) return <>{fallback ?? children}</>;
   return (
      <FileRefView reader={reader} fileRef={ref} fallback={fallback ?? children}>
         {children}
      </FileRefView>
   );
}

const OPEN_DELAY = 300;
/** Time to move the mouse from the ref into its popover. */
const CLOSE_DELAY = 300;

function FileRefView({
   reader,
   fileRef: ref,
   children,
   fallback,
}: {
   reader: FileReader;
   fileRef: FileRef;
   children: ReactNode;
   fallback: ReactNode;
}) {
   const win = refWindow(ref);
   const result = useFileResult(reader, ref.path, win.from, win.to);
   const [state, dispatch] = useReducer(chipPopover, closedChip);
   const [error, setError] = useState<string | null>(null);
   const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
   const anchorRef = useRef<HTMLSpanElement>(null);
   const contentRef = useRef<HTMLDivElement>(null);
   const onView = useContext(FileViewContext);
   useEffect(() => () => clearTimeout(timer.current), []);
   if (!result || result.kind === "none") return <>{fallback}</>;
   const slice = result.kind === "ok" ? result.slice : null;

   const open = chipOpen(state, false);
   const close = () => {
      clearTimeout(timer.current);
      dispatch({ type: "close" });
   };
   const hover = (on: boolean, ms: number) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => dispatch({ type: "hover", on }), ms);
   };
   const openAt = (line?: number) => {
      close();
      reader.open(slice?.path ?? ref.path, line).then(
         () => setError(null),
         (e) => {
            setError(errText(e));
            dispatch({ type: "toggle" });
         },
      );
   };
   /** Shows the file (found path, the ref's lines) in the app; without a viewer, opens it in the editor. */
   const view = () => {
      if (!onView) return openAt(ref.start ?? undefined);
      close();
      onView({ ...ref, path: slice?.path ?? ref.path });
   };
   /** Cmd/Ctrl opens the file in the editor; else shows it in the app. A locked file only toggles its popover. */
   const press = (e: { metaKey: boolean; ctrlKey: boolean }) => {
      if (!slice) return dispatch({ type: "toggle" });
      if (chipClick(e) === "open") return openAt(ref.start ?? undefined);
      view();
   };
   const access = (change: (path: string) => Promise<void>, path: string) =>
      change(path).then(
         () => setError(null),
         (e) => setError(errText(e)),
      );
   const label = lineLabel(ref);
   return (
      <Popover open={open} onOpenChange={(o) => !o && close()}>
         <PopoverAnchor asChild>
            <span
               ref={anchorRef}
               role="button"
               tabIndex={0}
               aria-haspopup="dialog"
               aria-expanded={open}
               aria-label={slice ? undefined : `${ref.path} (locked)`}
               className={cn(
                  // `select-text`: part of the message text (a copy keeps the path), though a `role="button"`.
                  "cursor-pointer select-text rounded-[0.35em] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  // On the code itself: its box would hide a decoration drawn by this span. Locked: amber.
                  "*:underline *:decoration-dotted *:decoration-1 *:underline-offset-[3px]",
                  slice
                     ? "*:decoration-sky-500/60 hover:*:decoration-sky-500"
                     : "*:decoration-amber-500/70 hover:*:decoration-amber-500",
               )}
               onClick={(e) => {
                  e.preventDefault();
                  press(e);
               }}
               onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  press(e);
               }}
               onMouseEnter={() => hover(true, OPEN_DELAY)}
               onMouseLeave={() => hover(false, CLOSE_DELAY)}
               onFocus={() => hover(true, 0)}
               onBlur={(e) =>
                  !contentRef.current?.contains(e.relatedTarget as Node | null) && hover(false, 0)
               }
            >
               {children}
            </span>
         </PopoverAnchor>
         <PopoverContent
            ref={contentRef}
            role="dialog"
            aria-label={ref.path}
            side="bottom"
            align="start"
            className="flex w-[560px] max-w-[calc(100vw-16px)] flex-col bg-card p-0"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) =>
               anchorRef.current?.contains(e.target as Node) && e.preventDefault()
            }
            onEscapeKeyDown={() => {
               if (contentRef.current?.contains(document.activeElement)) anchorRef.current?.focus();
            }}
            onMouseEnter={() => hover(true, 0)}
            onMouseLeave={() => hover(false, CLOSE_DELAY)}
         >
            <div className="flex min-w-0 items-center gap-2 border-b py-1 pr-1 pl-3 font-mono text-[11px] text-muted-foreground">
               {!slice && <Lock className="size-3 shrink-0 text-amber-500" aria-hidden />}
               <Tooltip content={slice?.path ?? ref.path}>
                  <span className="min-w-0 truncate [direction:rtl] text-left">
                     <bdi>{slice?.path ?? ref.path}</bdi>
                  </span>
               </Tooltip>
               {label && <span className="shrink-0">{label}</span>}
               {!slice ? (
                  <ScopeBadge kind="locked" />
               ) : slice.scope !== "inside" ? (
                  <ScopeBadge kind={slice.scope} />
               ) : null}
               {error && <span className="min-w-0 truncate text-destructive">{error}</span>}
               <span className="ml-auto" />
               {slice?.scope === "allowed" && (
                  <Tooltip content="Lock this file again in this Session">
                     <button
                        type="button"
                        className={HEADER_BUTTON}
                        onClick={() => access(reader.revoke, slice.path)}
                     >
                        Remove access
                     </button>
                  </Tooltip>
               )}
               {slice && (
                  <>
                     <WrapButton />
                     <Tooltip content={onView ? "Show in the Files panel" : "Open in editor"}>
                        <button type="button" className={HEADER_BUTTON} onClick={view}>
                           <Eye className="size-3.5" aria-hidden />
                           View
                        </button>
                     </Tooltip>
                  </>
               )}
            </div>
            {slice ? (
               <FileLines reader={reader} base={slice} fileRef={ref} />
            ) : (
               result.kind === "locked" && (
                  <LockedNotice
                     reason={result.reason}
                     path={result.path}
                     written={ref.path}
                     onAllow={() => access(reader.allow, result.path)}
                  />
               )
            )}
         </PopoverContent>
      </Popover>
   );
}

const HEADER_BUTTON =
   "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-sans text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground";

/** Where a file outside the Session folder stands: locked, allowed, or outside (nothing secret). */
export function ScopeBadge({ kind }: { kind: "locked" | "outside" | "allowed" }) {
   const [text, variant] =
      kind === "locked"
         ? (["Locked", "warning"] as const)
         : kind === "allowed"
           ? (["Allowed", "success"] as const)
           : (["Outside folder", "secondary"] as const);
   return (
      <Badge variant={variant} className="h-4 shrink-0 px-1.5 py-0 font-sans text-[10px]">
         {text}
      </Badge>
   );
}

/** Asks to show a file outside the Session folder that can hold secrets. `reason`: why (`in the hidden folder ~/.aws`).
 * `path`: the real file "Allow" unlocks, named when it is not `written` (the path asked for, e.g. a symlink). A failed
 * `onAllow` shows its error here. */
export function LockedNotice({
   reason,
   path,
   written,
   onAllow,
   className,
}: {
   reason: string;
   path: string;
   written: string;
   onAllow: () => Promise<unknown>;
   className?: string;
}) {
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState<string | null>(null);
   return (
      // A container: in a narrow place (the Files panel beside its tree) the icon goes above the text.
      <div className={cn("@container font-sans", className)}>
         <div className="flex flex-col gap-2 p-3 @[16rem]:flex-row @[16rem]:gap-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden />
            <div className="flex min-w-0 flex-col gap-1.5 break-words text-xs text-muted-foreground">
               <p className="text-sm font-medium text-foreground">This file can hold secrets</p>
               {reason && <p>It is {reason}.</p>}
               {path !== written && (
                  <p>
                     Allows <span className="font-mono text-foreground">{path}</span>
                  </p>
               )}
               <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                     size="sm"
                     className="h-auto min-h-7 max-w-full whitespace-normal py-1"
                     disabled={busy}
                     onClick={() => {
                        setBusy(true);
                        setError(null);
                        onAllow()
                           .catch((e: unknown) => setError(errText(e)))
                           .finally(() => setBusy(false));
                     }}
                  >
                     Allow and show
                  </Button>
               </div>
               {error && (
                  <p role="alert" className="text-destructive">
                     Could not allow it: {error}
                  </p>
               )}
               <p className="text-[11px]">
                  Allowed for this file in this Session only. You can remove it later.
               </p>
            </div>
         </div>
      </div>
   );
}

/** A ref's lines in a frame, for a panel: `fallback` until the file is read, or when there is no such file; the allow
 * prompt when it is locked. */
export function FilePreview({
   reader,
   fileRef: ref,
   fallback = null,
}: {
   reader: FileReader;
   fileRef: FileRef;
   fallback?: ReactNode;
}) {
   const win = refWindow(ref);
   const result = useFileResult(reader, ref.path, win.from, win.to);
   if (result?.kind === "locked")
      return (
         <div className="rounded-md border border-amber-500/40 border-dashed">
            <LockedNotice
               reason={result.reason}
               path={result.path}
               written={ref.path}
               onAllow={() => reader.allow(result.path)}
            />
         </div>
      );
   if (result?.kind !== "ok") return <>{fallback}</>;
   const slice = result.slice;
   return (
      <Frame label={lineLabel(ref) ?? "Start of file"} action={<WrapButton />}>
         <FileLines key={fileRefKey(ref)} reader={reader} base={slice} fileRef={ref} />
      </Frame>
   );
}

/** Lines one click on "more lines" adds. */
const STEP = 20;

/** Numbered, highlighted lines; the ref's lines marked; rows above and below show the rest of the file, `STEP` lines a
 * click; those rows stay put while the lines scroll. Lines wrap with the code blocks' wrap choice. */
function FileLines({
   reader,
   base,
   fileRef: ref,
}: {
   reader: FileReader;
   base: FileSlice;
   fileRef: FileRef;
}) {
   const wrap = useWrapCode();
   const [win, setWin] = useState({ from: base.start, to: base.start + base.lines.length - 1 });
   const more = useFileResult(reader, base.path, win.from, win.to);
   const slice = more?.kind === "ok" ? more.slice : base;
   const { start: first, lines, total } = slice;
   const rows = useMemo(() => highlightLines(languageOf(slice.path), lines), [lines, slice.path]);
   if (!lines.length)
      return (
         <div className="px-3 py-2 text-xs text-muted-foreground">
            The file has {total} {total === 1 ? "line" : "lines"}.
         </div>
      );
   const last = first + lines.length - 1;
   const from = ref.start ?? Number.POSITIVE_INFINITY;
   const to = ref.end ?? ref.start ?? 0;
   const above = first - 1;
   const below = total - last;
   const digits = `${String(win.to).length + 1}ch`;
   return (
      <div className="typeset flex min-h-0 flex-col font-mono text-[12.5px] leading-5">
         {above > 0 && (
            <MoreLines
               up
               count={above}
               onClick={() => setWin((w) => ({ ...w, from: Math.max(1, w.from - STEP) }))}
            />
         )}
         <ScrollArea
            // The popover's room, less its header and the "more lines" rows.
            className="max-h-[min(320px,calc(var(--radix-popover-content-available-height)-80px))]"
            viewportClassName="max-h-[inherit]"
         >
            <div className={cn("select-text py-1.5", !wrap && "overflow-x-auto")}>
               {rows.map((runs, i) => {
                  const n = first + i;
                  const marked = n >= from && n <= to;
                  return (
                     <div
                        key={n}
                        className={cn(
                           "flex min-w-full",
                           !wrap && "w-max",
                           marked && "bg-sky-500/10",
                        )}
                     >
                        <span
                           aria-hidden
                           style={{ minWidth: digits }}
                           className={cn(
                              "sticky left-0 shrink-0 select-none bg-card pr-3 pl-3 text-right text-muted-foreground/60 tabular-nums",
                              marked &&
                                 "bg-[color-mix(in_oklab,var(--color-sky-500)_10%,var(--color-card))] text-muted-foreground shadow-[inset_2px_0_0_var(--color-sky-500)]",
                           )}
                        >
                           {n}
                        </span>
                        <span
                           className={cn(
                              "min-w-0 flex-1 bg-transparent p-0 pr-3 text-foreground",
                              wrap ? WRAP : "whitespace-pre",
                           )}
                        >
                           {runs.map((r, j) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: runs of one line.
                              <span key={j} className={r.cls}>
                                 {r.text}
                              </span>
                           ))}
                           {!runs.length && " "}
                        </span>
                     </div>
                  );
               })}
            </div>
         </ScrollArea>
         {below > 0 && (
            <MoreLines
               count={below}
               onClick={() => setWin((w) => ({ ...w, to: Math.min(total, w.to + STEP) }))}
            />
         )}
      </div>
   );
}

/** "↑ 249 more lines": shows `STEP` more lines on that side. */
function MoreLines({ up, count, onClick }: { up?: boolean; count: number; onClick: () => void }) {
   const Icon = up ? ChevronUp : ChevronDown;
   return (
      <Tooltip content={`Show ${Math.min(count, STEP)} more`}>
         <button
            type="button"
            className={cn(
               "flex w-full items-center gap-1.5 px-3 py-0.5 text-left font-sans text-[11px] text-muted-foreground outline-none hover:bg-muted/40 hover:text-foreground focus-visible:bg-muted/40 focus-visible:text-foreground",
               up ? "border-b" : "border-t",
            )}
            onClick={onClick}
         >
            <Icon className="size-3.5" aria-hidden />
            {count} more {count === 1 ? "line" : "lines"}
         </button>
      </Tooltip>
   );
}
