# Theme import from tweakcn

2026-10-30. tweakcn.com, shadcn registry schema `registry-item.json`.

**Observed:**
- `https://tweakcn.com/r/themes/<id>` returns a shadcn registry item: `name`, `cssVars.theme` (fonts, radius, `tracking-*`), `cssVars.light`, `cssVars.dark`. Example theme "Zen Inspired Theme": 44 tokens per mode after our filter.
- The "Code" dialog's CSS has `@import`, `@custom-variant`, `:root {}`, `.dark {}` and `@theme inline {}` (only `var(--x)` mappings).
- Keys outside the bundled presets' set (e.g. `tracking-*`) are dropped on import; `spacing` is skipped when applied, like presets.

**Assumed / unverified:**
- tweakcn share links are `tweakcn.com/themes/<id>`; the editor uses `?theme=<id>`. Both are rewritten to `/r/themes/<id>`.
- Whether tweakcn sends CORS headers (not tested): the fetch runs in the core (`FetchJson`, system curl) either way.

**Open questions:**
- Other community registries: any https URL serving a registry item works, untested beyond tweakcn.
