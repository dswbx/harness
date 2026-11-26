//! The `harness` command (ADR 0030): `harness diff [dir]` opens a Folder Diff window, `harness new
//! [dir]` opens the Composer with that folder. The client runs in `main.rs` before Tauri starts and
//! sends one request to the running app over a Unix socket of its data dir (`<data_dir>/cli.sock`),
//! so a dev build and the installed app never catch each other's calls. With no app running, a
//! bundled binary starts the app with `open -a` and waits for its socket.
//!
//! The app (`serve`) queues each request and pokes the main window (`cli-request`); its Shell takes
//! the queue with `cli_take` on mount and on every poke, so a request survives a cold start or a
//! reload. At quit the app removes its socket and refuses requests (`CliServer::stop`), so a client
//! never hands work to a dying app. Also: installing the command on the PATH (`install`, `uninstall`, from the app menu).

use std::collections::VecDeque;
use std::ffi::{OsStr, OsString};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// One request from the `harness` command. `folder` is absolute and canonical (the client resolves it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CliRequest {
    /// Open the Folder Diff window of `folder`.
    Diff { folder: String },
    /// Open the Composer with `folder` filled in.
    New { folder: String },
    /// Only bring the app to the front (a second launch with no command). Never queued.
    Focus,
}

pub const USAGE: &str = "Usage: harness [command]

Commands:
  diff [dir]      Open the diff window for a folder (default: the current folder)
  new [dir]       Start a new Session in a folder (default: the current folder)

Options:
  -h, --help      Show this help
  -V, --version   Show the version

With no command, harness opens the app or brings it to the front.";

/// Exit codes of the client.
pub const EXIT_OK: i32 = 0;
pub const EXIT_USAGE: i32 = 1;
pub const EXIT_BAD_DIR: i32 = 2;

/// What the process arguments ask for.
#[derive(Debug, PartialEq, Eq)]
pub enum Cmd {
    /// Start the app (no command, or flags that macOS passes to an app it launches).
    Gui,
    Help,
    Version,
    Diff(Option<OsString>),
    New(Option<OsString>),
}

/// Parses the arguments after the program name. Unknown commands are an error; arguments that
/// look like AppKit or LaunchServices flags (`-psn_…`, `-NSFoo`, `-AppleFoo`) start the app.
pub fn parse(args: &[OsString]) -> Result<Cmd, String> {
    let Some(first) = args.first() else { return Ok(Cmd::Gui) };
    let rest = &args[1..];
    let first_str = first.to_string_lossy();
    let cmd = match first_str.as_ref() {
        "-h" | "--help" | "help" => return Ok(Cmd::Help),
        "-V" | "--version" => return Ok(Cmd::Version),
        "diff" => Cmd::Diff,
        "new" => Cmd::New,
        s if s.starts_with("-psn_") || s.strip_prefix('-').is_some_and(|f| f.starts_with(|c: char| c.is_ascii_uppercase())) => return Ok(Cmd::Gui),
        s => return Err(format!("unknown command '{s}'")),
    };
    if rest.iter().any(|a| a == "-h" || a == "--help") {
        return Ok(Cmd::Help);
    }
    match rest {
        [] => Ok(cmd(None)),
        [dir] if !dir.to_string_lossy().starts_with('-') => Ok(cmd(Some(dir.clone()))),
        [one] => Err(format!("unknown option '{}'", one.to_string_lossy())),
        _ => Err(format!("'{first_str}' takes at most one folder")),
    }
}

/// `dir` (default `.`) against `cwd`, canonical; it must be a directory with a UTF-8 path.
pub fn resolve_dir(cwd: &Path, dir: Option<&OsStr>) -> Result<String, String> {
    let given = dir.unwrap_or(OsStr::new("."));
    let path = cwd.join(given);
    let shown = Path::new(given).display();
    let real = path.canonicalize().map_err(|_| format!("{shown}: no such folder"))?;
    if !real.is_dir() {
        return Err(format!("{shown}: not a folder"));
    }
    real.into_os_string().into_string().map_err(|_| format!("{shown}: the path is not valid UTF-8"))
}

/// Longest socket path we use: macOS allows 104 bytes in `sun_path`, with the trailing NUL.
const MAX_SOCKET_PATH: usize = 100;

