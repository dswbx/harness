# Spike: rmcp streamable-HTTP server, stdio shim, login-shell env

Code: `harness/spikes/rmcp-server/` (throwaway, uncommitted). Run: `cargo run` (server, port 0 prints `LISTEN http://127.0.0.1:<port>/mcp`), `spike client <url> <token>`, `spike mcp-shim`, `spike env`. Tokens hardcoded: `tok-session-A` -> `sess-A`, `tok-session-B` -> `sess-B`.

## Versions

rmcp 3.7.0 (features: `server client macros transport-streamable-http-server transport-streamable-http-client-reqwest transport-io`), axum 0.8.9, schemars 1.x, tokio 1, cargo 1.98. codex-cli 0.160.0. MCP protocol negotiated: 2025-06-18.

## Result summary

| Part | Result |
|---|---|
| A: rmcp server in axum, bearer + Origin reject, token->session, curl + rmcp client | works |
| B: codex via HTTP url + bearer env var | works (server logged `session=sess-A`) |
| B: `claude -p --mcp-config` | NOT verified: CLI returns `401 OAuth access token is invalid` even for `claude -p "say ok"` (also with `env -i`, sandbox off); `claude auth status` says logged in. User must re-login, then rerun the command below |
| C: stdio shim | works (naive line proxy; tested by piping JSON and via codex stdio config); claude stdio untested (same auth issue) |
| D: login-shell env | works, ~0.5s with oh-my-zsh + nvm |

## Part A: server

Layout: axum `Router::new().nest_service("/mcp", StreamableHttpService).layer(auth middleware)`. Middleware runs before rmcp: rejects any request with `Origin` (403), missing/unknown bearer (401), else inserts `HarnessSession(String)` into request extensions. rmcp copies `http::request::Parts` into the tool request context, so tools take `Extension<http::request::Parts>` and read `parts.extensions.get::<HarnessSession>()`. This is per call (not per MCP session), so token->Harness session attribution is exact.

```rust
#[tool_router]
impl Harness {
    #[tool(description = "Echo text back")]
    async fn echo(&self, Extension(parts): Extension<http::request::Parts>,
                  Parameters(EchoArgs { text }): Parameters<EchoArgs>) -> Result<CallToolResult, ErrorData> {
        eprintln!("[tool] echo session={}", sid(&parts));
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
    }
}
#[tool_handler]
impl ServerHandler for Harness {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }
}

let svc = StreamableHttpService::new(
    move || Ok(Harness { git_dir: git_dir.clone() }),
    Arc::new(LocalSessionManager::default()),
    StreamableHttpServerConfig::default().enforce_origin_validation(), // empty allowlist => reject ANY Origin
);
let app = Router::new().nest_service("/mcp", svc)
    .layer(middleware::from_fn_with_state(AuthState { tokens }, auth));
let l = TcpListener::bind(("127.0.0.1", 0)).await?; // random port
```

rmcp also validates `Host` by default (localhost/127.0.0.1/::1, anti DNS-rebinding) and has its own Origin check (`enforce_origin_validation()`); our middleware is belt and braces plus the bearer check.

curl results (initialize -> `notifications/initialized` -> tools/list -> tools/call): no token 401; `Origin: http://evil.com` 403; valid flow 200, `Mcp-Session-Id` header on the initialize response (send it + `MCP-Protocol-Version` afterwards), notification gets 202, responses SSE-framed. rmcp client works too: `StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(url).auth_header(token))`, `().serve(t)`, `list_all_tools()`, `call_tool(CallToolRequestParams::new("echo").with_arguments(map))`.

### Gotchas

- 3.x API changes: `Content` -> `ContentBlock`; `ServerInfo::new(caps)` builder; `StreamableHttpServerConfig` is `#[non_exhaustive]` (builder methods only); `auth_header(token)` takes the raw token without `Bearer `.
- MCP-session hijack: `LocalSessionManager` does not bind `Mcp-Session-Id` to the creating token. Token B with token A's session id worked; the call was attributed to B (we read the token per request, so attribution is right), but rmcp session state is shared. Fine for attribution; for isolation use stateless mode (`NeverSessionManager`; spec 2026-07-28 SEP-2567 removes sessions anyway) or check token==creator in middleware.
- Responses are SSE even for simple calls (priming `data:` + `retry: 3000`); `json_response = true` prefers plain JSON when no interim messages. Clients must handle both.
- curl needs `Accept: application/json, text/event-stream`. zsh does not word-split `$H` header vars (gave misleading 400s); use arrays or bash.
- Parameterless tool: no `Parameters` arg; schema is `{"type":"object"}`.

## Part B: real agents

Codex works (one cheap run, ~10k tokens). Token via env var so it never lands in argv:

```sh
HARNESS_TOK=tok-session-A codex exec --skip-git-repo-check -s read-only \
  -c 'mcp_servers.harness.url="http://127.0.0.1:PORT/mcp"' \
  -c 'mcp_servers.harness.bearer_token_env_var="HARNESS_TOK"' \
  -c 'mcp_servers.harness.default_tools_approval_mode="approve"' \
  "call the harness echo tool with text 'ping-codex' and report the result" </dev/null
```

Server log: `[tool] echo session=sess-A text="ping-codex"`. Approval mode override likely needed for non-interactive exec (not tested without). Codex sends no `Origin`. Running it from within a sandboxed shell needed sandbox off (needs `~/.codex` + network).

