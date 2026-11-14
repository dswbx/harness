import { useEffect, useRef } from "react";
import type { PanelSelf } from "./contract";

/** Targets already applied. Keyed by the target object, so a panel that remounts does not apply one twice. */
const applied = new WeakSet<object>();

/** Applies each new `self.target` once (a new `seq`, even with an equal value). Run in the panel's Body. */
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
