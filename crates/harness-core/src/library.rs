//! MCP Library: user-defined MCP servers, selectable per Session. Definitions live in
//! `mcp.json`; secret env values and headers live in a `Secrets` store (the Keychain).

use parking_lot::{Mutex, RwLock};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

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
        Ok(self.0.lock().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.0.lock().insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.0.lock().remove(key);
        Ok(())
    }
}

pub struct Library {
    path: PathBuf,
    servers: RwLock<Vec<McpServerDef>>,
    /// Serializes `save` and `remove`, so their Keychain calls need not run under `servers`.
    edit: Mutex<()>,
    secrets: Box<dyn Secrets>,
}

fn secret_key(server_id: &str, key: &str) -> String {
    format!("{server_id}/{key}")
}

impl Library {
    pub fn open(path: PathBuf, secrets: Box<dyn Secrets>) -> anyhow::Result<Self> {
        let servers = crate::persist::JsonFile::<Vec<McpServerDef>>::new(path.clone()).load_or_default()?;
        Ok(Self { path, servers: RwLock::new(servers), edit: Mutex::new(()), secrets })
    }

    pub fn list(&self) -> Vec<McpServerDef> {
        self.servers.read().clone()
    }

    pub fn save(&self, mut server: McpServerDef, secrets: BTreeMap<String, String>) -> anyhow::Result<McpServerDef> {
        if server.name.trim().is_empty() {
            return Err(crate::error::invalid("the server needs a name"));
        }
        let is_new = server.id.is_empty();
        if is_new {
            server.id = crate::git::slug(&server.name);
        }
        if server.id == "harness" {
            return Err(crate::error::invalid("\"harness\" is reserved for the Harness MCP"));
        }
        let _edit = self.edit.lock();
        // Keychain calls run before the `servers` lock is taken: readers never wait on them, and a
        // failed call leaves the stored list as it was.
        let (exists, old_keys) = {
            let all = self.servers.read();
            (all.iter().any(|s| s.id == server.id), all.iter().find(|s| s.id == server.id).map(|s| s.secret_keys.clone()))
        };
        if is_new && exists {
            return Err(crate::error::conflict(format!("an MCP server named {:?} already exists", server.name.trim())));
        }
        // Secret values never land in mcp.json.
        match &mut server.transport {
            McpTransport::Stdio { env, .. } => env.retain(|k, _| !server.secret_keys.contains(k)),
            McpTransport::Http { headers, .. } => headers.retain(|k, _| !server.secret_keys.contains(k)),
        }
        for (k, v) in &secrets {
            if !server.secret_keys.contains(k) {
                return Err(crate::error::invalid(format!("{k} is not one of the server's secret keys")));
            }
            self.secrets.set(&secret_key(&server.id, k), v)?;
        }
        // In memory only once saved: a refused write must not leave an edit the file lacks.
        let mut next = self.servers.read().clone();
        next.retain(|s| s.id != server.id);
        next.push(server.clone());
        self.write(&next)?;
        *self.servers.write() = next;
        // After the file: a refused write keeps the old secrets.
        for k in old_keys.iter().flatten().filter(|k| !server.secret_keys.contains(k)) {
            self.secrets.delete(&secret_key(&server.id, k))?;
        }
        Ok(server)
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let _edit = self.edit.lock();
        let Some(server) = self.servers.read().iter().find(|s| s.id == id).cloned() else {
            return Err(crate::error::not_found(format!("unknown MCP server {id}")));
        };
        let mut next = self.servers.read().clone();
        next.retain(|s| s.id != id);
        self.write(&next)?;
        *self.servers.write() = next;
        // After the file: a refused write keeps the server and its secrets.
        for k in &server.secret_keys {
            self.secrets.delete(&secret_key(id, k))?;
        }
        Ok(())
    }

    fn write(&self, servers: &[McpServerDef]) -> anyhow::Result<()> {
        crate::persist::JsonFile::<Vec<McpServerDef>>::new(self.path.clone()).save(&servers.to_vec())
    }

