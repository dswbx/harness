//! MCP Library: user-defined MCP servers, selectable per Session. Definitions live in
//! `mcp.json`; secret env values and headers live in a `Secrets` store (the Keychain).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

use crate::api::{McpServerDef, McpTransport};

pub trait Secrets: Send + Sync {
    fn get(&self, key: &str) -> anyhow::Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()>;
    fn delete(&self, key: &str) -> anyhow::Result<()>;
}

/// macOS Keychain, one generic password per secret.
pub struct Keychain;

const SERVICE: &str = "dev.dswbx.harness.mcp";

impl Secrets for Keychain {
    fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        match keyring::Entry::new(SERVICE, key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        Ok(keyring::Entry::new(SERVICE, key)?.set_password(value)?)
    }

    fn delete(&self, key: &str) -> anyhow::Result<()> {
        match keyring::Entry::new(SERVICE, key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// In-memory secrets for tests.
#[derive(Default)]
pub struct MemorySecrets(Mutex<HashMap<String, String>>);

impl Secrets for MemorySecrets {
    fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.0.lock().unwrap().insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

pub struct Library {
    path: PathBuf,
    servers: RwLock<Vec<McpServerDef>>,
    secrets: Box<dyn Secrets>,
}

fn secret_key(server_id: &str, key: &str) -> String {
    format!("{server_id}/{key}")
}

impl Library {
    pub fn open(path: PathBuf, secrets: Box<dyn Secrets>) -> anyhow::Result<Self> {
        let servers = match std::fs::read(&path) {
            Ok(b) => serde_json::from_slice(&b)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { path, servers: RwLock::new(servers), secrets })
    }

    pub fn list(&self) -> Vec<McpServerDef> {
        self.servers.read().unwrap().clone()
    }

    pub fn save(&self, mut server: McpServerDef, secrets: BTreeMap<String, String>) -> anyhow::Result<McpServerDef> {
        anyhow::ensure!(!server.name.trim().is_empty(), "the server needs a name");
        anyhow::ensure!(
            crate::workspace::slug(&server.name) != "harness" || !server.id.is_empty(),
            "\"harness\" is reserved for the Harness MCP"
        );
        if server.id.is_empty() {
            server.id = crate::workspace::slug(&server.name);
        }
        // Secret values never land in mcp.json.
        match &mut server.transport {
            McpTransport::Stdio { env, .. } => env.retain(|k, _| !server.secret_keys.contains(k)),
            McpTransport::Http { headers, .. } => headers.retain(|k, _| !server.secret_keys.contains(k)),
        }
        for (k, v) in &secrets {
            anyhow::ensure!(server.secret_keys.contains(k), "{k} is not one of the server's secret keys");
            self.secrets.set(&secret_key(&server.id, k), v)?;
        }
        let mut all = self.servers.write().unwrap();
        if let Some(old) = all.iter().find(|s| s.id == server.id) {
            for k in old.secret_keys.iter().filter(|k| !server.secret_keys.contains(k)) {
                self.secrets.delete(&secret_key(&server.id, k))?;
            }
        }
        all.retain(|s| s.id != server.id);
        all.push(server.clone());
        self.write(&all)?;
        Ok(server)
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let mut all = self.servers.write().unwrap();
        let Some(server) = all.iter().find(|s| s.id == id).cloned() else {
            anyhow::bail!("unknown MCP server {id}");
        };
        for k in &server.secret_keys {
            self.secrets.delete(&secret_key(id, k))?;
        }
        all.retain(|s| s.id != id);
        self.write(&all)
    }

    fn write(&self, servers: &[McpServerDef]) -> anyhow::Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(servers)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }

    /// The server with its secrets filled in, ready to hand to an Agent.
    pub fn resolve(&self, id: &str) -> anyhow::Result<McpServerDef> {
        let mut server = self
            .list()
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| anyhow::anyhow!("unknown MCP server {id}"))?;
        let mut filled = BTreeMap::new();
        for k in &server.secret_keys {
            let v = self.secrets.get(&secret_key(id, k))?.ok_or_else(|| anyhow::anyhow!("{}: secret {k} is not set", server.name))?;
            filled.insert(k.clone(), v);
        }
        match &mut server.transport {
            McpTransport::Stdio { env, .. } => env.extend(filled),
            McpTransport::Http { headers, .. } => headers.extend(filled),
        }
        Ok(server)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_stay_out_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let lib = Library::open(path.clone(), Box::new(MemorySecrets::default())).unwrap();
        let def = McpServerDef {
            id: String::new(),
            name: "My API".into(),
            transport: McpTransport::Http {
                url: "https://example.com/mcp".into(),
                headers: [("Authorization".to_owned(), "leak".to_owned()), ("X-Plain".to_owned(), "p".to_owned())].into(),
            },
            secret_keys: vec!["Authorization".into()],
        };
        let saved = lib.save(def, [("Authorization".to_owned(), "Bearer s3cret".to_owned())].into()).unwrap();
        assert_eq!(saved.id, "my-api");
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("s3cret") && !on_disk.contains("leak"), "{on_disk}");
        let McpTransport::Http { headers, .. } = lib.resolve("my-api").unwrap().transport else { panic!() };
        assert_eq!(headers["Authorization"], "Bearer s3cret");
        assert_eq!(headers["X-Plain"], "p");

        // Re-saving without the secret keeps it; dropping the key deletes it.
        let mut again = saved.clone();
        lib.save(again.clone(), BTreeMap::new()).unwrap();
        assert!(lib.resolve("my-api").is_ok());
        again.secret_keys.clear();
        lib.save(again, BTreeMap::new()).unwrap();
        assert_eq!(lib.secrets.get("my-api/Authorization").unwrap(), None);
    }
}
