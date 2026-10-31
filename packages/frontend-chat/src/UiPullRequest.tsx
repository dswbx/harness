import { ExternalLink, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { cn } from "@harness/ui";
import type { UiNode } from "./tools";

type Pr = Extract<UiNode, { type: "PullRequest" }>["props"];
type State = Pr["state"];

const states: Record<State, { icon: typeof GitPullRequest; label: string; fg: string; pill: string }> = {
  open: { icon: GitPullRequest, label: "Open", fg: "text-emerald-600 dark:text-emerald-400", pill: "bg-emerald-600 dark:bg-emerald-500" },
  draft: { icon: GitPullRequestDraft, label: "Draft", fg: "text-muted-foreground", pill: "bg-zinc-500 dark:bg-zinc-600" },
  merged: { icon: GitMerge, label: "Merged", fg: "text-violet-600 dark:text-violet-400", pill: "bg-violet-600 dark:bg-violet-500" },
  closed: { icon: GitPullRequestClosed, label: "Closed", fg: "text-destructive", pill: "bg-red-600 dark:bg-red-500" },
};
const reviews = {
  approved: { text: "Approved", cls: "text-emerald-600 dark:text-emerald-400" },
  changes_requested: { text: "Changes requested", cls: "text-destructive" },
  required: { text: "Review required", cls: "text-amber-600 dark:text-amber-400" },
  none: { text: "No reviews", cls: "text-muted-foreground" },
} as const;

function checkStats(c: NonNullable<Pr["checks"]>) {
  const pending = c.pending ?? 0;
  const failed = c.failed ?? 0;
  const total = c.passed + pending + failed;
  const cls = failed ? "text-destructive" : pending ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400";
  return { pending, failed, total, cls };
}

function ChecksBar({ checks, className }: { checks: NonNullable<Pr["checks"]>; className: string }) {
  const { pending, failed, total } = checkStats(checks);
  if (!total) return null;
  const seg = (n: number, bg: string) => (n ? <span className={bg} style={{ width: `${(n / total) * 100}%` }} /> : null);
  return (
    <span className={cn("flex shrink-0 overflow-hidden rounded-full bg-muted", className)} role="img" aria-label="checks">
      {seg(checks.passed, "bg-emerald-500")}
      {seg(pending, "bg-amber-500")}
      {seg(failed, "bg-red-500")}
    </span>
  );
}

function Review({ review }: { review?: Pr["review"] }) {
  if (!review) return null;
  const r = reviews[review];
  return <span className={cn("ml-auto shrink-0 text-xs", r.cls)}>{r.text}</span>;
}

function Stats({ p, commits }: { p: Pr; commits?: boolean }) {
  const bits = [
    p.additions != null && <span key="a" className="font-mono text-emerald-600 dark:text-emerald-400">+{p.additions}</span>,
    p.deletions != null && <span key="d" className="font-mono text-destructive">−{p.deletions}</span>,
    p.files != null && <span key="f">{p.files} {p.files === 1 ? "file" : "files"}</span>,
    commits && p.commits != null && <span key="c">{p.commits} {p.commits === 1 ? "commit" : "commits"}</span>,
  ].filter(Boolean);
  return bits;
}

function Link({ url, label }: { url: string; label?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label="Open on GitHub"
      title="Open on GitHub"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-muted-foreground hover:text-foreground",
        label && "h-8 rounded-md border px-3 text-ui-sm hover:bg-accent",
      )}
    >
      <ExternalLink className="size-3.5" />
      {label}
    </a>
  );
}

const Dot = () => <span aria-hidden>·</span>;
function Joined({ items }: { items: React.ReactNode[] }) {
  return items.flatMap((x, i) => (i ? [<Dot key={`s${i}`} />, x] : [x]));
}

