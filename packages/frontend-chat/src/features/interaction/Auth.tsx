import type { AttachmentInput, SessionApi } from "@harness/api";
import { errText } from "@harness/api";
import { Button, Card, CardContent, CardHeader, CardTitle, Spinner } from "@harness/ui";
import { CircleCheck, KeyRound } from "lucide-react";
import { useContext, useEffect, useSyncExternalStore } from "react";
import type { Item } from "../../state/reducer";
import { getPendingMessages, pendingActions } from "../prompt/pendingMessages";
import { composerKey } from "../review/reviewComments";
import { OpenTerminal } from "../terminal/openTerminal";

type Auth = Extract<Item, { type: "auth" }>;
type Method = Auth["methods"][number];

/**
 * What a card is doing, kept outside React so it survives the row unmounting (scrolling, switching
 * Sessions). Not persisted: a reload shows the result from the log (`item.finished`) only.
 * `seen`: the `AuthFinished` the card had when the sign-in started.
 */
type Flow =
   | { phase: "starting"; methodId: string }
   | { phase: "waiting"; methodId: string; terminalId: number; seen: string | null }
   | { phase: "done"; resent: boolean }
   | { phase: "external" }
   | { phase: "error"; text: string };

const flows = new Map<string, Flow>();
const listeners = new Set<() => void>();
function setFlow(key: string, f: Flow | null) {
   if (f) flows.set(key, f);
   else flows.delete(key);
   for (const l of listeners) l();
}
const subscribe = (cb: () => void) => {
   listeners.add(cb);
   return () => void listeners.delete(cb);
};
/** @internal for tests */
export const resetAuthFlows = () => flows.clear();

/**
 * Sends the refused message again: a message that failed to send waits in the prompt box (its Retry), a
 * Turn the Agent refused mid-way has its message on the card. True when something was sent.
 */
function resend(api: SessionApi, item: Auth, thread: string | null): boolean {
   const key = composerKey(api.sessionId, thread);
   const retry = pendingActions(key);
   if (retry && getPendingMessages(key).some((p) => p.status === "failed")) {
      retry.retry();
      return true;
   }
   if (!item.resend) return false;
   const files = item.resend.attachments.map(
      (a): AttachmentInput => ({ type: "path", path: a.path }),
   );
   api.prompt(item.resend.text, files, thread).catch(() => {});
   return true;
}

/**
 * Shown when the Agent needs the user to sign in. A terminal method runs in a Terminal tab of the
 * Session (shown in the Terminal panel); when it signs in, the core restarts the Agent and the card
 * sends the refused message again.
 */
