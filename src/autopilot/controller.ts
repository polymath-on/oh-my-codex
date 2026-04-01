import { join } from 'node:path';
import { cancelMode, readModeState, startMode, updateModeState, type ModeState } from '../modes/base.js';
import { getDefaultBridge, isBridgeEnabled, type RuntimeSnapshot } from '../runtime/bridge.js';
import type {
  AutopilotControllerAction,
  AutopilotControllerOptions,
  PipelineConfig,
  PipelineModeStateExtension,
  PipelineResult,
  StageContext,
  StageResult,
} from '../pipeline/types.js';

const MODE_NAME = 'autopilot' as const;
const ACTION_ORDER = ['plan', 'execute', 'verify'] as const satisfies readonly AutopilotControllerAction[];
const ACTION_TO_PHASE = {
  plan: 'planning',
  execute: 'execution',
  verify: 'verification',
  replan: 'planning',
  finish: 'complete',
} as const;
const DEFAULT_STAGE_BY_ACTION: Record<AutopilotControllerAction, string> = {
  plan: 'ralplan',
  execute: 'team-exec',
  verify: 'ralph-verify',
};
const AUTOPILOT_CONTROLLER_VERSION = 'runtime-controller-v1';
export const AUTOPILOT_CONTROLLER_ENTRYPOINT = 'src/autopilot/controller.ts#runAutopilotController';

type ControllerAction = AutopilotControllerAction | 'replan' | 'finish';
type ControllerPhase = typeof ACTION_TO_PHASE[ControllerAction];
type ControllerEvidenceStatus = 'fresh' | 'stale' | 'missing';
type ControllerLedgerStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'skipped';

interface ControllerLedgerEntry {
  stage: string;
  status: ControllerLedgerStatus;
  attempts: number;
  last_result?: StageResult;
  evidence_summary?: string;
}

interface ControllerLedger {
  planning: ControllerLedgerEntry;
  execution: ControllerLedgerEntry;
  verification: ControllerLedgerEntry;
}

export interface AutopilotDecisionLog {
  index: number;
  action: ControllerAction;
  phase: ControllerPhase;
  stage?: string;
  trigger: string;
  reason: string;
  evidence_status: ControllerEvidenceStatus;
  evidence_summary: string;
  compatibility_phase: string;
  timestamp: string;
}

export interface RuntimeBridgeSummary {
  captured: boolean;
  source: 'disabled' | 'runtime-bridge' | 'injected' | 'unavailable';
  readiness_ready: boolean | null;
  readiness_reasons: string[];
  backlog_pending: number | null;
  replay_pending_events: number | null;
  authority_owner: string | null;
}

export interface AutopilotControllerStateExtension extends ModeState, PipelineModeStateExtension {
  autopilot_entrypoint: string;
  autopilot_controller_version: string;
  autopilot_controller_phase: ControllerPhase;
  autopilot_controller_active_action: ControllerAction;
  autopilot_controller_stage_by_action: Record<AutopilotControllerAction, string>;
  autopilot_controller_decisions: AutopilotDecisionLog[];
  autopilot_controller_ledger: ControllerLedger;
  autopilot_controller_last_reason: string;
  autopilot_controller_evidence_status: ControllerEvidenceStatus;
  autopilot_controller_runtime_bridge: RuntimeBridgeSummary;
  autopilot_controller_compat_phase: string;
  autopilot_controller_replan_attempts: number;
}

export interface RunAutopilotControllerOptions {
  runtimeSnapshotReader?: (cwd: string) => RuntimeSnapshot | null;
}

interface ControllerDecision {
  action: ControllerAction;
  stageName?: string;
  trigger: string;
  reason: string;
  evidenceStatus: ControllerEvidenceStatus;
  evidenceSummary: string;
}

interface ControllerDecisionContext {
  stageByAction: Record<AutopilotControllerAction, string>;
  ledger: ControllerLedger;
  stageResults: Record<string, StageResult>;
  executionArtifacts: Record<string, unknown> | null;
  replanAttempts: number;
  maxReplanAttempts: number;
}

function isFinalized(status: ControllerLedgerStatus): boolean {
  return status === 'completed' || status === 'skipped';
}

function statusFromStageResult(result: StageResult): ControllerLedgerStatus {
  if (result.status === 'completed') return 'completed';
  if (result.status === 'skipped') return 'skipped';
  return 'failed';
}

