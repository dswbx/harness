import { useEffect, useRef } from "react";
import { RotateCcw, X } from "lucide-react";
import type { SessionApi } from "@harness/api";
import { Button, Tooltip } from "@harness/ui";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

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

/** The Session's Terminal in the right panel. Stays mounted while hidden so the shell's screen is kept. */
export default function TerminalPanel({ api, active, onClose }: { api: SessionApi; active: boolean; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ term: Terminal; fit: () => void; restart: () => void } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const css = getComputedStyle(el);
    const t = new Terminal({
      fontFamily: css.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace",
      fontSize: 12,
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
    let unsubscribe: (() => void) | null = null;
    let exited = false;

    // Flow control: tell the core what xterm has drawn.
    let unacked = 0;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    const flushAck = () => {
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = null;
      if (unacked > 0) void api.terminalAck(unacked).catch(() => {});
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
        api.terminalInput(chunk).then(next, next);
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
        .terminalAttach(t.cols, t.rows, (o) => {
          if (gen !== generation) return;
          if (o instanceof Uint8Array) {
            t.write(o, () => drawn(o.length));
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
    term.current = { term: t, fit, restart };
    attach();

    const subs = [
      t.onData((d) => (exited ? restart() : send(d))),
      t.onResize(({ cols, rows }) => void api.terminalResize(cols, rows).catch(() => {})),
    ];
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    ro.observe(el);
    // Theme switches change the tokens on <html>.
    const mo = new MutationObserver(() => (t.options.theme = themeFrom(el)));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });

    return () => {
      disposed = true;
      flushAck();
      subs.forEach((s) => s.dispose());
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame);
      unsubscribe?.();
      term.current = null;
      t.dispose();
    };
  }, [api]);

  useEffect(() => {
    if (!active || !term.current) return;
    term.current.fit();
    term.current.term.focus();
  }, [active]);

  return (
    <aside className="flex h-full w-full flex-col border-l bg-background" aria-label="Terminal">
      <div className="flex items-center gap-1.5 border-b py-2 pr-2 pl-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Terminal</span>
        <Tooltip content="Restart shell" side="bottom">
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Restart shell"
            onClick={() => void api.terminalKill().then(() => term.current?.restart())}
          >
            <RotateCcw />
          </Button>
        </Tooltip>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Close terminal" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 py-1 pl-2">
        <div ref={host} className="h-full w-full" />
      </div>
    </aside>
  );
}