export function AuthCard({
   item,
   api,
   threadId,
   side,
}: {
   item: Auth;
   api: SessionApi;
   threadId: string;
   side: boolean;
}) {
   const key = `${api.sessionId}:${item.id}`;
   const flow = useSyncExternalStore(subscribe, () => flows.get(key) ?? null);
   const openTerminal = useContext(OpenTerminal);
   const thread = side ? threadId : null;
   const finished = item.finished ?? null;

   // The sign-in this card started ended (`AuthFinished`).
   useEffect(() => {
      const f = flows.get(key);
      if (f?.phase !== "waiting" || !finished || finished.id === f.seen) return;
      if (finished.outcome === "signed_in")
         setFlow(key, { phase: "done", resent: resend(api, item, thread) });
      else setFlow(key, null);
   }, [key, finished, api, item, thread]);

   const run = async (m: Method) => {
      setFlow(key, { phase: "starting", methodId: m.id });
      try {
         if (m.kind !== "terminal") {
            await api.authenticate(m.id);
            setFlow(key, { phase: "done", resent: resend(api, item, thread) });
         } else if (!openTerminal) {
            // No Terminal panel here (Quick overlay).
            await api.openAuthTerminal(m.id);
            setFlow(key, { phase: "external" });
         } else {
            const terminalId = await api.authInTerminal(m.id, thread);
            setFlow(key, {
               phase: "waiting",
               methodId: m.id,
               terminalId,
               seen: finished?.id ?? null,
            });
            openTerminal(terminalId);
         }
      } catch (e) {
         setFlow(key, { phase: "error", text: errText(e) });
      }
   };
   const cancel = (terminalId: number) => {
      setFlow(key, null);
      void api.terminalClose(terminalId).catch(() => {});
   };
   const openInTerminalApp = async (terminalId: number, methodId: string) => {
      setFlow(key, { phase: "external" });
      void api.terminalClose(terminalId).catch(() => {});
      await api
         .openAuthTerminal(methodId)
         .catch((e) => setFlow(key, { phase: "error", text: errText(e) }));
   };

   const waiting = flow?.phase === "waiting" ? flow : null;
   const done =
      flow?.phase === "done" || (!flow && finished?.outcome === "signed_in")
         ? {
              // After a reload the card no longer knows whether the message went again.
              next:
                 flow?.phase !== "done"
                    ? ""
                    : flow.resent
                      ? " Resent your message."
                      : " Send your message again.",
              name: finished?.methodName ?? null,
           }
         : null;
   const failed = !flow && finished?.outcome === "failed" ? finished : null;
   const busy = flow?.phase === "starting" ? flow.methodId : null;

   return (
      <Card className={done ? "border-emerald-500/40" : "border-amber-500/40"}>
         <CardHeader>
            {done ? (
               <CircleCheck className="size-4 text-emerald-600" />
            ) : (
               <KeyRound className="size-4 text-amber-500" />
            )}
            <CardTitle>
               {done
                  ? "Signed in"
                  : item.agentName
                    ? `Sign in to ${item.agentName}`
                    : "Sign in to continue"}
            </CardTitle>
         </CardHeader>
         <CardContent className="space-y-3 text-sm">
            {done ? (
               <p role="status" className="text-emerald-600">
                  {done.name ? `Signed in with ${done.name}.` : "Signed in."}
                  {done.next}
               </p>
            ) : waiting ? (
               <>
                  <p className="flex items-center gap-2" role="status">
                     <Spinner className="size-3.5" />
                     Waiting for sign-in…
                  </p>
                  <p className="text-xs text-muted-foreground">
                     Finish signing in in the Terminal panel. Your message is sent again after that.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                     <Button size="sm" variant="outline" onClick={() => cancel(waiting.terminalId)}>
                        Cancel
                     </Button>
                     <Button
                        size="sm"
                        variant="link"
                        className="px-0 text-xs"
                        onClick={() => void openInTerminalApp(waiting.terminalId, waiting.methodId)}
                     >
                        Open in Terminal.app instead
                     </Button>
                  </div>
               </>
            ) : (
               <>
                  <p>{item.message}</p>
                  {item.methods.length === 0 ? (
                     <p className="text-muted-foreground">
                        Sign in to this Agent outside the Harness (e.g. run its CLI login), then
                        send your message again.
                     </p>
                  ) : (
                     <ul className="space-y-2">
                        {item.methods.map((m) => (
                           <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <Button
                                 size="sm"
                                 variant={failed?.methodId === m.id ? "default" : "outline"}
                                 disabled={busy !== null}
                                 onClick={() => void run(m)}
                              >
                                 {busy === m.id && <Spinner className="size-3.5" />}
                                 {failed?.methodId === m.id ? "Try again" : m.name}
                              </Button>
                              {m.description && (
                                 <span className="text-xs text-muted-foreground">
                                    {m.description}
                                 </span>
                              )}
                           </li>
                        ))}
                     </ul>
                  )}
                  {failed && (
                     <p role="alert" className="text-xs text-destructive">
                        Sign-in with {failed.methodName} did not finish
                        {failed.exitCode != null ? ` (exit code ${failed.exitCode})` : ""}.
                     </p>
                  )}
                  {flow?.phase === "external" && (
                     <p role="status" className="text-xs text-muted-foreground">
                        Terminal opened. Finish signing in there, then send your message again.
                     </p>
                  )}
                  {flow?.phase === "error" && (
                     <p role="alert" className="text-xs text-destructive">
                        {flow.text}
                     </p>
                  )}
               </>
            )}
         </CardContent>
      </Card>
   );
}
