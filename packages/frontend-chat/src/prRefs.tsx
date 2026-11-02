import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Check, CircleDashed, Copy, ExternalLink } from "lucide-react";
import {
  createPrSearch, createPrStore, displayRef, openExternalUrl, parsePrKey, prKey, repoName, usePr, type PrInfo, type PrRefContext, type PrRefKey, type PrSearch, type PrStore,
  type SessionApi,
} from "@harness/api";
import { Popover, PopoverAnchor, PopoverContent, cn } from "@harness/ui";
import { chipClick, chipOpen, chipPopover, closedChip } from "./prChip";
import { prStateVisual } from "./UiPullRequest";
import { formatRelativeTime, useNow } from "./time";

/** `me`: the `gh` user (their PRs come first in the `#` menu). */
export type PrRefs = { ctx: PrRefContext; store: PrStore; search: PrSearch; me: string | null };
const PrRefsContext = createContext<PrRefs | null>(null);

/** The Session's PR ref context and store; null outside a provider or before the context loaded. */
export const usePrRefs = () => useContext(PrRefsContext);

/** PR chips for one Session: asks the core for its repo and the known repos once, and shares one lookup store. Without
 * them (no repo, `gh` missing) refs stay text. */
export function PrRefProvider({ api, children }: { api: Pick<SessionApi, "prContext" | "lookupPrs" | "searchPrs">; children: ReactNode }) {
  const store = useMemo(() => createPrStore(api), [api]);
  const search = useMemo(() => createPrSearch(api, store), [api, store]);
  const [ctx, setCtx] = useState<{ ctx: PrRefContext; me: string | null } | null>(null);
  useEffect(() => {
    let off = false;
    setCtx(null);
    api.prContext().then(
      (c) => !off && setCtx({ ctx: { sessionRepo: c.session_repo, knownRepos: c.known_repos }, me: c.me }),
      () => {},
    );
    return () => void (off = true);
  }, [api]);
  const value = useMemo(() => (ctx ? { ...ctx, store, search } : null), [ctx, store, search]);
  return <PrRefsContext.Provider value={value}>{children}</PrRefsContext.Provider>;
}

const OPEN_DELAY = 300;
/** Time to move the mouse from the chip into its popover. */
const CLOSE_DELAY = 300;
const iconCls = "mr-[3px] inline size-[13px] align-[-1px]";

/** A PR ref (`data-pr-ref` from `rehypePrRefs`): a state chip linking to the PR with a popover on hover/focus; plain
 * `raw` text when the PR does not exist or can't be looked up. */
export function PrChip({ refKey, raw }: { refKey: string; raw: string }) {
  const refs = usePrRefs();
  const key = useMemo(() => parsePrKey(refKey), [refKey]);
  if (!refs || !key) return <>{raw}</>;
  return <PrChipView refs={refs} prKey={key} raw={raw} text={displayRef(key, refs.ctx)} />;
}

/** Registers an Esc handler with the prompt editor (before its other Esc handling); `handle` returns true when it closed something. */
export type RegisterEscape = (handle: () => boolean) => () => void;

/**
 * The chip of one PR: state icon + `text`, popover on hover. Click (or Enter/Space on a focused message chip) pins the
 * popover; Cmd/Ctrl+click opens the PR on GitHub. In messages a link (popover also on focus). In the prompt (`prompt`)
 * a plain span on a slightly lighter bg; `active` (caret next to it) shows the hover bg and opens the popover above;
 * `onEscape` lets Esc in the editor close the popover first; a click puts the caret on the clicked side (`onCaret`).
 */
