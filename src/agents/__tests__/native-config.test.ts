import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type { AgentDefinition } from '../definitions.js';
import { generateAgentToml, installNativeAgentConfigs } from '../native-config.js';

async function readSourceManifestRaw(): Promise<string> {
  return readFile(join(process.cwd(), 'src', 'catalog', 'manifest.json'), 'utf8');
}

describe('agents/native-config', () => {
  it('generates TOML with stripped frontmatter and escaped triple quotes', () => {
    const agent: AgentDefinition = {
      name: 'executor',
      description: 'Code implementation',
      reasoningEffort: 'medium',
      posture: 'deep-worker',
      modelClass: 'standard',
      routingRole: 'executor',
      tools: 'execution',
      category: 'build',
    };

    const prompt = `---\ntitle: demo\n---\n\nInstruction line\n"""danger"""`;
    const toml = generateAgentToml(agent, prompt);

    assert.match(toml, /# oh-my-codex agent: executor/);
    assert.match(toml, /model_reasoning_effort = "medium"/);
    assert.ok(!toml.includes('title: demo'));
    assert.ok(toml.includes('Instruction line'));
    assert.ok(toml.includes('You are operating in the deep-worker posture.'));
    assert.ok(toml.includes('- posture: deep-worker'));

    const tripleQuoteBlocks = toml.match(/"""/g) || [];
    assert.equal(tripleQuoteBlocks.length, 2, 'only TOML delimiters should remain as raw triple quotes');
  });

  it('installs only agents with prompt files and skips existing files without force', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-native-config-'));
    const promptsDir = join(root, 'prompts');
    const outDir = join(root, 'agents-out');

    try {
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, 'executor.md'), 'executor prompt');
      await writeFile(join(promptsDir, 'planner.md'), 'planner prompt');

      const created = await installNativeAgentConfigs(root, { agentsDir: outDir });
      assert.equal(created, 2);
      assert.equal(existsSync(join(outDir, 'executor.toml')), true);
      assert.equal(existsSync(join(outDir, 'planner.toml')), true);

      const executorToml = await readFile(join(outDir, 'executor.toml'), 'utf8');
      assert.match(executorToml, /model_reasoning_effort = "medium"/);

      const skipped = await installNativeAgentConfigs(root, { agentsDir: outDir });
      assert.equal(skipped, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('filters native agent configs to installable manifest agents when manifest is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-native-config-manifest-'));
    const promptsDir = join(root, 'prompts');
    const templatesDir = join(root, 'templates');
    const outDir = join(root, 'agents-out');

    try {
      await mkdir(promptsDir, { recursive: true });
      await mkdir(templatesDir, { recursive: true });
      await writeFile(join(templatesDir, 'catalog-manifest.json'), await readSourceManifestRaw());

      await writeFile(join(promptsDir, 'executor.md'), 'executor prompt');
      await writeFile(join(promptsDir, 'style-reviewer.md'), 'style reviewer prompt');
      await writeFile(join(promptsDir, 'code-simplifier.md'), 'code simplifier prompt');

      const created = await installNativeAgentConfigs(root, { agentsDir: outDir });
      assert.equal(created, 2);
      assert.equal(existsSync(join(outDir, 'executor.toml')), true);
      assert.equal(existsSync(join(outDir, 'code-simplifier.toml')), true);
      assert.equal(existsSync(join(outDir, 'style-reviewer.toml')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to current agent definitions when no manifest is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-native-config-fallback-'));
    const promptsDir = join(root, 'prompts');
    const outDir = join(root, 'agents-out');

    try {
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, 'executor.md'), 'executor prompt');
      await writeFile(join(promptsDir, 'style-reviewer.md'), 'style reviewer prompt');

      const created = await installNativeAgentConfigs(root, { agentsDir: outDir });
      assert.equal(created, 2);
      assert.equal(existsSync(join(outDir, 'executor.toml')), true);
      assert.equal(existsSync(join(outDir, 'style-reviewer.toml')), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
