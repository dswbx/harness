import type { LucideIcon } from "lucide-react";
import { type ComponentType, useEffect, useState } from "react";
import { uiIcons } from "./uiIcons";

type Loader = () => Promise<{ default: LucideIcon }>;
type IconMap = Record<string, Loader>;

let mapPromise: Promise<IconMap> | undefined;
/** lucide's name -> loader table (about 1700 names, each its own chunk). Fetched once, on first need. */
export function lucideIconMap(): Promise<IconMap> {
   mapPromise ??= import("lucide-react/dynamicIconImports").then(
      (m) => m.default as unknown as IconMap,
   );
   return mapPromise;
}

/** Every lucide icon name (kebab case, aliases included), sorted. Fetched once. */
export function lucideIconNames(): Promise<string[]> {
   return lucideIconMap().then((m) => Object.keys(m).sort());
}

const resolved = new Map<string, LucideIcon | null>();
const pending = new Map<string, Promise<LucideIcon | null>>();

function loadIcon(name: string): Promise<LucideIcon | null> {
   let p = pending.get(name);
   if (!p) {
      p = lucideIconMap()
         .then((m) => m[name]?.())
         .then((mod) => mod?.default ?? null)
         .catch(() => null)
         .then((icon) => {
            resolved.set(name, icon);
            return icon;
         });
      pending.set(name, p);
   }
   return p;
}

/**
 * A lucide icon by name, not in `uiIcons`. Until it loads (or when the name is unknown) it renders an
 * empty svg of the same size, so nothing shifts.
 */
function lazyIcon(name: string): ComponentType<{ className?: string }> {
   return function LazyIcon(props) {
      const [Icon, setIcon] = useState<LucideIcon | null>(() => resolved.get(name) ?? null);
      useEffect(() => {
         if (Icon) return;
         let live = true;
         loadIcon(name).then((i) => live && setIcon(() => i));
         return () => {
            live = false;
         };
      }, [Icon]);
      if (Icon) return <Icon {...props} />;
      return <svg width={24} height={24} aria-hidden="true" {...props} />;
   };
}

const lazy = new Map<string, ComponentType<{ className?: string }>>();

/**
 * The icon for a panel's `icon` name: a curated one (`uiIcons`) at once, any other lucide icon name
 * lazily, nothing for an empty name. The component of a name is stable across calls.
 */
export function iconFor(
   name: string | null | undefined,
): ComponentType<{ className?: string }> | undefined {
   if (!name) return undefined;
   const own = (uiIcons as Record<string, LucideIcon | undefined>)[name];
   if (own) return own;
   let c = lazy.get(name);
   if (!c) {
      c = lazyIcon(name);
      lazy.set(name, c);
   }
   return c;
}

/** `iconFor` as an element; `fallback` when the name is empty. */
export function PanelIcon({
   name,
   fallback: Fallback,
   className,
}: {
   name: string | null | undefined;
   fallback?: ComponentType<{ className?: string }>;
   className?: string;
}) {
   const Icon = iconFor(name) ?? Fallback;
   return Icon ? <Icon className={className} /> : null;
}
