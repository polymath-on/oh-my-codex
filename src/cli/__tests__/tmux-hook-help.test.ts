import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmuxHookCommand } from '../tmux-hook.js';

describe('tmuxHookCommand help', () => {
  it('documents team-only / legacy ownership and points non-team users to native hooks', async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...items: unknown[]) => {
      logs.push(items.map(String).join(' '));
    };

    try {
      await tmuxHookCommand(['--help']);
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    assert.match(output, /Non-team tmux-hook usage is deprecated\. Native Codex hooks in \.codex\/hooks\.json now own non-team automation\./);
    assert.match(output, /This command remains for team-runtime \/ legacy tmux injection workflows only\./);
  });
});
