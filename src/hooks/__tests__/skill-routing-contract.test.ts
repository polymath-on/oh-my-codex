import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readSkill(relativePath: string): Promise<string> {
  return readFile(join(process.cwd(), relativePath), 'utf8');
}

describe('skill routing contracts', () => {
  it('documents analyze as a router with debugger default and architect handoff', async () => {
    const skill = await readSkill('skills/analyze/SKILL.md');

    assert.match(skill, /default owner:\s*`debugger`/i);
    assert.match(skill, /route to `architect`/i);
    assert.match(skill, /tie-breaker:.*`debugger`/i);
    assert.match(skill, /regression, broken, failing, stack trace, crash, flaky, root cause/i);
    assert.match(skill, /boundaries, interface, dependency impact, architecture, module interaction, tradeoff/i);
    assert.match(skill, /router/i);
  });

  it('keeps code-review separate from dedicated security review', async () => {
    const skill = await readSkill('skills/code-review/SKILL.md');

    assert.match(skill, /dedicated security audit/i);
    assert.match(skill, /use `security-review`/i);
  });

  it('keeps review skill scoped to deprecated plan review only', async () => {
    const skill = await readSkill('skills/review/SKILL.md');

    assert.match(skill, /deprecated compatibility alias/i);
    assert.match(skill, /plan review only/i);
    assert.match(skill, /not a primary public review surface/i);
    assert.match(skill, /\*\*not\*\*\s+a general code review alias/i);
    assert.match(skill, /\/plan --review/i);
  });

  it('keeps security-review focused on trust boundaries as a specialist compatibility lane', async () => {
    const skill = await readSkill('skills/security-review/SKILL.md');

    assert.match(skill, /specialist compatibility/i);
    assert.match(skill, /not.*primary public review entry/i);
    assert.match(skill, /stays distinct from `code-review`/i);
    assert.match(skill, /Do \*\*not\*\* use it for generic maintainability, style, or API ergonomics feedback/i);
  });
});
