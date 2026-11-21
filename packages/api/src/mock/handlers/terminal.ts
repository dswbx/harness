import type { CommandResult } from "../../generated";
import type { Handlers } from "./types";

const terminalNoop = (): CommandResult => {
   return { type: "Ok" };
};

export const terminalHandlers = {
   ListTerminals: (mock, cmd) => {
      const tabs = mock.tabs(cmd.session_id);
      return {
         type: "Terminals",
         terminals: tabs.ids.map((id, i) => ({
            id,
            // Like the core: the shell's name and the tab's number.
            title: `zsh ${i + 1}`,
            running: mock.terminals.has(`${cmd.session_id}:${id}`),
            busy: false,
         })),
      };
   },
   TerminalOpen: (mock, cmd) => {
      const tabs = mock.tabs(cmd.session_id);
      tabs.ids.push(++tabs.next);
      mock.emitApp({ type: "TerminalsChanged", session_id: cmd.session_id });
      return { type: "TerminalOpened", terminal_id: tabs.next };
   },
   TerminalClose: (mock, cmd) => {
      const tabs = mock.tabs(cmd.session_id);
      tabs.ids = tabs.ids.filter((id) => id !== cmd.terminal_id);
      mock.endTerminal(cmd.session_id, cmd.terminal_id, null);
      mock.emitApp({ type: "TerminalsChanged", session_id: cmd.session_id });
      return { type: "Ok" };
   },
   TerminalInput: (mock, cmd) => {
      mock.terminalInput(cmd.session_id, cmd.terminal_id, cmd.data);
      return { type: "Ok" };
   },
   TerminalResize: terminalNoop,
   TerminalAck: terminalNoop,
   TerminalKill: (mock, cmd) => {
      mock.endTerminal(cmd.session_id, cmd.terminal_id, null);
      return { type: "Ok" };
   },
} satisfies Partial<Handlers>;
