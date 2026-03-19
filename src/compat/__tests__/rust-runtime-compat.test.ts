import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initTeamState } from '../../team/state.js';
import { readTeamState } from '../../hud/state.js';

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const omxBin = join(repoRoot(), 'dist', 'cli', 'omx.js');
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message };
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

async function withTempTeamStateRoot<T>(
  teamStateRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previousRoot = process.env.OMX_TEAM_STATE_ROOT;
  process.env.OMX_TEAM_STATE_ROOT = teamStateRoot;
  try {
    return await fn();
  } finally {
    if (previousRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
    else process.env.OMX_TEAM_STATE_ROOT = previousRoot;
  }
}

describe('rust runtime legacy-reader compatibility', () => {
  it('keeps team status on the manifest-authored compatibility view', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-rust-compat-team-'));
    try {
      const teamStateRoot = join(wd, '.omx', 'state');
      await withTempTeamStateRoot(teamStateRoot, async () => {
        await initTeamState('rust-compat-team', 'compatibility lane', 'executor', 1, wd);

        const teamDir = join(teamStateRoot, 'team', 'rust-compat-team');
        const configPath = join(teamDir, 'config.json');
        const manifestPath = join(teamDir, 'manifest.v2.json');
        const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;

        config.workspace_mode = 'single';
        config.tmux_session = 'omx-team-legacy-rust-compat-team';
        manifest.workspace_mode = 'worktree';
        manifest.tmux_session = 'omx-team-rust-compat-team';

        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

        const result = runOmx(wd, ['team', 'status', 'rust-compat-team', '--json'], { OMX_TEAM_STATE_ROOT: teamStateRoot });
        if (shouldSkipForSpawnPermissions(result.error)) return;

        assert.equal(result.status, 0, result.stderr || result.stdout);
        const payload = JSON.parse(result.stdout) as {
          command?: string;
          team_name?: string;
          status?: string;
          workspace_mode?: string | null;
        };
        assert.equal(payload.command, 'omx team status');
        assert.equal(payload.team_name, 'rust-compat-team');
        assert.equal(payload.status, 'ok');
        assert.equal(payload.workspace_mode, 'worktree');
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps doctor --team on the manifest-authored tmux session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-rust-compat-doctor-'));
    try {
      const teamStateRoot = join(wd, '.omx', 'state');
      await withTempTeamStateRoot(teamStateRoot, async () => {
        await initTeamState('rust-compat-doctor', 'compatibility lane', 'executor', 1, wd);

        const teamDir = join(teamStateRoot, 'team', 'rust-compat-doctor');
        const configPath = join(teamDir, 'config.json');
        const manifestPath = join(teamDir, 'manifest.v2.json');
        const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
        const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;

        config.tmux_session = 'omx-team-legacy-rust-compat-doctor';
        manifest.tmux_session = 'omx-team-rust-compat-doctor';

        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

        const fakeBin = join(wd, 'bin');
        await mkdir(fakeBin, { recursive: true });
        const tmuxPath = join(fakeBin, 'tmux');
        await writeFile(
          tmuxPath,
          '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-rust-compat-doctor"; exit 0; fi\nexit 0\n',
        );
        await chmod(tmuxPath, 0o755);

        const result = runOmx(
          wd,
          ['doctor', '--team'],
          { PATH: `${fakeBin}:${process.env.PATH || ''}`, OMX_TEAM_STATE_ROOT: teamStateRoot },
        );
        if (shouldSkipForSpawnPermissions(result.error)) return;

        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /team diagnostics: no issues/);
        assert.match(result.stdout, /All team checks passed\./);
        assert.doesNotMatch(result.stdout, /resume_blocker/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps HUD team state on the session-scoped compatibility file', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-rust-compat-hud-'));
    try {
      const stateRoot = join(wd, '.omx', 'state');
      const sessionId = 'hud-rust-compat';
      const sessionStateDir = join(stateRoot, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });

      await writeFile(join(stateRoot, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(
        join(stateRoot, 'team-state.json'),
        JSON.stringify({
          active: false,
          current_phase: 'root-fallback',
          team_name: 'legacy-root',
          agent_count: 1,
        }, null, 2),
      );
      await writeFile(
        join(sessionStateDir, 'team-state.json'),
        JSON.stringify({
          active: true,
          current_phase: 'executing',
          team_name: 'rust-session',
          agent_count: 3,
        }, null, 2),
      );

      const state = await readTeamState(wd);
      assert.ok(state);
      assert.equal(state?.team_name, 'rust-session');
      assert.equal(state?.current_phase, 'executing');
      assert.equal(state?.agent_count, 3);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
