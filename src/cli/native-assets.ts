import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawnPlatformCommandSync } from '../utils/platform-command.js';
import { getPackageRoot } from '../utils/package.js';

export type NativeProduct = 'omx-explore-harness' | 'omx-runtime' | 'omx-sparkshell';

export interface NativeReleaseAsset {
  product: NativeProduct;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  archive: string;
  binary: string;
  binary_path: string;
  sha256: string;
  size?: number;
  download_url: string;
}

export interface NativeReleaseManifest {
  manifest_version?: number;
  version: string;
  tag?: string;
  generated_at?: string;
  assets: NativeReleaseAsset[];
}

export interface HydrateNativeBinaryOptions {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}

const NATIVE_AUTO_FETCH_ENV = 'OMX_NATIVE_AUTO_FETCH';
const NATIVE_MANIFEST_URL_ENV = 'OMX_NATIVE_MANIFEST_URL';
const NATIVE_RELEASE_BASE_URL_ENV = 'OMX_NATIVE_RELEASE_BASE_URL';
const NATIVE_CACHE_DIR_ENV = 'OMX_NATIVE_CACHE_DIR';
export const EXPLORE_BIN_ENV = 'OMX_EXPLORE_BIN';
export const RUNTIME_BIN_ENV = 'OMX_RUNTIME_BIN';
export const SPARKSHELL_BIN_ENV = 'OMX_SPARKSHELL_BIN';

function packageJsonPath(packageRoot = getPackageRoot()): string {
  return join(packageRoot, 'package.json');
}

async function readPackageJson(packageRoot = getPackageRoot()): Promise<{ version?: string; repository?: { url?: string } | string }> {
  const raw = await readFile(packageJsonPath(packageRoot), 'utf-8');
  return JSON.parse(raw) as { version?: string; repository?: { url?: string } | string };
}

export async function getPackageVersion(packageRoot = getPackageRoot()): Promise<string> {
  const pkg = await readPackageJson(packageRoot);
  if (!pkg.version?.trim()) throw new Error('[native-assets] package.json is missing version');
  return pkg.version.trim();
}

function repositoryHttpBase(repository: { url?: string } | string | undefined): string | undefined {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim().replace(/^git\+/, '').replace(/\.git$/, '');
  if (trimmed.startsWith('https://github.com/')) return trimmed;
  if (trimmed.startsWith('http://github.com/')) return trimmed.replace(/^http:/, 'https:');
  return undefined;
}

export async function resolveNativeReleaseBaseUrl(
  packageRoot = getPackageRoot(),
  version?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const override = env[NATIVE_RELEASE_BASE_URL_ENV]?.trim();
  if (override) return override.replace(/\/$/, '');
  const pkg = await readPackageJson(packageRoot);
  const repo = repositoryHttpBase(pkg.repository);
  if (!repo) throw new Error('[native-assets] unable to resolve GitHub repository URL for native release downloads');
  const resolvedVersion = version ?? await getPackageVersion(packageRoot);
  return `${repo}/releases/download/v${resolvedVersion}`;
}

export async function resolveNativeManifestUrl(
  packageRoot = getPackageRoot(),
  version?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const override = env[NATIVE_MANIFEST_URL_ENV]?.trim();
  if (override) return override;
  const baseUrl = await resolveNativeReleaseBaseUrl(packageRoot, version, env);
  return `${baseUrl}/native-release-manifest.json`;
}

export function resolveNativeCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[NATIVE_CACHE_DIR_ENV]?.trim();
  if (override) return resolve(override);
  if (process.platform === 'win32') {
    return resolve(env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local'), 'oh-my-codex', 'rust');
  }
  return resolve(env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'oh-my-codex', 'rust');
}

export function resolveCachedNativeBinaryPath(
  product: NativeProduct,
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const binary = platform === 'win32' ? `${product}.exe` : product;
  return join(resolveNativeCacheRoot(env), version, `${platform}-${arch}`, product, binary);
}

export function isRepositoryCheckout(packageRoot = getPackageRoot()): boolean {
  return existsSync(join(packageRoot, '.git')) || existsSync(join(packageRoot, 'src'));
}

export async function loadNativeReleaseManifest(
  packageRoot = getPackageRoot(),
  version?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeReleaseManifest> {
  const url = await resolveNativeManifestUrl(packageRoot, version, env);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`[native-assets] failed to fetch native release manifest (${response.status} ${response.statusText}) from ${url}`);
  }
  return await response.json() as NativeReleaseManifest;
}

