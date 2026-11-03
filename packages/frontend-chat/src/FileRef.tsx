import type { SessionApi } from "@harness/api";
import { cn, Popover, PopoverAnchor, PopoverContent, ScrollArea } from "@harness/ui";
import { common, createLowlight } from "lowlight";
import { ExternalLink } from "lucide-react";
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
import { type FileRef, fileRefKey, lineLabel, parseFileRefKey, refWindow } from "./fileRefs";
import { chipClick, chipOpen, chipPopover, closedChip } from "./prChip";

const lowlight = createLowlight(common);

/** Lines of a file: `lines` start at line `start`; `total` lines in all. */
export type FileSlice = { start: number; lines: string[]; total: number };

/** Reads files of one Session for file refs; each window is read once (null: no such text file in the folder). */
export type FileReader = {
   /** The cached result: undefined while not read yet. */
   peek(ref: FileRef): FileSlice | null | undefined;
   read(ref: FileRef): Promise<FileSlice | null>;
   open(path: string, line?: number): Promise<void>;
};

export function createFileReader(
   api: Pick<SessionApi, "readSessionFile" | "openInEditor">,
): FileReader {
   const done = new Map<string, FileSlice | null>();
   const pending = new Map<string, Promise<FileSlice | null>>();
   const key = (ref: FileRef) => {
      const w = refWindow(ref);
      return `${w.from}-${w.to}:${ref.path}`;
   };
   return {
      peek: (ref) => done.get(key(ref)),
      read(ref) {
         const k = key(ref);
         if (done.has(k)) return Promise.resolve(done.get(k)!);
         let p = pending.get(k);
         if (!p) {
            const w = refWindow(ref);
            p = api.readSessionFile(ref.path, w.from, w.to).then(
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

/** The slice of a ref's file: undefined while reading, null when there is none. */
function useFileSlice(reader: FileReader, ref: FileRef) {
   const k = fileRefKey(ref);
   const [slice, setSlice] = useState(() => reader.peek(ref));
   // biome-ignore lint/correctness/useExhaustiveDependencies: `k` stands for `ref`.
   useEffect(() => {
      let off = false;
      setSlice(reader.peek(ref));
      reader.read(ref).then((s) => !off && setSlice(s));
      return () => void (off = true);
   }, [reader, k]);
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
   const slice = useFileSlice(reader, ref);
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
      reader.open(ref.path, line).then(
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
               <span className="min-w-0 truncate [direction:rtl] text-left" title={ref.path}>
                  <bdi>{ref.path}</bdi>
               </span>
               {label && <span className="shrink-0">{label}</span>}
               {error && <span className="min-w-0 truncate text-destructive">{error}</span>}
               <button
                  type="button"
                  className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-sans text-xs outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
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
               <FileLines slice={slice} fileRef={ref} onOpen={openAt} />
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
const toReact = (n: Hast, key: number): ReactNode => {
   if (n.type === "text") return n.value;
   const kids = (n.children ?? []).map(toReact);
   if (n.type !== "element") return kids;
   const cls = n.properties?.className;
   return (
      <span key={key} className={Array.isArray(cls) ? cls.join(" ") : undefined}>
         {kids}
      </span>
   );
};

const LINE = 20;
const PAD = 6;

/** Numbered, highlighted lines; the ref's lines marked. A click opens the file at the clicked line. */
function FileLines({
   slice,
   fileRef: ref,
   onOpen,
}: {
   slice: FileSlice;
   fileRef: FileRef;
   onOpen: (line: number) => void;
}) {
   const { start: first, lines } = slice;
   const code = useMemo(() => {
      const text = lines.join("\n");
      const lang = fileLanguage(ref.path);
      if (!lang) return text;
      try {
         return toReact(lowlight.highlight(lang, text) as Hast, 0);
      } catch {
         return text;
      }
   }, [lines, ref.path]);
   if (!lines.length)
      return (
         <div className="px-3 py-2 text-xs text-muted-foreground">
            The file has {slice.total} {slice.total === 1 ? "line" : "lines"}.
         </div>
      );
   const last = first + lines.length - 1;
   const from = ref.start === null ? null : Math.max(ref.start, first);
   const to = ref.start === null ? null : Math.min(ref.end ?? ref.start, last);
   return (
      <div
         className="typeset relative flex cursor-pointer font-mono text-[12.5px] leading-5"
         onClick={(e) => {
            if (window.getSelection()?.toString()) return;
            const y = e.clientY - e.currentTarget.getBoundingClientRect().top - PAD;
            onOpen(Math.min(last, Math.max(first, first + Math.floor(y / LINE))));
         }}
      >
         {from !== null && to !== null && from <= to && (
            <div
               aria-hidden
               className="pointer-events-none absolute inset-x-0 bg-sky-500/10 shadow-[inset_2px_0_0_var(--color-sky-500)]"
               style={{ top: PAD + (from - first) * LINE, height: (to - from + 1) * LINE }}
            />
         )}
         <div
            aria-hidden
            className="shrink-0 select-none py-1.5 pr-3 pl-3 text-right text-muted-foreground/60 tabular-nums"
         >
            {lines.map((_, i) => (
               // biome-ignore lint/suspicious/noArrayIndexKey: line numbers.
               <div key={i}>{first + i}</div>
            ))}
         </div>
         <pre
            data-not-typeset
            className={cn(
               "m-0 min-w-0 flex-1 overflow-x-auto bg-transparent py-1.5 pr-3 text-foreground",
               "font-[inherit] text-[length:inherit] leading-[inherit]",
            )}
         >
            <code>{code}</code>
            {lines[lines.length - 1] === "" && " "}
         </pre>
      </div>
   );
}
