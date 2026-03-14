/**
 * RALPLAN stage adapter for pipeline orchestrator.
 *
 * Wraps the consensus planning workflow (planner + architect + critic)
 * into a PipelineStage. Produces a plan artifact at `.omx/plans/`.
 */

import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { isPlanningComplete, readPlanningArtifacts } from '../../planning/artifacts.js';

/**
 * Create a RALPLAN pipeline stage.
 *
 * The RALPLAN stage performs consensus planning by coordinating planner,
 * architect, and critic agents. It outputs a plan file that downstream
 * stages (team-exec) consume.
 *
 * This is a structural adapter — actual agent orchestration happens at
 * the skill layer. The stage manages lifecycle, artifact discovery, and
 * skip detection.
 */
export function createRalplanStage(): PipelineStage {
  return {
    name: 'ralplan',

    canSkip(ctx: StageContext): boolean {
      return isPlanningComplete(readPlanningArtifacts(ctx.cwd));
    },

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();
      try {
        const planningArtifacts = readPlanningArtifacts(ctx.cwd);

        return {
          status: 'completed',
          artifacts: {
            plansDir: planningArtifacts.plansDir,
            specsDir: planningArtifacts.specsDir,
            task: ctx.task,
            prdPaths: planningArtifacts.prdPaths,
            testSpecPaths: planningArtifacts.testSpecPaths,
            deepInterviewSpecPaths: planningArtifacts.deepInterviewSpecPaths,
            planningComplete: isPlanningComplete(planningArtifacts),
            stage: 'ralplan',
            instruction: `Run RALPLAN consensus planning for: ${ctx.task}`,
          },
          duration_ms: Date.now() - startTime,
        };
      } catch (err) {
        return {
          status: 'failed',
          artifacts: {},
          duration_ms: Date.now() - startTime,
          error: `RALPLAN stage failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
