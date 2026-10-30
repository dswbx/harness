//! Harness core: UI-agnostic host for ACP Agents (ADR 0001).

mod acp;
pub mod agents;
pub mod api;
mod attachments;
mod env;
pub mod host;
pub mod library;
pub mod log;
pub mod mcp;
pub mod permissions;
pub mod session;
mod summary;
pub mod toolchain;
pub mod workspace;

pub use host::Harness;
