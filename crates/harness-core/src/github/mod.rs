//! GitHub: API calls over HTTP with the token of the GitHub CLI (`gh auth token`), PR checkout via `gh`,
//! and the cached PR references.

mod client;
mod pr;
mod refs;
mod repos;

pub use pr::{checkout_pr, list_prs, view_pr};
pub use refs::PrRefs;
pub(crate) use repos::valid_repo;
