# Hygiene ledger

The weekly hygiene routine reads this file and keeps it up to date. It holds what the routine must remember from one run to the next: which area to look at this week, the findings that are already known, and what the routine may do without asking. The routine edits this file in its own PR, and that PR follows the rules below like any other.

## Run

1. **Scope.** The commits on `main` since the newest issue labelled `weekly-hygiene` (open or closed), plus this week's rotating area. If no such issue exists, use the last 7 days.
2. **Measure.** Collect the numbers from the table in the last issue and compare them with that issue.
3. **Find.** Look for:
   - duplicated logic
   - modules that grew past one responsibility
   - AGENTS.md rules that new code breaks
   - docs that name paths or commands that no longer exist
   - deprecation warnings in the last CI and Release runs

   Report a finding only if you verified it in the code, with `file:line`. Skip every finding listed under [Known findings](#known-findings). Use an independent subagent to verify each finding before you report it.
4. **Fix.** Open up to 2 PRs, on the session's branch or branches, for fixes in the [auto-merge classes](#auto-merge). Each PR fixes only one class of problem.
5. **Review.** Each PR gets an independent subagent review. Give the reviewer the diff, not your conclusion, and ask it to check behaviour, layout, keyboard and focus, and the AGENTS.md rules. Run the browser mock for UI changes.
6. **Merge or ask.**
   - Merge the PR yourself when all three hold:
     - CI is green on the PR's head.
     - The review says SAFE with no blocking items.
     - The PR stays inside the auto-merge rules.
   - Otherwise leave the PR open and put it under "Needs you" in the issue.
7. **Record.** Add every finding that you did not fix to [Known findings](#known-findings), with its status. Do this in the run's ledger PR. That PR may be one of the 2 PRs, and an auto-merge PR may include the ledger update.
8. **Report.**
   - Open the issue "Weekly hygiene YYYY-MM-DD" with the label `weekly-hygiene`. It holds up to 5 ranked findings, the PRs with their outcome (merged, or open with the reason), and the numbers table.
   - If nothing needs the owner, close the issue at the end of the run.
   - If the previous run's issue is still open and nothing in it is open any more, close it.
9. **Notify.** Send a push notification only when something needs the owner: an open PR, a finding marked `decide`, or a run that failed. A run where everything went well stays silent.
10. **Security.** File a security finding as a private draft advisory only, and put one neutral line in the issue. Never fix a security finding in an auto-merge PR.

## Auto-merge

The routine may merge its own PR without asking only when the PR does nothing but the following:

- fixes a doc path or command that no longer exists, or updates this ledger
- bumps a GitHub Action whose new major only changes the runtime, in workflows that CI runs (`ci.yml`); not `release.yml`
- swaps native code for the rule's version under an AGENTS.md rule (`ScrollArea`, shadcn `Tooltip`, `storedValue`, ...) with the same behaviour, and the browser mock was checked
- replaces copies of a helper with one shared helper that gives the same output; it may add the helper to `HOMES` in `scripts/boundaries.ts`
- removes dead code that knip or Biome reports (unused exports, suppressions that have no effect)

It never merges:

- behaviour changes in `crates/`
- changes to the Event/Command API or `generated.ts`
- dependency bumps
- changes to `release.yml`
- deletions of tests
- a PR with more than about 150 changed lines

Anything outside these rules stays open for the owner.

## Rotating area

The area is the ISO week number modulo 6.

| Week mod 6 | Area |
| --- | --- |
| 0 | `crates/harness-core/src/session/`, `acp/`, `log.rs` |
| 1 | `crates/harness-core/src/git/`, `github/`, `mcp/`, `sub_sessions.rs` |
| 2 | `crates/harness-tauri/` |
| 3 | `packages/api/`, `packages/ui/` |
| 4 | `packages/frontend-chat/`, `packages/frontend-inspector/` |
| 5 | `app/`, `scripts/`, `.github/`, docs (AGENTS.md, README, ADRs) |

## Known findings

The routine skips these. To retire an entry, set its status to `fixed (#PR)` or `wontfix (reason)`. The routine removes `fixed` entries once they are older than 4 weeks.

Status values:

- **`open`**: a fix with no decision needed that is not done yet. The routine may pick it up as one of its PRs.
- **`decide`**: needs the owner (a design or a split).
- **`fixed`** and **`wontfix`**: closed.

| ID | First seen | Finding | Where | Status |
| --- | --- | --- | --- | --- |
| H1 | 2026-11-17 (#185) | Config-option choices are parsed twice. `option_values` and `ModeInfo::of_option` ignore grouped choices, but `sub_sessions` flattens them, so the mode name and plan-mode detection miss grouped values. | `crates/harness-core/src/api/event.rs:401-410`, `sub_sessions.rs:676-692` | decide (behaviour change in core) |
| H2 | 2026-11-17 (#185) | The list and inspector keyboard controllers are copied between the two panels. | `features/artifacts/ArtifactsPanel.tsx:216-232,753-770`, `features/references/ReferencesPanel.tsx:431-447,653-670` | open |
| H3 | 2026-11-17 (#185) | Rust helpers are duplicated: `slug`, `~` expansion, and the osascript timeout loop, which re-implements `proc::run`. | `shared.rs:49`/`git/parse.rs:102`; `permissions.rs:183`/`git/worktree.rs:202`; `harness-tauri/src/context.rs:436` | decide (core behaviour) |
| H4 | 2026-11-17 (#185) | `log.rs` has about 6 jobs (projections, scan, health, writer, fan-out, API). `sub_sessions.rs` has 3. | `crates/harness-core/src/log.rs`, `sub_sessions.rs` | decide (module split) |
| H5 | 2026-11-17 (#185) | Native `title=` tooltips; in `FilesPanel` the path shows twice, next to the `PanelHeader` tooltip. | `features/files/FilesPanel.tsx:278`, `features/toolDisplay/TraceDisplay.tsx:88` | open |
| H6 | 2026-11-17 (#185) | `upload-artifact@v4` and `download-artifact@v4` run on Node 20. The fix is v6 and v7, but CI does not exercise `release.yml`. | `.github/workflows/release.yml` | decide (release workflow) |
| H7 | 2026-11-17 (#185) | `actions/checkout@v4` on Node 20, README `src/api.rs`, three `plural` copies, native scroll in PlanNote, toast, UserMessage, disclosure and FileTreeList, and an unused `biome-ignore` in slotPanels. | | fixed (#184, #186) |
