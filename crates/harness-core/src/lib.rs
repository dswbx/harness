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
pub mod error;
mod frontend_files;
mod fsutil;
mod github;
mod github_refs;
mod harness_context;
pub mod host;
pub mod library;
pub mod log;
pub mod mcp;
mod panels;
pub mod permissions;
pub mod session;
pub mod shared;
mod shell;
mod state;
mod summary;
pub mod terminal;
mod tool_facts;
pub mod toolchain;
mod transcript;
pub mod workspace;

pub use host::Harness;
