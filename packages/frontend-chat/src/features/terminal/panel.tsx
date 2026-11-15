import { SquareTerminal } from "lucide-react";
import { lazy } from "react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";

// xterm.js stays out of the main chunk until the Terminal is first opened.
const TerminalBody = lazy(async () => {
   const { default: TerminalPanel } = await import("./TerminalPanel");
   return {
      default: ({ ctx, self }: PanelBodyProps<null>) => (
         <TerminalPanel api={ctx.api} active={self.open} />
      ),
   };
});

/** The Session's shell. Once opened it stays mounted (hidden), so its screen survives hiding and moving. */
export const terminalPanel = definePanel<null>({
   id: "terminal",
   label: "Terminal",
   icon: SquareTerminal,
   placement: { edge: "bottom" },
   mount: "afterFirstOpen",
   // Cmd+J toggles it, as in VS Code. The host listens in the capture phase, so xterm never sees it.
   shortcut: {
      keys: ["⌘", "J"],
      match: (e) => e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyJ",
   },
   useModel: () => null,
   status: () => ({ presence: "ready" }),
   Body: TerminalBody,
});
