# Core is a UI-agnostic library; Tauri is one adapter

The product ships as one Tauri app hosting several Frontends, but the core is built as a standalone Rust library that knows nothing about Tauri or any UI: commands in, events out, one schema. Tauri is a thin adapter on top. This keeps every Frontend on identical primitives and leaves a future daemon, remote, or TUI host possible without rewriting the core, at the cost of a little indirection now.