function resolveStageByAction(config: PipelineConfig): Record<AutopilotControllerAction, string> {
  const explicit = config.autopilotController?.stageByAction ?? {};
  const byName = new Map(config.stages.map((stage) => [stage.name, stage.name]));
  const remaining = [...config.stages.map((stage) => stage.name)];
  const resolved = {} as Record<AutopilotControllerAction, string>;

  for (const action of ACTION_ORDER) {
    const configured = explicit[action]?.trim();
    if (configured && byName.has(configured)) {
      resolved[action] = configured;
      const index = remaining.indexOf(configured);
      if (index >= 0) remaining.splice(index, 1);
      continue;
    }

    const preferred = DEFAULT_STAGE_BY_ACTION[action];
    if (byName.has(preferred)) {
      resolved[action] = preferred;
      const index = remaining.indexOf(preferred);
      if (index >= 0) remaining.splice(index, 1);
      continue;
    }

    const fallback = remaining.shift();
    if (!fallback) {
      throw new Error(`Autopilot controller requires a stage for action "${action}"`);
    }
    resolved[action] = fallback;
  }

  return resolved;
}

function createInitialLedger(stageByAction: Record<AutopilotControllerAction, string>): ControllerLedger {
  return {
    planning: { stage: stageByAction.plan, status: 'pending', attempts: 0 },
    execution: { stage: stageByAction.execute, status: 'pending', attempts: 0 },
    verification: { stage: stageByAction.verify, status: 'pending', attempts: 0 },
  };
}

function pickExecutionArtifacts(
  stageResults: Record<string, StageResult>,
  stageByAction: Record<AutopilotControllerAction, string>,
): Record<string, unknown> | null {
  const result = stageResults[stageByAction.execute];
  if (!result || !result.artifacts || typeof result.artifacts !== 'object') return null;
  return result.artifacts as Record<string, unknown>;
}

function inferEvidenceStatus(executionArtifacts: Record<string, unknown> | null): ControllerEvidenceStatus {
  const value = executionArtifacts?.verificationEvidence ?? executionArtifacts?.evidenceStatus;
  if (value === 'fresh' || value === 'stale' || value === 'missing') return value;
  if (executionArtifacts?.requiresVerification === true) return 'stale';
  if (executionArtifacts?.riskLevel === 'high' || executionArtifacts?.riskLevel === 'critical') return 'stale';
  return executionArtifacts ? 'fresh' : 'missing';
}

function summarizeExecutionEvidence(
  executionArtifacts: Record<string, unknown> | null,
  evidenceStatus: ControllerEvidenceStatus,
): string {
  if (!executionArtifacts) {
    return 'no execution evidence captured yet';
  }

  const summary = executionArtifacts.evidenceSummary;
  if (typeof summary === 'string' && summary.trim() !== '') {
    return summary.trim();
  }

  const parts: string[] = [];
  if (typeof executionArtifacts.riskLevel === 'string') {
    parts.push(`risk=${executionArtifacts.riskLevel}`);
  }
  if (typeof executionArtifacts.changedFiles === 'number') {
    parts.push(`changed_files=${executionArtifacts.changedFiles}`);
  }
  if (executionArtifacts.requiresVerification === true) {
    parts.push('requires_verification=true');
  }
  parts.push(`evidence=${evidenceStatus}`);
  return parts.join(', ');
}

export function chooseAutopilotControllerAction(context: ControllerDecisionContext): ControllerDecision {
  const executionEntry = context.ledger.execution;
  if (!isFinalized(context.ledger.planning.status)) {
    return {
      action: 'plan',
      stageName: context.stageByAction.plan,
      trigger: 'missing_plan_state',
      reason: 'Planning artifacts are not yet controller-complete.',
      evidenceStatus: 'missing',
      evidenceSummary: 'controller requires a planning baseline before execution',
    };
  }

  if (executionEntry.status === 'failed' && context.replanAttempts < context.maxReplanAttempts) {
    return {
      action: 'replan',
      stageName: context.stageByAction.plan,
      trigger: 'execution_failed',
      reason: 'Execution failed and the controller is retrying through the planning adapter.',
      evidenceStatus: inferEvidenceStatus(context.executionArtifacts),
      evidenceSummary: summarizeExecutionEvidence(
        context.executionArtifacts,
        inferEvidenceStatus(context.executionArtifacts),
      ),
    };
  }

  if (!isFinalized(executionEntry.status)) {
    return {
      action: 'execute',
      stageName: context.stageByAction.execute,
      trigger: 'planning_ready',
      reason: 'Planning is ready, so the controller is dispatching execution through the team adapter.',
      evidenceStatus: 'missing',
      evidenceSummary: 'execution has not produced evidence yet',
    };
  }

  if (!isFinalized(context.ledger.verification.status)) {
    const evidenceStatus = inferEvidenceStatus(context.executionArtifacts);
    const summary = summarizeExecutionEvidence(context.executionArtifacts, evidenceStatus);
    const riskLevel = context.executionArtifacts?.riskLevel;
    const requiresVerification = context.executionArtifacts?.requiresVerification === true;
    const trigger = evidenceStatus === 'stale'
      ? 'stale_execution_evidence'
      : evidenceStatus === 'missing'
        ? 'missing_execution_evidence'
        : (riskLevel === 'high' || riskLevel === 'critical' || requiresVerification)
          ? 'risk_signal'
          : 'completion_gate';
    const reason = trigger === 'risk_signal'
      ? 'Execution signaled elevated risk, so verification is inserted before completion.'
      : trigger === 'completion_gate'
        ? 'Execution finished cleanly, but verification still owns the final completion gate.'
        : 'Execution evidence is incomplete or stale, so verification must run before finish.';
    return {
      action: 'verify',
      stageName: context.stageByAction.verify,
      trigger,
      reason,
      evidenceStatus,
      evidenceSummary: summary,
    };
  }

  return {
    action: 'finish',
    trigger: 'verification_complete',
    reason: 'Planning, execution, and verification are complete.',
    evidenceStatus: 'fresh',
    evidenceSummary: 'controller completed all autopilot ledger steps',
  };
}