    /// The server with its secrets filled in, ready to hand to an Agent.
    pub fn resolve(&self, id: &str) -> anyhow::Result<McpServerDef> {
        let mut server = self.list().into_iter().find(|s| s.id == id).ok_or_else(|| crate::error::not_found(format!("unknown MCP server {id}")))?;
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

    #[test]
    fn reads_the_file_format_of_today_and_survives_corruption() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("mcp.json");
        std::fs::write(&path, r#"[{"id":"a","name":"A","transport":{"type":"http","url":"https://x/mcp","headers":{}},"secret_keys":[]}]"#).unwrap();
        let lib = Library::open(path.clone(), Box::new(MemorySecrets::default())).unwrap();
        assert_eq!(lib.list().len(), 1);
        lib.remove("a").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
        std::fs::write(&path, b"[{").unwrap();
        let lib = Library::open(path.clone(), Box::new(MemorySecrets::default())).unwrap();
        assert!(lib.list().is_empty());
        let n = std::fs::read_dir(d.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("mcp.json.corrupt-")).count();
        assert_eq!(n, 1);
    }
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_refused_save_or_remove_leaves_the_list_and_the_secrets_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let lib = Library::open(path.clone(), Box::new(MemorySecrets::default())).unwrap();
        let def = |name: &str| McpServerDef {
            id: String::new(),
            name: name.into(),
            transport: McpTransport::Http { url: "https://example.com/mcp".into(), headers: BTreeMap::new() },
            secret_keys: vec!["K".into()],
        };
        let kept = lib.save(def("Kept"), [("K".to_owned(), "v".to_owned())].into()).unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let writable = std::fs::write(dir.path().join("probe"), b"").is_ok();
        let added = lib.save(def("Added"), BTreeMap::new());
        let mut edited = kept.clone();
        edited.name = "Renamed".into();
        let edit = lib.save(edited, BTreeMap::new());
        let removed = lib.remove(&kept.id);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        if writable {
            return; // running as root
        }
        assert!(added.is_err() && edit.is_err() && removed.is_err());
        let list = lib.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Kept");
        assert_eq!(lib.secrets.get("kept/K").unwrap().as_deref(), Some("v"), "the secret stays with the server");
    }

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

    fn lib() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path().join("mcp.json"), Box::new(MemorySecrets::default())).unwrap();
        (dir, lib)
    }

    fn def(id: &str, name: &str, secret_keys: &[&str]) -> McpServerDef {
        McpServerDef {
            id: id.into(),
            name: name.into(),
            transport: McpTransport::Http { url: "https://example.com/mcp".into(), headers: Default::default() },
            secret_keys: secret_keys.iter().map(|k| (*k).to_owned()).collect(),
        }
    }

    fn secret(k: &str, v: &str) -> BTreeMap<String, String> {
        [(k.to_owned(), v.to_owned())].into()
    }

    #[test]
    fn a_new_server_never_replaces_an_existing_one() {
        let (_dir, lib) = lib();
        lib.save(def("", "My API", &["Authorization"]), secret("Authorization", "one")).unwrap();
        // A different name with the same slug.
        let err = lib.save(def("", "my  api!", &["Token"]), secret("Token", "two")).unwrap_err();
        assert!(format!("{err:#}").contains("already exists"), "{err:#}");
        let all = lib.list();
        assert_eq!((all.len(), all[0].name.as_str()), (1, "My API"));
        assert_eq!(lib.secrets.get("my-api/Authorization").unwrap().as_deref(), Some("one"));
        assert_eq!(lib.secrets.get("my-api/Token").unwrap(), None);
    }

    #[test]
    fn an_explicit_id_updates_and_prunes_secrets() {
        let (_dir, lib) = lib();
        lib.save(def("", "My API", &["A", "B"]), [("A".to_owned(), "a".to_owned()), ("B".to_owned(), "b".to_owned())].into()).unwrap();
        let saved = lib.save(def("my-api", "Renamed", &["A"]), BTreeMap::new()).unwrap();
        assert_eq!(saved.id, "my-api");
        let all = lib.list();
        assert_eq!((all.len(), all[0].name.as_str()), (1, "Renamed"));
        assert_eq!(lib.secrets.get("my-api/A").unwrap().as_deref(), Some("a"));
        assert_eq!(lib.secrets.get("my-api/B").unwrap(), None);
    }

    #[test]
    fn the_harness_id_is_reserved() {
        let (_dir, lib) = lib();
        assert!(lib.save(def("", "Harness", &[]), BTreeMap::new()).is_err());
        assert!(lib.save(def("harness", "Mine", &[]), BTreeMap::new()).is_err());
        assert!(lib.save(def("harness", "Harness", &[]), BTreeMap::new()).is_err());
        assert!(lib.list().is_empty());
    }
}