Claude Code (not verified, auth 401). Prepared:

```sh
echo '{"mcpServers":{"harness":{"type":"http","url":"http://127.0.0.1:PORT/mcp","headers":{"Authorization":"Bearer tok-session-A"}}}}' > mcp.json
claude -p "call the echo tool from the harness MCP server with text 'ping' and report" \
  --mcp-config mcp.json --strict-mcp-config --allowedTools mcp__harness__echo --model haiku </dev/null
```

Notes: `--strict-mcp-config` isolates from user MCP config; tools are `mcp__<server>__<tool>`; use `</dev/null` (CLI waits 3s for stdin); when testing from inside another Claude session scrub inherited `CLAUDE_CODE_*`/`ANTHROPIC_*` env. In the real product the path is ACP `session/new` with `mcpServers: [{type:"http", name, url, headers:[{name:"Authorization", value:"Bearer ..."}]}]` (agent must advertise `mcpCapabilities.http`), else fall back to the shim.

## Part C: stdio shim

Naive approach (~40 lines, reqwest): per stdin line (one JSON-RPC message) POST to `HARNESS_MCP_URL` with `Authorization: Bearer $HARNESS_MCP_TOKEN` + `Accept: application/json, text/event-stream`; remember `Mcp-Session-Id` from the first response and send it after; write body (JSON) or each SSE `data:` payload as one line to stdout; 202 notifications write nothing.

```rust
let mut rb = http.post(&url).bearer_auth(&tok)
    .header("accept", "application/json, text/event-stream")
    .header("content-type", "application/json").body(line);
if let Some(s) = &session { rb = rb.header("mcp-session-id", s); }
let resp = rb.send().await?;
// capture mcp-session-id; if content-type starts with text/event-stream: print each `data:` line, else print body
```

Tested: piped initialize/initialized/tools/call returns correct responses; codex end to end via stdio config (`mcp_servers.hs.command=<spike>`, `args=["mcp-shim"]`, `env={HARNESS_MCP_URL=..., HARNESS_MCP_TOKEN=...}`; log `session=sess-B text="ping-shim"`). Claude stdio form (untested): `{"mcpServers":{"harness":{"type":"stdio","command":"/path/spike","args":["mcp-shim"],"env":{"HARNESS_MCP_URL":"...","HARNESS_MCP_TOKEN":"..."}}}}`.

Limits of naive shim: no server->client streams (GET SSE, sampling, elicitation, late progress), no reconnect/`Last-Event-ID`, no DELETE on shutdown. OK for request/response tools. Upgrade path if needed: rmcp stdio server (`transport-io`) whose `ServerHandler` delegates `list_tools`/`call_tool` to an rmcp HTTP client `Peer` (not built). Ship the shim as a subcommand of the Harness binary itself (`harness mcp-shim`) so there is one signed binary.

## Part D: login-shell env on macOS

GUI apps (launchd) get minimal env (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`), so brew/nvm/bun/`~/.local/bin` tools (git is in /usr/bin; node, claude, codex are not) are missing. Recover via the login shell: `$SHELL -ilc '<sentinel; env -0; sentinel>'`.

Measured (zsh + oh-my-zsh + nvm, started from `env -i`): **0.47-0.51s** per call. Resulting PATH had `~/.local/bin`, `~/.bun/bin`, nvm node, `/opt/homebrew/bin`, cargo; `command -v git node claude codex` all resolved. Do it once at startup in the background and cache; never per spawn.

Pitfalls:

- rc stdout noise (echo, banners, p10k instant prompt): sentinels, parse between last begin and the next end. `env -0` so multi-line values survive.
- stderr noise (`can't change option: zle` without tty): discard stderr; don't trust exit code.
- stdin must be `/dev/null` (interactive shell otherwise may wait / emit job-control warnings).
- rc files can hang (nvm, network, prompts): hard timeout (10s) + `kill_on_drop`; fall back to minimal env plus `/opt/homebrew/bin:/usr/local/bin:~/.local/bin`.
- `SHELL` may be unset in GUI env: use `getpwuid` / `dscl . -read ~ UserShell`, default `/bin/zsh`. Syntax used (`printf`, `env -0`) works in zsh/bash/fish; not csh.
- Env had oddities (`LOGNAME=root`, `SHLVL=0`, `_`, `PWD`, `OLDPWD`): merge `PATH` plus a vetted set, drop `PWD OLDPWD SHLVL _ LOGNAME USER HOME`. rc-exported API keys become visible to agents; make that explicit.
- Per-project env (direnv/mise) not captured; would need running in session cwd.

Sketch (tested, `spikes/rmcp-server/src/main.rs`):

```rust
async fn login_env() -> anyhow::Result<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or("/bin/zsh".into());
    let script = "printf '__HS_BEGIN__'; /usr/bin/env -0; printf '__HS_END__'";
    let child = tokio::process::Command::new(&shell).args(["-ilc", script])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .kill_on_drop(true).spawn()?;
    let out = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await??;
    let s = String::from_utf8_lossy(&out.stdout);
    let body = s.rsplit_once("__HS_BEGIN__").and_then(|(_, r)| r.split_once("__HS_END__")).map(|(b, _)| b)
        .ok_or_else(|| anyhow!("sentinels not found"))?;
    Ok(body.split('\0').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.into(), v.into())).collect())
}
```
