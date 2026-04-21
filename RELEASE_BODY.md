# oh-my-codex v0.14.1

## Summary

`0.14.1` is a patch release after `v0.14.0` focused on hardening the new interactive orchestration surfaces shipped in that release. It tightens deep-interview question enforcement, improves tmux question-pane reliability across reused and non-POSIX sessions, makes setup/update refresh behavior more resilient, deduplicates lifecycle normalization onto the shared runtime contract, and keeps lightweight review/explore guidance aligned with the current dev defaults.

## Added

- **Reused-session deep-interview question bridge guidance** — prompt-side activation now includes a concrete current-session CLI bridge command when bare `omx question` is unavailable.
- **Detached question-session liveness checks** — detached tmux question sessions are now validated immediately after launch and fail closed if the session disappears.

## Changed

- **Lifecycle normalization now shares one source of truth** — terminal lifecycle compatibility helpers delegate to the centralized run-outcome contract.
- **Code-review guidance is stricter** — the shipped code-review workflow now expects a broader, dual-perspective review posture.
- **Explore/sparkshell lightweight fallback guidance stays lean** — lightweight command paths keep mini/spark defaults without broadening the general role roster.

## Fixed

- **Deep-interview Stop gating** — pending structured question obligations now keep Stop blocked even if the deep-interview mode already marked itself inactive.
- **Question UI reliability** — question panes stay alive under non-POSIX tmux shells, fail closed when panes or detached sessions disappear on launch, and submit answers more reliably in Codex panes.
- **Setup/update refresh resilience** — accepted setup overwrites no longer destroy managed `AGENTS.md`; postinstall/setup refresh stays rooted to npm's install prefix; explicit `omx update` reruns setup when setup state is stale and no longer fails on advisory update-state write errors.
- **Stop-state and session-status leakage** — stale Ralph, skill-active, and ultrawork stop state no longer leaks across sessions or floods Stop handling.
- **Release metadata drift** — Node/Cargo package metadata, lockfiles, changelog, release body, release notes, and release-readiness docs are synchronized to `0.14.1`.

## Verification

- `npm test`
- `cargo test -p omx-explore-harness -p omx-sparkshell`
- `npm pack --dry-run`

## Remaining risk

- This is still a local release-readiness pass, not a full GitHub Actions matrix rerun.
- The highest-value post-release observation surface remains real tmux / multi-session operator behavior around `omx question`, Stop gating, and setup refresh on upgraded installs.

## Contributors

Thanks to Yeachan-Heo, Bellman, pinion05, sappho192, and the other OMX contributors who landed the fixes in this patch train.

**Full Changelog**: [`v0.14.0...v0.14.1`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.14.0...v0.14.1)
