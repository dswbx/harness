import { type SessionApi, useSessionEvents } from "@harness/api";
import { useMemo, useState } from "react";
import { reduce, reduceBatch } from "../features/renderUi/chatReducer";
import { initialState } from "../state/reducer";

/**
 * The chat state of the Session (cached across Session switches, ADR 0029), and `inert`: true
 * while it shows a cached fold the load has not confirmed whole yet. That fold can be behind the
 * log (a Turn that ended while away still runs, a permission already answered), so it must not take
 * clicks. A first load (no cache, `loaded` false) is not inert: the prompt box takes input while
 * the log loads. A failed load ends it too: a View that never takes input is worse.
 */
export function useChatLog(api: SessionApi) {
   // One token per `api`: a load of an earlier `api` (or of this one shown before) never counts.
   const token = useMemo(() => ({ api }), [api]);
   const [settled, setSettled] = useState<object | null>(null);
   const state = useSessionEvents(api, reduce, initialState, reduceBatch, {
      cache: true,
      onLoad: (l) => {
         if ("failed" in l || l.next >= l.end) setSettled(token);
      },
   });
   return { state, inert: state.loaded && settled !== token };
}
