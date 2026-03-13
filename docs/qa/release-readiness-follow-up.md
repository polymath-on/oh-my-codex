# Release Readiness Follow-up (Team state root guard)

## crates/* + omx-runtime parity review (2026-03-13)

Current review status for the Rust workspace migration and deployment surfaces:

| Surface | Current truth | Evidence |
|---|---|---|
| Rust workspace membership | `Cargo.toml` includes `crates/omx-explore`, `crates/omx-runtime`, and `crates/omx-sparkshell`. | `Cargo.toml` workspace members |
| CI rust coverage lane | **Aligned** — `.github/workflows/ci.yml` now points the sparkshell coverage step at `crates/omx-sparkshell/Cargo.toml`. | `sed -n '190,198p' .github/workflows/ci.yml` |
| Release manifest requirements | **Aligned** — `.github/workflows/release.yml` now requires `omx-explore-harness,omx-runtime,omx-sparkshell`, so release expectations now include `omx-runtime`. | `sed -n '92,106p' .github/workflows/release.yml` |
| Packaged tarball shape | **Aligned** — `npm pack --dry-run --json` no longer includes `bin/native/*` or `bin/rust/*`, so native staging output is now cleaned before packaging. | `npm pack --dry-run --json` |
| Native runtime hydration contract | Code already models `omx-runtime` as a native product for cache hydration and manifest lookup. | `src/cli/native-assets.ts` |

### Practical implication

As of 2026-03-13, the source tree, runtime resolution logic, CI coverage workflow, release manifest expectations, and packaged tarball cleanup all reflect the current `crates/*` + `omx-runtime` truth checked in this worktree.

### Recommended verification after fixes land

Run these from repository root:

```bash
sed -n '190,198p' .github/workflows/ci.yml
sed -n '96,103p' .github/workflows/release.yml
npm pack --dry-run
node scripts/check-version-sync.mjs --tag v$(node -p "require('./package.json').version")
node scripts/smoke-packed-install.mjs
```

## Local verification commands

Run from repository root:

```bash
npm run build   # TypeScript build
node --test dist/team/__tests__/state.test.js
node --test dist/mcp/__tests__/state-server-team-tools.test.js
npm test
```

## OMX_TEAM_* environment caveat and cleanup

Team/path resolution now supports explicit `OMX_TEAM_STATE_ROOT` across worker worktrees.  
When running local tests manually, clear worker-specific env after each run to avoid cross-test contamination:

```bash
unset OMX_TEAM_STATE_ROOT OMX_TEAM_WORKER OMX_TEAM_LEADER_CWD
```

If a test needs these vars, save/restore them inside the test (`const prev = process.env...` + `finally` cleanup).
