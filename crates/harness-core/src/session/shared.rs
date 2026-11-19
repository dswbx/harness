use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::app_events::AppEvents;
use crate::permissions::Policy;

/// Harness-wide state every Session shares.
pub struct Shared {
    pub policy: Policy,
    /// How long an Agent process may sit with no Turn, no pending request and no View before it
    /// is stopped.
    pub idle_timeout: Duration,
    /// The waits before each new try at restoring an Agent Session whose resume and load failed.
    pub restore_retries: Vec<Duration>,
    /// How long an Agent may take to end a Turn after a Cancel before its process is stopped.
    pub cancel_grace: Duration,
    pub agents: crate::agents::Agents,
    pub frontends: parking_lot::RwLock<Vec<crate::api::FrontendManifest>>,
    pub mcp: crate::mcp::HarnessMcp,
    pub library: crate::library::Library,
    /// How Agents without HTTP MCP start the stdio shim: command and args (the shim reads
    /// `HARNESS_MCP_URL` and `HARNESS_MCP_TOKEN`).
    pub mcp_shim: Option<(String, Vec<String>)>,
    pub app_events: AppEvents,
    /// Optional overrides of the `<harness_context>` texts (`harness.md`, `<frontend id>.md`).
    pub prompts_dir: PathBuf,
    /// Custom Instructions (`<data dir>/instructions/`), added to the `<harness_context>`.
    pub instructions: crate::instructions::Instructions,
    /// PR lookups and the Sessions' GitHub repos, shared by all Sessions.
    pub pr_refs: crate::github::PrRefs,
    /// Shared Artifacts (ADR 0024), in `<data dir>/shared/`.
    pub artifacts: crate::shared::SharedArtifacts,
    /// Tasks (ADR 0028), in `<data dir>/tasks/`.
    pub tasks: crate::tasks::Tasks,
    /// The Harness, so the Harness MCP can start and reach Sub Sessions. Set once it exists.
    pub host: std::sync::OnceLock<std::sync::Weak<crate::host::Harness>>,
    /// `Harness::shutdown` started: no Agent, Session or Turn starts any more.
    pub closing: std::sync::atomic::AtomicBool,
    /// What parents still need to hear from their Sub Sessions.
    pub notices: crate::sub_sessions::Notices,
}

impl Shared {
    /// Runs `f` on the MCP Library on the blocking pool: its secrets are in the Keychain, whose
    /// calls can wait on the system (a prompt) and must not park a runtime thread.
    pub async fn library_blocking<R: Send + 'static>(self: &Arc<Self>, f: impl FnOnce(&crate::library::Library) -> R + Send + 'static) -> anyhow::Result<R> {
        let shared = self.clone();
        tokio::task::spawn_blocking(move || f(&shared.library)).await.map_err(|e| anyhow::anyhow!("library task: {e}"))
    }

    /// The Harness, while it lives.
    pub fn host(&self) -> anyhow::Result<Arc<crate::host::Harness>> {
        self.host.get().and_then(std::sync::Weak::upgrade).ok_or_else(|| anyhow::anyhow!("the Harness is shutting down"))
    }
}
