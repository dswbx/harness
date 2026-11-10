import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
   return twMerge(clsx(inputs));
}

/** `v` within `min` and `max` (`min` wins when the range is inverted). */
export function clamp(v: number, min: number, max: number): number {
   return Math.max(min, Math.min(max, v));
}
