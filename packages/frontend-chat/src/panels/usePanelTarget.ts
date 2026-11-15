import { useEffect, useRef, useState } from "react";
import type { PanelSelf } from "./contract";

/** Targets already applied. Keyed by the target object, so a panel that remounts does not apply one twice. */
const applied = new WeakSet<object>();

/** Applies each new `self.target` once (a new `seq`, even with an equal value). Run in the panel's model or body. */
export function usePanelTarget<T>(self: PanelSelf<T>, apply: (t: T) => void) {
   const latest = useRef(apply);
   latest.current = apply;
   const target = self.target;
   useEffect(() => {
      if (!target || applied.has(target)) return;
      applied.add(target);
      latest.current(target.value);
   }, [target]);
}

/**
 * A body's latest target as state, for a body that hands it to a component as a prop. A target pending when
 * the body mounts is the first state (no render without it); each later one makes a fresh `S`, so the same
 * value opened twice still changes the state. In a model, use `usePanelTarget`.
 */
export function usePanelTargetState<T, S>(self: PanelSelf<T>, make: (t: T) => S): S | null {
   const makeRef = useRef(make);
   makeRef.current = make;
   const first = useRef<object | null>(null);
   const [state, setState] = useState<S | null>(() => {
      const pending = self.target && !applied.has(self.target) ? self.target : null;
      first.current = pending;
      return pending ? make(pending.value) : null;
   });
   const target = self.target;
   useEffect(() => {
      if (!target || applied.has(target)) return;
      applied.add(target);
      if (target !== first.current) setState(makeRef.current(target.value));
   }, [target]);
   return state;
}
