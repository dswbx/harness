//! Prompt attachments: images and pasted files are stored in the Session Directory's
//! `attachments/`; each becomes the ACP content block the Agent accepts.

use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1 as acp;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;

use crate::api::{Attachment, AttachmentInput, AttachmentKind};

/// Largest image sent to an Agent.
const MAX_IMAGE: usize = 5 * 1024 * 1024;
/// Largest image file read for the prompt box preview; it is scaled down there before sending.
const MAX_IMAGE_READ: u64 = 25 * 1024 * 1024;
/// Largest text file embedded in a prompt; bigger files are linked instead.
const MAX_EMBED: usize = 1024 * 1024;

const DIR: &str = "attachments";

/// An attachment ready to send: what the Turn logs, the block for the Agent, and bytes still to
/// be stored at `attachment.path`.
pub struct Resolved {
    pub attachment: Attachment,
    pub block: acp::ContentBlock,
    store: Option<Vec<u8>>,
}

enum Source {
    Bytes(Vec<u8>),
    File(PathBuf),
}

/// Checks and resolves `inputs` without writing anything, so a rejected prompt leaves no trace.
/// `folder` is the Workspace Folder: files inside it are linked, the Agent can read them.
pub fn resolve(
    session_dir: &Path,
    folder: &Path,
    agent: &str,
    caps: &acp::PromptCapabilities,
    inputs: Vec<AttachmentInput>,
) -> anyhow::Result<Vec<Resolved>> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let store_dir = std::fs::canonicalize(session_dir)?.join(DIR);
    let folder = std::fs::canonicalize(folder).unwrap_or_else(|_| folder.to_owned());
    let mut out = Vec::new();
    for input in inputs {
        let (name, mime, source) = match input {
            AttachmentInput::Data { name, mime, data } => {
                let bytes = B64.decode(data.trim()).map_err(|e| anyhow::anyhow!("{name}: invalid base64 data ({e})"))?;
                (name, mime, Source::Bytes(bytes))
            }
            AttachmentInput::Path { path } => {
                let p = std::fs::canonicalize(&path).map_err(|e| anyhow::anyhow!("{path}: {e}"))?;
                anyhow::ensure!(p.is_file(), "{path} is not a file");
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone());
                (name, guess_mime(&p).to_owned(), Source::File(p))
            }
        };
        out.push(if is_image(&mime) {
            anyhow::ensure!(caps.image, "{agent} does not accept images.");
            let bytes = match source {
                Source::Bytes(b) => b,
                Source::File(p) => {
                    anyhow::ensure!(std::fs::metadata(&p)?.len() <= MAX_IMAGE as u64, "{name} is larger than 5 MB.");
                    std::fs::read(&p)?
                }
            };
            anyhow::ensure!(bytes.len() <= MAX_IMAGE, "{name} is larger than 5 MB.");
            let path = store_dir.join(stored_name(&name));
            let block = acp::ContentBlock::Image(acp::ImageContent::new(B64.encode(&bytes), mime.as_str()).uri(file_uri(&path)));
            Resolved { attachment: attachment(name, mime, &path, AttachmentKind::Image), block, store: Some(bytes) }
        } else {
            let (path, bytes) = match source {
                Source::Bytes(b) => (store_dir.join(stored_name(&name)), Some(b)),
                Source::File(p) => (p, None),
            };
            let uri = file_uri(&path);
            let text = if path.starts_with(&folder) || !caps.embedded_context {
                None
            } else {
                match &bytes {
                    Some(b) if b.len() <= MAX_EMBED => String::from_utf8(b.clone()).ok(),
                    Some(_) => None,
                    None if std::fs::metadata(&path)?.len() <= MAX_EMBED as u64 => String::from_utf8(std::fs::read(&path)?).ok(),
                    None => None,
                }
            };
            let block = match text {
                Some(text) => acp::ContentBlock::Resource(acp::EmbeddedResource::new(
                    acp::EmbeddedResourceResource::TextResourceContents(acp::TextResourceContents::new(text, uri).mime_type(mime.as_str())),
                )),
                None => acp::ContentBlock::ResourceLink(acp::ResourceLink::new(name.as_str(), uri).mime_type(mime.as_str())),
            };
            Resolved { attachment: attachment(name, mime, &path, AttachmentKind::File), block, store: bytes }
        });
    }
    Ok(out)
}

