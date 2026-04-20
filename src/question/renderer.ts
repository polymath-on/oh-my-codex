import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { parsePaneIdFromTmuxOutput, shellEscapeSingle } from '../hud/tmux.js';
import { sleepSync } from '../utils/sleep.js';
import { sanitizeReplyInput } from '../notifications/reply-listener.js';
import { getCurrentTmuxPaneId } from '../notifications/tmux.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';
import type { QuestionAnswer, QuestionRendererState } from './types.js';

export type QuestionRendererStrategy = 'inside-tmux' | 'detached-tmux' | 'test-noop' | 'unsupported';

export interface LaunchQuestionRendererOptions {
  cwd: string;
  recordPath: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  nowIso?: string;
}

export type ExecTmuxSync = (args: string[]) => string;
export type SleepSync = (ms: number) => void;

const QUESTION_TEXT_SETTLE_MS = 120;
const QUESTION_SUBMIT_REPEAT_DELAY_MS = 100;
const QUESTION_RENDERER_PANE_SETTLE_MS = 120;

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isPaneId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^%\d+$/.test(value.trim());
}

export function resolveQuestionRendererStrategy(
  env: NodeJS.ProcessEnv = process.env,
  tmuxBinary = resolveTmuxBinaryForPlatform(),
): QuestionRendererStrategy {
  if (safeString(env.OMX_QUESTION_TEST_RENDERER).trim() === 'noop') return 'test-noop';
  if (safeString(env.TMUX).trim() !== '') return 'inside-tmux';
  if (tmuxBinary) return 'detached-tmux';
  return 'unsupported';
}

function buildQuestionUiCommand(
  recordPath: string,
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    sessionId?: string;
  },
): string {
  const omxBin = resolveOmxCliEntryPath({
    argv1: process.argv[1],
    cwd: options.cwd,
    env: options.env,
  }) || process.argv[1];
  if (!omxBin) throw new Error('Unable to resolve OMX CLI entry path for question UI launch.');
  const sessionPrefix = options.sessionId ? `OMX_SESSION_ID=${shellEscapeSingle(options.sessionId)} ` : '';
  return `${sessionPrefix}${shellEscapeSingle(process.execPath)} ${shellEscapeSingle(omxBin)} question --ui --state-path ${shellEscapeSingle(recordPath)}`;
}

function defaultExecTmux(args: string[]): string {
  const tmux = resolveTmuxBinaryForPlatform();
  if (!tmux) throw new Error('tmux is unavailable; omx question requires tmux for OMX-owned question UI rendering.');
  return execFileSync(tmux, args, {
    encoding: 'utf-8',
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  });
}

function resolveReturnTarget(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envPane = safeString(env.TMUX_PANE).trim();
  if (isPaneId(envPane)) return envPane;
  const detectedPane = getCurrentTmuxPaneId();
  return isPaneId(detectedPane) ? detectedPane : undefined;
}

function isLaunchedQuestionPaneAlive(
  paneId: string,
  execTmux: ExecTmuxSync,
): boolean {
  if (!isPaneId(paneId)) return false;
  try {
    const status = execTmux(['list-panes', '-t', paneId, '-F', '#{pane_dead}\t#{pane_id}']);
    const firstLine = status.split('\n')[0]?.trim() || '';
    const [paneDead = '', resolvedPaneId = ''] = firstLine.split('\t');
    return paneDead !== '1' && resolvedPaneId === paneId;
  } catch {
    return false;
  }
}

export function formatQuestionAnswerForInjection(answer: QuestionAnswer): string {
  const prefix = '[omx question answered]';
  if (answer.kind === 'other') {
    return sanitizeReplyInput(`${prefix} ${answer.other_text ?? String(answer.value)}`);
  }
  if (answer.kind === 'multi') {
    const raw = Array.isArray(answer.value) ? answer.value.join(', ') : String(answer.value);
    return sanitizeReplyInput(`${prefix} ${raw}`);
  }
  return sanitizeReplyInput(`${prefix} ${String(answer.value)}`);
}

export function injectQuestionAnswerToPane(
  paneId: string,
  answer: QuestionAnswer,
  execTmux: ExecTmuxSync = defaultExecTmux,
  sleepImpl: SleepSync = sleepSync,
): boolean {
  if (!isPaneId(paneId)) return false;
  const text = formatQuestionAnswerForInjection(answer);
  if (!text) return false;

  execTmux(['send-keys', '-t', paneId, '-l', '--', text]);
  // Match the repo-standard Codex raw-mode submit sequence: let literal text
  // settle, then send isolated C-m submits rather than Enter key names.
  sleepImpl(QUESTION_TEXT_SETTLE_MS);
  execTmux(['send-keys', '-t', paneId, 'C-m']);
  sleepImpl(QUESTION_SUBMIT_REPEAT_DELAY_MS);
  execTmux(['send-keys', '-t', paneId, 'C-m']);
  return true;
}

export function launchQuestionRenderer(
  options: LaunchQuestionRendererOptions,
  deps: {
    strategy?: QuestionRendererStrategy;
    execTmux?: ExecTmuxSync;
    sleepSync?: SleepSync;
  } = {},
): QuestionRendererState {
  const strategy = deps.strategy ?? resolveQuestionRendererStrategy(options.env ?? process.env);
  const execTmux = deps.execTmux ?? defaultExecTmux;
  const sleepImpl = deps.sleepSync ?? sleepSync;
  const launchedAt = options.nowIso ?? new Date().toISOString();
  const command = buildQuestionUiCommand(options.recordPath, {
    cwd: options.cwd,
    env: options.env,
    sessionId: options.sessionId,
  });

  if (strategy === 'inside-tmux') {
    const rawPane = execTmux([
      'split-window',
      '-v',
      '-l',
      '12',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      options.cwd,
      command,
    ]);
    const paneId = parsePaneIdFromTmuxOutput(rawPane);
    if (!paneId) throw new Error('Failed to create tmux split pane for omx question UI.');
    sleepImpl(QUESTION_RENDERER_PANE_SETTLE_MS);
    if (!isLaunchedQuestionPaneAlive(paneId, execTmux)) {
      throw new Error(`Question UI pane ${paneId} disappeared immediately after launch.`);
    }
    const returnTarget = resolveReturnTarget(options.env ?? process.env);
    return {
      renderer: 'tmux-pane',
      target: paneId,
      launched_at: launchedAt,
      ...(returnTarget ? { return_target: returnTarget, return_transport: 'tmux-send-keys' } : {}),
    };
  }

  if (strategy === 'detached-tmux') {
    const baseName = basename(options.recordPath, '.json').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32) || 'question';
    const sessionName = `omx-question-${baseName}`;
    const output = execTmux([
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{session_name}',
      '-s',
      sessionName,
      '-c',
      options.cwd,
      command,
    ]).trim();
    return {
      renderer: 'tmux-session',
      target: output || sessionName,
      launched_at: launchedAt,
    };
  }

  if (strategy === 'test-noop') {
    return {
      renderer: 'tmux-session',
      target: 'test-noop-renderer',
      launched_at: launchedAt,
    };
  }

  throw new Error('omx question requires tmux for OMX-owned question UI rendering in this session.');
}
