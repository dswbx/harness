//! Errors that carry an `ErrorCode`. `anyhow` stays inside the core; `Harness::execute` classifies
//! at the edge: an error built here keeps its code, anything else is `Internal`.

use std::fmt;

use crate::api::{ErrorCode, HarnessError};

/// Marker error inside an `anyhow` chain. `.context(..)` on top of it keeps the code.
#[derive(Debug)]
struct Coded {
    code: ErrorCode,
    message: String,
}

impl fmt::Display for Coded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Coded {}

pub fn coded(code: ErrorCode, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(Coded { code, message: message.into() })
}

pub fn not_found(message: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::NotFound, message)
}

pub fn conflict(message: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::Conflict, message)
}

pub fn agent_unavailable(message: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::AgentUnavailable, message)
}

pub fn auth_required(message: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::AuthRequired, message)
}

pub fn policy_denied(message: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::PolicyDenied, message)
}

pub fn invalid(message: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::Invalid, message)
}

impl From<anyhow::Error> for HarnessError {
    fn from(e: anyhow::Error) -> Self {
        let code = e.chain().find_map(|c| c.downcast_ref::<Coded>()).map_or(ErrorCode::Internal, |c| c.code);
        HarnessError { code, message: format!("{e:#}") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_survives_context() {
        let e = not_found("unknown session x").context("while opening");
        let h = HarnessError::from(e);
        assert_eq!(h.code, ErrorCode::NotFound);
        assert_eq!(h.message, "while opening: unknown session x");
    }

    #[test]
    fn plain_errors_are_internal() {
        let h = HarnessError::from(anyhow::anyhow!("boom"));
        assert_eq!((h.code, h.message.as_str()), (ErrorCode::Internal, "boom"));
    }
}
