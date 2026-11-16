import { errText, onStorageFailure } from "@harness/api";
import { AlertTriangle, CircleCheck, X } from "lucide-react";
import {
   createContext,
   type ReactNode,
   useCallback,
   useContext,
   useEffect,
   useMemo,
   useRef,
   useState,
} from "react";

type Toast = {
   id: number;
   text: string;
   sticky?: boolean;
   action?: NoticeAction;
   /** An announcement (not an error): `title` over `text`, replaced or withdrawn by `key`. */
   info?: { key: string; title: string };
};
export type NoticeAction = { label: string; run: () => void };
type Notify = (text: string, action?: NoticeAction) => void;
type Report = (what: string, err: unknown) => void;
/** Something happened elsewhere (a Session finished): shown a while, replaced by the next with the same `key`. */
export type Announcement = { key: string; title: string; text: string; action?: NoticeAction };
type Announce = { announce: (a: Announcement) => void; withdraw: (key: string) => void };

const Ctx = createContext<Report>((what, err) => console.error(what, err));
const NotifyCtx = createContext<Notify>((text) => console.warn(text));
const AnnounceCtx = createContext<Announce>({ announce: () => {}, withdraw: () => {} });

/** Announces something that happened out of view; `withdraw(key)` once it is seen. */
export const useAnnounce = () => useContext(AnnounceCtx);

/** Tells the user something that matters and stays until dismissed (a reset settings file), with an optional action. */
export const useNotify = () => useContext(NotifyCtx);

/** Reports a failed command to the user: `report("Archive failed", err)`. */
export const useReportError = () => useContext(Ctx);

const MAX = 4;
const TTL_MS = 10_000;
const INFO_TTL_MS = 8_000;

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
         setToasts((t) => {
            const all = [...t.filter((x) => x.text !== text), { id, text }];
            // Only errors are capped: a notice stays until dismissed.
            const errors = all.filter((x) => !x.sticky).slice(-MAX);
            return all.filter((x) => x.sticky || errors.includes(x));
         });
         setTimeout(() => dismiss(id), TTL_MS);
      },
      [dismiss],
   );
   // A failed localStorage write (a full quota, mostly): drafts and settings would silently not persist.
   useEffect(
      () =>
         onStorageFailure((f) =>
            report(
               "Could not save locally",
               new Error(
                  f.quota
                     ? "browser storage is full, so drafts and settings may not be kept"
                     : "browser storage is not writable",
               ),
            ),
         ),
      [report],
   );
   const notify = useCallback<Notify>((text, action) => {
      const id = ++n.current;
      setToasts((t) => [...t, { id, text, action, sticky: true }]);
   }, []);
   const withdraw = useCallback(
      (key: string) => setToasts((t) => t.filter((x) => x.info?.key !== key)),
      [],
   );
   const announce = useCallback(
      (a: Announcement) => {
         const id = ++n.current;
         // At most MAX announcements; a newer one for the same key replaces the old.
         setToasts((t) => {
            const rest = t.filter((x) => x.info?.key !== a.key);
            const infos = rest.filter((x) => x.info);
            const drop = new Set(infos.slice(0, Math.max(0, infos.length - MAX + 1)));
            return [
               ...rest.filter((x) => !drop.has(x)),
               { id, text: a.text, action: a.action, info: { key: a.key, title: a.title } },
            ];
         });
         setTimeout(() => dismiss(id), INFO_TTL_MS);
      },
      [dismiss],
   );
   const announcer = useMemo(() => ({ announce, withdraw }), [announce, withdraw]);
   const value = useMemo(() => report, [report]);
   const close = (t: Toast) => (
      <button
         aria-label="Dismiss"
         className="relative rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
         onClick={() => dismiss(t.id)}
      >
         <X className="size-4" />
      </button>
   );
   // An announcement is one target: a click anywhere runs its action (the X still only dismisses).
   const notice = (t: Toast, info: NonNullable<Toast["info"]>) => (
      <div
         key={t.id}
         role="status"
         className="pointer-events-auto relative flex items-start gap-2 rounded-lg border bg-popover p-3 text-sm shadow-lg hover:bg-accent motion-safe:animate-toast-in"
      >
         {t.action && (
            <button
               aria-label={`${t.action.label} ${info.title}`}
               className="absolute inset-0 rounded-lg"
               onClick={() => {
                  t.action?.run();
                  dismiss(t.id);
               }}
            />
         )}
         <CircleCheck className="pointer-events-none mt-0.5 size-4 shrink-0 text-muted-foreground" />
         <div className="pointer-events-none min-w-0 flex-1">
            <p className="truncate font-medium">{info.title}</p>
            <p className="text-xs text-muted-foreground">{t.text}</p>
         </div>
         {close(t)}
      </div>
   );
   const error = (t: Toast) => (
      <div
         key={t.id}
         role="alert"
         className="pointer-events-auto flex items-start gap-2 rounded-lg border border-destructive/40 bg-popover p-3 text-sm shadow-lg"
      >
         <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
         <p className="max-h-40 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words">
            {t.text}
         </p>
         {t.action && (
            <button
               className="shrink-0 rounded border px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground"
               onClick={t.action.run}
            >
               {t.action.label}
            </button>
         )}
         {close(t)}
      </div>
   );
   return (
      <Ctx.Provider value={value}>
         <NotifyCtx.Provider value={notify}>
            <AnnounceCtx.Provider value={announcer}>{children}</AnnounceCtx.Provider>
         </NotifyCtx.Provider>
         {/* Announcements top right (below the header), where the eye is; errors bottom right. */}
         <div className="pointer-events-none fixed right-3 top-14 z-[100] flex w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
            {toasts.map((t) => t.info && notice(t, t.info))}
         </div>
         <div className="pointer-events-none fixed bottom-3 right-3 z-[100] flex w-96 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
            {toasts.map((t) => !t.info && error(t))}
         </div>
      </Ctx.Provider>
   );
}
