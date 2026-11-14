import type { Transport } from "../../transport/transport";
import { expectResult, run } from "../expect";
import type { SessionApi } from "../session";

type Terminal = Pick<
   SessionApi,
   | "terminalList"
   | "terminalOpen"
   | "terminalClose"
   | "terminalsChanged"
   | "terminalAttach"
   | "terminalInput"
   | "terminalResize"
   | "terminalAck"
   | "terminalKill"
>;

export const terminalApi = (transport: Transport, sessionId: string): Terminal => ({
   terminalList: async () =>
      (await expectResult(transport, { type: "ListTerminals", session_id: sessionId }, "Terminals"))
         .terminals,
   terminalOpen: async () =>
      (
         await expectResult(
            transport,
            { type: "TerminalOpen", session_id: sessionId },
            "TerminalOpened",
         )
      ).terminal_id,
   terminalClose: (terminal_id) =>
      run(transport, { type: "TerminalClose", session_id: sessionId, terminal_id }),
   terminalsChanged: (onChange) =>
      transport.subscribeApp(
         (e) => e.type === "TerminalsChanged" && e.session_id === sessionId && onChange(),
      ),
   terminalAttach: (terminalId, cols, rows, onOutput) =>
      transport.attachTerminal(sessionId, terminalId, cols, rows, onOutput),
   terminalInput: (terminal_id, data) =>
      run(transport, { type: "TerminalInput", session_id: sessionId, terminal_id, data }),
   terminalResize: (terminal_id, cols, rows) =>
      run(transport, { type: "TerminalResize", session_id: sessionId, terminal_id, cols, rows }),
   terminalAck: (terminal_id, bytes) =>
      run(transport, { type: "TerminalAck", session_id: sessionId, terminal_id, bytes }),
   terminalKill: (terminal_id) =>
      run(transport, { type: "TerminalKill", session_id: sessionId, terminal_id }),
});
