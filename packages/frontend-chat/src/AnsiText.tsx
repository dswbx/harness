import { useMemo } from "react";
import { parseAnsi } from "./ansi";

/** Terminal output with its ANSI colors (code theme `--ansi-*`). */
export function AnsiText({ text }: { text: string }) {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {spans.map((s, i) =>
        s.fg || s.bg || s.bold || s.dim || s.italic || s.underline ? (
          <span
            key={i}
            style={{
              color: s.fg,
              background: s.bg,
              fontWeight: s.bold ? 600 : undefined,
              opacity: s.dim ? 0.7 : undefined,
              fontStyle: s.italic ? "italic" : undefined,
              textDecoration: s.underline ? "underline" : undefined,
            }}
          >
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </>
  );
}
