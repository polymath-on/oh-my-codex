import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeSnapshot } from '../../runtime/bridge.js';
import type { PipelineConfig, PipelineStage, StageContext, StageResult } from '../../pipeline/types.js';
import {
  AUTOPILOT_CONTROLLER_ENTRYPOINT,
  chooseAutopilotControllerAction,
  runAutopilotController,
} from '../controller.js';

function makeStage(
  name: string,
  result: Partial<StageResult> = {},
  hooks?: { onRun?: (ctx: StageContext) => void },
): PipelineStage {
  return {
    name,
    async run(ctx: StageContext): Promise<StageResult> {
      hooks?.onRun?.(ctx);
      return {
        status: 'completed',
        artifacts: { stage: name },
        duration_ms: 0,
        ...result,
      };
    },
  };
}

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-autopilot-controller-'));
});

afterEach(async () => {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe('Autopilot runtime-controller', () => {
  describe('unit decisions', () => {
    it('routes execution failure back to planning before replan budget is exhausted', () => {
      const decision = chooseAutopilotControllerAction({
        stageByAction: {
          plan: 'ralplan',
          execute: 'team-exec',
          verify: 'ralph-verify',
        },
        ledger: {
          planning: { stage: 'ralplan', status: 'completed', attempts: 1 },
          execution: { stage: 'team-exec', status: 'failed', attempts: 1 },
          verification: { stage: 'ralph-verify', status: 'pending', attempts: 0 },
        },
        stageResults: {},
        executionArtifacts: { verificationEvidence: 'stale', evidenceSummary: 'worker run failed before verification' },
        replanAttempts: 0,
        maxReplanAttempts: 1,
      });

      assert.equal(decision.action, 'replan');
      assert.equal(decision.stageName, 'ralplan');
      assert.equal(decision.trigger, 'execution_failed');
      assert.equal(decision.evidenceStatus, 'stale');
    });
  });

  describe('integration + smoke', () => {
    it('records decision reasons, runtime-bridge fit, and compatibility state while preserving autopilot semantics', async () => {
      const transitions: Array<[string, string]> = [];
      const executionInputs: Array<Record<string, unknown>> = [];
      const config: PipelineConfig = {
        name: 'autopilot',
        task: 'implement the approved autopilot milestone',
        cwd: tempDir,
        stages: [
          makeStage('ralplan', {
            artifacts: {
              stage: 'ralplan',
              prdPaths: ['.omx/plans/prd-autopilot-runtime-controller.md'],
              testSpecPaths: ['.omx/plans/test-spec-autopilot-runtime-controller.md'],
            },
          }),
          makeStage('team-exec', {
            artifacts: {
              stage: 'team-exec',
              riskLevel: 'high',
              verificationEvidence: 'stale',
              requiresVerification: true,
              changedFiles: 4,
              evidenceSummary: 'team execution changed controller wiring and needs verification',
            },
          }, {
            onRun: (ctx) => executionInputs.push(ctx.artifacts),
          }),
          makeStage('ralph-verify', {
            artifacts: {
              stage: 'ralph-verify',
              verificationEvidence: 'fresh',
            },
          }),
        ],
        autopilotController: {
          enabled: true,
          stageByAction: {
            plan: 'ralplan',
            execute: 'team-exec',
            verify: 'ralph-verify',
          },
          maxReplanAttempts: 1,
        },
        onStageTransition: (from, to) => transitions.push([from, to]),
      };

      const snapshot: RuntimeSnapshot = {
        schema_version: 1,
        authority: {
          owner: 'autopilot-controller',
          lease_id: 'lease-1',
          leased_until: '2026-04-01T04:55:00.000Z',
          stale: false,
          stale_reason: null,
        },
        backlog: {
          pending: 1,
          notified: 0,
          delivered: 0,
          failed: 0,
        },
        replay: {
          cursor: 'cursor-1',
          pending_events: 2,
          last_replayed_event_id: 'evt-1',
          deferred_leader_notification: false,
        },
        readiness: {
          ready: true,
          reasons: [],
        },
      };

      const result = await runAutopilotController(config, {
        runtimeSnapshotReader: () => snapshot,
      });

      assert.equal(result.status, 'completed');
      assert.deepEqual(Object.keys(result.stageResults), ['ralplan', 'team-exec', 'ralph-verify']);
      assert.deepEqual(transitions, [
        ['ralplan', 'team-exec'],
        ['team-exec', 'ralph-verify'],
      ]);
      assert.equal(executionInputs.length, 1);
      assert.ok(executionInputs[0]?.ralplan);

      const persisted = JSON.parse(await readFile(join(tempDir, '.omx', 'state', 'autopilot-state.json'), 'utf-8'));
      assert.equal(persisted.autopilot_entrypoint, AUTOPILOT_CONTROLLER_ENTRYPOINT);
      assert.equal(persisted.current_phase, 'complete');
      assert.equal(persisted.autopilot_controller_runtime_bridge.source, 'injected');
      assert.equal(persisted.autopilot_controller_runtime_bridge.readiness_ready, true);
      assert.equal(persisted.pipeline_stage_index, 2);
      assert.deepEqual(
        persisted.autopilot_controller_decisions.map((entry: { action: string }) => entry.action),
        ['plan', 'execute', 'verify', 'finish'],
      );
      assert.match(
        persisted.autopilot_controller_decisions[2].reason,
        /verification/i,
      );
      assert.equal(persisted.pipeline_stage_results['ralph-verify'].status, 'completed');
    });
  });
});