function isUnavailableManifestError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\[native-assets\] failed to fetch native release manifest/i.test(error.message)
    || /fetch failed/i.test(error.message);
}

function findManifestAsset(
  manifest: NativeReleaseManifest,
  product: NativeProduct,
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): NativeReleaseAsset | undefined {
  return manifest.assets.find((asset) => asset.product === product
    && asset.version === version
    && asset.platform === platform
    && asset.arch === arch);
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`[native-assets] failed to download ${url} (${response.status} ${response.statusText})`);
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
}

async function sha256ForFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function extractArchive(archivePath: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const ext = extname(archivePath).toLowerCase();
  if (ext === '.zip') {
    const { result } = spawnPlatformCommandSync(
      process.platform === 'win32' ? 'powershell' : 'unzip',
      process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}' -Force`]
        : ['-oq', archivePath, '-d', destinationDir],
      { encoding: 'utf-8' },
    );
    if (result.status !== 0 || result.error) {
      throw new Error(`[native-assets] failed to extract zip archive ${archivePath}: ${(result.stderr || result.error?.message || '').trim()}`);
    }
    return;
  }

  const { result } = spawnPlatformCommandSync('tar', ['-xf', archivePath, '-C', destinationDir], { encoding: 'utf-8' });
  if (result.status !== 0 || result.error) {
    throw new Error(`[native-assets] failed to extract archive ${archivePath}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
}

async function findExtractedBinaryPath(rootDir: string, binaryPath: string): Promise<string | undefined> {
  const normalizedNeedle = binaryPath.replaceAll('\\', '/');
  const exactCandidate = join(rootDir, binaryPath);
  if (existsSync(exactCandidate)) return exactCandidate;

  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      const relative = fullPath.slice(rootDir.length + 1).replaceAll('\\', '/');
      if (relative === normalizedNeedle || relative.endsWith(`/${normalizedNeedle}`)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

export async function hydrateNativeBinary(
  product: NativeProduct,
  options: HydrateNativeBinaryOptions = {},
): Promise<string | undefined> {
  const {
    packageRoot = getPackageRoot(),
    env = process.env,
    platform = process.platform,
    arch = process.arch,
  } = options;

  if (env[NATIVE_AUTO_FETCH_ENV]?.trim() === '0') return undefined;
  if (!['linux', 'darwin', 'win32'].includes(platform)) return undefined;
  if (!['x64', 'arm64'].includes(arch)) return undefined;

  const version = await getPackageVersion(packageRoot);
  const cachedBinaryPath = resolveCachedNativeBinaryPath(product, version, platform, arch, env);
  if (existsSync(cachedBinaryPath)) return cachedBinaryPath;

  let manifest: NativeReleaseManifest;
  try {
    manifest = await loadNativeReleaseManifest(packageRoot, version, env);
  } catch (error) {
    if (isUnavailableManifestError(error)) return undefined;
    throw error;
  }
  const asset = findManifestAsset(manifest, product, version, platform, arch);
  if (!asset) return undefined;

  const tempRoot = await mkdtemp(join(tmpdir(), `${product}-${platform}-${arch}-`));
  const archivePath = join(tempRoot, asset.archive);
  const extractDir = join(tempRoot, 'extract');

  try {
    await downloadFile(asset.download_url, archivePath);
    const archiveStat = await stat(archivePath);
    if (typeof asset.size === 'number' && asset.size > 0 && archiveStat.size !== asset.size) {
      throw new Error(`[native-assets] downloaded archive size mismatch for ${asset.archive}`);
    }
    const digest = await sha256ForFile(archivePath);
    if (digest !== asset.sha256) {
      throw new Error(`[native-assets] checksum mismatch for ${asset.archive}`);
    }

    await extractArchive(archivePath, extractDir);
    const extractedBinaryPath = await findExtractedBinaryPath(extractDir, asset.binary_path);
    if (!extractedBinaryPath) {
      throw new Error(`[native-assets] extracted archive missing expected binary ${asset.binary_path}`);
    }

    await mkdir(dirname(cachedBinaryPath), { recursive: true });
    await copyFile(extractedBinaryPath, cachedBinaryPath);
    if (platform !== 'win32') chmodSync(cachedBinaryPath, 0o755);
    return cachedBinaryPath;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
