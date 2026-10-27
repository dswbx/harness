# Agents come from the ACP Registry and run on a Harness-managed toolchain

The Harness installs Agents from the ACP Registry (npx, uvx, or per-platform binary recipes), with Custom Agents as an escape hatch. For npx and uvx Agents it always uses its own pinned Node and uv in app data, never the user's system installs, so Agent behaviour is reproducible and independent of nvm/pyenv setups. Cost: roughly 100 MB of downloaded runtimes and keeping their pins current.

## Considered Options

- System runtimes only: smallest footprint, but breaks on missing or mismatched installs.
- Hybrid (system if suitable, else managed): friendlier on paper, but doubles the code paths and bug surface.
