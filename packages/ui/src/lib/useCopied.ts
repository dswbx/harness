import { useCallback, useEffect, useRef, useState } from "react";

/** How long the check mark shows after a copy. */
const COPIED_MS = 1500;

/**
 * Copy-to-clipboard with a "done" flag: `copy(text)` writes the clipboard and `copied` is true for
 * a moment after (a failed write leaves it false). Show a check mark while it is true.
 */
export function useCopied(): readonly [copied: boolean, copy: (text: string) => Promise<void>] {
   const [copied, setCopied] = useState(false);
   const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
   useEffect(() => () => clearTimeout(timer.current), []);
   const copy = useCallback(
      (text: string) =>
         navigator.clipboard.writeText(text).then(
            () => {
               setCopied(true);
               clearTimeout(timer.current);
               timer.current = setTimeout(() => setCopied(false), COPIED_MS);
            },
            () => {},
         ),
      [],
   );
   return [copied, copy];
}
