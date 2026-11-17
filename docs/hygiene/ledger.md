# Hygiene ledger

The weekly hygiene routine reads this file and keeps it up to date. It holds what the routine must remember from one run to the next: the steps it takes, the area to look at this week, the findings already known, and what the routine may do without asking.

The routine may edit only the [Known findings](#known-findings) table, and only in the ways that table allows. Every other part of this file changes only through a PR the owner merges.

## Run

1. **Scope.** The commits on `main` since the newest issue labelled `weekly-hygiene` (open or closed), plus this week's [rotating area](#rotating-area). With no earlier issue, use the last 7 days.
2. **Measure.** Collect the [numbers](#numbers) and compare them with the previous issue's table.
3. **Find.** Look for:
   - duplicated logic
   - modules that grew past one responsibility
   - AGENTS.md rules that new code breaks
   - docs that name paths or commands that no longer exist
   - deprecation warnings in the last CI and Release runs

   Report a finding only if it was verified in the code, with `file:line`. Skip findings already in [Known findings](#known-findings). An independent subagent checks each finding before it is reported.
4. **Fix.** Open at most 2 fix PRs. Each one covers one [auto-merge class](#auto-merge), or picks up one `open` finding from the table. A fix PR never also changes this file.
5. **Review.** Every fix PR gets a review from an independent subagent:
   - Give it the diff, not your conclusion.
   - Ask for a verdict, `SAFE` or `NOT SAFE`, and a list of blocking items.
   - Ask it to check behaviour, layout, keyboard and focus, and the AGENTS.md rules.
   - For UI changes, also run the browser mock.
6. **Merge or leave.**
   - Merge a fix PR yourself only when all of these hold:
     - Every CI check on its head completed and passed.
     - The verdict is `SAFE` with no blocking items.
     - The PR fits the [auto-merge](#auto-merge) rules.
   - Otherwise leave it open for the owner.
7. **Record.** After step 6, open one ledger PR that changes only the Known findings table:
   - Add each new finding that was not fixed.
   - Set fixed rows to `fixed (#PR)`.

   Merge it yourself only when CI passed and every change in it is one that [Known findings](#known-findings) lets the routine make (add rows, mark rows fixed, remove old fixed rows). Anything else in the diff leaves it open for the owner. If a fix PR is still open, its finding goes in as `open (#PR)`.
8. **Report.**
   - Open the issue "Weekly hygiene YYYY-MM-DD", labelled `weekly-hygiene`. It holds up to 5 ranked new findings, each PR with its outcome (merged, or open and why), and the numbers table.
   - If a run finds nothing, say so in one line.
   - Close the issue at the end of the run if the run has no open PR, no new `decide` finding and no failed step.
   - Close the previous run's issue once all its PRs are merged or closed.
9. **Notify.** Send a push notification only for:
   - a PR left open for the owner
   - a new `decide` finding
   - a step that failed, such as access denied or a red check that could not be fixed

   Findings that were already `decide` before this run never trigger a notification. A clean run stays silent.
10. **Security.** File a security finding only as a private draft advisory, and put one neutral line in the issue. Security findings never go into this file and are never fixed in an auto-merge PR.

## Auto-merge

The routine may merge its own fix PR only if the PR does nothing but the following:

- fixes a path or command that no longer exists in `README.md`, `docs/plans/` or a package README
- under an AGENTS.md rule, swaps native scrolling for `ScrollArea`/`VirtualList` with the same behaviour. Check the swap in the browser mock. Other swaps (tooltips, controls) change timing or focus, so they stay open for the owner.
- replaces copies of a helper with one shared helper that gives the same output for every caller (checked by reading each copy), inside one package
- removes dead code that is internal to a file: suppressions that have no effect, unused local functions or variables

It never merges a PR that:

- changes behaviour anywhere (Rust or TS), or any public export of `@harness/api` or `@harness/ui`
- touches:
  - `crates/`
  - `generated.ts`, `crates/harness-core/src/api/`, `packages/api/`, manifests
  - dependencies or lockfiles
  - GitHub Actions versions
  - `.github/workflows/`, workflow permissions
  - Tauri config or capabilities
  - `agents.rs`, `toolchain.rs`
  - `prompts/`, `instructions.md`
  - `AGENTS.md`, `GLOSSARY.md`, ADRs
  - `scripts/boundaries.ts`, `scripts/check-boundaries.ts`, `biome.json`, `knip.json`
  - storage keys, stored formats, Panel ids
- deletes, skips or loosens a test or snapshot, or updates a snapshot
- has more than 150 changed lines (insertions plus deletions in `git diff --shortstat` against `main`)

Everything else stays open for the owner.

## Numbers

Put these in each issue's table, with the previous value next to each:

- Biome warnings and infos (`biome check .`)
- Clippy warnings (the CI result)
- knip findings, `knip.json` ignore entries, and the number of `@internal` tags
- Boundary exceptions: entries in the `*_ALLOWED` maps in `scripts/check-boundaries.ts`
- Tests: vitest (normal and bench) and Rust (passed and ignored, from the CI log)
- CI duration per job, from the last `main` run of `ci.yml`
- Reruns: runs with an attempt above 1 among the last 40
- Cache: rust-cache hit and size
- The 10 largest source files (no generated files, fixtures or `spikes/`)

## Rotating area

The area is the ISO week number modulo 6. The paths are from the repo root.

| Week mod 6 | Area                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0          | `crates/harness-core/src/`: `session/`, `acp/`, `log.rs`, `persist.rs`, `state.rs`, `agent_quirks.rs`                                                                                       |
| 1          | `crates/harness-core/src/`: `host/`, `api/`, `git/`, `github/`, `mcp/`, `sub_sessions.rs`, `shared.rs`                                                                                      |
| 2          | `crates/harness-core/src/`: the other top-level files (`agents.rs`, `toolchain.rs`, `permissions.rs`, `terminal.rs`, `proc.rs`, `http.rs`, ...), `prompts/`, `tests/`, `crates/fake-agent/` |
| 3          | `crates/harness-tauri/`, `packages/api/`, `packages/ui/`                                                                                                                                    |
| 4          | `packages/frontend-chat/`, `packages/frontend-inspector/`                                                                                                                                   |
| 5          | `app/`, `scripts/`, `.github/`, root config, docs (AGENTS.md, README, ADRs)                                                                                                                 |

## Known findings

The routine skips these.

The routine may:

- add a row with status `open`, `open (#PR)` or `decide`
- set a row to `fixed (#PR)` once that PR is merged
- remove `fixed` rows that are more than 4 weeks old

Only the owner sets `wontfix` or edits a finding's text.

Status values:

- **`open`**: a fix that needs no decision and is not done yet. The routine may pick it up as a fix PR.
- **`open (#PR)`**: a fix PR exists. The routine does not open another one; the owner reviews that PR.
- **`decide`**: needs the owner (a design, a split, or a change to behaviour).
- **`fixed`** and **`wontfix`**: closed.

| ID  | First seen        | Finding                                                                                                                                                                                                               | Where                                                                                                                                                                                                                            | Status                                   |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| H1  | 2026-11-17 (#185) | Config-option choices are parsed twice. `option_values` and `ModeInfo::of_option` ignore grouped choices, but `sub_sessions` flattens them, so the mode name and plan-mode detection miss grouped values.             | `crates/harness-core/src/api/event.rs:400-410`, `crates/harness-core/src/sub_sessions.rs:676-692`                                                                                                                                | decide (behaviour change in core)        |
| H2  | 2026-11-17 (#185) | The list and inspector keyboard controllers are copied between the two panels. The copies differ: Enter does something different in each, and one checks `e.target`.                                                  | `packages/frontend-chat/src/features/artifacts/ArtifactsPanel.tsx:216-232,753-768`, `packages/frontend-chat/src/features/references/ReferencesPanel.tsx:431-447,653-669`                                                         | decide (shared hook, behaviour differs)  |
| H3  | 2026-11-17 (#185) | Rust helpers are duplicated: `slug`, `~` expansion, and the osascript timeout loop, which re-implements `proc::run`.                                                                                                  | `crates/harness-core/src/shared.rs:49` and `crates/harness-core/src/git/parse.rs:102`; `crates/harness-core/src/permissions.rs:183` and `crates/harness-core/src/git/worktree.rs:202`; `crates/harness-tauri/src/context.rs:436` | decide (core)                            |
| H4  | 2026-11-17 (#185) | `log.rs` has about 6 jobs (projections, scan, health, writer, fan-out, API). `sub_sessions.rs` has 3.                                                                                                                 | `crates/harness-core/src/log.rs`, `crates/harness-core/src/sub_sessions.rs`                                                                                                                                                      | decide (module split)                    |
| H5  | 2026-11-17 (#185) | Native `title=` tooltips. In `FilesPanel` the path shows in two tooltips, the native one and the `PanelHeader` one.                                                                                                   | `packages/frontend-chat/src/features/files/FilesPanel.tsx:278`, `packages/frontend-chat/src/features/toolDisplay/TraceDisplay.tsx:88`                                                                                            | decide (tooltip timing and focus change) |
| H6  | 2026-11-17 (#185) | `upload-artifact@v4` and `download-artifact@v4` run on Node 20. The fix is v6 and v7, but CI does not exercise `release.yml`.                                                                                         | `.github/workflows/release.yml:131,151`                                                                                                                                                                                          | decide (release workflow)                |
| H7  | 2026-11-17 (#185) | Fixed: `actions/checkout@v4` on Node 20, the README path `src/api.rs`, three `plural` copies, native scroll in PlanNote, toast, UserMessage, disclosure and FileTreeList, and an unused `biome-ignore` in slotPanels. |                                                                                                                                                                                                                                  | fixed (#184, #186)                       |