/// The socket of a data dir: `<data_dir>/cli.sock`, or, when that path is too long for a Unix
/// socket, `harness-<hash of data_dir>.sock` in a private per-user dir (`private_dir`). Never `/tmp`.
pub fn socket_path(data_dir: &Path, tmpdir: Option<&OsStr>, home: &Path) -> io::Result<PathBuf> {
    let inside = data_dir.join("cli.sock");
    if inside.as_os_str().len() < MAX_SOCKET_PATH {
        return Ok(inside);
    }
    let dir = private_dir(tmpdir, home)?;
    let hash = fnv1a(data_dir.as_os_str().as_bytes());
    // A long `$TMPDIR` may leave no room for the readable name: try a bare hash.
    [format!("harness-{hash:016x}.sock"), format!("{hash:016x}")]
        .into_iter()
        .map(|name| dir.join(name))
        .find(|p| p.as_os_str().len() < MAX_SOCKET_PATH)
        .ok_or_else(|| io::Error::other(format!("{} is too long for a socket", dir.display())))
}

/// The dir for a fallback socket: `$TMPDIR` when set (per-user and mode 0700 on macOS), else
/// `<home>/Library/Caches/harness`, made with mode 0700. It must be a dir that we own and that no
/// one else can write to; otherwise another user could plant the socket path.
fn private_dir(tmpdir: Option<&OsStr>, home: &Path) -> io::Result<PathBuf> {
    let dir = match tmpdir.filter(|t| !t.is_empty()) {
        Some(t) => PathBuf::from(t),
        None => {
            let dir = home.join("Library/Caches/harness");
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
            dir
        }
    };
    let meta = std::fs::metadata(&dir)?;
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    if !meta.is_dir() || meta.uid() != me || meta.mode() & 0o022 != 0 {
        return Err(io::Error::other(format!("{} is not a private folder of this user", dir.display())));
    }
    Ok(dir)
}

/// FNV-1a: a hash that stays the same across builds and Rust versions (the client and the app may differ).
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

/// The socket of `data_dir`, from the environment. The client and the app both use it, so they agree.
fn socket_for(data_dir: &Path) -> io::Result<PathBuf> {
    let home = std::env::home_dir().ok_or_else(|| io::Error::other("no home folder"))?;
    socket_path(data_dir, std::env::var_os("TMPDIR").as_deref(), &home)
}

/// The socket of this build's data dir (same resolution as the app: `HARNESS_HOME`, else `~/.harness` or, in a dev build, `~/.harness-dev`).
fn this_socket() -> io::Result<PathBuf> {
    let home = std::env::home_dir().ok_or_else(|| io::Error::other("no home folder"))?;
    socket_for(&harness_core::host::default_data_dir(home, std::env::var_os("HARNESS_HOME"), cfg!(debug_assertions)))
}

/// Why a request did not get through.
#[derive(Debug)]
pub enum SendError {
    /// No app listens on the socket, or the one that does is quitting and refused the request.
    NotRunning,
    /// The app answered with an error, or the connection broke.
    Failed(String),
}

/// Sends one request and waits for the app's `ok`. Anything else but a clear error is `NotRunning`.
pub fn send(socket: &Path, req: &CliRequest) -> Result<(), SendError> {
    let mut stream = UnixStream::connect(socket).map_err(|_| SendError::NotRunning)?;
    let failed = |e: io::Error| SendError::Failed(e.to_string());
    stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(failed)?;
    let mut line = serde_json::to_string(req).map_err(|e| SendError::Failed(e.to_string()))?;
    line.push('\n');
    stream.write_all(line.as_bytes()).map_err(failed)?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).map_err(failed)?;
    match reply.trim() {
        "ok" => Ok(()),
        // A quitting app answers `quitting`; one that died mid-request closes the connection.
        QUITTING_REPLY | "" => Err(SendError::NotRunning),
        other => Err(SendError::Failed(other.to_owned())),
    }
}

/// The `.app` bundle that holds `exe` (`<bundle>.app/Contents/MacOS/<exe>`), if any.
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

fn this_exe() -> Option<PathBuf> {
    std::env::current_exe().ok()?.canonicalize().ok()
}

/// How long a cold start may take until the app's socket answers.
const COLD_START: Duration = Duration::from_secs(20);

