import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldSendLifecycleNotification,
  recordLifecycleNotificationSent,
} from '../lifecycle-dedupe.js';
import type { FullNotificationPayload } from '../types.js';

function buildPayload(overrides: Partial<FullNotificationPayload> = {}): FullNotificationPayload {
  return {
    event: 'session-end',
    sessionId: 'session-1475',
    message: 'done',
    timestamp: '2026-04-11T00:00:00.000Z',
    projectPath: '/tmp/project',
    projectName: 'project',
    reason: 'session_exit',
    ...overrides,
  };
}

describe('lifecycle notification dedupe', () => {
  it('suppresses duplicate session lifecycle notifications for the same session transition', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-dedupe-'));
    try {
      const payload = buildPayload();
      assert.equal(shouldSendLifecycleNotification(stateDir, payload), true);
      recordLifecycleNotificationSent(stateDir, payload);
      assert.equal(shouldSendLifecycleNotification(stateDir, payload), false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('re-emits when the lifecycle fingerprint changes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-dedupe-change-'));
    try {
      const payload = buildPayload();
      recordLifecycleNotificationSent(stateDir, payload);
      assert.equal(shouldSendLifecycleNotification(stateDir, buildPayload({ reason: 'completed' })), true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('stores dedupe state per session id', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'omx-lifecycle-dedupe-session-'));
    try {
      const payload = buildPayload({ sessionId: 'session-a', event: 'session-start' });
      recordLifecycleNotificationSent(stateDir, payload);

      const sessionFile = join(stateDir, 'sessions', 'session-a', 'lifecycle-notif-state.json');
      const state = JSON.parse(await readFile(sessionFile, 'utf-8')) as {
        events?: Record<string, { fingerprint?: string }>;
      };

      assert.equal(typeof state.events?.['session-start']?.fingerprint, 'string');
      assert.equal(shouldSendLifecycleNotification(stateDir, buildPayload({ sessionId: 'session-b', event: 'session-start' })), true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
