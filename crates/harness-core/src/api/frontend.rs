//! Frontend manifests and Frontend Tool types.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FrontendManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Guidance for the Agent about this Frontend (its `instructions.md`), sent in `<harness_context>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default)]
    pub frontend_tools: Vec<FrontendToolDecl>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FrontendToolDecl {
    pub name: String,
    pub description: String,
    #[specta(type = specta_typescript::Unknown)]
    pub input_schema: Json,
    /// The Frontend answers the call: the result goes back to the Agent, nothing goes in the Session Log.
    #[serde(default)]
    pub replies: bool,
}

/// A Frontend's answer to a `FrontendRequest`. `error` makes it a tool error for the Agent; else
/// the Agent gets `text` then `image`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct FrontendAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<FrontendImage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FrontendImage {
    pub mime: String,
    /// Base64 (standard alphabet, no `data:` prefix).
    pub data: String,
}