/// The `harness` command, run before Tauri. `None`: start the app (no command, and, in a release
/// build, no running instance of this data dir to bring to the front). `Some(code)`: exit with it.
pub fn client(args: &[OsString]) -> Option<i32> {
    let cmd = match parse(args) {
        Ok(cmd) => cmd,
        Err(e) => {
            eprintln!("harness: {e}\n\n{USAGE}");
            return Some(EXIT_USAGE);
        }
    };
    let (make, dir): (fn(String) -> CliRequest, _) = match cmd {
        Cmd::Help => {
            println!("{USAGE}");
            return Some(EXIT_OK);
        }
        Cmd::Version => {
            println!("harness {}", version());
            return Some(EXIT_OK);
        }
        // A second launch of the installed app (the `harness` link run with no command) must not
        // start a second app on the same data dir: bring the running one to the front instead.
        // Dev builds skip this: several checkouts run `bun run dev` at once on `~/.harness-dev`.
        Cmd::Gui if cfg!(debug_assertions) => return None,
        Cmd::Gui => return this_socket().ok().and_then(|s| send(&s, &CliRequest::Focus).ok()).map(|()| EXIT_OK),
        Cmd::Diff(dir) => (|folder| CliRequest::Diff { folder }, dir),
        Cmd::New(dir) => (|folder| CliRequest::New { folder }, dir),
    };
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(e) => {
            eprintln!("harness: the current folder: {e}");
            return Some(EXIT_BAD_DIR);
        }
    };
    let folder = match resolve_dir(&cwd, dir.as_deref()) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("harness: {e}");
            return Some(EXIT_BAD_DIR);
        }
    };
    let req = make(folder);
    let socket = match this_socket() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("harness: {e}");
            return Some(EXIT_USAGE);
        }
    };
    Some(match deliver(&socket, &req) {
        Ok(()) => EXIT_OK,
        Err(e) => {
            eprintln!("harness: {e}");
            EXIT_USAGE
        }
    })
}

/// Sends `req`; with no app running, starts the bundle this binary is in and retries until it answers.
fn deliver(socket: &Path, req: &CliRequest) -> Result<(), String> {
    match send(socket, req) {
        Ok(()) => return Ok(()),
        Err(SendError::Failed(e)) => return Err(e),
        Err(SendError::NotRunning) => {}
    }
    let Some(bundle) = this_exe().as_deref().and_then(app_bundle) else {
        return Err(if cfg!(debug_assertions) { "Harness (dev) is not running: start it with `bun run dev`".into() } else { "Harness is not running".into() });
    };
    let started = std::process::Command::new("open").arg("-a").arg(&bundle).status().map_err(|e| format!("open {}: {e}", bundle.display()))?;
    if !started.success() {
        return Err(format!("could not start {}", bundle.display()));
    }
    let until = Instant::now() + COLD_START;
    loop {
        match send(socket, req) {
            Ok(()) => return Ok(()),
            Err(SendError::Failed(e)) => return Err(e),
            Err(SendError::NotRunning) if Instant::now() < until => std::thread::sleep(Duration::from_millis(100)),
            Err(SendError::NotRunning) => return Err(format!("Harness did not start within {}s", COLD_START.as_secs())),
        }
    }
}

/// The bundle's version (`CFBundleShortVersionString`), else the crate's (a dev build).
fn version() -> String {
    let plist = this_exe().as_deref().and_then(app_bundle).and_then(|b| std::fs::read_to_string(b.join("Contents/Info.plist")).ok());
    plist.as_deref().and_then(plist_version).map_or_else(|| format!("{} (dev)", env!("CARGO_PKG_VERSION")), str::to_owned)
}

fn plist_version(plist: &str) -> Option<&str> {
    let after = plist.split("<key>CFBundleShortVersionString</key>").nth(1)?;
    let start = after.find("<string>")? + "<string>".len();
    let len = after[start..].find("</string>")?;
    Some(after[start..start + len].trim())
}

// --- Server (the app) ---

/// Requests that came in and that the main window has not taken yet.
#[derive(Default)]
pub struct CliQueue(Mutex<VecDeque<CliRequest>>);

/// Device and inode of a file: tells our socket from a newer instance's at the same path.
type FileId = (u64, u64);

fn file_id(path: &Path) -> io::Result<FileId> {
    let m = std::fs::symlink_metadata(path)?;
    Ok((m.dev(), m.ino()))
}

/// The socket server's state, for quitting.
#[derive(Default)]
pub struct CliServer {
    stopped: AtomicBool,
    /// The socket we bound and its identity.
    bound: Mutex<Option<(PathBuf, FileId)>>,
}

impl CliServer {
    /// Quitting: from now on every request gets `quitting`, and our socket file is removed (only
    /// if it is still ours, a newer instance may own the path by now), so clients start the app.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some((path, id)) = self.bound.lock().take() {
            remove_if_ours(&path, id);
        }
    }
}

