import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileHudForPromptSubmit } from '../reconcile.js';

describe('reconcileHudForPromptSubmit', () => {
  it('skips reconciliation outside tmux', async () => {
    const result = await reconcileHudForPromptSubmit('/tmp', {
      env: {},
    });
    assert.equal(result.status, 'skipped_not_tmux');
    assert.equal(result.paneId, null);
  });

  it('recreates a missing HUD in tmux', async () => {
    const created: Array<{ cwd: string; cmd: string; options?: { heightLines?: number; fullWidth?: boolean } }> = [];
    const resized: Array<{ paneId: string; heightLines: number }> = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
      ],
      readCurrentWindowSize: () => ({ width: 80, height: 24 }),
      createHudWatchPane: (cwd, cmd, options) => {
        created.push({ cwd, cmd, options });
        return '%9';
      },
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      readHudConfig: async () => ({ preset: 'focused', git: { display: 'branch' } }),
      readAllState: async () => ({
        version: null,
        gitBranch: 'main',
        ralph: null,
        ultrawork: null,
        autopilot: null,
        ralplan: null,
        deepInterview: null,
        autoresearch: null,
        ultraqa: null,
        team: null,
        metrics: null,
        hudNotify: null,
        session: null,
      }),
      resolveOmxEntryPath: () => '/repo/dist/index.js',
    });

    assert.equal(result.status, 'recreated');
    assert.equal(result.paneId, '%9');
    assert.equal(created.length, 1);
    assert.equal(created[0]?.options?.heightLines, 1);
    assert.equal(resized.length, 1);
  });

  it('kills duplicate HUD panes and recreates one full-width pane', async () => {
    const killed: string[] = [];

    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        { paneId: '%2', currentCommand: 'node', startCommand: 'node omx hud --watch' },
        { paneId: '%3', currentCommand: 'node', startCommand: 'node omx hud --watch' },
        { paneId: '%4', currentCommand: 'codex', startCommand: 'codex' },
      ],
      readCurrentWindowSize: () => ({ width: 32, height: 24 }),
      killTmuxPane: (paneId) => {
        killed.push(paneId);
        return true;
      },
      createHudWatchPane: (_cwd, _cmd, options) => {
        assert.equal(options?.fullWidth, true);
        return '%9';
      },
      resizeTmuxPane: () => true,
      readHudConfig: async () => ({ preset: 'focused', git: { display: 'branch' } }),
      readAllState: async () => ({
        version: null,
        gitBranch: 'feature/some-branch',
        ralph: { active: true, iteration: 3, max_iterations: 10 },
        ultrawork: null,
        autopilot: null,
        ralplan: null,
        deepInterview: null,
        autoresearch: null,
        ultraqa: null,
        team: null,
        metrics: null,
        hudNotify: null,
        session: null,
      }),
      resolveOmxEntryPath: () => '/repo/dist/index.js',
    });

    assert.equal(result.status, 'replaced_duplicates');
    assert.deepEqual(killed, ['%2', '%3']);
  });

  it('resizes an existing single HUD pane instead of recreating it', async () => {
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const result = await reconcileHudForPromptSubmit('/repo', {
      env: { TMUX: '1', TMUX_PANE: '%1' },
      listCurrentWindowPanes: () => [
        { paneId: '%1', currentCommand: 'codex', startCommand: 'codex' },
        { paneId: '%2', currentCommand: 'node', startCommand: 'node omx hud --watch' },
      ],
      readCurrentWindowSize: () => ({ width: 24, height: 24 }),
      resizeTmuxPane: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      readHudConfig: async () => ({ preset: 'focused', git: { display: 'branch' } }),
      readAllState: async () => ({
        version: null,
        gitBranch: 'feature/some-branch',
        ralph: { active: true, iteration: 3, max_iterations: 10 },
        ultrawork: { active: true },
        autopilot: { active: true, current_phase: 'planning' },
        ralplan: { active: true, current_phase: 'review' },
        deepInterview: null,
        autoresearch: null,
        ultraqa: null,
        team: null,
        metrics: null,
        hudNotify: null,
        session: null,
      }),
      resolveOmxEntryPath: () => '/repo/dist/index.js',
    });

    assert.equal(result.status, 'resized');
    assert.equal(resized.length, 1);
    assert.equal(resized[0]?.paneId, '%2');
    assert.ok((resized[0]?.heightLines ?? 0) >= 2);
  });
});
