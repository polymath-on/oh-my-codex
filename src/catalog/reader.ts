import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { AGENT_DEFINITIONS, type AgentDefinition } from '../agents/definitions.js';
import { getPackageRoot } from '../utils/package.js';
import { type CatalogManifest, summarizeCatalogCounts, type CatalogCounts, validateCatalogManifest } from './schema.js';

const MANIFEST_CANDIDATE_PATHS = [
  ['templates', 'catalog-manifest.json'],
  ['src', 'catalog', 'manifest.json'],
  ['dist', 'catalog', 'manifest.json'],
] as const;

const INSTALLABLE_AGENT_STATUSES = new Set<CatalogManifest['agents'][number]['status']>(['active', 'internal']);

let cachedManifest: CatalogManifest | null = null;
let cachedPath: string | null = null;

type AgentPolicySource = CatalogManifest | string;

function resolveManifestPath(packageRoot: string): string | null {
  for (const segments of MANIFEST_CANDIDATE_PATHS) {
    const fullPath = join(packageRoot, ...segments);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

function uniqueNames(names: Iterable<string>): string[] {
  return [...new Set(names)];
}

function resolveManifest(source: AgentPolicySource = getPackageRoot()): CatalogManifest | null {
  if (typeof source === 'string') {
    return tryReadCatalogManifest(source);
  }
  return source;
}

export function readCatalogManifest(packageRoot: string = getPackageRoot()): CatalogManifest {
  const path = resolveManifestPath(packageRoot);
  if (!path) {
    throw new Error('catalog_manifest_missing');
  }

  if (cachedManifest && cachedPath === path) return cachedManifest;

  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const manifest = validateCatalogManifest(raw);
  cachedManifest = manifest;
  cachedPath = path;
  return manifest;
}

export function tryReadCatalogManifest(packageRoot: string = getPackageRoot()): CatalogManifest | null {
  try {
    return readCatalogManifest(packageRoot);
  } catch {
    return null;
  }
}

export function getCatalogCounts(packageRoot: string = getPackageRoot()): CatalogCounts {
  const manifest = readCatalogManifest(packageRoot);
  return summarizeCatalogCounts(manifest);
}

export function getInstallableCatalogAgentNames(manifest: CatalogManifest): string[] {
  return manifest.agents
    .filter((agent) => INSTALLABLE_AGENT_STATUSES.has(agent.status))
    .map((agent) => agent.name);
}

export function getInstallableAgentNames(source: AgentPolicySource = getPackageRoot()): string[] {
  const manifest = resolveManifest(source);
  if (!manifest) {
    return Object.keys(AGENT_DEFINITIONS);
  }

  const installableNames = new Set(getInstallableCatalogAgentNames(manifest));
  return Object.keys(AGENT_DEFINITIONS).filter((name) => installableNames.has(name));
}

export function getInstallableAgentDefinitions(
  source: AgentPolicySource = getPackageRoot(),
): Array<[string, AgentDefinition]> {
  const installableNames = new Set(getInstallableAgentNames(source));
  return Object.entries(AGENT_DEFINITIONS).filter(([name]) => installableNames.has(name));
}

export function getManagedAgentNames(source: AgentPolicySource = getPackageRoot()): string[] {
  const manifest = resolveManifest(source);
  return uniqueNames([
    ...Object.keys(AGENT_DEFINITIONS),
    ...(manifest?.agents.map((agent) => agent.name) ?? []),
  ]);
}

export interface PublicCatalogContract {
  generatedAt: string;
  version: string;
  counts: CatalogCounts;
  coreSkills: string[];
  skills: CatalogManifest['skills'];
  agents: CatalogManifest['agents'];
  aliases: Array<{ name: string; canonical: string }>;
  internalHidden: string[];
}

export function toPublicCatalogContract(manifest: CatalogManifest): PublicCatalogContract {
  const aliases = manifest.skills
    .filter((s) => (s.status === 'alias' || s.status === 'merged') && typeof s.canonical === 'string')
    .map((s) => ({ name: s.name, canonical: s.canonical! }));
  const internalHidden = manifest.skills
    .filter((s) => s.status === 'internal')
    .map((s) => s.name);

  return {
    generatedAt: new Date().toISOString(),
    version: manifest.catalogVersion,
    counts: summarizeCatalogCounts(manifest),
    coreSkills: manifest.skills.filter((s) => s.core).map((s) => s.name),
    skills: manifest.skills,
    agents: manifest.agents,
    aliases,
    internalHidden,
  };
}
