import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getStateFilePath, readCurrentSessionId } from '../mcp/state-paths.js';
import {
  runOmxQuestion,
  type OmxQuestionClientOptions,
  type OmxQuestionSuccessPayload,
} from './client.js';
import type { TerminalLifecycleOutcome } from '../runtime/terminal-lifecycle.js';
import type { QuestionInput } from './types.js';

const DEEP_INTERVIEW_STATE_FILE = 'deep-interview-state.json';

export interface DeepInterviewQuestionEnforcementState {
  obligation_id: string;
  source: 'omx-question';
  status: 'pending' | 'satisfied' | 'cleared';
  lifecycle_outcome: 'askuserQuestion';
  requested_at: string;
  question_id?: string;
  satisfied_at?: string;
  cleared_at?: string;
  clear_reason?: 'handoff' | 'abort' | 'error';
}

interface DeepInterviewStateRecord {
  updated_at?: string;
  lifecycle_outcome?: TerminalLifecycleOutcome;
  question_enforcement?: DeepInterviewQuestionEnforcementState;
  [key: string]: unknown;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function buildObligationId(now = new Date()): string {
  return `deep-interview-question-${now.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 10)}`;
}

async function readDeepInterviewStateIfExists(
  cwd: string,
  sessionId?: string,
): Promise<DeepInterviewStateRecord | null> {
  const statePath = getStateFilePath(DEEP_INTERVIEW_STATE_FILE, cwd, sessionId);
  try {
    return JSON.parse(await readFile(statePath, 'utf-8')) as DeepInterviewStateRecord;
  } catch {
    return null;
  }
}

async function writeDeepInterviewState(
  cwd: string,
  state: DeepInterviewStateRecord,
  sessionId?: string,
): Promise<void> {
  const statePath = getStateFilePath(DEEP_INTERVIEW_STATE_FILE, cwd, sessionId);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function createDeepInterviewQuestionObligation(
  now = new Date(),
): DeepInterviewQuestionEnforcementState {
  return {
    obligation_id: buildObligationId(now),
    source: 'omx-question',
    status: 'pending',
    lifecycle_outcome: 'askuserQuestion',
    requested_at: now.toISOString(),
  };
}

export function isPendingDeepInterviewQuestionEnforcement(
  enforcement: Partial<DeepInterviewQuestionEnforcementState> | null | undefined,
): enforcement is DeepInterviewQuestionEnforcementState {
  return safeString(enforcement?.obligation_id).trim() !== ''
    && safeString(enforcement?.status).trim().toLowerCase() === 'pending';
}

export function satisfyDeepInterviewQuestionObligation(
  enforcement: DeepInterviewQuestionEnforcementState,
  questionId: string,
  now = new Date(),
): DeepInterviewQuestionEnforcementState {
  return {
    ...enforcement,
    status: 'satisfied',
    question_id: questionId,
    satisfied_at: now.toISOString(),
    cleared_at: undefined,
    clear_reason: undefined,
  };
}

export function clearDeepInterviewQuestionObligation(
  enforcement: DeepInterviewQuestionEnforcementState | undefined,
  reason: 'handoff' | 'abort' | 'error',
  now = new Date(),
): DeepInterviewQuestionEnforcementState | undefined {
  if (!enforcement) return undefined;
  if (enforcement.status !== 'pending') return enforcement;
  return {
    ...enforcement,
    status: 'cleared',
    cleared_at: now.toISOString(),
    clear_reason: reason,
  };
}

export async function updateDeepInterviewQuestionEnforcement(
  cwd: string,
  sessionId: string | undefined,
  updater: (
    current: DeepInterviewQuestionEnforcementState | undefined,
  ) => DeepInterviewQuestionEnforcementState | undefined,
): Promise<DeepInterviewStateRecord | null> {
  if (!safeString(sessionId).trim()) return null;
  const state = await readDeepInterviewStateIfExists(cwd, sessionId);
  if (!state) return null;

  const nextEnforcement = updater(state.question_enforcement);
  const nextState: DeepInterviewStateRecord = {
    ...state,
    updated_at: new Date().toISOString(),
    ...(nextEnforcement
      ? {
          question_enforcement: nextEnforcement,
          ...(nextEnforcement.status === 'pending'
            ? {
                lifecycle_outcome: 'askuserQuestion',
                run_outcome: 'blocked_on_user',
                active: false,
                completed_at: safeString(state.completed_at) || new Date().toISOString(),
              }
            : {}),
        }
      : {}),
  };
  if (!nextEnforcement) {
    delete nextState.question_enforcement;
  }
  if (nextEnforcement?.status !== 'pending') {
    delete nextState.lifecycle_outcome;
    delete nextState.run_outcome;
  }

  await writeDeepInterviewState(cwd, nextState, sessionId);
  return nextState;
}

export async function runDeepInterviewQuestion(
  input: Partial<QuestionInput> & { question: string },
  options: OmxQuestionClientOptions = {},
): Promise<OmxQuestionSuccessPayload> {
  const cwd = options.cwd ?? process.cwd();
  const sessionId = safeString(input.session_id).trim() || await readCurrentSessionId(cwd);
  const obligation = createDeepInterviewQuestionObligation();

  await updateDeepInterviewQuestionEnforcement(
    cwd,
    sessionId,
    () => obligation,
  );

  try {
    const result = await runOmxQuestion(
      {
        ...input,
        source: input.source ?? 'deep-interview',
        ...(sessionId ? { session_id: sessionId } : {}),
      },
      options,
    );

    await updateDeepInterviewQuestionEnforcement(
      cwd,
      sessionId,
      (current) => (
        current?.obligation_id === obligation.obligation_id
          ? satisfyDeepInterviewQuestionObligation(current, result.question_id)
          : current
      ),
    );

    return result;
  } catch (error) {
    await updateDeepInterviewQuestionEnforcement(
      cwd,
      sessionId,
      (current) => (
        current?.obligation_id === obligation.obligation_id
          ? clearDeepInterviewQuestionObligation(current, 'error')
          : current
      ),
    );
    throw error;
  }
}
