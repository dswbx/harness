# Rust owns shared primitives; Frontends own purpose-built logic in TS

The starting rule was "all backend logic in Rust, TS purely representational". We refined it: Rust core owns everything every Frontend needs (ACP, Sessions, git/worktrees, permissions, storage, MCP), while a Frontend's purpose-specific logic and state (e.g. a gen UI renderer, a canvas's sqlite projections) live in TS, reaching the system only through core's generic interfaces and Frontend Tools.

## Considered Options

- Rust companion module per Frontend: keeps all logic in Rust and testable headless, but makes building purpose-built Frontends slow and rigid. Rejected because creative freedom per Frontend is the point of the product.
- Agent writes Frontend state directly via file tools: too implicit to be the general mechanism; still allowed inside a Frontend's own design.