function buildRuntimeBridgeSummary(
  cwd: string,
  options: AutopilotControllerOptions | undefined,
  runtimeOptions: RunAutopilotControllerOptions,
): RuntimeBridgeSummary {
  if (options?.captureRuntimeSnapshot === false) {
    return {
      captured: false,
      source: 'disabled',
      readiness_ready: null,
      readiness_reasons: [],
      backlog_pending: null,
      replay_pending_events: null,
      authority_owner: null,
    };
  }

  try {
    const snapshot = runtimeOptions.runtimeSnapshotReader
      ? runtimeOptions.runtimeSnapshotReader(cwd)
      : (isBridgeEnabled() ? getDefaultBridge(join(cwd, '.omx', 'state')).readSnapshot() : null);
    if (!snapshot) {
      return {
        captured: false,
        source: 'unavailable',
        readiness_ready: null,
        readiness_reasons: [],
        backlog_pending: null,
        replay_pending_events: null,
        authority_owner: null,
      };
    }

    return {
      captured: true,
      source: runtimeOptions.runtimeSnapshotReader ? 'injected' : 'runtime-bridge',
      readiness_ready: snapshot.readiness.ready,
      readiness_reasons: [...snapshot.readiness.reasons],
      backlog_pending: snapshot.backlog.pending,
      replay_pending_events: snapshot.replay.pending_events,
      authority_owner: snapshot.authority.owner,
    };
  } catch {
    return {
      captured: false,
      source: 'unavailable',
      readiness_ready: null,
      readiness_reasons: [],
      backlog_pending: null,
      replay_pending_events: null,
      authority_owner: null,
    };
  }
}

function buildDecisionLog(
  decisions: AutopilotDecisionLog[],
  decision: ControllerDecision,
  compatibilityPhase: string,
): AutopilotDecisionLog[] {
  return decisions.concat({
    index: decisions.length + 1,
    action: decision.action,
    phase: ACTION_TO_PHASE[decision.action],
    stage: decision.stageName,
    trigger: decision.trigger,
    reason: decision.reason,
    evidence_status: decision.evidenceStatus,
    evidence_summary: decision.evidenceSummary,
    compatibility_phase: compatibilityPhase,
    timestamp: new Date().toISOString(),
  });
}

function validateAutopilotControllerConfig(config: PipelineConfig, stageByAction: Record<AutopilotControllerAction, string>): void {
  if (config.name !== 'autopilot') {
    throw new Error('Autopilot controller requires config.name to be "autopilot"');
  }
  for (const action of ACTION_ORDER) {
    if (!config.stages.some((stage) => stage.name === stageByAction[action])) {
      throw new Error(`Autopilot controller could not resolve a stage for action "${action}"`);
    }
  }
}

function stageIndex(config: PipelineConfig, stageName: string): number {
  return config.stages.findIndex((stage) => stage.name === stageName);
}

function cloneArtifacts(artifacts: Record<string, unknown>): Record<string, unknown> {
  return { ...artifacts };
}

