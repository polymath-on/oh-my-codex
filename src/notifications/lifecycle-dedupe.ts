import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NotificationEvent, FullNotificationPayload } from './types.js';

const SESSION_ID_SAFE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const LIFECYCLE_DEDUPE_FILE = 'lifecycle-notif-state.json';
const DEDUPED_EVENTS = new Set<NotificationEvent>(['session-start', 'session-stop', 'session-end']);

interface LifecycleDedupeState {
  events?: Record<string, { fingerprint?: string; sentAt?: string }>;
}

function normalizeFingerprint(payload: FullNotificationPayload): string {
  return JSON.stringify({
    event: payload.event,
    reason: payload.reason || '',
    activeMode: payload.activeMode || '',
    question: payload.question || '',
    incompleteTasks: payload.incompleteTasks || 0,
  });
}

function getStatePath(stateDir: string, sessionId: string): string {
  if (SESSION_ID_SAFE_PATTERN.test(sessionId)) {
    return join(stateDir, 'sessions', sessionId, LIFECYCLE_DEDUPE_FILE);
  }
  return join(stateDir, LIFECYCLE_DEDUPE_FILE);
}

function readState(path: string): LifecycleDedupeState {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LifecycleDedupeState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(path: string, state: LifecycleDedupeState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    // best effort
  }
}

export function shouldDedupeLifecycleNotification(event: NotificationEvent): boolean {
  return DEDUPED_EVENTS.has(event);
}

export function shouldSendLifecycleNotification(
  stateDir: string,
  payload: FullNotificationPayload,
): boolean {
  if (!shouldDedupeLifecycleNotification(payload.event)) return true;
  if (!payload.sessionId || !stateDir) return true;
  const path = getStatePath(stateDir, payload.sessionId);
  const state = readState(path);
  const previous = state.events?.[payload.event];
  return previous?.fingerprint !== normalizeFingerprint(payload);
}

export function recordLifecycleNotificationSent(
  stateDir: string,
  payload: FullNotificationPayload,
): void {
  if (!shouldDedupeLifecycleNotification(payload.event)) return;
  if (!payload.sessionId || !stateDir) return;
  const path = getStatePath(stateDir, payload.sessionId);
  const state = readState(path);
  state.events = state.events && typeof state.events === 'object' ? state.events : {};
  state.events[payload.event] = {
    fingerprint: normalizeFingerprint(payload),
    sentAt: new Date().toISOString(),
  };
  writeState(path, state);
}
