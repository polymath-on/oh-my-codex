# Hooks Extension (Custom Plugins)

OMX uses Codex native hooks for non-team automation and exposes a plugin extension point for
user plugins under `.omx/hooks/*.mjs`.

> Non-team sessions are native-hook-first.
> `omx tmux-hook` is reserved for team runtime behavior and legacy tmux troubleshooting.

## Quick start

```bash
omx hooks init
omx hooks status
omx hooks validate
omx hooks test
```

This creates a scaffold plugin at:

- `.omx/hooks/sample-plugin.mjs`

## Ownership and precedence

OMX treats hook ownership as a split contract:

- **Repo-local native hooks** — OMX owns the repo-local Codex hook entries it installs for
  non-team automation. These are the entries that power lifecycle/tool-adjacent behavior after the
  migration.
- **User/global native hooks** — existing user-managed Codex hooks remain user-managed. OMX should
  merge around unrelated entries rather than claiming the whole file.
- **tmux injection** — retained for team runtime paths and explicit legacy troubleshooting only; it
  is no longer the default non-team follow-on mechanism.

Operationally, that means:

- `omx setup` is expected to force-enable `[features].codex_hooks = true` in supported scopes.
- Unsupported or disabled native-hook runtimes must surface explicit setup/doctor status instead of
  silently falling back to non-team tmux injection.
- Team runtime tmux coordination remains in place unless a team-specific migration is documented
  separately.

## Enablement model

Plugins are **enabled by default**.

Disable plugin dispatch explicitly:

```bash
export OMX_HOOK_PLUGINS=0
```

Optional timeout tuning (default: 1500ms):

```bash
export OMX_HOOK_PLUGIN_TIMEOUT_MS=1500
```

## Native event pipeline (v1)

For non-team sessions, OMX emits plugin events from the native Codex hook pipeline. Team sessions
continue to preserve their existing tmux-oriented runtime flow.

Current native events are emitted from existing lifecycle/notify paths:

- `session-start`
- `session-end`
- `turn-complete`
- `session-idle`

Pass one keeps this existing event vocabulary; it does **not** introduce an event-taxonomy redesign.

For clawhip-oriented operational routing, see [Clawhip Event Contract](./clawhip-event-contract.md).

Envelope fields include:

- `schema_version: "1"`
- `event`
- `timestamp`
- `source` (`native` or `derived`)
- `context`
- optional IDs: `session_id`, `thread_id`, `turn_id`, `mode`

## Derived signals (opt-in)

Best-effort derived events are gated and disabled by default.

```bash
export OMX_HOOK_DERIVED_SIGNALS=1
```

Derived signals include:

- `needs-input`
- `pre-tool-use`
- `post-tool-use`

Derived events are labeled with:

- `source: "derived"`
- `confidence`
- parser-specific context hints

## Team-safety behavior

In team-worker sessions (`OMX_TEAM_WORKER` set), plugin side effects are skipped by default.
This keeps the lead session as the canonical side-effect emitter and avoids duplicate sends.

## Plugin contract

Each plugin must export:

```js
export async function onHookEvent(event, sdk) {
  // handle event
}
```

SDK surface includes:

- `sdk.tmux.sendKeys(...)`
- `sdk.log.info|warn|error(...)`
- `sdk.state.read|write|delete|all(...)` (plugin namespace scoped)
- `sdk.omx.session.read()`
- `sdk.omx.hud.read()`
- `sdk.omx.notifyFallback.read()`
- `sdk.omx.updateCheck.read()`

`sdk.omx` is intentionally narrow and read-only in pass one. These helpers read the
repo-root `.omx/state/*.json` runtime files for the current workspace.

Compatibility notes:

- `omx tmux-hook` remains a team-runtime / legacy CLI workflow, not `sdk.omx.tmuxHook.*`
- pass one does not add `sdk.omx.tmuxHook.*`; tmux plugin behavior stays on `sdk.tmux.sendKeys(...)`
- pass one does not add generic `sdk.omx.readJson(...)`, `sdk.omx.list()`, or `sdk.omx.exists()`
- pass one does not add `sdk.pluginState`; keep using `sdk.state`

## Logs

Plugin dispatch and plugin logs are written to:

- `.omx/logs/hooks-YYYY-MM-DD.jsonl`
