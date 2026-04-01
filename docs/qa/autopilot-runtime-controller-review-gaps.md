# Autopilot runtime-controller review gaps

This note captures the concrete brownfield review gaps that still need line-level follow-through once the runtime-controller implementation slice lands.

## Exact file/line follow-up map

### 1. Replace linear pipeline ownership with controller ownership
- `src/pipeline/orchestrator.ts:22-179`
  - Current state: `MODE_NAME = 'autopilot'` and `runPipeline(...)` own autopilot progress directly through `current_phase = stage:*` and `pipeline_stage_results`.
  - Required follow-up: make this file a compatibility wrapper around the new controller entrypoint instead of the primary owner of autopilot state.
  - Review check: controller state must become canonical; `pipeline_stage_results` must stay derived/read-only compatibility data.

### 2. Preserve autopilot mode exclusivity during verification handoff
- `src/modes/base.ts:47-99`
  - Current state: `autopilot` and `ralph` are both exclusive modes.
  - Required follow-up: controller-driven Ralph verification must finish or explicitly suspend autopilot before Ralph starts.
  - Review check: no path should leave both modes active at once.

### 3. Keep team execution as an adapter, not a second controller
- `src/pipeline/stages/team-exec.ts:44-119`
  - Current state: team execution produces a descriptor/instruction from planning artifacts and follow-up staffing.
  - Required follow-up: controller should call this adapter (or its extracted successor) as an action, not duplicate team launch/staffing logic elsewhere.
  - Review check: launch instructions remain bounded to autopilot scope and continue reusing `buildFollowupStaffingPlan(...)`.

### 4. Keep Ralph verification as an explicit adapter path
- `src/pipeline/stages/ralph-verify.ts:38-105`
  - Current state: verification creates a Ralph descriptor/instruction from prior execution artifacts.
  - Required follow-up: controller should trigger this only from an explicit verify/handoff decision with evidence context attached.
  - Review check: no implicit always-on Ralph overlap; verification reasons/evidence should be persisted before handoff.

### 5. Reuse existing staffing and verification-lane planning
- `src/team/followup-planner.ts:156-200`
  - Current state: launch hints and verification plans already encode the bootstrap `omx team` / `omx ralph` surfaces.
  - Required follow-up: controller implementation should continue using these helpers for team-ready handoff artifacts instead of inventing a parallel staffing schema.
  - Review check: bootstrap launch command and post-launch lane allocation guidance stay consistent.

### 6. Keep autopilot-facing guidance aligned with the shipped controller semantics
- `skills/autopilot/SKILL.md:224-234`
  - Current state: skill docs now mention the runtime-controller milestone but still sit below the legacy pipeline section.
  - Required follow-up: once the controller entrypoint is real, update the surrounding skill guidance so the compatibility/pipeline wording does not imply the pipeline still owns the runtime.
  - Review check: visible `$autopilot` UX stays stable while the docs clearly describe controller-first internals.

## Integration sign-off prompts
- Confirm the implementation introduces exactly one authoritative autopilot controller entrypoint.
- Confirm HUD/mode-state readers still see coherent autopilot progress after stage ownership moves behind the controller.
- Confirm team handoff artifacts still point at the current `omx team N:role ...` bootstrap surface.
- Confirm Ralph handoff tests prove exclusive-mode safety instead of assuming it.
