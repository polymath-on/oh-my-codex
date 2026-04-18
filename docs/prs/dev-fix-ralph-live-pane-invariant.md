# PR Draft: Preserve verified Ralph pane anchors and avoid tmux-hook target drift

## Target branch
`dev`

## Summary
This follow-up fixes two regressions in the managed tmux recovery paths that showed up during review of the Ralph resume / continue work.

The first issue was pane rebinding drift. Once a stored Ralph pane anchor had already been verified as part of the correct managed session, the recovery path still rescanned the whole tmux session and rebound to whichever Codex pane was currently focused. In multi-pane Codex sessions that could silently move future watcher or auto-nudge injections onto the wrong lane.

The second issue was repo-scoped target drift in `.omx/tmux-hook.json`. A notify-hook turn skipped by the pre-guard could still heal and persist a pane target before any injection actually succeeded. That left transient pane ids behind after the session exited and later unmanaged turns could resolve against a dead explicit target.

## Changes
- split managed-pane heuristics so `TMUX_PANE` detection can stay permissive while stored-anchor retention stays strict
- keep the verified anchor pane in `resolveManagedPaneFromAnchor()` only when it still looks like a retained Codex-managed pane
- only rescan the tmux session when the anchor is gone or no longer looks agent-owned
- stop persisting healed tmux-hook targets on pre-guard early returns
- add regressions for the direct managed-pane helper, watcher rebinding behavior, auto-nudge anchor retention / node-shell upgrade paths, and pre-guard config-drift handling

## Why this is good
- prevents Ralph continue / resume state from jumping between Codex panes just because focus changed
- keeps watcher and auto-nudge behavior aligned with the stored managed anchor contract
- reduces repo-scoped tmux-hook config drift from transient skipped events
- makes the healing logic easier to reason about by removing persistence from the pre-guard skip path

## Validation
- [x] `npx biome lint src/scripts/notify-hook/managed-tmux.ts src/scripts/notify-hook/tmux-injection.ts src/hooks/__tests__/notify-hook-managed-tmux.test.ts src/hooks/__tests__/notify-hook-tmux-heal.test.ts src/hooks/__tests__/notify-fallback-watcher.test.ts`
- [x] `npm run build`
- [x] `node --test dist/hooks/__tests__/notify-fallback-watcher.test.js dist/hooks/__tests__/notify-hook-auto-nudge.test.js dist/hooks/__tests__/notify-hook-managed-tmux.test.js dist/hooks/__tests__/notify-hook-tmux-heal.test.js`

## Related
- follow-up to the Ralph resume / managed tmux healing review pass
