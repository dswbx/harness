/** Last segment of a path (`/` or `\\` separators, trailing ones ignored); the path itself when it has none. */
export const baseName = (path: string): string =>
   path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path;
