import { SquareTerminal } from "lucide-react";
import { lazy } from "react";
import { definePanel, type PanelBodyProps } from "../../panels/contract";
import { usePanelTargetState } from "../../panels/usePanelTarget";

// xterm.js stays out of the main chunk until the Terminal is first opened.
const TerminalBody = lazy(async () => {
   const { default: TerminalPanel } = await import("./TerminalPanel");
   return {
      default: ({ ctx, self }: PanelBodyProps<null, number>) => {
         const show = usePanelTargetState(self, (id) => ({ id }));
         return <TerminalPanel api={ctx.api} active={self.open} show={show} />;
      },
   };
});

/**
 * The Session's shell. Once opened it stays mounted (hidden), so its screen survives hiding and moving.
 * Opened at a Terminal id, it shows that tab.
 */
export const terminalPanel = definePanel<null, number>({
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
