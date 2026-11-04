# PR header shows no checks on a conflicting PR

Date: 2026-11-04. Tested with `gh` against the harness repo; no Agents involved.

## Observed

- PR #41 (branch `harness/harness-001fff`) showed `mergeable: CONFLICTING` and `statusCheckRollup: []`, and `gh run list` had no CI run for it.
- PRs #36 to #40 each had 1 check.

## Assumed / unverified

- CI runs on `pull_request`, and GitHub does not start `pull_request` workflows while a PR has merge conflicts. So an empty rollup can be correct rather than stale.
- The header does not show conflicts today, so a conflicting PR looks like "no checks yet".

## Open questions

- Does the empty rollup go away once the conflict is resolved and the branch is pushed?
- Should the header show `mergeable` (out of scope for the refresh work)?
