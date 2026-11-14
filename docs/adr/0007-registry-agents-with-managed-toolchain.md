# Agents come from the ACP Registry and run on a Harness-managed toolchain

The Harness installs Agents from the ACP Registry (npx, uvx, or per-platform binary recipes), with Custom Agents as an escape hatch. For npx and uvx Agents it always uses its own pinned Node and uv in app data, never the user's system installs, so Agent behaviour is reproducible and independent of nvm/pyenv setups. Cost: roughly 100 MB of downloaded runtimes and keeping their pins current.

## Considered Options

- System runtimes only: smallest footprint, but breaks on missing or mismatched installs.
- Hybrid (system if suitable, else managed): friendlier on paper, but doubles the code paths and bug surface.

## Addendum: verified, transactional installs

- A binary archive is installed only if the registry lists its sha256. Without one the install is refused unless the Command carries `allow_unverified` (the Agents panel asks first). The sha256 of every downloaded artifact is computed and recorded in the Agent record (`install.sha256`, `install.unverified`) with the version. npx and uvx installs have no single artifact and record no hash; their runtimes stay hash-pinned.
- An install or update goes into its own `agents/<id>/<version>/` directory beside the current one, then runs a headless conformance check: the Agent starts as Sessions start it (stripped env, managed PATH) with a throwaway HOME/XDG dirs and folder, answers `initialize` with protocol version 1 within 60 s, and `session/new` succeeds or asks for sign-in (which counts as a pass). On a failure the new directory is deleted, the current version keeps running, and the error (with the Agent's stderr tail) is returned and kept as `install.check`.
- On a pass the Agent switches. The version it replaces stays installed as `install.previous` for `RollbackAgent`; older versions are deleted. `RollbackAgent` swaps back and holds the Agent. `HoldAgentVersion` keeps an Agent at its version: installs of a different version are refused until released.
- The registry index itself is still fetched without a signature; the sha256 in it protects the archive only as far as the CDN is trusted.
- A nightly workflow (`agents-nightly.yml`, example `conformance`) installs the current registry versions of the Claude and Codex Agents and runs the check.

## Addendum: downloads use the core's HTTP client, not `curl`

Toolchain, Agent and registry downloads first ran the system `curl`, with different flags per call site. No reason for that is recorded; it was the shortest way to stream a file. They now use `http::download`/`get_json` on the same reqwest client as the rest of the core: one stack, a connect timeout, a stall timeout (no bytes for 60 s), a total limit, a per-call size cap, limited redirects, https only (an `http://` or `file://` registry, used in tests, allows the same for its archives), and the sha256 is computed while streaming and checked before the file is renamed into place, so a mismatch leaves no file. Transient failures retry twice.
- Certificates: rustls with the platform verifier, so the system trust store (and corporate roots in it) applies, as it did for `curl`.
- Proxy: the standard env vars (`HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) as before. The macOS system proxy setting is read by neither; an app started from Finder has no shell env, so it needs the proxy set in the login environment as before.
