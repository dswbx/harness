//! Throwaway ACP client spike. See ../../docs/spikes/acp-client.md
//!
//! usage: acp-client-spike --agent claude|codex|"<cmd>" [--cwd DIR] [--prompt P]
//!        [--set id=value]... [--mode ID] [--load ID | --resume ID] [--list] [--close] [--no-prompt]
//! stdout: one JSON object per line: {"ev": "...", ...}. agent stderr -> our stderr (prefixed).

use agent_client_protocol::schema::v1::*;
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo, LineDirection};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

fn emit(ev: &str, v: Value) {
    println!("{}", json!({ "ev": ev, "data": v }));
}

fn to_v<T: serde::Serialize>(t: &T) -> Value {
    serde_json::to_value(t).unwrap_or(Value::Null)
}

type Exit = Option<(Option<u32>, Option<String>)>;

struct Term {
    out: Arc<Mutex<String>>,
    exit: watch::Receiver<Exit>,
    kill: mpsc::UnboundedSender<()>,
}

type Terms = Arc<Mutex<HashMap<String, Arc<Term>>>>;

fn spawn_term(req: &CreateTerminalRequest) -> std::io::Result<Term> {
    // adapters may send a whole shell line in `command` with empty args
    let mut cmd = if req.args.is_empty() && req.command.contains(' ') {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&req.command);
        c
    } else {
        let mut c = Command::new(&req.command);
        c.args(&req.args);
        c
    };
    for e in &req.env {
        cmd.env(&e.name, &e.value);
    }
    if let Some(cwd) = &req.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn()?;
    let out = Arc::new(Mutex::new(String::new()));
    let (etx, erx) = watch::channel::<Exit>(None);
    let (ktx, mut krx) = mpsc::unbounded_channel::<()>();
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let limit = req.output_byte_limit.unwrap_or(1 << 20) as usize;
    for mut r in [
        Box::new(so) as Box<dyn tokio::io::AsyncRead + Unpin + Send>,
        Box::new(se),
    ] {
        let out = out.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 4096];
            while let Ok(n) = r.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut o = out.lock().unwrap();
                if o.len() < limit {
                    o.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
            }
        });
    }
    tokio::spawn(async move {
        let st = tokio::select! {
            s = child.wait() => s.ok(),
            _ = krx.recv() => { let _ = child.kill().await; child.wait().await.ok() }
        };
        use std::os::unix::process::ExitStatusExt;
        let v = st.map(|s| (s.code().map(|c| c as u32), s.signal().map(|x| x.to_string())));
        // let readers drain
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = etx.send(Some(v.unwrap_or((None, None))));
    });
    Ok(Term { out, exit: erx, kill: ktx })
}

struct Args {
    agent: String,
    cwd: Option<PathBuf>,
    prompt: Option<String>,
    sets: Vec<(String, String)>,
    mode: Option<String>,
    load: Option<String>,
    resume: Option<String>,
    list: bool,
    close: bool,
}

fn parse_args() -> Args {
    let mut a = Args {
        agent: "claude".into(),
        cwd: None,
        prompt: Some("Create a file hello.txt containing 'hi', then run `ls` and tell me the result.".into()),
        sets: vec![],
        mode: None,
        load: None,
        resume: None,
        list: false,
        close: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        match k.as_str() {
            "--agent" => a.agent = it.next().unwrap(),
            "--cwd" => a.cwd = Some(it.next().unwrap().into()),
            "--prompt" => a.prompt = Some(it.next().unwrap()),
            "--no-prompt" => a.prompt = None,
            "--set" => {
                let s = it.next().unwrap();
                let (k, v) = s.split_once('=').unwrap();
                a.sets.push((k.into(), v.into()));
            }
            "--mode" => a.mode = it.next(),
            "--load" => a.load = it.next(),
            "--resume" => a.resume = it.next(),
            "--list" => a.list = true,
            "--close" => a.close = true,
            other => panic!("unknown arg {other}"),
        }
    }
    a
}

