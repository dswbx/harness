import type { SessionApi } from "@harness/api";
import { cn, Popover, PopoverAnchor, PopoverContent, ScrollArea } from "@harness/ui";
import { common, createLowlight } from "lowlight";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
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
import { useWrapCode, WRAP, WrapButton } from "./CodeBlock";
import { type FileRef, lineLabel, parseFileRefKey, refWindow } from "./fileRefs";
import { chipClick, chipOpen, chipPopover, closedChip } from "./prChip";

const lowlight = createLowlight(common);

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

/** File refs for one Session: inline code and links naming a file in its folder get a popover with the lines. Without
 * a provider (outside a Session) they stay plain. */
export function FileRefProvider({
   api,
   children,
}: {
   api: Pick<SessionApi, "readSessionFile" | "openInEditor">;
   children: ReactNode;
}) {
   const reader = useMemo(() => createFileReader(api), [api]);
   return <FileRefsContext.Provider value={reader}>{children}</FileRefsContext.Provider>;
}

export const useFileRefs = () => useContext(FileRefsContext);

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
   /** Cmd/Ctrl opens the file; else pins (or unpins) the popover. From the keyboard, focus moves into it. */
   const press = (e: { metaKey: boolean; ctrlKey: boolean }, keyboard: boolean) => {
      if (chipClick(e) === "open") return openAt(ref.start ?? undefined);
      clearTimeout(timer.current);
      const pinning = !state.pinned;
      dispatch({ type: "toggle" });
      if (keyboard && pinning)
         setTimeout(() => contentRef.current?.querySelector("button")?.focus());
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
                  press(e, false);
               }}
               onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  press(e, true);
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
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-sans text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
                  onClick={() => openAt(ref.start ?? undefined)}
               >
                  <ExternalLink className="size-3.5" aria-hidden />
                  Open
               </button>
            </div>
            <ScrollArea
               className="max-h-[min(320px,calc(var(--radix-popover-content-available-height)-36px))]"
               viewportClassName="max-h-[inherit]"
            >
               <FileLines reader={reader} base={slice} fileRef={ref} onOpen={openAt} />
            </ScrollArea>
         </PopoverContent>
      </Popover>
   );
}

/** Extensions highlight.js (lowlight `common`) does not know by name. */
const LANG_ALIASES: Record<string, string> = {
   mts: "typescript",
   cts: "typescript",
   mjs: "javascript",
   cjs: "javascript",
   jsonc: "json",
   json5: "json",
   toml: "ini",
   html: "xml",
   htm: "xml",
   vue: "xml",
   svelte: "xml",
   zsh: "bash",
   fish: "bash",
   mdx: "markdown",
   Makefile: "makefile",
};

/** The highlight language of a file, from its extension (or name); null for plain text. */
export function fileLanguage(path: string): string | null {
   const name = path.slice(path.lastIndexOf("/") + 1);
   const dot = name.lastIndexOf(".");
   const ext = dot > 0 ? name.slice(dot + 1) : name;
   const lang = LANG_ALIASES[ext] ?? ext.toLowerCase();
   return lowlight.registered(lang) ? lang : null;
}

type Hast = {
   type: string;
   value?: string;
   properties?: { className?: unknown };
   children?: Hast[];
};
/** One highlighted line: text runs with the classes of their innermost token. */
type Run = { text: string; cls?: string };

/** `lowlight` output split into lines (a token over several lines, like a block comment, is split too). */
function toLines(tree: Hast): Run[][] {
   const lines: Run[][] = [[]];
   const walk = (n: Hast, cls?: string) => {
      if (n.type === "text") {
         n.value!.split("\n").forEach((t, i) => {
            if (i) lines.push([]);
            if (t) lines[lines.length - 1]!.push({ text: t, cls });
         });
         return;
      }
      const own = n.properties?.className;
      const next = Array.isArray(own) ? own.join(" ") : cls;
      for (const c of n.children ?? []) walk(c, next);
   };
   walk(tree);
   return lines;
}

/** Lines one click on "more lines" adds. */
const STEP = 20;

/** Numbered, highlighted lines; the ref's lines marked; rows above and below show the rest of the file, `STEP` lines a
 * click. A click on a line opens the file there. Lines wrap with the code blocks' wrap choice. */
function FileLines({
   reader,
   base,
   fileRef: ref,
   onOpen,
}: {
   reader: FileReader;
   base: FileSlice;
   fileRef: FileRef;
   onOpen: (line: number) => void;
}) {
   const wrap = useWrapCode();
   const [win, setWin] = useState({ from: base.start, to: base.start + base.lines.length - 1 });
   const slice = useFileSlice(reader, base.path, win.from, win.to) ?? base;
   const { start: first, lines, total } = slice;
   const rows = useMemo(() => {
      const text = lines.join("\n");
      const lang = fileLanguage(slice.path);
      const plain = (): Run[][] => lines.map((l) => (l ? [{ text: l }] : []));
      if (!lang) return plain();
      try {
         return toLines(lowlight.highlight(lang, text) as Hast);
      } catch {
         return plain();
      }
   }, [lines, slice.path]);
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
      <div className="typeset font-mono text-[12.5px] leading-5">
         {above > 0 && (
            <MoreLines
               up
               count={above}
               onClick={() => setWin((w) => ({ ...w, from: Math.max(1, w.from - STEP) }))}
            />
         )}
         <div className={cn("py-1.5", !wrap && "overflow-x-auto")}>
            {rows.map((runs, i) => {
               const n = first + i;
               const marked = n >= from && n <= to;
               return (
                  <div
                     key={n}
                     className={cn(
                        "flex min-w-full cursor-pointer hover:bg-muted/40",
                        !wrap && "w-max",
                        marked && "bg-sky-500/10 hover:bg-sky-500/15",
                     )}
                     onClick={() => !window.getSelection()?.toString() && onOpen(n)}
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
