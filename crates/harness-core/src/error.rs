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

pub fn needs_approval(reason: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::NeedsApproval, reason)
}

pub fn invalid(message: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::Invalid, message)
}

pub fn unavailable(message: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::Unavailable, message)
}

pub fn timeout(message: impl Into<String>) -> anyhow::Error {
    coded(ErrorCode::Timeout, message)
}

/// `e` with a new message, keeping its code.
pub fn reword(e: &anyhow::Error, message: impl Into<String>) -> anyhow::Error {
    match e.chain().find_map(|c| c.downcast_ref::<Coded>()) {
        Some(c) => coded(c.code, message),
        None => anyhow::anyhow!(message.into()),
    }
}

/// A failed process run with the caller's `message`: a timeout keeps its code, anything else is plain.
pub fn from_proc(e: &crate::proc::ProcError, message: impl Into<String>) -> anyhow::Error {
    match e {
        crate::proc::ProcError::Timeout { .. } => timeout(message),
        _ => anyhow::anyhow!(message.into()),
    }
}

/// A failed download or request with the caller's `message`: a timeout is `Timeout`, a network failure `Unavailable`.
pub fn from_http(e: &crate::http::Error, message: impl Into<String>) -> anyhow::Error {
    match e.code() {
        Some(code) => coded(code, message),
        None => anyhow::anyhow!(message.into()),
    }
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
    fn timeouts_and_network_failures_keep_a_code_other_failures_stay_plain() {
        use crate::http::Error as Http;
        let code = |e: anyhow::Error| HarnessError::from(e).code;
        let proc_timeout = crate::proc::ProcError::Timeout { program: "git".into(), after: std::time::Duration::from_secs(1), stderr_tail: String::new() };
        let proc_spawn = crate::proc::ProcError::Spawn { program: "git".into(), source: std::io::Error::other("x") };
        assert_eq!([code(from_proc(&proc_timeout, "m")), code(from_proc(&proc_spawn, "m"))], [ErrorCode::Timeout, ErrorCode::Internal]);
        let http = |e: Http| code(from_http(&e, "m"));
        assert_eq!(
            [
                http(Http::TimedOut(5)),
                http(Http::Stalled(5)),
                http(Http::Status(503)),
                http(Http::Other("request: refused".into())),
                http(Http::Status(404)),
                http(Http::NotHttps),
                http(Http::Refused("request: bad certificate".into()))
            ],
            [
                ErrorCode::Timeout,
                ErrorCode::Timeout,
                ErrorCode::Unavailable,
                ErrorCode::Unavailable,
                ErrorCode::Internal,
                ErrorCode::Internal,
                ErrorCode::Invalid
            ]
        );
        assert_eq!(from_proc(&proc_timeout, "git status: timed out").to_string(), "git status: timed out");
    }

    #[test]
    fn plain_errors_are_internal() {
        let h = HarnessError::from(anyhow::anyhow!("boom"));
        assert_eq!((h.code, h.message.as_str()), (ErrorCode::Internal, "boom"));
    }
}
