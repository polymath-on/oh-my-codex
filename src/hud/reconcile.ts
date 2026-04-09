import { readAllState, readHudConfig } from './state.js';
import { renderHud, countRenderedHudLines } from './render.js';
import { HUD_TMUX_HEIGHT_LINES, HUD_TMUX_MAX_HEIGHT_LINES } from './constants.js';
import {
  buildHudWatchCommand,
  createHudWatchPane,
  findHudWatchPaneIds,
  isHudWatchPane,
  killTmuxPane,
  listCurrentWindowPanes,
  readCurrentWindowSize,
  resizeTmuxPane,
  type TmuxPaneSnapshot,
} from './tmux.js';
import { resolveOmxEntryPath } from '../utils/paths.js';

export interface ReconcileHudForPromptSubmitResult {
  status:
    | 'skipped_not_tmux'
    | 'skipped_no_entry'
    | 'resized'
    | 'recreated'
    | 'replaced_duplicates'
    | 'failed';
  paneId: string | null;
  desiredHeight: number | null;
  duplicateCount: number;
}

export interface ReconcileHudForPromptSubmitDeps {
  env?: NodeJS.ProcessEnv;
  listCurrentWindowPanes?: () => TmuxPaneSnapshot[];
  readCurrentWindowSize?: () => { width: number | null; height: number | null };
  createHudWatchPane?: (
    cwd: string,
    hudCmd: string,
    options?: { heightLines?: number; fullWidth?: boolean },
  ) => string | null;
  killTmuxPane?: (paneId: string) => boolean;
  resizeTmuxPane?: (paneId: string, heightLines: number) => boolean;
  readHudConfig?: typeof readHudConfig;
  readAllState?: typeof readAllState;
  renderHud?: typeof renderHud;
  resolveOmxEntryPath?: typeof resolveOmxEntryPath;
}

function resolveHudMaxLines(windowHeight: number | null): number {
  if (!Number.isFinite(windowHeight) || !windowHeight || windowHeight <= 0) {
    return HUD_TMUX_MAX_HEIGHT_LINES;
  }
  return Math.max(1, Math.min(HUD_TMUX_MAX_HEIGHT_LINES, Math.floor(windowHeight - 1)));
}

async function resolveDesiredHudHeight(
  cwd: string,
  width: number | null,
  height: number | null,
  deps: ReconcileHudForPromptSubmitDeps,
): Promise<number> {
  const maxLines = resolveHudMaxLines(height);
  try {
    const readHudConfigFn = deps.readHudConfig ?? readHudConfig;
    const readAllStateFn = deps.readAllState ?? readAllState;
    const renderHudFn = deps.renderHud ?? renderHud;
    const config = await readHudConfigFn(cwd);
    const ctx = await readAllStateFn(cwd, config);
    const frame = renderHudFn(ctx, config.preset, {
      maxWidth: width ?? undefined,
      maxLines,
    });
    return Math.max(1, Math.min(maxLines, countRenderedHudLines(frame)));
  } catch {
    return Math.min(Math.max(1, maxLines), HUD_TMUX_HEIGHT_LINES);
  }
}

export async function reconcileHudForPromptSubmit(
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps = {},
): Promise<ReconcileHudForPromptSubmitResult> {
  const env = deps.env ?? process.env;
  if (!env.TMUX) {
    return {
      status: 'skipped_not_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const resolveOmxEntryPathFn = deps.resolveOmxEntryPath ?? resolveOmxEntryPath;
  const omxBin = resolveOmxEntryPathFn();
  if (!omxBin) {
    return {
      status: 'skipped_no_entry',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const listPanes = deps.listCurrentWindowPanes ?? (() => listCurrentWindowPanes());
  const readSize = deps.readCurrentWindowSize ?? (() => readCurrentWindowSize());
  const createPane = deps.createHudWatchPane ?? ((hudCwd, hudCmd, options) => createHudWatchPane(hudCwd, hudCmd, options));
  const killPane = deps.killTmuxPane ?? ((paneId) => killTmuxPane(paneId));
  const resizePane = deps.resizeTmuxPane ?? ((paneId, lines) => resizeTmuxPane(paneId, lines));

  const panes = listPanes();
  const currentPaneId = env.TMUX_PANE?.trim();
  const hudPaneIds = findHudWatchPaneIds(panes, currentPaneId);
  const duplicateCount = Math.max(0, hudPaneIds.length - 1);
  const nonHudPaneCount = panes.filter((pane) => !isHudWatchPane(pane)).length;
  const { width, height } = readSize();
  const desiredHeight = await resolveDesiredHudHeight(cwd, width, height, deps);

  const readHudConfigFn = deps.readHudConfig ?? readHudConfig;
  const hudConfig = await readHudConfigFn(cwd).catch(() => null);
  const preset = hudConfig?.preset;
  const hudCmd = buildHudWatchCommand(omxBin, preset);

  if (hudPaneIds.length === 1) {
    const resized = resizePane(hudPaneIds[0], desiredHeight);
    return {
      status: resized ? 'resized' : 'failed',
      paneId: hudPaneIds[0],
      desiredHeight,
      duplicateCount,
    };
  }

  for (const paneId of hudPaneIds) {
    killPane(paneId);
  }

  const paneId = createPane(cwd, hudCmd, {
    heightLines: desiredHeight,
    fullWidth: nonHudPaneCount > 1,
  });
  if (!paneId) {
    return {
      status: 'failed',
      paneId: null,
      desiredHeight,
      duplicateCount,
    };
  }

  resizePane(paneId, desiredHeight);

  return {
    status: hudPaneIds.length > 1 ? 'replaced_duplicates' : 'recreated',
    paneId,
    desiredHeight,
    duplicateCount,
  };
}