/// Writes the bytes of resolved attachments to `attachments/`.
pub fn store(resolved: &[Resolved]) -> anyhow::Result<()> {
    for r in resolved {
        if let Some(bytes) = &r.store {
            let path = Path::new(&r.attachment.path);
            std::fs::create_dir_all(path.parent().unwrap())?;
            std::fs::write(path, bytes)?;
        }
    }
    Ok(())
}

/// A stored attachment as `(mime, base64)`; refuses anything outside `attachments/`.
pub fn read(session_dir: &Path, path: &str) -> anyhow::Result<(String, String)> {
    let outside = || anyhow::anyhow!("{path} is not an attachment of this Session");
    let root = std::fs::canonicalize(session_dir.join(DIR)).map_err(|_| outside())?;
    let p = std::fs::canonicalize(path).map_err(|_| outside())?;
    anyhow::ensure!(p.starts_with(&root) && p != root && p.is_file(), outside());
    Ok((guess_mime(&p).to_owned(), B64.encode(std::fs::read(&p)?)))
}

/// An image file picked or dropped in the prompt box, as `(mime, base64)`, so the box can preview
/// and scale it like a pasted one. Refuses anything that isn't an image by extension.
pub fn read_image(path: &str) -> anyhow::Result<(String, String)> {
    let p = Path::new(path);
    let mime = guess_mime(p);
    anyhow::ensure!(is_image(mime), "{path} is not an image");
    let len = std::fs::metadata(p).map_err(|e| anyhow::anyhow!("{path}: {e}"))?.len();
    anyhow::ensure!(len <= MAX_IMAGE_READ, "{path} is too large ({} MB max)", MAX_IMAGE_READ / 1024 / 1024);
    Ok((mime.to_owned(), B64.encode(std::fs::read(p)?)))
}

fn attachment(name: String, mime: String, path: &Path, kind: AttachmentKind) -> Attachment {
    Attachment { name, mime, path: path.display().to_string(), kind }
}

/// Images an Agent can view; SVG is sent as a file.
pub(crate) fn is_image(mime: &str) -> bool {
    mime.starts_with("image/") && mime != "image/svg+xml"
}

/// `<uuid v7>-<name>`, with the name reduced to safe characters.
pub(crate) fn stored_name(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let safe = safe.trim_start_matches('.');
    let safe = if safe.is_empty() { "attachment" } else { safe };
    let skip = safe.len().saturating_sub(80);
    format!("{}-{}", uuid::Uuid::now_v7(), &safe[skip..])
}

fn file_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for b in path.to_string_lossy().bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri
}

pub(crate) fn guess_mime(path: &Path) -> &'static str {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "txt" | "log" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "toml" | "yaml" | "yml" | "sh" | "css" | "xml"
        | "c" | "h" | "cpp" | "java" | "swift" | "rb" | "sql" => "text/plain",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_names_are_safe() {
        let n = stored_name("../my shot.png");
        assert!(n.ends_with("-_my_shot.png"), "{n}");
        assert!(stored_name("...").ends_with("-attachment"));
    }

    #[test]
    fn read_image_only_reads_images() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.PNG");
        std::fs::write(&png, b"png").unwrap();
        std::fs::write(dir.path().join("b.txt"), b"secret").unwrap();
        assert_eq!(read_image(png.to_str().unwrap()).unwrap(), ("image/png".into(), B64.encode(b"png")));
        assert!(read_image(dir.path().join("b.txt").to_str().unwrap()).is_err());
        assert!(read_image(dir.path().join("missing.png").to_str().unwrap()).is_err());
    }

    #[test]
    fn file_uris_are_encoded() {
        assert_eq!(file_uri(Path::new("/a b/c%.txt")), "file:///a%20b/c%25.txt");
    }
}
