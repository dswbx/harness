import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, RotateCcw, X } from "lucide-react";
import type { SessionApi, TerminalInfo } from "@harness/api";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip, cn } from "@harness/ui";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { PanelHeader } from "./PanelHeader";

/** Acknowledge drawn output in batches of this size, or after `ACK_DELAY` (core flow control, ADR 0017). */
const ACK_BATCH = 64 * 1024;
const ACK_DELAY = 100;

/** Any CSS color (oklch etc.) as `rgb()`, which xterm can parse. */
function toRgb(color: string): string {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return color;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a! / 255).toFixed(3)})`;
}

function themeFrom(el: HTMLElement): ITheme {
  const css = getComputedStyle(el);
  const v = (name: string) => toRgb(css.getPropertyValue(name).trim() || "black");
  return {
    background: v("--background"),
    foreground: v("--foreground"),
    cursor: v("--foreground"),
    cursorAccent: v("--background"),
    selectionBackground: toRgb(`color-mix(in oklab, ${css.getPropertyValue("--primary").trim() || "gray"} 30%, transparent)`),
  };
}

/** Font from the host's Appearance (`--terminal-font`, else `--font-mono`; `--terminal-font-size`). */
function fontFrom(el: HTMLElement): { fontFamily: string; fontSize: number } {
  const css = getComputedStyle(el);
  const family = css.getPropertyValue("--terminal-font").trim() || css.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
  const size = parseFloat(css.getPropertyValue("--terminal-font-size"));
  return { fontFamily: family, fontSize: Number.isFinite(size) && size > 0 ? size : 12 };
}

type Handle = { fit: () => void; restart: () => void; focus: () => void };

/** One tab's xterm. Stays mounted while hidden so the shell's screen is kept. */
function TerminalView({ api, id, visible, onHandle, onActivity, onShortcut }: {
  api: SessionApi;
  id: number;
  visible: boolean;
  onHandle: (id: number, h: Handle | null) => void;
  /** Output arrived while the tab is not shown. */
  onActivity: (id: number) => void;
  onShortcut: (key: "t" | "w" | number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const onShortcutRef = useRef(onShortcut);
  onShortcutRef.current = onShortcut;

  useEffect(() => {
    const el = host.current!;
    // xterm measures the font once per change: start on the system mono until a web font has loaded (`restyle`).
    const initial = fontFrom(el);
    const t = new Terminal({
      fontSize: initial.fontSize,
      fontFamily: document.fonts.check(`${initial.fontSize}px ${initial.fontFamily}`) ? initial.fontFamily : "ui-monospace, monospace",
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      minimumContrastRatio: 3,
      macOptionIsMeta: true,
      theme: themeFrom(el),
    });
    const fitAddon = new FitAddon();
    t.loadAddon(fitAddon);
    t.open(el);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose()); // falls back to the DOM renderer
      t.loadAddon(webgl);
    } catch {
      // No WebGL2: the DOM renderer is slower but works.
    }
    const fit = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fitAddon.fit();
    };
    fit();

    let disposed = false;
    /** Replays being written: xterm's answers to their queries are dropped. */
    let replaying = 0;
    let unsubscribe: (() => void) | null = null;
    let exited = false;

    // Flow control: tell the core what xterm has drawn.
    let unacked = 0;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    const flushAck = () => {
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = null;
      if (unacked > 0) void api.terminalAck(id, unacked).catch(() => {});
      unacked = 0;
    };
    const drawn = (n: number) => {
      unacked += n;
      if (unacked >= ACK_BATCH) flushAck();
      else ackTimer ??= setTimeout(flushAck, ACK_DELAY);
    };

    // Input in order: IPC calls can overtake each other, so one is in flight at a time and keys typed meanwhile go together.
    let pending = "";
    let sending = false;
    const send = (data: string) => {
      pending += data;
      if (sending) return;
      sending = true;
      const next = (): void => {
        const chunk = pending;
        pending = "";
        if (!chunk || disposed) {
          sending = false;
          return;
        }
        api.terminalInput(id, chunk).then(next, next);
      };
      next();
    };

    // Each attach has a generation, so a killed shell's late exit does not touch the new one.
    let generation = 0;
    const attach = () => {
      const gen = ++generation;
      unsubscribe?.();
      unsubscribe = null;
      exited = false;
      api
        .terminalAttach(id, t.cols, t.rows, (o) => {
          if (gen !== generation) return;
          if (o instanceof Uint8Array) {
            if (!visibleRef.current) onActivity(id);
            t.write(o, () => drawn(o.length));
          } else if ("replay" in o) {
            // Old output holds the shell's old queries (cursor position, modes); xterm's answers
            // would reach the shell as typed text, so they are dropped until the replay is drawn.
            if (!o.replay.length) return;
            replaying++;
            t.write(o.replay, () => replaying--);
          } else {
            exited = true;
            unsubscribe = null;
            t.write(`\r\n\x1b[2m[Process exited${o.exit != null ? ` with code ${o.exit}` : ""}. Press any key to restart.]\x1b[0m\r\n`);
          }
        })
        .then(
          (off) => (disposed || gen !== generation ? off() : (unsubscribe = off)),
          (e) => t.write(`\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`),
        );
    };
    const restart = () => {
      t.reset();
      attach();
    };
    handle.current = { fit, restart, focus: () => t.focus() };
    onHandle(id, handle.current);
    attach();

    // Tab shortcuts while this Terminal has focus (Cmd+T new, Cmd+W close, Cmd+1..9 switch).
    t.attachCustomKeyEventHandler((e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return true;
      const key = /^[1-9]$/.test(e.key) ? Number(e.key) : e.key === "t" || e.key === "w" ? e.key : null;
      if (key === null) return true;
      if (e.type === "keydown") {
        e.preventDefault();
        onShortcutRef.current(key);
      }
      return false;
    });

    const subs = [
      t.onData((d) => (replaying ? undefined : exited ? restart() : send(d))),
      t.onResize(({ cols, rows }) => void api.terminalResize(id, cols, rows).catch(() => {})),
    ];
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    ro.observe(el);
    // Appearance changes set tokens on <html>. A web font is measured only once loaded, so wait for it.
    const restyle = () => {
      t.options.theme = themeFrom(el);
      const font = fontFrom(el);
      if (font.fontFamily === t.options.fontFamily && font.fontSize === t.options.fontSize) return;
      void document.fonts.load(`${font.fontSize}px ${font.fontFamily}`).catch(() => {}).then(() => {
        if (disposed) return;
        t.options.fontFamily = font.fontFamily;
        t.options.fontSize = font.fontSize;
        fit();
      });
    };
    restyle();
    const mo = new MutationObserver(restyle);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });

    return () => {
      disposed = true;
      flushAck();
      subs.forEach((s) => s.dispose());
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame);
      unsubscribe?.();
      onHandle(id, null);
      handle.current = null;
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id]);

  useEffect(() => {
    if (!visible || !handle.current) return;
    handle.current.fit();
    handle.current.focus();
  }, [visible]);

  return (
    <div className={cn("absolute inset-0 py-1 pl-2", !visible && "pointer-events-none invisible")}>
      <div ref={host} className="h-full w-full" />
    </div>
  );
}

const sameTabs = (a: TerminalInfo[], b: TerminalInfo[]) => JSON.stringify(a) === JSON.stringify(b);
/** Below this panel width the tabs collapse into one picker. */
const NARROW = 320;
const TITLES_POLL = 2000;

/** The Session's Terminals as tabs in a panel (ADR 0017). Every tab keeps its xterm mounted, so screens survive switching. */
export default function TerminalPanel({ api, active }: { api: SessionApi; active: boolean }) {
  const [tabs, setTabs] = useState<TerminalInfo[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [unread, setUnread] = useState<Set<number>>(new Set());
  const [narrow, setNarrow] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<number, Handle>());
  const cur = tabs.find((t) => t.id === sel)?.id ?? tabs[0]?.id ?? null;

  const refresh = useCallback(
    () => api.terminalList().then((next) => setTabs((prev) => (sameTabs(prev, next) ? prev : next)), () => {}),
    [api],
  );
  useEffect(() => {
    void refresh();
    let off: (() => void) | null = null;
    let gone = false;
    void api.terminalsChanged(() => void refresh()).then((u) => (gone ? u() : (off = u)));
    return () => {
      gone = true;
      off?.();
    };
  }, [api, refresh]);
  // Titles and the busy dot change without an event.
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), TITLES_POLL);
    return () => clearInterval(timer);
  }, [active, refresh]);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth < NARROW));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Viewing a tab clears its dot.
  useEffect(() => {
    if (active && cur != null) setUnread((u) => (u.has(cur) ? new Set([...u].filter((x) => x !== cur)) : u));
  }, [active, cur]);

  const open = () => void api.terminalOpen().then((id) => refresh().then(() => setSel(id)), () => {});
  const close = (id: number) => {
    if (id === cur) {
      const i = tabs.findIndex((t) => t.id === id);
      setSel((tabs[i + 1] ?? tabs[i - 1])?.id ?? null);
    }
    // The core makes a fresh tab when the last one closes.
    void api.terminalClose(id).then(refresh, () => {});
  };
  const onHandle = useCallback((id: number, h: Handle | null) => void (h ? handles.current.set(id, h) : handles.current.delete(id)), []);
  const onActivity = useCallback((id: number) => setUnread((u) => (u.has(id) ? u : new Set(u).add(id))), []);
  const shortcutRef = useRef<(key: "t" | "w" | number) => void>(() => {});
  shortcutRef.current = (key) => {
    if (key === "t") open();
    else if (key === "w") cur != null && close(cur);
    else if (tabs[key - 1]) setSel(tabs[key - 1]!.id);
  };
  const onShortcut = useCallback((key: "t" | "w" | number) => shortcutRef.current(key), []);

  const index = tabs.findIndex((t) => t.id === cur);
  const dots = (t: TerminalInfo) => (
    <>
      {t.busy && <span className="size-1.5 shrink-0 rounded-full bg-green-500" aria-label="Running" />}
      {unread.has(t.id) && t.id !== cur && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New output" />}
    </>
  );

  return (
    <>
      <PanelHeader>
        {narrow ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 min-w-0 gap-1 px-2 text-xs data-[state=open]:bg-accent" aria-label="Terminals">
                {tabs.some((t) => t.id !== cur && unread.has(t.id)) && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
                <span className="truncate">{tabs[index] ? `${tabs[index].title}${tabs[index].busy ? ` ${index + 1}` : ""}/${tabs.length}` : "Terminal"}</span>
                <ChevronDown className="shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {tabs.map((t) => (
                <DropdownMenuItem key={t.id} onSelect={() => setSel(t.id)}>
                  <span className="truncate">{t.title}</span>
                  {dots(t)}
                  {t.id === cur && <Check className="ml-auto" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => cur != null && close(cur)}><X /> Close terminal</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div role="tablist" aria-label="Terminals" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={cn("group flex h-7 shrink-0 items-center rounded-md text-xs", t.id === cur ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50")}
              >
                <button role="tab" aria-selected={t.id === cur} className="flex h-full max-w-32 items-center gap-1.5 pr-1 pl-2" onClick={() => setSel(t.id)}>
                  {dots(t)}
                  <span className="truncate">{t.title}</span>
                </button>
                <button
                  aria-label={`Close ${t.title}`}
                  className={cn("mr-1 flex size-4 items-center justify-center rounded hover:bg-foreground/10", t.id !== cur && "opacity-0 group-hover:opacity-100")}
                  onClick={() => close(t.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <Tooltip content="New terminal (Cmd+T)" side="bottom">
          <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="New terminal" onClick={open}>
            <Plus />
          </Button>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip content="Restart shell" side="bottom">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Restart shell"
            disabled={cur == null}
            onClick={() => cur != null && void api.terminalKill(cur).then(() => handles.current.get(cur)?.restart())}
          >
            <RotateCcw />
          </Button>
        </Tooltip>
      </PanelHeader>
      <div ref={body} className="relative min-h-0 flex-1">
        {tabs.map((t) => (
          <TerminalView key={t.id} api={api} id={t.id} visible={active && t.id === cur} onHandle={onHandle} onActivity={onActivity} onShortcut={onShortcut} />
        ))}
      </div>
    </>
  );
}
