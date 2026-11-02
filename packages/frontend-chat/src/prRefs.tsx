import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CircleDashed } from "lucide-react";
import {
  createPrStore, displayRef, parsePrKey, repoName, usePr, type PrInfo, type PrRefContext, type PrRefKey, type PrStore, type SessionApi,
} from "@harness/api";
import { Popover, PopoverAnchor, PopoverContent, cn } from "@harness/ui";
import { prStateVisual } from "./UiPullRequest";
import { formatRelativeTime, useNow } from "./time";

type PrRefs = { ctx: PrRefContext; store: PrStore };
const PrRefsContext = createContext<PrRefs | null>(null);

/** The Session's PR ref context and store; null outside a provider or before the context loaded. */
export const usePrRefs = () => useContext(PrRefsContext);

/** PR chips for one Session: asks the core for its repo and the known repos once, and shares one lookup store. Without
 * them (no repo, `gh` missing) refs stay text. */
export function PrRefProvider({ api, children }: { api: Pick<SessionApi, "prContext" | "lookupPrs">; children: ReactNode }) {
  const store = useMemo(() => createPrStore(api), [api]);
  const [ctx, setCtx] = useState<PrRefContext | null>(null);
  useEffect(() => {
    let off = false;
    setCtx(null);
    api.prContext().then(
      (c) => !off && setCtx({ sessionRepo: c.session_repo, knownRepos: c.known_repos }),
      () => {},
    );
    return () => void (off = true);
  }, [api]);
  const value = useMemo(() => (ctx ? { ctx, store } : null), [ctx, store]);
  return <PrRefsContext.Provider value={value}>{children}</PrRefsContext.Provider>;
}

const OPEN_DELAY = 300;
const CLOSE_DELAY = 150;
const iconCls = "mr-[3px] inline size-[13px] align-[-1px]";

/** A PR ref (`data-pr-ref` from `rehypePrRefs`): a state chip linking to the PR with a popover on hover/focus; plain
 * `raw` text when the PR does not exist or can't be looked up. */
export function PrChip({ refKey, raw }: { refKey: string; raw: string }) {
  const refs = usePrRefs();
  const key = useMemo(() => parsePrKey(refKey), [refKey]);
  if (!refs || !key) return <>{raw}</>;
  return <Chip refs={refs} prKey={key} raw={raw} />;
}

function Chip({ refs, prKey: key, raw }: { refs: PrRefs; prKey: PrRefKey; raw: string }) {
  const entry = usePr(refs.store, key);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (entry.status === "missing" || entry.status === "unavailable") return <>{raw}</>;

  const pr = entry.status === "found" ? entry.pr : null;
  const v = pr ? prStateVisual(pr.state, pr.checks) : null;
  const Icon = v?.Icon ?? CircleDashed;
  const later = (to: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(to), ms);
  };
  const show = { onMouseEnter: () => later(true, OPEN_DELAY), onMouseLeave: () => later(false, CLOSE_DELAY) };
  const a = (
    <a
      href={pr?.url ?? `https://github.com/${repoName(key.repo)}/pull/${key.number}`}
      target="_blank"
      rel="noreferrer"
      data-not-typeset
      className={cn(
        "inline rounded-[4px] bg-foreground/6 px-[3px] whitespace-nowrap text-inherit no-underline outline-none",
        v?.hoverBg ?? "hover:bg-zinc-500/20 focus-visible:bg-zinc-500/20",
      )}
      {...(pr && { ...show, onFocus: () => later(true, 0), onBlur: () => later(false, 0) })}
    >
      <Icon strokeWidth={2.2} className={cn(iconCls, v?.fg ?? "text-muted-foreground")} aria-hidden />
      {displayRef(key, refs.ctx)}
    </a>
  );
  if (!pr) return a;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>{a}</PopoverAnchor>
      <PopoverContent
        className="w-[340px] max-w-[calc(100vw-16px)] px-3 py-2.5"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        {...show}
      >
        <PrPopover pr={pr} />
      </PopoverContent>
    </Popover>
  );
}

const Dot = () => <span aria-hidden>·</span>;

/** A PR in three lines: state · repo #N · age / title / author · checks · +add −del · files. */
export function PrPopover({ pr }: { pr: PrInfo }) {
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
    </div>
  );
}
