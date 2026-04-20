import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatQuestionAnswerForInjection,
  injectQuestionAnswerToPane,
  launchQuestionRenderer,
  resolveQuestionRendererStrategy,
} from '../renderer.js';

describe('resolveQuestionRendererStrategy', () => {
  it('prefers inside-tmux when TMUX is present', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ TMUX: '/tmp/tmux-demo' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'inside-tmux',
    );
  });

  it('falls back to detached-tmux when tmux exists but TMUX is absent', () => {
    assert.equal(
      resolveQuestionRendererStrategy({} as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'detached-tmux',
    );
  });

  it('uses noop test renderer override when requested', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_QUESTION_TEST_RENDERER: 'noop' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'test-noop',
    );
  });
});

describe('launchQuestionRenderer', () => {
  it('opens an interactive foreground split when already inside tmux', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
        sessionId: 's1',
        nowIso: '2026-04-19T00:00:00.000Z',
        env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'split-window') return '%42\n';
          if (args[0] === 'list-panes') return '0\t%42\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-pane');
    assert.equal(result.target, '%42');
    assert.equal(result.return_target, '%11');
    assert.equal(result.return_transport, 'tmux-send-keys');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'split-window');
    assert.ok(!calls[0]?.includes('-d'));
    assert.deepEqual(calls[1], ['list-panes', '-t', '%42', '-F', '#{pane_dead}\t#{pane_id}']);
  });

  it('fails before prompting state when a reported split pane is already gone', () => {
    const calls: string[][] = [];
    assert.throws(
      () => launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
          sessionId: 's1',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'split-window') return '%42\n';
            throw new Error("can't find pane: %42");
          },
          sleepSync: () => {},
        },
      ),
      /Question UI pane %42 disappeared immediately after launch/,
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'split-window');
    assert.deepEqual(calls[1], ['list-panes', '-t', '%42', '-F', '#{pane_dead}\t#{pane_id}']);
  });

  it('uses detached sessions outside tmux', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-2.json',
        nowIso: '2026-04-19T00:00:00.000Z',
      },
      {
        strategy: 'detached-tmux',
        execTmux: (args) => {
          calls.push(args);
          return 'omx-question-question-2\n';
        },
      },
    );

    assert.equal(result.renderer, 'tmux-session');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], 'new-session');
    assert.ok(calls[0]?.includes('-d'));
  });

  it('prefers the current launcher path over a stale ambient OMX_ENTRY_PATH when spawning the UI', () => {
    const calls: string[][] = [];
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/repo/dist/cli/omx.js';
    try {
      const result = launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-3.json',
          sessionId: 's1',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: {
            TMUX: '/tmp/tmux-demo',
            TMUX_PANE: '%11',
            OMX_ENTRY_PATH: '/stale/global/dist/cli/omx.js',
          } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'split-window') return '%42\n';
            if (args[0] === 'list-panes') return '0\t%42\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.target, '%42');
      const command = calls[0]?.[calls[0].length - 1] || '';
      assert.match(command, /\/repo\/dist\/cli\/omx\.js/);
      assert.doesNotMatch(command, /\/stale\/global\/dist\/cli\/omx\.js/);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

describe('question answer injection', () => {
  it('formats other answers into a single-line continuation-safe prompt', () => {
    assert.equal(
      formatQuestionAnswerForInjection({
        kind: 'other',
        value: 'hello\nworld',
        selected_labels: ['Other'],
        selected_values: ['hello\nworld'],
        other_text: 'hello\nworld',
      }),
      '[omx question answered] hello world',
    );
  });

  it('injects the answered text back into the requester pane and submits with isolated double C-m', () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const ok = injectQuestionAnswerToPane(
      '%11',
      {
        kind: 'option',
        value: 'proceed',
        selected_labels: ['Proceed'],
        selected_values: ['proceed'],
      },
      (args) => {
        calls.push(args);
        return '';
      },
      (ms) => {
        sleeps.push(ms);
      },
    );

    assert.equal(ok, true);
    assert.deepEqual(calls, [
      ['send-keys', '-t', '%11', '-l', '--', '[omx question answered] proceed'],
      ['send-keys', '-t', '%11', 'C-m'],
      ['send-keys', '-t', '%11', 'C-m'],
    ]);
    assert.deepEqual(sleeps, [120, 100]);
    assert.equal(calls.some((argv) => argv.includes('Enter')), false);
  });
});