export function PullRequest({ node }: { node: Extract<UiNode, { type: "PullRequest" }> }) {
  const p = node.props;
  const st = states[p.state];
  const Icon = st.icon;
  const variant = p.variant ?? "summary";
  const checks = p.checks ? checkStats(p.checks) : null;
  const checksLabel = checks && checks.total ? `${p.checks!.passed}/${checks.total} checks` : null;
  const pill = <span className={cn("shrink-0 rounded-full px-2 py-px text-xs font-medium text-white", st.pill)}>{st.label}</span>;
  const ref = <span key="ref">{p.repo} #{p.number}</span>;
  const branch = p.head && p.base ? <span key="br" className="font-mono">{p.head} → {p.base}</span> : p.head ? <span key="br" className="font-mono">{p.head}</span> : null;

  if (variant === "compact") {
    return (
      <div className="flex min-w-0 items-center gap-2 text-ui-sm">
        <Icon className={cn("size-4 shrink-0", st.fg)} />
        <span className="min-w-0 truncate">{p.title}</span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">#{p.number}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
          {checks && checksLabel && <span className={cn("font-mono", checks.cls)}>{p.checks!.passed}/{checks.total}</span>}
          <Stats p={{ ...p, files: undefined }} />
        </span>
      </div>
    );
  }

  if (variant === "card") {
    const parts = checks
      ? [`${p.checks!.passed}/${checks.total} checks passed`, checks.pending ? `${checks.pending} running` : "", checks.failed ? `${checks.failed} failed` : ""].filter(Boolean)
      : [];
    const meta = [p.author && <span key="au">{p.author}</span>, p.updated && <span key="up">{p.updated}</span>].filter(Boolean);
    const stats = Stats({ p, commits: true }) as React.ReactNode[];
    return (
      <div className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon className={cn("size-4 shrink-0", st.fg)} />
          <span className="min-w-0 truncate">{p.repo} #{p.number}</span>
          {pill}
        </div>
        <div className="text-base font-semibold leading-snug">{p.title}</div>
        {(branch || meta.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {branch && <GitBranch className="size-3.5 shrink-0" />}
            <Joined items={[branch, ...meta].filter(Boolean)} />
          </div>
        )}
        {stats.length > 0 && <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground"><Joined items={stats} /></div>}
        {checks && checks.total > 0 && (
          <div className="flex flex-col gap-1">
            <ChecksBar checks={p.checks!} className="h-1.5 w-full" />
            <div className="flex items-center gap-2 text-xs">
              <span className={checks.cls}>{parts.join(" · ")}</span>
              <Review review={p.review} />
            </div>
          </div>
        )}
        {!(checks && checks.total > 0) && p.review && <div className="flex text-xs"><Review review={p.review} /></div>}
        {(p.labels?.length || p.url) && (
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {p.labels?.map((l) => <span key={l} className="rounded-full border px-2 py-px text-xs text-muted-foreground">{l}</span>)}
            </div>
            {p.url && <span className="ml-auto"><Link url={p.url} label="Open on GitHub" /></span>}
          </div>
        )}
        {p.note && <div className="border-t pt-2 text-xs text-muted-foreground">{p.note}</div>}
      </div>
    );
  }

  const line2 = [ref, branch, ...(Stats({ p }) as React.ReactNode[])].filter(Boolean);
  const showChecks = checks && checks.total > 0;
  const line3 = showChecks || p.note || p.review;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn("size-4 shrink-0", st.fg)} />
        <span className="min-w-0 truncate font-semibold">{p.title}</span>
        {pill}
        {p.url && <span className="ml-auto"><Link url={p.url} /></span>}
      </div>
      <div className="flex items-center gap-x-2 overflow-hidden whitespace-nowrap pl-6 text-xs text-muted-foreground"><Joined items={line2} /></div>
      {line3 && (
        <div className="flex items-center gap-2 pl-6 text-xs">
          {showChecks ? (
            <>
              <ChecksBar checks={p.checks!} className="h-1 w-[72px]" />
              <span className={checks.cls}>{checksLabel}</span>
            </>
          ) : p.note ? (
            <span className="min-w-0 truncate text-muted-foreground">{p.note}</span>
          ) : null}
          <Review review={p.review} />
        </div>
      )}
    </div>
  );
}
