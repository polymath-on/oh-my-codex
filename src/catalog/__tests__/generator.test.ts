import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getInstallableCatalogAgentNames, getManagedAgentNames, readCatalogManifest, toPublicCatalogContract } from '../reader.js';

async function readSourceManifestRaw(): Promise<string> {
  return readFile(join(process.cwd(), 'src', 'catalog', 'manifest.json'), 'utf8');
}

async function readSourceManifestCounts(): Promise<{ skills: number; agents: number }> {
  const raw = await readSourceManifestRaw();
  const parsed = JSON.parse(raw) as { skills: unknown[]; agents: unknown[] };
  return {
    skills: parsed.skills.length,
    agents: parsed.agents.length,
  };
}

describe('catalog reader/contract', () => {
  it('prefers template manifest path when present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-catalog-'));
    await mkdir(join(root, 'templates'), { recursive: true });
    await writeFile(
      join(root, 'templates', 'catalog-manifest.json'),
      await readSourceManifestRaw(),
    );

    const parsed = readCatalogManifest(root);
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(parsed.skills.length > 0);
  });

  it('derives installable vs managed agent names from manifest lifecycle state', () => {
    const manifest = readCatalogManifest();
    const installable = new Set(getInstallableCatalogAgentNames(manifest));
    const managed = new Set(getManagedAgentNames(manifest));

    assert.ok(installable.has('executor'));
    assert.ok(installable.has('code-simplifier'));
    assert.ok(!installable.has('style-reviewer'));
    assert.ok(!installable.has('product-manager'));
    assert.ok(managed.has('style-reviewer'));
  });

  it('builds public contract with aliases and internalHidden', async () => {
    const contract = toPublicCatalogContract(readCatalogManifest());
    const expected = await readSourceManifestCounts();
    assert.equal(contract.counts.skillCount, expected.skills);
    assert.equal(contract.counts.promptCount, expected.agents);
    assert.ok(contract.aliases.some((a) => a.name === 'swarm' && a.canonical === 'team'));
    assert.ok(contract.internalHidden.includes('worker'));
    assert.ok(contract.coreSkills.includes('autopilot'));
    assert.ok(contract.skills.some((s) => s.name === 'ask-claude' && s.status === 'active'));
    assert.ok(contract.skills.some((s) => s.name === 'ask-gemini' && s.status === 'active'));
    assert.ok(contract.skills.some((s) => s.name === 'ai-slop-cleaner' && s.status === 'active'));
  });

  it('template manifest can be synced from source manifest', async () => {
    const sourceRaw = await readFile(join(process.cwd(), 'src', 'catalog', 'manifest.json'), 'utf8');
    const targetRaw = await readFile(join(process.cwd(), 'templates', 'catalog-manifest.json'), 'utf8');
    assert.equal(JSON.parse(targetRaw).catalogVersion, JSON.parse(sourceRaw).catalogVersion);
  });
});
