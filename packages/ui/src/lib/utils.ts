import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Our font-size utilities (styles.css); without this, twMerge reads them as colors and drops them next to a text color. */
const twMerge = extendTailwindMerge({
   extend: {
      classGroups: {
         "font-size": [{ text: ["ui", "ui-step", "ui-sm", "ui-xs", "ui-lg", "ui-xl", "code"] }],
      },
   },
});

export function cn(...inputs: ClassValue[]) {
   return twMerge(clsx(inputs));
}

/** `v` within `min` and `max` (`min` wins when the range is inverted). */
export function clamp(v: number, min: number, max: number): number {
   return Math.max(min, Math.min(max, v));
}