#[tokio::main] // default multi-thread runtime; no LocalSet needed
async fn main() -> anyhow::Result<()> {
    let args = parse_args();
    let cwd = match &args.cwd {
        Some(c) => c.clone(),
        None => {
            let d = std::env::temp_dir().join(format!("acp-spike-{}", std::process::id()));
            std::fs::create_dir_all(&d)?;
            std::fs::write(d.join("main.py"), "print('hello')\n")?;
            std::fs::write(d.join("README.md.bak"), "tiny project\n")?;
            let _ = std::process::Command::new("git").arg("init").arg("-q").current_dir(&d).status();
            d
        }
    };
    let cwd = cwd.canonicalize()?;
    eprintln!("[spike] cwd={}", cwd.display());

    let cmd = match args.agent.as_str() {
        "claude" => "npx -y @agentclientprotocol/claude-agent-acp".to_string(),
        "codex" => "npx -y @agentclientprotocol/codex-acp".to_string(),
        other => other.to_string(),
    };
    let agent = AcpAgent::from_str(&cmd)?.with_debug(|line, dir| {
        if matches!(dir, LineDirection::Stderr) {
            eprintln!("[agent-stderr] {line}");
        }
    });

    let terms: Terms = Default::default();
    let (t_create, t_out, t_wait, t_kill, t_rel) =
        (terms.clone(), terms.clone(), terms.clone(), terms.clone(), terms.clone());
    let n = Arc::new(std::sync::atomic::AtomicU64::new(0));

    Client
        .builder()
        .name("harness-acp-spike")
        .on_receive_notification(
            async move |n: SessionNotification, _cx| {
                let u = to_v(&n.update);
                let kind = u.get("sessionUpdate").and_then(|k| k.as_str()).unwrap_or("?").to_string();
                emit("session/update", json!({"kind": kind, "update": u}));
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |req: RequestPermissionRequest, responder, _cx| {
                let pick = req
                    .options
                    .iter()
                    .find(|o| matches!(o.kind, PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways))
                    .or(req.options.first())
                    .map(|o| o.option_id.clone());
                emit("request_permission", json!({"req": to_v(&req), "picked": pick.as_ref().map(to_v)}));
                match pick {
                    Some(id) => responder.respond(RequestPermissionResponse::new(
                        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
                    )),
                    None => responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: ReadTextFileRequest, responder, _cx| {
                emit("fs/read_text_file", to_v(&req));
                match std::fs::read_to_string(&req.path) {
                    Ok(s) => {
                        let s = match (req.line, req.limit) {
                            (None, None) => s,
                            (l, lim) => s
                                .lines()
                                .skip(l.unwrap_or(1).saturating_sub(1) as usize)
                                .take(lim.map(|x| x as usize).unwrap_or(usize::MAX))
                                .collect::<Vec<_>>()
                                .join("\n"),
                        };
                        responder.respond(ReadTextFileResponse::new(s))
                    }
                    Err(e) => responder.respond_with_error(agent_client_protocol::util::internal_error(e.to_string())),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: WriteTextFileRequest, responder, _cx| {
                emit("fs/write_text_file", json!({"path": req.path, "bytes": req.content.len()}));
                match std::fs::write(&req.path, &req.content) {
                    Ok(_) => responder.respond(WriteTextFileResponse::new()),
                    Err(e) => responder.respond_with_error(agent_client_protocol::util::internal_error(e.to_string())),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: CreateTerminalRequest, responder, _cx| {
                emit("terminal/create", to_v(&req));
                match spawn_term(&req) {
                    Ok(t) => {
                        let id = format!("term-{}", n.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
                        t_create.lock().unwrap().insert(id.clone(), Arc::new(t));
                        responder.respond(CreateTerminalResponse::new(id))
                    }
                    Err(e) => responder.respond_with_error(agent_client_protocol::util::internal_error(e.to_string())),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: TerminalOutputRequest, responder, _cx| {
                let t = t_out.lock().unwrap().get(&req.terminal_id.to_string()).cloned();
                let Some(t) = t else {
                    return responder.respond_with_error(agent_client_protocol::util::internal_error("no such terminal"));
                };
                let out = t.out.lock().unwrap().clone();
                let ex = t.exit.borrow().clone();
                emit("terminal/output", json!({"id": req.terminal_id, "out": out, "exit": ex}));
                let mut r = TerminalOutputResponse::new(out, false);
                if let Some((c, s)) = ex {
                    let mut st = TerminalExitStatus::new();
                    st = st.exit_code(c).signal(s);
                    r = r.exit_status(st);
                }
                responder.respond(r)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: WaitForTerminalExitRequest, responder, cx| {
                emit("terminal/wait_for_exit", to_v(&req));
                let t = t_wait.lock().unwrap().get(&req.terminal_id.to_string()).cloned();
                let Some(t) = t else {
                    return responder.respond_with_error(agent_client_protocol::util::internal_error("no such terminal"));
                };
                // don't block the dispatch loop while waiting
                cx.spawn(async move {
                    let mut rx = t.exit.clone();
                    let ex = loop {
                        if let Some(e) = rx.borrow().clone() {
                            break e;
                        }
                        if rx.changed().await.is_err() {
                            break (None, None);
                        }
                    };
                    emit("terminal/exited", json!({"exit": ex}));
                    responder.respond(WaitForTerminalExitResponse::new(
                        TerminalExitStatus::new().exit_code(ex.0).signal(ex.1),
                    ))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: KillTerminalRequest, responder, _cx| {
                emit("terminal/kill", to_v(&req));
                if let Some(t) = t_kill.lock().unwrap().get(&req.terminal_id.to_string()) {
                    let _ = t.kill.send(());
                }
                responder.respond(KillTerminalResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |req: ReleaseTerminalRequest, responder, _cx| {
                emit("terminal/release", to_v(&req));
                if let Some(t) = t_rel.lock().unwrap().remove(&req.terminal_id.to_string()) {
                    let _ = t.kill.send(());
                }
                responder.respond(ReleaseTerminalResponse::new())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |c: ConnectionTo<Agent>| async move {
            let init = c
                .send_request(
                    InitializeRequest::new(ProtocolVersion::V1)
                        .client_capabilities(
                            ClientCapabilities::new()
                                .fs(FileSystemCapabilities::new().read_text_file(true).write_text_file(true))
                                .terminal(true),
                        )
                        .client_info(Implementation::new("harness-acp-spike", "0.0.0")),
                )
                .block_task()
                .await?;
            emit("initialize", to_v(&init));

            if args.list {
                let l = c.send_request(ListSessionsRequest::new()).block_task().await;
                emit("session/list", match &l { Ok(r) => to_v(r), Err(e) => json!({"error": e.to_string()}) });
            }

            let sid: SessionId = if let Some(id) = &args.load {
                let r = c.send_request(LoadSessionRequest::new(id.clone(), cwd.clone())).block_task().await?;
                emit("session/load.response", to_v(&r));
                SessionId::new(id.clone())
            } else if let Some(id) = &args.resume {
                let r = c.send_request(ResumeSessionRequest::new(id.clone(), cwd.clone())).block_task().await?;
                emit("session/resume.response", to_v(&r));
                SessionId::new(id.clone())
            } else {
                let r = c.send_request(NewSessionRequest::new(cwd.clone())).block_task().await?;
                emit("session/new.response", to_v(&r));
                r.session_id
            };
            eprintln!("[spike] session id = {sid}");

            if let Some(m) = &args.mode {
                let r = c.send_request(SetSessionModeRequest::new(sid.clone(), m.clone())).block_task().await;
                emit("session/set_mode", match &r { Ok(r) => to_v(r), Err(e) => json!({"error": e.to_string()}) });
            }
            for (k, v) in &args.sets {
                let r = c
                    .send_request(SetSessionConfigOptionRequest::new(sid.clone(), k.clone(), v.as_str()))
                    .block_task()
                    .await;
                emit("session/set_config_option", match &r { Ok(r) => to_v(r), Err(e) => json!({"error": e.to_string()}) });
            }

            if let Some(p) = &args.prompt {
                let r = c
                    .send_request(PromptRequest::new(sid.clone(), vec![ContentBlock::Text(TextContent::new(p.clone()))]))
                    .block_task()
                    .await?;
                emit("prompt.response", to_v(&r));
            }
            if args.close {
                let r = c.send_request(CloseSessionRequest::new(sid.clone())).block_task().await;
                emit("session/close", match &r { Ok(r) => to_v(r), Err(e) => json!({"error": e.to_string()}) });
            }
            Ok(())
        })
        .await?;
    Ok(())
}
