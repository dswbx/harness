//! Agents: installed from the ACP Registry onto the managed toolchain (ADR 0007), or added by
//! hand as Custom Agents. Installed Agents are recorded in `agents.json`; files live in
//! `agents/<id>/<version>/`. The config option values last picked per Agent are in
//! `agent-config.json` and given to each new Session's Agent.

use parking_lot::RwLock;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::api::{AgentInfo, AgentSource, InstallInfo, PreviousInstall, RegistryAgent};
use crate::toolchain::Toolchain;

pub const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/// One registry entry as published (see the registry's FORMAT.md).
#[derive(Debug, Clone, Deserialize)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub icon: Option<String>,
    pub website: Option<String>,
    pub repository: Option<String>,
    pub distribution: Distribution,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Distribution {
    pub npx: Option<Package>,
    pub uvx: Option<Package>,
    #[serde(default)]
    pub binary: BTreeMap<String, Binary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Package {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Binary {
    pub archive: String,
    pub sha256: Option<String>,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Index {
    agents: Vec<Value>,
}

impl Entry {
    /// How this machine would install it: a binary for this platform first, then npx, then uvx.
    fn method(&self) -> Option<&'static str> {
        if self.distribution.binary.contains_key(crate::toolchain::platform()) {
            Some("binary")
        } else if self.distribution.npx.is_some() {
            Some("npx")
        } else if self.distribution.uvx.is_some() {
            Some("uvx")
        } else {
            None
        }
    }
}

pub struct Agents {
    data_dir: PathBuf,
    registry_url: String,
    /// Agents given by the embedder (tests, dev); not persisted.
    fixed: Vec<AgentInfo>,
    installed: RwLock<Vec<AgentInfo>>,
    /// Agent id -> config option id -> value last picked.
    config: RwLock<BTreeMap<String, BTreeMap<String, String>>>,
    pub toolchain: Toolchain,
    install_lock: tokio::sync::Mutex<()>,
}

impl Agents {
    pub fn open(data_dir: &Path, registry_url: String, fixed: Vec<AgentInfo>) -> anyhow::Result<Self> {
        let installed = match std::fs::read(data_dir.join("agents.json")) {
            Ok(b) => serde_json::from_slice(&b)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let config = match std::fs::read(data_dir.join("agent-config.json")) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|e| {
                tracing::warn!("agent-config.json unreadable, starting empty: {e}");
                BTreeMap::new()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            data_dir: data_dir.to_owned(),
            registry_url,
            fixed,
            installed: RwLock::new(installed),
            config: RwLock::new(config),
            toolchain: Toolchain::new(data_dir),
            install_lock: Default::default(),
        })
    }

    pub fn list(&self) -> Vec<AgentInfo> {
        let mut all = self.fixed.clone();
        all.extend(self.installed.read().iter().cloned());
        all
    }

    pub fn get(&self, id: &str) -> Option<AgentInfo> {
        self.list().into_iter().find(|a| a.id == id)
    }

    fn save(&self, agents: &[AgentInfo]) -> anyhow::Result<()> {
        let path = self.data_dir.join("agents.json");
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(agents)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// Config option values last picked for the Agent (id -> value).
    pub fn remembered_config(&self, agent_id: &str) -> BTreeMap<String, String> {
        self.config.read().get(agent_id).cloned().unwrap_or_default()
    }

    /// Records a picked config option value, so new Sessions with this Agent start with it.
    pub fn remember_config(&self, agent_id: &str, config_id: &str, value: &str) -> anyhow::Result<()> {
        let mut all = self.config.write();
        all.entry(agent_id.to_owned()).or_default().insert(config_id.to_owned(), value.to_owned());
        let path = self.data_dir.join("agent-config.json");
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&*all)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    fn upsert(&self, agent: AgentInfo) -> anyhow::Result<()> {
        let mut all = self.installed.write();
        all.retain(|a| a.id != agent.id);
        all.push(agent);
        self.save(&all)
    }

    /// Registry entries, from the cache unless `refresh` (or no cache yet).
    pub async fn registry(&self, refresh: bool) -> anyhow::Result<Vec<RegistryAgent>> {
        let installed = self.list();
        Ok(self
            .entries(refresh)
            .await?
            .into_iter()
            .map(|e| RegistryAgent {
                installed_version: installed
                    .iter()
                    .find(|a| matches!(&a.source, AgentSource::Registry { registry_id } if *registry_id == e.id))
                    .and_then(|a| a.version.clone()),
                install_method: e.method().map(str::to_owned),
                id: e.id,
                name: e.name,
                version: e.version,
                description: e.description,
                icon: e.icon,
                website: e.website.or(e.repository),
            })
            .collect())
    }

    async fn entries(&self, refresh: bool) -> anyhow::Result<Vec<Entry>> {
        let cache = self.data_dir.join("registry-cache.json");
        if refresh || !cache.exists() {
            let tmp = cache.with_extension("json.tmp");
            crate::toolchain::download(&self.registry_url, &tmp, None).await?;
            std::fs::rename(&tmp, &cache)?;
        }
        let index: Index = serde_json::from_slice(&std::fs::read(&cache)?)?;
        // Skip entries this version of the Harness cannot parse rather than failing the list.
        Ok(index.agents.into_iter().filter_map(|a| serde_json::from_value(a).ok()).collect())
    }

    /// The installed (not fixed) record of `id`.
    fn installed_agent(&self, id: &str) -> Option<AgentInfo> {
        self.installed.read().iter().find(|a| a.id == id).cloned()
    }

    /// Installs (or updates to) the registry's current version of `registry_id`, side by side
    /// with the current one. The Agent switches to it only if the conformance check passes; the
    /// current version stays as the rollback target. A binary without a sha256 in the registry
    /// is refused unless `allow_unverified`.
    pub async fn install(&self, registry_id: &str, allow_unverified: bool) -> anyhow::Result<AgentInfo> {
        let entry =
            self.entries(false).await?.into_iter().find(|e| e.id == registry_id).ok_or_else(|| anyhow::anyhow!("{registry_id} is not in the ACP Registry"))?;
        let _guard = self.install_lock.lock().await;
        let existing = self.installed_agent(&entry.id);
        if let Some(cur) = &existing {
            if cur.version.as_deref() == Some(entry.version.as_str()) {
                return Ok(cur.clone());
            }
            anyhow::ensure!(!cur.install.held, "{} is held at v{}; release the hold to update", entry.name, cur.version.as_deref().unwrap_or("?"));
        }
        let dir = self.data_dir.join("agents").join(&entry.id).join(&entry.version);
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        // The directory held the rollback target (after a rollback): that target is gone now.
        let dir_was_previous = existing.as_ref().is_some_and(|c| c.install.previous.as_ref().is_some_and(|p| p.version == entry.version));
        std::fs::create_dir_all(&dir)?;
        let result = self.install_into(&entry, &dir, allow_unverified).await;
        let installed = match result {
            Ok(r) => r,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                if dir_was_previous {
                    self.drop_previous(&entry.id);
                }
                return Err(e.context(format!("installing {}", entry.name)));
            }
        };
        let mut agent = AgentInfo {
            id: entry.id.clone(),
            name: entry.name.clone(),
            command: installed.command.display().to_string(),
            args: installed.args,
            env: installed.env,
            source: AgentSource::Registry { registry_id: entry.id.clone() },
            version: Some(entry.version.clone()),
            icon: entry.icon.clone(),
            install: InstallInfo { sha256: installed.sha256, unverified: installed.unverified, ..Default::default() },
        };
        let check = crate::conformance::check(&agent, &self.toolchain.path(), crate::conformance::CHECK_TIMEOUT).await;
        if !check.passed {
            let _ = std::fs::remove_dir_all(&dir);
            let why = check.error.clone().unwrap_or_default();
            if let Some(mut cur) = existing {
                // Keep the current version, and show why the update was refused.
                if dir_was_previous {
                    cur.install.previous = None;
                }
                cur.install.check = Some(check);
                self.upsert(cur)?;
            }
            anyhow::bail!("{} v{} failed the conformance check and was not installed: {why}", entry.name, entry.version);
        }
        agent.install.check = Some(check);
        agent.install.previous = existing.and_then(|c| previous_of(&c));
        let keep: Vec<String> = [Some(entry.version.clone()), agent.install.previous.as_ref().map(|p| p.version.clone())].into_iter().flatten().collect();
        self.upsert(agent.clone())?;
        // Versions older than the previous one go; running Agents keep their files until they exit.
        self.prune(&entry.id, &keep);
        Ok(agent)
    }

    fn drop_previous(&self, id: &str) {
        let mut all = self.installed.write();
        if let Some(a) = all.iter_mut().find(|a| a.id == id) {
            a.install.previous = None;
            let _ = self.save(&all);
        }
    }

    /// Removes the version directories of `id` that are not in `keep`.
    fn prune(&self, id: &str, keep: &[String]) {
        let Ok(entries) = std::fs::read_dir(self.data_dir.join("agents").join(id)) else { return };
        for e in entries.flatten() {
            if !keep.iter().any(|k| e.file_name() == k.as_str()) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }

    /// Switches back to the previous version and holds the Agent there; the version rolled back
    /// from becomes the new previous.
    pub async fn rollback(&self, id: &str) -> anyhow::Result<AgentInfo> {
        let _guard = self.install_lock.lock().await;
        let cur = self.installed_agent(id).ok_or_else(|| anyhow::anyhow!("unknown Agent {id}"))?;
        let prev = cur.install.previous.clone().ok_or_else(|| anyhow::anyhow!("{} has no previous version", cur.name))?;
        anyhow::ensure!(Path::new(&prev.command).exists(), "the files of {} v{} are gone", cur.name, prev.version);
        let agent = AgentInfo {
            command: prev.command,
            args: prev.args,
            env: prev.env,
            version: Some(prev.version),
            install: InstallInfo { sha256: prev.sha256, unverified: prev.unverified, previous: previous_of(&cur), held: true, check: None },
            ..cur
        };
        self.upsert(agent.clone())?;
        Ok(agent)
    }

    /// Holds an installed Agent at its current version, or releases it.
    pub fn hold(&self, id: &str, hold: bool) -> anyhow::Result<AgentInfo> {
        let mut all = self.installed.write();
        let a = all.iter_mut().find(|a| a.id == id).ok_or_else(|| anyhow::anyhow!("unknown Agent {id}"))?;
        a.install.held = hold;
        let agent = a.clone();
        self.save(&all)?;
        Ok(agent)
    }

    async fn install_into(&self, entry: &Entry, dir: &Path, allow_unverified: bool) -> anyhow::Result<Installed> {
        let d = &entry.distribution;
        match entry.method() {
            Some("binary") => {
                let b = &d.binary[crate::toolchain::platform()];
                anyhow::ensure!(
                    b.sha256.is_some() || allow_unverified,
                    "{} lists no sha256 in the ACP Registry, so the download cannot be verified",
                    entry.name
                );
                let sha256;
                if crate::toolchain::is_archive(&b.archive) {
                    let name = b.archive.rsplit('/').next().unwrap_or("archive").split('?').next().unwrap_or("archive");
                    let archive = dir.join(format!(".download-{name}"));
                    sha256 = crate::toolchain::download(&b.archive, &archive, b.sha256.as_deref()).await?;
                    crate::toolchain::unpack(&archive, dir).await?;
                    std::fs::remove_file(&archive)?;
                } else {
                    let target = dir.join(b.cmd.trim_start_matches("./"));
                    sha256 = crate::toolchain::download(&b.archive, &target, b.sha256.as_deref()).await?;
                }
                let cmd = dir.join(b.cmd.trim_start_matches("./"));
                anyhow::ensure!(cmd.exists(), "{} not found in the downloaded archive", b.cmd);
                make_executable(&cmd)?;
                Ok(Installed { command: cmd, args: b.args.clone(), env: b.env.clone(), sha256: Some(sha256), unverified: b.sha256.is_none() })
            }
            Some("npx") => {
                let p = d.npx.as_ref().ok_or_else(|| anyhow::anyhow!("registry entry has no npx distribution"))?;
                let node_bin = self.toolchain.node().await?;
                run(tokio::process::Command::new(node_bin.join("npm"))
                    .args(["install", "--no-audit", "--no-fund", "--loglevel=error", "--prefix"])
                    .arg(dir)
                    .arg(&p.package)
                    .env("PATH", self.toolchain.path()))
                .await?;
                let bin = npm_bin(dir, &package_name(&p.package))?;
                Ok(Installed { command: bin, args: p.args.clone(), env: p.env.clone(), sha256: None, unverified: false })
            }
            Some("uvx") => {
                let p = d.uvx.as_ref().ok_or_else(|| anyhow::anyhow!("registry entry has no uvx distribution"))?;
                let uv_bin = self.toolchain.uv().await?;
                let tc = self.toolchain.root();
                run(tokio::process::Command::new(uv_bin.join("uv"))
                    .args(["tool", "install", &p.package])
                    .env("UV_TOOL_DIR", dir.join("tools"))
                    .env("UV_TOOL_BIN_DIR", dir.join("bin"))
                    .env("UV_PYTHON_INSTALL_DIR", tc.join("python"))
                    .env("UV_CACHE_DIR", tc.join("uv-cache"))
                    .env("PATH", self.toolchain.path()))
                .await?;
                let bin_dir = dir.join("bin");
                let wanted = bin_dir.join(python_name(&p.package));
                let bin = if wanted.exists() {
                    wanted
                } else {
                    let mut entries: Vec<PathBuf> = std::fs::read_dir(&bin_dir)?.filter_map(|e| e.ok().map(|e| e.path())).collect();
                    anyhow::ensure!(entries.len() == 1, "cannot tell which executable {} provides", p.package);
                    entries.remove(0)
                };
                Ok(Installed { command: bin, args: p.args.clone(), env: p.env.clone(), sha256: None, unverified: false })
            }
            _ => anyhow::bail!("{} has no distribution for {}", entry.name, crate::toolchain::platform()),
        }
    }

    pub fn add_custom(&self, name: String, command: String, args: Vec<String>, env: BTreeMap<String, String>) -> anyhow::Result<AgentInfo> {
        let agent = AgentInfo {
            id: format!("custom-{}", crate::workspace::slug(&name)),
            name,
            command,
            args,
            env,
            source: AgentSource::Custom,
            version: None,
            icon: None,
            install: Default::default(),
        };
        anyhow::ensure!(self.get(&agent.id).is_none(), "an Agent with id {} already exists", agent.id);
        self.upsert(agent.clone())?;
        Ok(agent)
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let mut all = self.installed.write();
        let before = all.len();
        all.retain(|a| a.id != id);
        anyhow::ensure!(all.len() != before, "unknown Agent {id}");
        self.save(&all)?;
        let _ = std::fs::remove_dir_all(self.data_dir.join("agents").join(id));
        Ok(())
    }
}

/// What an install produced.
struct Installed {
    command: PathBuf,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    /// Hash of the downloaded artifact (binary installs).
    sha256: Option<String>,
    unverified: bool,
}

/// The launch spec of `a` as a rollback target (registry installs with a version only).
fn previous_of(a: &AgentInfo) -> Option<PreviousInstall> {
    Some(PreviousInstall {
        version: a.version.clone()?,
        command: a.command.clone(),
        args: a.args.clone(),
        env: a.env.clone(),
        sha256: a.install.sha256.clone(),
        unverified: a.install.unverified,
    })
}

async fn run(cmd: &mut tokio::process::Command) -> anyhow::Result<()> {
    let out = cmd.stdin(std::process::Stdio::null()).output().await?;
    anyhow::ensure!(out.status.success(), "{}", String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).trim());
    Ok(())
}

/// `@scope/name@1.2.3` -> `@scope/name`.
fn package_name(spec: &str) -> String {
    match spec[1..].find('@') {
        Some(i) => spec[..i + 1].to_owned(),
        None => spec.to_owned(),
    }
}

/// `name[extra]==1.2` -> `name`.
fn python_name(spec: &str) -> String {
    spec.split(|c: char| "[=<>~!@ ".contains(c)).next().unwrap_or(spec).to_owned()
}

/// The executable an npm package installs: its only `bin`, or the one named after the package.
fn npm_bin(prefix: &Path, package: &str) -> anyhow::Result<PathBuf> {
    let manifest: Value = serde_json::from_slice(&std::fs::read(prefix.join("node_modules").join(package).join("package.json"))?)?;
    let short = package.rsplit('/').next().unwrap_or(package);
    let name = match manifest.get("bin") {
        Some(Value::String(_)) => short.to_owned(),
        Some(Value::Object(m)) if let (1, Some(k)) = (m.len(), m.keys().next()) => k.clone(),
        Some(Value::Object(m)) => {
            m.keys().find(|k| k.as_str() == short).or_else(|| m.keys().next()).cloned().ok_or_else(|| anyhow::anyhow!("{package} declares no executable"))?
        }
        _ => anyhow::bail!("{package} declares no executable"),
    };
    let bin = prefix.join("node_modules").join(".bin").join(name);
    anyhow::ensure!(bin.exists(), "{} missing after install", bin.display());
    Ok(bin)
}

fn make_executable(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = std::fs::metadata(p)?.permissions();
    perm.set_mode(perm.mode() | 0o755);
    std::fs::set_permissions(p, perm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(package_name("@agentclientprotocol/codex-acp@2.3.0"), "@agentclientprotocol/codex-acp");
        assert_eq!(package_name("left-pad"), "left-pad");
        assert_eq!(package_name("left-pad@1"), "left-pad");
        assert_eq!(python_name("fast-agent-mcp==0.3.1"), "fast-agent-mcp");
        assert_eq!(python_name("pkg[acp]>=1"), "pkg");
    }
}
