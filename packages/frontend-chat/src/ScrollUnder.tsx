import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A message list that scrolls under its bottom bar (the prompt box), which fades the content out
 * above it so wide artifacts never show around its corners. `children` gets the bar's height, to
 * keep as space at the end of the list.
 */
export function ScrollUnder({ bottom, children }: { bottom: ReactNode; children: (inset: number) => ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setInset(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {children(inset)}
      <div ref={bar} className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(to_bottom,transparent,var(--background)_2rem)] pt-8">
        <div className="pointer-events-auto">{bottom}</div>
      </div>
    </div>
  );
}