export function PrChipView({ refs, prKey: key, raw, text, prompt }: {
  refs: PrRefs;
  prKey: PrRefKey;
  raw: string;
  text: string;
  prompt?: { active: boolean; onEscape?: RegisterEscape; onCaret?: (side: "before" | "after") => void };
}) {
  const entry = usePr(refs.store, key);
  const [state, dispatch] = useReducer(chipPopover, closedChip);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Closes it now; a pending hover must not open it again. */
  const close = () => {
    clearTimeout(timer.current);
    dispatch({ type: "close" });
  };
  const chipRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const active = !!prompt?.active;
  const open = chipOpen(state, active);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!active) dispatch({ type: "inactive" });
  }, [active]);
  const onEscape = prompt?.onEscape;
  useEffect(
    () =>
      onEscape?.(() => {
        if (!openRef.current) return false;
        clearTimeout(timer.current);
        dispatch({ type: "close" });
        return true;
      }),
    [onEscape],
  );
  if (entry.status === "missing" || entry.status === "unavailable") return <>{raw}</>;

  const pr = entry.status === "found" ? entry.pr : null;
  const url = pr?.url ?? `https://github.com/${repoName(key.repo)}/pull/${key.number}`;
  const v = pr ? prStateVisual(pr.state, pr.checks) : null;
  const Icon = v?.Icon ?? CircleDashed;
  const hover = (on: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => dispatch({ type: "hover", on }), ms);
  };
  const show = { onMouseEnter: () => hover(true, OPEN_DELAY), onMouseLeave: () => hover(false, CLOSE_DELAY) };
  /** Pins (or unpins) the popover; from the keyboard, focus moves into it so its buttons can be reached. */
  const toggle = (keyboard: boolean) => {
    clearTimeout(timer.current);
    const pinning = !state.pinned;
    dispatch({ type: "toggle" });
    if (keyboard && pinning) setTimeout(() => contentRef.current?.querySelector("button")?.focus());
  };
  const onClick = (e: React.MouseEvent) => {
    // A message chip is a link: never let the browser (or Tauri's opener) follow it.
    if (!prompt) e.preventDefault();
    if (chipClick(e) === "open" || (!pr && !prompt)) {
      e.preventDefault();
      close();
      openExternalUrl(url);
      return;
    }
    if (prompt?.onCaret) {
      const r = e.currentTarget.getBoundingClientRect();
      prompt.onCaret(e.clientX < r.left + r.width / 2 ? "before" : "after");
    }
    // Enter on a link fires a click with detail 0.
    if (pr) toggle(!prompt && e.detail === 0);
  };
  const cls = cn(
    "inline rounded-[4px] px-[3px] whitespace-nowrap",
    prompt ? "cursor-pointer bg-foreground/7" : "bg-foreground/6 text-inherit no-underline outline-none",
    v?.hoverBg ?? "hover:bg-zinc-500/20 focus-visible:bg-zinc-500/20",
    (active || open) && (v?.activeBg ?? "bg-zinc-500/20"),
  );
  const body = (
    <>
      <Icon strokeWidth={2.2} className={cn(iconCls, v?.fg ?? "text-muted-foreground")} aria-hidden />
      {text}
    </>
  );
  const chip = prompt ? (
    <span ref={chipRef} className={cls} onClick={onClick} {...(pr && show)}>{body}</span>
  ) : (
    <a
      ref={chipRef as React.Ref<HTMLAnchorElement>}
      href={url}
      target="_blank"
      rel="noreferrer"
      data-not-typeset
      className={cls}
      onClick={onClick}
      {...(pr && {
        ...show,
        "aria-haspopup": "dialog" as const,
        "aria-expanded": open,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key !== " ") return;
          e.preventDefault();
          toggle(true);
        },
        onFocus: () => hover(true, 0),
        // Not when focus moves into the popover (its buttons).
        onBlur: (e: React.FocusEvent) => !contentRef.current?.contains(e.relatedTarget as Node | null) && hover(false, 0),
      })}
    >
      {body}
    </a>
  );
  if (!pr) return chip;
  return (
    <Popover open={open} onOpenChange={(o) => !o && close()}>
      <PopoverAnchor asChild>{chip}</PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        role="dialog"
        aria-label={`${repoName(pr.repo)}#${pr.number}`}
        side={prompt ? "top" : "bottom"}
        align="center"
        className="w-[340px] max-w-[calc(100vw-16px)] px-3 py-2.5"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // The chip toggles itself; a click on it is not "outside".
        onInteractOutside={(e) => chipRef.current?.contains(e.target as Node) && e.preventDefault()}
        onEscapeKeyDown={(e) => {
          // In the editor, its Esc handler closes the popover (before menus etc.); this one would run first.
          if (prompt && (document.activeElement as HTMLElement | null)?.isContentEditable) return e.preventDefault();
          if (contentRef.current?.contains(document.activeElement)) chipRef.current?.focus();
        }}
        // Entering the popover keeps it open at once (the chip's close is pending).
        onMouseEnter={() => hover(true, 0)}
        onMouseLeave={show.onMouseLeave}
      >
        <PrPopover pr={pr} onOpen={() => (close(), openExternalUrl(url))} />
      </PopoverContent>
    </Popover>
  );
}

const Dot = () => <span aria-hidden>·</span>;

/** A PR in three lines: state · repo #N · age / title / author · checks · +add −del · files; then its actions. */
export function PrPopover({ pr, onOpen }: { pr: PrInfo; onOpen: () => void }) {
  const now = useNow();
  const v = prStateVisual(pr.state, pr.checks);
  const failing = pr.checks === "failing";
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <v.Icon strokeWidth={2.2} className={cn("size-3.5 shrink-0", v.fg)} aria-hidden />
        <span className={cn("shrink-0 font-medium", v.fg)}>{v.label}</span>
        <Dot />
        <span className="min-w-0 truncate">{repoName(pr.repo)} #{pr.number}</span>
        <Dot />
        <span className="shrink-0">{formatRelativeTime(Date.parse(pr.updated_at), now)}</span>
      </div>
      <div className="line-clamp-2 text-ui-sm font-semibold leading-snug text-popover-foreground">{pr.title}</div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        <span>{pr.author}</span>
        {pr.checks_total > 0 && (
          <>
            <Dot />
            <span className={cn(failing && "text-red-600 dark:text-red-400")}>checks {pr.checks_passed}/{pr.checks_total}</span>
          </>
        )}
        <Dot />
        <span className="font-mono">
          <span className="text-emerald-600 dark:text-emerald-400">+{pr.additions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{pr.deletions}</span>
        </span>
        <Dot />
        <span>{pr.changed_files} {pr.changed_files === 1 ? "file" : "files"}</span>
      </div>
      <div className="-mx-1.5 mt-0.5 flex items-center gap-0.5">
        <Action icon={ExternalLink} label="Open on GitHub" onClick={onOpen} />
        <CopyAction text={prKey(pr)} />
      </div>
    </div>
  );
}

/** A small muted button of the popover's action row. Mouse down keeps focus where it is (the prompt caret). */
function Action({ icon: Icon, label, onClick }: { icon: typeof Copy; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}

/** Copies `owner/repo#N`; shows "Copied" for a moment. */
function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () =>
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }, () => {});
  return <Action icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy"} onClick={() => void copy()} />;
}