/// Stops the socket server of `app` (see `CliServer::stop`). Safe to call twice or without a server.
pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    if let Some(server) = app.try_state::<CliServer>() {
        server.stop();
    }
}

/// Removes `path` when it is a socket with identity `id`.
fn remove_if_ours(path: &Path, id: FileId) {
    let is_ours = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_socket() && (m.dev(), m.ino()) == id);
    if is_ours && let Err(e) = std::fs::remove_file(path) {
        tracing::warn!("cli: remove {}: {e}", path.display());
    }
}

/// Binds the socket of `socket`'s data dir. `Ok(None)`: another live instance owns it (its
/// connect succeeds), so this one leaves it alone. A stale socket file (no one listens) is removed.
pub fn bind(socket: &Path) -> io::Result<Option<UnixListener>> {
    if UnixStream::connect(socket).is_ok() {
        return Ok(None);
    }
    match std::fs::symlink_metadata(socket) {
        Ok(m) if m.file_type().is_socket() => std::fs::remove_file(socket)?,
        Ok(_) => return Err(io::Error::other(format!("{} exists and is not a socket", socket.display()))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    if let Some(dir) = socket.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let listener = UnixListener::bind(socket)?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    Ok(Some(listener))
}

/// Longest request line read (a folder path in JSON).
const MAX_LINE: u64 = 64 * 1024;

/// The reply of a quitting app: the request was not queued.
const QUITTING_REPLY: &str = "quitting";

/// Reads one request line, hands it to `on` and answers `ok` (or `error: …`). Once `stopped`, it
/// answers `quitting` and drops the request.
pub fn handle(stream: UnixStream, stopped: &AtomicBool, on: &dyn Fn(CliRequest)) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut line = String::new();
    BufReader::new((&stream).take(MAX_LINE)).read_line(&mut line)?;
    let reply = match serde_json::from_str::<CliRequest>(line.trim()) {
        _ if stopped.load(Ordering::SeqCst) => format!("{QUITTING_REPLY}\n"),
        Ok(req) => {
            on(req);
            "ok\n".to_owned()
        }
        Err(e) => format!("error: bad request: {e}\n"),
    };
    (&stream).write_all(reply.as_bytes())
}

/// Serves the socket of `data_dir` until `stop` (a thread). Skips binding when another instance
/// owns it. Needs `CliServer` in the managed state.
pub fn serve<R: Runtime>(app: &AppHandle<R>, data_dir: &Path) {
    let socket = match socket_for(data_dir) {
        Ok(s) => s,
        Err(e) => return tracing::warn!("cli: no socket path: {e}"),
    };
    let listener = match bind(&socket) {
        Ok(Some(l)) => l,
        Ok(None) => return tracing::warn!("cli: another instance serves {}", socket.display()),
        Err(e) => return tracing::warn!("cli: cannot listen on {}: {e}", socket.display()),
    };
    let server = app.state::<CliServer>();
    match file_id(&socket) {
        Ok(id) => *server.bound.lock() = Some((socket, id)),
        Err(e) => tracing::warn!("cli: stat {}: {e}", socket.display()),
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            if let Err(e) = handle(stream, &app.state::<CliServer>().stopped, &|req| receive(&app, req)) {
                tracing::warn!("cli: {e}");
            }
        }
    });
}

/// Queues the request (not `Focus`), brings the main window up and pokes it.
fn receive<R: Runtime>(app: &AppHandle<R>, req: CliRequest) {
    if req != CliRequest::Focus {
        app.state::<CliQueue>().0.lock().push_back(req);
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        show_main(&handle);
        if let Err(e) = handle.emit_to("main", "cli-request", ()) {
            tracing::warn!("cli: poke main: {e}");
        }
    });
}

/// Brings the main window to the front, made again from the config if it was closed, and makes
/// Harness the active app. A window that is still hidden (its page has not painted) shows itself
/// once painted. Main thread only.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window("main") {
        Some(main) => {
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
        None => {
            let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else { return };
            match tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
                Ok(main) => {
                    let _ = main.set_title(&app.package_info().name);
                }
                Err(e) => tracing::warn!("cli: recreate main window: {e}"),
            }
        }
    }
    #[cfg(target_os = "macos")]
    crate::overlay::activate_app();
}

/// The requests queued since the last call, oldest first. The main window's Shell calls it on
/// mount and on each `cli-request`.
#[tauri::command]
pub fn cli_take(queue: tauri::State<'_, CliQueue>) -> Vec<CliRequest> {
    queue.0.lock().drain(..).collect()
}

// --- Install on PATH (release builds, app menu) ---

