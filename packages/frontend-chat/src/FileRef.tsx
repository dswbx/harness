import type { SessionApi } from "@harness/api";
import { cn, Popover, PopoverAnchor, PopoverContent, ScrollArea } from "@harness/ui";
import { ChevronDown, ChevronUp, Eye } from "lucide-react";
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
import { Frame, useWrapCode, WRAP, WrapButton } from "./CodeBlock";
import { type FileRef, fileRefKey, lineLabel, parseFileRefKey, refWindow } from "./fileRefs";
import { fileLanguage, highlightLines } from "./highlight";
import { chipClick, chipOpen, chipPopover, closedChip } from "./prChip";

/** Lines of a file (`path`, relative to the Session folder): `lines` start at line `start`; `total` lines in all. */
export type FileSlice = { path: string; start: number; lines: string[]; total: number };

/** Reads files of one Session for file refs; each window is read once (null: no such text file in the folder). */
export type FileReader = {
   /** The cached result: undefined while not read yet. */
   peek(path: string, from: number, to: number): FileSlice | null | undefined;
   read(path: string, from: number, to: number): Promise<FileSlice | null>;
   open(path: string, line?: number): Promise<void>;
};

export function createFileReader(
   api: Pick<SessionApi, "readSessionFile" | "openInEditor">,
): FileReader {
   const done = new Map<string, FileSlice | null>();
   const pending = new Map<string, Promise<FileSlice | null>>();
   return {
      peek: (path, from, to) => done.get(`${from}-${to}:${path}`),
      read(path, from, to) {
         const k = `${from}-${to}:${path}`;
         if (done.has(k)) return Promise.resolve(done.get(k)!);
         let p = pending.get(k);
         if (!p) {
            p = api.readSessionFile(path, from, to).then(
               (s) => s,
               () => null,
            );
            p.then((s) => {
               done.set(k, s);
               pending.delete(k);
            });
            pending.set(k, p);
         }
         return p;
      },
      open: (path, line) => api.openInEditor(path, line),
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
   api: Pick<SessionApi, "readSessionFile" | "openInEditor">;
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

export const useFileRefs = () => useContext(FileRefsContext);
/** Shows a file in the app (the Files panel), when the provider has a viewer. */
export const useFileView = () => useContext(FileViewContext);

/** Lines `from..=to` of `path`: undefined while reading, null when there is no such file. While another window is
 * read, the last one stays. */
function useFileSlice(reader: FileReader, path: string, from: number, to: number) {
   const [slice, setSlice] = useState(() => reader.peek(path, from, to));
   useEffect(() => {
      let off = false;
      const cached = reader.peek(path, from, to);
      if (cached !== undefined) setSlice(cached);
      else reader.read(path, from, to).then((s) => !off && setSlice(s));
      return () => void (off = true);
   }, [reader, path, from, to]);
   return slice;
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
   const slice = useFileSlice(reader, ref.path, win.from, win.to);
   const [state, dispatch] = useReducer(chipPopover, closedChip);
   const [error, setError] = useState<string | null>(null);
   const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
   const anchorRef = useRef<HTMLSpanElement>(null);
   const contentRef = useRef<HTMLDivElement>(null);
   const onView = useContext(FileViewContext);
   useEffect(() => () => clearTimeout(timer.current), []);
   if (!slice) return <>{fallback}</>;

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
            setError(e instanceof Error ? e.message : String(e));
            dispatch({ type: "toggle" });
         },
      );
   };
   /** Shows the file (found path, the ref's lines) in the app; without a viewer, opens it in the editor. */
   const view = () => {
      if (!onView) return openAt(ref.start ?? undefined);
      close();
      onView({ ...ref, path: slice.path });
   };
   /** Cmd/Ctrl opens the file in the editor; else shows it in the app. */
   const press = (e: { metaKey: boolean; ctrlKey: boolean }) => {
      if (chipClick(e) === "open") return openAt(ref.start ?? undefined);
      view();
   };
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
               className={cn(
                  "cursor-pointer rounded-[0.35em] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  // On the code itself: its box would hide a decoration drawn by this span.
                  "*:underline *:decoration-sky-500/60 *:decoration-dotted *:decoration-1 *:underline-offset-[3px] hover:*:decoration-sky-500",
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
               <span className="min-w-0 truncate [direction:rtl] text-left" title={slice.path}>
                  <bdi>{slice.path}</bdi>
               </span>
               {label && <span className="shrink-0">{label}</span>}
               {error && <span className="min-w-0 truncate text-destructive">{error}</span>}
               <span className="ml-auto" />
               <WrapButton />
               <button
                  type="button"
                  title={onView ? "Show in the Files panel" : "Open in editor"}
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-sans text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                  onClick={view}
               >
                  <Eye className="size-3.5" aria-hidden />
                  View
               </button>
            </div>
            <FileLines reader={reader} base={slice} fileRef={ref} />
         </PopoverContent>
      </Popover>
   );
}

/** A ref's lines in a frame, for a panel: nothing until the file is read, or when there is no such file. */
export function FilePreview({ reader, fileRef: ref }: { reader: FileReader; fileRef: FileRef }) {
   const win = refWindow(ref);
   const slice = useFileSlice(reader, ref.path, win.from, win.to);
   if (!slice) return null;
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
   const slice = useFileSlice(reader, base.path, win.from, win.to) ?? base;
   const { start: first, lines, total } = slice;
   const rows = useMemo(() => highlightLines(fileLanguage(slice.path), lines), [lines, slice.path]);
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
            <div className={cn("py-1.5", !wrap && "overflow-x-auto")}>
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
      <button
         type="button"
         title={`Show ${Math.min(count, STEP)} more`}
         className={cn(
            "flex w-full items-center gap-1.5 px-3 py-0.5 text-left font-sans text-[11px] text-muted-foreground outline-none hover:bg-muted/40 hover:text-foreground focus-visible:bg-muted/40 focus-visible:text-foreground",
            up ? "border-b" : "border-t",
         )}
         onClick={onClick}
      >
         <Icon className="size-3.5" aria-hidden />
         {count} more {count === 1 ? "line" : "lines"}
      </button>
   );
}
