import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";

export const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

type Toast = { id: number; text: string };
type Report = (what: string, err: unknown) => void;

const Ctx = createContext<Report>((what, err) => console.error(what, err));

/** Reports a failed command to the user: `report("Archive failed", err)`. */
export const useReportError = () => useContext(Ctx);

const MAX = 4;
const TTL_MS = 10_000;

/** App-level alert area (bottom right) for failed commands that have no inline spot. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const n = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const report = useCallback<Report>(
    (what, err) => {
      console.error(what, err);
      const id = ++n.current;
      const text = `${what}: ${errText(err)}`;
      // Identical consecutive errors collapse into one toast.
      setToasts((t) => [...t.filter((x) => x.text !== text), { id, text }].slice(-MAX));
      setTimeout(() => dismiss(id), TTL_MS);
    },
    [dismiss],
  );
  const value = useMemo(() => report, [report]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-3 right-3 z-[100] flex w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="alert" className="pointer-events-auto flex items-start gap-2 rounded-lg border border-destructive/40 bg-popover p-3 text-sm shadow-lg">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="max-h-40 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words">{t.text}</p>
            <button aria-label="Dismiss" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={() => dismiss(t.id)}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