/// Where the command is linked.
pub const LINK: &str = "/usr/local/bin/harness";

const MOVE_FIRST: &str = "Move Harness to the Applications folder first, then open it from there.";

/// The binary to link to: it must be inside a `.app` that is not translocated (macOS runs a
/// downloaded app from a random read-only path until it is moved) or on a mounted disk image.
pub fn install_source(exe: &Path) -> Result<&str, &'static str> {
    let s = exe.to_str().ok_or(MOVE_FIRST)?;
    if s.contains("/AppTranslocation/") || s.starts_with("/Volumes/") || app_bundle(exe).is_none() {
        return Err(MOVE_FIRST);
    }
    Ok(s)
}

/// What is at the link path now.
#[derive(Debug, PartialEq, Eq)]
pub enum Existing {
    Missing,
    /// A link to this binary.
    Ours,
    /// A link into another `Harness*.app` (an older install somewhere else).
    OtherHarness,
    /// Anything else: never removed without asking.
    Foreign,
}

pub fn existing(link: &Path, exe: &Path) -> Existing {
    let Ok(meta) = std::fs::symlink_metadata(link) else { return Existing::Missing };
    if !meta.file_type().is_symlink() {
        return Existing::Foreign;
    }
    match std::fs::read_link(link) {
        Ok(to) if to == exe => Existing::Ours,
        Ok(to) if points_into_harness(&to) => Existing::OtherHarness,
        _ => Existing::Foreign,
    }
}

/// Whether a link target lies inside a `Harness*.app` bundle.
pub fn points_into_harness(target: &Path) -> bool {
    target.components().any(|c| c.as_os_str().to_str().is_some_and(|n| n.starts_with("Harness") && n.ends_with(".app")))
}

/// `s` as one single-quoted `sh` word.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// An AppleScript that runs `cmd` with `sh` as root, after the system password prompt.
pub fn admin_script(cmd: &str) -> String {
    format!("do shell script \"{}\" with administrator privileges", cmd.replace('\\', r"\\").replace('"', "\\\""))
}

/// Runs `cmd` as root through the system password prompt. `Ok(false)`: the user cancelled.
fn run_as_admin(cmd: &str) -> Result<bool, String> {
    let out = std::process::Command::new("osascript").arg("-e").arg(admin_script(cmd)).output().map_err(|e| format!("osascript: {e}"))?;
    if out.status.success() {
        return Ok(true);
    }
    let err = String::from_utf8_lossy(&out.stderr);
    // -128: "User canceled."
    if err.contains("-128") { Ok(false) } else { Err(err.trim().to_owned()) }
}

fn message<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str, error: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog().message(body).title(title).kind(if error { MessageDialogKind::Error } else { MessageDialogKind::Info }).blocking_show();
}

/// Menu "Install 'harness' Command in PATH…": links `/usr/local/bin/harness` to this binary,
/// as root after a password prompt when the folder is not writable. Asks before replacing a file
/// Harness did not put there. Blocks: run it off the main thread.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    const TITLE: &str = "Install 'harness' command";
    let Some(exe) = this_exe() else { return message(app, TITLE, "Could not find the Harness binary.", true) };
    let exe_str = match install_source(&exe) {
        Ok(s) => s.to_owned(),
        Err(e) => return message(app, TITLE, e, true),
    };
    let link = Path::new(LINK);
    match existing(link, &exe) {
        Existing::Ours => return message(app, TITLE, &format!("{LINK} already runs this Harness."), false),
        Existing::Foreign => {
            let replace = app
                .dialog()
                .message(format!("{LINK} exists and was not installed by Harness. Replace it?"))
                .title(TITLE)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Replace".into(), "Cancel".into()))
                .blocking_show();
            if !replace {
                return;
            }
        }
        Existing::Missing | Existing::OtherHarness => {}
    }
    let direct = (|| {
        std::fs::create_dir_all("/usr/local/bin")?;
        if std::fs::symlink_metadata(link).is_ok() {
            std::fs::remove_file(link)?;
        }
        std::os::unix::fs::symlink(&exe, link)
    })();
    if direct.is_err() {
        let cmd = format!("mkdir -p /usr/local/bin && rm -f {l} && ln -s {e} {l}", l = sh_quote(LINK), e = sh_quote(&exe_str));
        match run_as_admin(&cmd) {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) => return message(app, TITLE, &format!("Could not create {LINK}: {e}"), true),
        }
    }
    message(app, TITLE, "Done. In a terminal, run `harness diff` or `harness new` in a project folder.", false);
}

