# Terminal: a PTY in the core, streamed outside the Session Log

The user wants a shell next to the chat, like the Changes panel, and it must stay fast under heavy output (`yes`, builds, `cat` of large logs).

**Core owns the PTY.** `terminal.rs` runs the user's login shell in a PTY (`portable-pty`) in the Session's primary Workspace Folder, one per Session, with the login-shell PATH, `TERM=xterm-256color` and without host `CLAUDE*` vars. It lives in the core, not a Frontend, so every Frontend gets the same shell (ADR 0002), and survives reloads, other windows and closed panels. Archiving or deleting the Session kills it; when the shell exits, the next attach starts a new one.

**Outside the Session Log.** Terminal output is large, binary and the user's own, not something the Agent did, so it is not logged (an exception to ADR 0003). Frontends attach to a live stream instead: a 512 KB replay buffer, then live bytes. Input, resize, acks and kill are ordinary Commands (`TerminalInput`, `TerminalResize`, `TerminalAck`, `TerminalKill`); attaching is a fourth Transport operation (`attachTerminal`, Tauri `terminal_attach` with a raw-bytes Channel, so output reaches JS as an `ArrayBuffer`, never JSON).

**Fast by construction.** A reader thread feeds a flush thread that sends at most one message per 4 ms while output streams (typing goes out at once). Flow control: the Frontend acks bytes once xterm has drawn them; past 1 MB unacked, the flush thread waits, the bounded queue fills, and the PTY blocks the writing program instead of the UI (a silent Frontend stalls output at most 2 s). The renderer is xterm.js with the WebGL addon (DOM renderer fallback), lazy-loaded on first open, kept mounted while hidden.

**Not now.** Several Terminals per Session, a pop-out window, and Agent access (an MCP tool reading the screen would need the core to parse VT, e.g. `alacritty_terminal`).
