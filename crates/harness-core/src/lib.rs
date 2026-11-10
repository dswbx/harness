//! Harness core: UI-agnostic host for ACP Agents (ADR 0001).

mod acp;
mod agent_quirks;
pub mod agents;
pub mod api;
mod app_settings;
mod attachments;
mod conformance;
mod editor;
mod env;
mod frontend_files;
mod github;
mod github_refs;
mod harness_context;
pub mod host;
pub mod library;
pub mod log;
pub mod mcp;
pub mod permissions;
pub mod session;
mod shell;
mod state;
mod summary;
pub mod terminal;
pub mod toolchain;
mod transcript;
pub mod workspace;

pub use host::Harness;