/// Menu "Uninstall 'harness' Command…": removes the link only when it points into a Harness app.
pub fn uninstall<R: Runtime>(app: &AppHandle<R>) {
    const TITLE: &str = "Uninstall 'harness' command";
    let exe = this_exe().unwrap_or_default();
    let link = Path::new(LINK);
    match existing(link, &exe) {
        Existing::Missing => return message(app, TITLE, &format!("{LINK} is not installed."), false),
        Existing::Foreign => return message(app, TITLE, &format!("{LINK} was not installed by Harness, so it stays."), true),
        Existing::Ours | Existing::OtherHarness => {}
    }
    if std::fs::remove_file(link).is_err() {
        match run_as_admin(&format!("rm -f {}", sh_quote(LINK))) {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) => return message(app, TITLE, &format!("Could not remove {LINK}: {e}"), true),
        }
    }
    message(app, TITLE, &format!("Removed {LINK}."), false);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<OsString> {
        a.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_commands_and_flags() {
        assert_eq!(parse(&args(&[])), Ok(Cmd::Gui));
        assert_eq!(parse(&args(&["-psn_0_12345"])), Ok(Cmd::Gui));
        assert_eq!(parse(&args(&["-NSDocumentRevisionsDebugMode", "YES"])), Ok(Cmd::Gui));
        assert_eq!(parse(&args(&["--help"])), Ok(Cmd::Help));
        assert_eq!(parse(&args(&["-h"])), Ok(Cmd::Help));
        assert_eq!(parse(&args(&["-V"])), Ok(Cmd::Version));
        assert_eq!(parse(&args(&["--version"])), Ok(Cmd::Version));
        assert_eq!(parse(&args(&["diff"])), Ok(Cmd::Diff(None)));
        assert_eq!(parse(&args(&["diff", "../x"])), Ok(Cmd::Diff(Some("../x".into()))));
        assert_eq!(parse(&args(&["new", "/a b"])), Ok(Cmd::New(Some("/a b".into()))));
        assert_eq!(parse(&args(&["new", "--help"])), Ok(Cmd::Help));
        assert!(parse(&args(&["dif"])).is_err());
        assert!(parse(&args(&["--nope"])).is_err());
        assert!(parse(&args(&["diff", "a", "b"])).is_err());
        assert!(parse(&args(&["diff", "--x"])).is_err());
    }

    #[test]
    fn resolves_dirs_against_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("file.txt"), "x").unwrap();
        assert_eq!(resolve_dir(&root, None).unwrap(), root.to_str().unwrap());
        assert_eq!(resolve_dir(&root.join("sub"), Some(OsStr::new(".."))).unwrap(), root.to_str().unwrap());
        assert_eq!(resolve_dir(&root, Some(OsStr::new("sub"))).unwrap(), root.join("sub").to_str().unwrap());
        let abs = root.join("sub");
        assert_eq!(resolve_dir(Path::new("/"), Some(abs.as_os_str())).unwrap(), abs.to_str().unwrap());
        assert!(resolve_dir(&root, Some(OsStr::new("missing"))).unwrap_err().contains("no such folder"));
        assert!(resolve_dir(&root, Some(OsStr::new("file.txt"))).unwrap_err().contains("not a folder"));
    }

    /// A temp dir with a short path: the fallback socket must fit in it (CI's `$TMPDIR` is long).
    fn short_tempdir() -> tempfile::TempDir {
        tempfile::Builder::new().tempdir_in("/tmp").unwrap()
    }

    fn private(dir: &Path) {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn socket_path_falls_back_to_a_private_dir_when_too_long() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let tmpdir = tmp.path().join("t");
        std::fs::create_dir(&tmpdir).unwrap();
        private(&tmpdir);
        let short = socket_path(Path::new("/Users/u/.harness"), Some(tmpdir.as_os_str()), &home).unwrap();
        assert_eq!(short, Path::new("/Users/u/.harness/cli.sock"));
        let long = PathBuf::from(format!("/Users/u/{}", "d".repeat(100)));
        let a = socket_path(&long, Some(tmpdir.as_os_str()), &home).unwrap();
        assert!(a.starts_with(&tmpdir) && a.to_string_lossy().ends_with(".sock"), "{a:?}");
        assert_eq!(a, socket_path(&long, Some(tmpdir.as_os_str()), &home).unwrap(), "same dir, same socket");
        assert_ne!(a, socket_path(&long.join("other"), Some(tmpdir.as_os_str()), &home).unwrap(), "other dir, other socket");
    }

    #[test]
    fn socket_path_without_tmpdir_uses_the_home_cache_never_tmp() {
        let tmp = short_tempdir();
        let home = tmp.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let long = PathBuf::from(format!("/Users/u/{}", "d".repeat(100)));
        for unset in [None, Some(OsStr::new(""))] {
            let p = socket_path(&long, unset, &home).unwrap();
            assert!(p.starts_with(home.join("Library/Caches/harness")), "{p:?}");
            assert_ne!(p.parent(), Some(Path::new("/tmp")), "never directly in the shared /tmp");
            assert!(p.as_os_str().len() < MAX_SOCKET_PATH);
        }
        let mode = std::fs::metadata(home.join("Library/Caches/harness")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn socket_path_refuses_an_insecure_fallback_dir() {
        let tmp = short_tempdir();
        let home = tmp.path().join("home");
        let cache = home.join("Library/Caches/harness");
        std::fs::create_dir_all(&cache).unwrap();
        let long = PathBuf::from(format!("/Users/u/{}", "d".repeat(100)));
        for mode in [0o777, 0o770, 0o702] {
            std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(mode)).unwrap();
            assert!(socket_path(&long, None, &home).is_err(), "mode {mode:o}");
            assert!(socket_path(&long, Some(cache.as_os_str()), &home).is_err(), "mode {mode:o} as TMPDIR");
        }
        std::fs::set_permissions(&cache, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(socket_path(&long, None, &home).is_ok());
        // A shared dir that we do not own (`/tmp` as `$TMPDIR`) is refused.
        assert!(socket_path(&long, Some(OsStr::new("/tmp")), &home).is_err());
        // A file is no dir.
        let file = tmp.path().join("file");
        std::fs::write(&file, "x").unwrap();
        assert!(socket_path(&long, Some(file.as_os_str()), &home).is_err());
    }

    #[test]
    fn request_wire_format() {
        let json = serde_json::to_string(&CliRequest::Diff { folder: "/a".into() }).unwrap();
        assert_eq!(json, r#"{"kind":"diff","folder":"/a"}"#);
        assert_eq!(serde_json::to_string(&CliRequest::Focus).unwrap(), r#"{"kind":"focus"}"#);
    }

    #[test]
    fn round_trip_over_a_socket() {
        let tmp = tempfile::tempdir().unwrap();
        let sock = tmp.path().join("cli.sock");
        assert!(matches!(send(&sock, &CliRequest::Focus), Err(SendError::NotRunning)));
        let listener = bind(&sock).unwrap().expect("free socket");
        let mode = std::fs::metadata(&sock).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let got = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = got.clone();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                handle(stream, &AtomicBool::new(false), &|r| seen.lock().push(r)).unwrap();
            }
        });
        let req = CliRequest::New { folder: "/x y".into() };
        send(&sock, &req).unwrap();
        let mut bad = UnixStream::connect(&sock).unwrap();
        bad.write_all(b"{\"kind\":\"nope\"}\n").unwrap();
        let mut reply = String::new();
        BufReader::new(bad).read_line(&mut reply).unwrap();
        assert!(reply.starts_with("error:"), "{reply}");
        server.join().unwrap();
        assert_eq!(*got.lock(), vec![req]);
    }

    #[test]
    fn live_socket_is_left_alone_stale_one_is_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let sock = tmp.path().join("cli.sock");
        let live = bind(&sock).unwrap().expect("free socket");
        assert!(bind(&sock).unwrap().is_none(), "another instance owns it");
        drop(live);
        // The file stays after the listener is gone: stale.
        assert!(sock.exists());
        assert!(bind(&sock).unwrap().is_some(), "stale socket replaced");
        let file = tmp.path().join("plain");
        std::fs::write(&file, "x").unwrap();
        assert!(bind(&file).is_err(), "a non-socket file is never removed");
        assert!(file.exists());
    }

    #[test]
    fn stop_removes_our_socket_only() {
        let tmp = tempfile::tempdir().unwrap();
        let sock = tmp.path().join("cli.sock");
        let _live = bind(&sock).unwrap().expect("free socket");
        let server = CliServer::default();
        *server.bound.lock() = Some((sock.clone(), file_id(&sock).unwrap()));
        server.stop();
        assert!(server.stopped.load(Ordering::SeqCst));
        assert!(!sock.exists(), "our socket is removed");
        assert!(matches!(send(&sock, &CliRequest::Focus), Err(SendError::NotRunning)));
        server.stop();

        // A newer instance's socket at the same path stays. The old one is still alive while the
        // new one is made, so the inodes differ.
        let sock = tmp.path().join("again.sock");
        let _old = bind(&sock).unwrap().expect("free socket");
        let old_id = file_id(&sock).unwrap();
        let other = tmp.path().join("other.sock");
        let _newer = bind(&other).unwrap().expect("free socket");
        std::fs::rename(&other, &sock).unwrap();
        let server = CliServer::default();
        *server.bound.lock() = Some((sock.clone(), old_id));
        server.stop();
        assert!(sock.exists(), "a different socket is not ours");

        // Nor a plain file.
        let file = tmp.path().join("plain");
        std::fs::write(&file, "x").unwrap();
        let server = CliServer::default();
        *server.bound.lock() = Some((file.clone(), file_id(&file).unwrap()));
        server.stop();
        assert!(file.exists());
    }

    #[test]
    fn a_stopped_server_refuses_and_the_client_sees_not_running() {
        let tmp = tempfile::tempdir().unwrap();
        let sock = tmp.path().join("cli.sock");
        let listener = bind(&sock).unwrap().expect("free socket");
        let got = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = got.clone();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle(stream, &AtomicBool::new(true), &|r| seen.lock().push(r)).unwrap();
        });
        let req = CliRequest::Diff { folder: "/x".into() };
        assert!(matches!(send(&sock, &req), Err(SendError::NotRunning)));
        server.join().unwrap();
        assert!(got.lock().is_empty(), "the request is dropped");

        // A server that closes the connection without an answer is not running either.
        let listener = UnixListener::bind(tmp.path().join("dead.sock")).unwrap();
        let closing = std::thread::spawn(move || drop(listener.accept().unwrap()));
        assert!(matches!(send(&tmp.path().join("dead.sock"), &req), Err(SendError::NotRunning)));
        closing.join().unwrap();
    }

    #[test]
    fn finds_the_app_bundle() {
        assert_eq!(app_bundle(Path::new("/Applications/Harness.app/Contents/MacOS/harness")), Some(PathBuf::from("/Applications/Harness.app")));
        assert_eq!(app_bundle(Path::new("/repo/target/debug/harness")), None);
        assert_eq!(app_bundle(Path::new("/x/Contents/MacOS/harness")), None);
    }

    #[test]
    fn install_source_rejects_translocated_and_loose_binaries() {
        let ok = Path::new("/Applications/Harness.app/Contents/MacOS/harness");
        assert_eq!(install_source(ok), Ok("/Applications/Harness.app/Contents/MacOS/harness"));
        assert!(install_source(Path::new("/private/var/folders/x/T/AppTranslocation/ABC/d/Harness.app/Contents/MacOS/harness")).is_err());
        assert!(install_source(Path::new("/Volumes/Harness/Harness.app/Contents/MacOS/harness")).is_err());
        assert!(install_source(Path::new("/repo/target/release/harness")).is_err());
    }

    #[test]
    fn classifies_the_existing_link() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = Path::new("/Applications/Harness.app/Contents/MacOS/harness");
        let link = tmp.path().join("harness");
        assert_eq!(existing(&link, exe), Existing::Missing);
        std::os::unix::fs::symlink(exe, &link).unwrap();
        assert_eq!(existing(&link, exe), Existing::Ours);
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink("/Users/u/Desktop/Harness 2.app/Contents/MacOS/harness", &link).unwrap();
        assert_eq!(existing(&link, exe), Existing::OtherHarness);
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink("/opt/other/bin/harness", &link).unwrap();
        assert_eq!(existing(&link, exe), Existing::Foreign);
        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, "#!/bin/sh").unwrap();
        assert_eq!(existing(&link, exe), Existing::Foreign);
    }

    #[test]
    fn quotes_for_sh_and_applescript() {
        assert_eq!(sh_quote("/a b/it's"), r"'/a b/it'\''s'");
        assert_eq!(admin_script(r#"ln -s '/a "b" \c' x"#), r#"do shell script "ln -s '/a \"b\" \\c' x" with administrator privileges"#);
    }

    #[test]
    fn reads_the_bundle_version() {
        let plist = "<dict>\n<key>CFBundleName</key>\n<string>Harness</string>\n<key>CFBundleShortVersionString</key>\n\t<string>2026.11.3</string>\n</dict>";
        assert_eq!(plist_version(plist), Some("2026.11.3"));
        assert_eq!(plist_version("<dict></dict>"), None);
    }
}