export async function runAutopilotController(
  config: PipelineConfig,
  runtimeOptions: RunAutopilotControllerOptions = {},
): Promise<PipelineResult> {
  const stageByAction = resolveStageByAction(config);
  validateAutopilotControllerConfig(config, stageByAction);

  const cwd = config.cwd ?? process.cwd();
  const maxRalphIterations = config.maxRalphIterations ?? 10;
  const workerCount = config.workerCount ?? 2;
  const agentType = config.agentType ?? 'executor';
  const maxReplanAttempts = Math.max(0, config.autopilotController?.maxReplanAttempts ?? 1);
  const runtimeBridgeSummary = buildRuntimeBridgeSummary(cwd, config.autopilotController, runtimeOptions);
  const stageResults: Record<string, StageResult> = {};
  const artifacts: Record<string, unknown> = {};
  let decisions: AutopilotDecisionLog[] = [];
  let ledger = createInitialLedger(stageByAction);
  let previousResult: StageResult | undefined;
  let lastStageName: string | undefined;
  let replanAttempts = 0;
  const started = await startMode(MODE_NAME, config.task, config.stages.length, cwd);

  const pipelineExtension: PipelineModeStateExtension = {
    pipeline_name: config.name,
    pipeline_stages: config.stages.map((stage) => stage.name),
    pipeline_stage_index: 0,
    pipeline_stage_results: {},
    pipeline_max_ralph_iterations: maxRalphIterations,
    pipeline_worker_count: workerCount,
    pipeline_agent_type: agentType,
  };

  await updateModeState(MODE_NAME, {
    ...started,
    ...pipelineExtension,
    current_phase: 'planning',
    autopilot_entrypoint: AUTOPILOT_CONTROLLER_ENTRYPOINT,
    autopilot_controller_version: AUTOPILOT_CONTROLLER_VERSION,
    autopilot_controller_phase: 'planning',
    autopilot_controller_active_action: 'plan',
    autopilot_controller_stage_by_action: stageByAction,
    autopilot_controller_decisions: decisions,
    autopilot_controller_ledger: ledger,
    autopilot_controller_last_reason: 'Controller initialized.',
    autopilot_controller_evidence_status: 'missing',
    autopilot_controller_runtime_bridge: runtimeBridgeSummary,
    autopilot_controller_compat_phase: `stage:${stageByAction.plan}`,
    autopilot_controller_replan_attempts: 0,
  } as Partial<AutopilotControllerStateExtension>, cwd);

  for (let safetyCounter = 0; safetyCounter < 10; safetyCounter += 1) {
    const executionArtifacts = pickExecutionArtifacts(stageResults, stageByAction);
    const decision = chooseAutopilotControllerAction({
      stageByAction,
      ledger,
      stageResults,
      executionArtifacts,
      replanAttempts,
      maxReplanAttempts,
    });

    const compatibilityPhase = decision.stageName ? `stage:${decision.stageName}` : 'controller:finish';
    decisions = buildDecisionLog(decisions, decision, compatibilityPhase);

    if (decision.action === 'finish') {
      await updateModeState(MODE_NAME, {
        active: false,
        current_phase: 'complete',
        completed_at: new Date().toISOString(),
        iteration: decisions.length,
        pipeline_stage_results: { ...stageResults },
        autopilot_controller_phase: 'complete',
        autopilot_controller_active_action: 'finish',
        autopilot_controller_decisions: decisions,
        autopilot_controller_ledger: ledger,
        autopilot_controller_last_reason: decision.reason,
        autopilot_controller_evidence_status: 'fresh',
        autopilot_controller_compat_phase: compatibilityPhase,
        autopilot_controller_replan_attempts: replanAttempts,
      } as Partial<AutopilotControllerStateExtension>, cwd);
      return {
        status: 'completed',
        stageResults,
        duration_ms: Date.now() - Date.parse(started.started_at),
        artifacts,
      };
    }

    const stageName = decision.stageName!;
    const stage = config.stages.find((candidate) => candidate.name === stageName);
    if (!stage) {
      throw new Error(`Autopilot controller missing stage "${stageName}"`);
    }

    if (decision.action === 'replan') {
      replanAttempts += 1;
      ledger = {
        ...ledger,
        planning: { ...ledger.planning, status: 'pending' },
        execution: { ...ledger.execution, status: 'pending' },
        verification: { ...ledger.verification, status: 'pending' },
      };
    }

    const ledgerKey = stageName === stageByAction.plan
      ? 'planning'
      : stageName === stageByAction.execute
        ? 'execution'
        : 'verification';
    const entry = ledger[ledgerKey];
    ledger = {
      ...ledger,
      [ledgerKey]: {
        ...entry,
        status: 'in_progress',
        attempts: entry.attempts + 1,
      },
    };

    await updateModeState(MODE_NAME, {
      current_phase: ACTION_TO_PHASE[decision.action],
      iteration: decisions.length,
      pipeline_stage_index: stageIndex(config, stageName),
      autopilot_controller_phase: ACTION_TO_PHASE[decision.action],
      autopilot_controller_active_action: decision.action,
      autopilot_controller_decisions: decisions,
      autopilot_controller_ledger: ledger,
      autopilot_controller_last_reason: decision.reason,
      autopilot_controller_evidence_status: decision.evidenceStatus,
      autopilot_controller_compat_phase: compatibilityPhase,
      autopilot_controller_replan_attempts: replanAttempts,
    } as Partial<AutopilotControllerStateExtension>, cwd);

    const ctx: StageContext = {
      task: config.task,
      artifacts: cloneArtifacts(artifacts),
      previousStageResult: previousResult,
      cwd,
      sessionId: config.sessionId,
    };

    if (lastStageName && config.onStageTransition) {
      config.onStageTransition(lastStageName, stageName);
    }

    let result: StageResult;
    try {
      if (stage.canSkip?.(ctx)) {
        result = {
          status: 'skipped',
          artifacts: {},
          duration_ms: 0,
        };
      } else {
        result = await stage.run(ctx);
      }
    } catch (error) {
      result = {
        status: 'failed',
        artifacts: {},
        duration_ms: 0,
        error: `Stage ${stageName} threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    stageResults[stageName] = result;
    artifacts[stageName] = result.artifacts;
    ledger = {
      ...ledger,
      [ledgerKey]: {
        ...ledger[ledgerKey],
        status: statusFromStageResult(result),
        last_result: result,
        evidence_summary: decision.evidenceSummary,
      },
    };

    await updateModeState(MODE_NAME, {
      current_phase: result.status === 'failed' ? 'blocked' : ACTION_TO_PHASE[decision.action],
      iteration: decisions.length,
      pipeline_stage_index: stageIndex(config, stageName),
      pipeline_stage_results: { ...stageResults },
      autopilot_controller_phase: result.status === 'failed' ? 'planning' : ACTION_TO_PHASE[decision.action],
      autopilot_controller_active_action: decision.action,
      autopilot_controller_decisions: decisions,
      autopilot_controller_ledger: ledger,
      autopilot_controller_last_reason: decision.reason,
      autopilot_controller_evidence_status: decision.evidenceStatus,
      autopilot_controller_compat_phase: `${compatibilityPhase}:${result.status}`,
      autopilot_controller_replan_attempts: replanAttempts,
    } as Partial<AutopilotControllerStateExtension>, cwd);

    if (result.status === 'failed') {
      if (stageName === stageByAction.execute && replanAttempts < maxReplanAttempts) {
        previousResult = result;
        lastStageName = stageName;
        continue;
      }

      await updateModeState(MODE_NAME, {
        active: false,
        current_phase: 'failed',
        completed_at: new Date().toISOString(),
        error: result.error,
        iteration: decisions.length,
        pipeline_stage_results: { ...stageResults },
        autopilot_controller_phase: 'planning',
        autopilot_controller_active_action: decision.action,
        autopilot_controller_decisions: decisions,
        autopilot_controller_ledger: ledger,
        autopilot_controller_last_reason: decision.reason,
        autopilot_controller_evidence_status: decision.evidenceStatus,
        autopilot_controller_compat_phase: `${compatibilityPhase}:${result.status}`,
        autopilot_controller_replan_attempts: replanAttempts,
      } as Partial<AutopilotControllerStateExtension>, cwd);
      return {
        status: 'failed',
        stageResults,
        duration_ms: Date.now() - Date.parse(started.started_at),
        artifacts,
        error: result.error,
        failedStage: stageName,
      };
    }

    previousResult = result;
    lastStageName = stageName;
  }

  throw new Error('Autopilot controller exceeded its safety iteration budget');
}

export async function readAutopilotControllerState(
  cwd?: string,
): Promise<AutopilotControllerStateExtension | null> {
  const state = await readModeState(MODE_NAME, cwd);
  if (!state || state.autopilot_entrypoint !== AUTOPILOT_CONTROLLER_ENTRYPOINT) {
    return null;
  }
  return state as unknown as AutopilotControllerStateExtension;
}

export async function canResumeAutopilotController(cwd?: string): Promise<boolean> {
  const state = await readAutopilotControllerState(cwd);
  if (!state) return false;
  return state.active === true && state.current_phase !== 'complete' && state.current_phase !== 'failed';
}

export async function cancelAutopilotController(cwd?: string): Promise<void> {
  await cancelMode(MODE_NAME, cwd);
}
