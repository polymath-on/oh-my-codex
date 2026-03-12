import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { withPackagedExploreHarnessLock } from './packaged-explore-harness-lock.js';

type PackageJson = {
  bin?: string | Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
};

type NpmPackDryRunFile = {
  path: string;
};

type NpmPackDryRunResult = {
  files?: NpmPackDryRunFile[];
};

describe('sparkshell packaging scaffold', () => {
  it('registers native helper scripts but keeps staged native artifacts out of npm releases', async () => {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;
    const binaryName = platform() === 'win32' ? 'omx-sparkshell.exe' : 'omx-sparkshell';
    const packagedBinaryRelativePath = join('bin', 'native', `${platform()}-${arch()}`, binaryName);
    const packagedBinaryPath = join(process.cwd(), packagedBinaryRelativePath);

    assert.deepEqual(pkg.bin, { omx: 'bin/omx' });
    assert.equal(pkg.scripts?.['build:sparkshell'], 'node scripts/build-sparkshell.mjs');
    assert.equal(pkg.scripts?.['test:sparkshell'], 'node scripts/test-sparkshell.mjs');
    assert.equal(pkg.files?.includes('bin/native/'), false, 'did not expect package files to include bin/native/');
    assert.equal(pkg.files?.includes('scripts/build-sparkshell.mjs'), true);
    assert.equal(pkg.files?.includes('scripts/test-sparkshell.mjs'), true);

    const buildScriptPath = join(process.cwd(), 'scripts', 'build-sparkshell.mjs');
    const testScriptPath = join(process.cwd(), 'scripts', 'test-sparkshell.mjs');
    assert.equal(existsSync(buildScriptPath), true, 'expected build sparkshell helper script to exist');
    assert.equal(existsSync(testScriptPath), true, 'expected test sparkshell helper script to exist');

    await withPackagedExploreHarnessLock(async () => {
      try {
        rmSync(packagedBinaryPath, { force: true });
        const buildResult = spawnSync(process.execPath, [buildScriptPath], {
          cwd: process.cwd(),
          encoding: 'utf-8',
          env: {
            ...process.env,
            OMX_SPARKSHELL_MANIFEST: join(process.cwd(), 'native', 'omx-sparkshell', 'Cargo.toml'),
          },
        });
        assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);
        assert.equal(existsSync(packagedBinaryPath), true, `expected staged binary at ${packagedBinaryRelativePath}`);

        const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
          cwd: process.cwd(),
          encoding: 'utf-8',
        });
        assert.equal(packed.status, 0, packed.stderr || packed.stdout);

        const results = JSON.parse(packed.stdout) as NpmPackDryRunResult[];
        const packedFiles = new Set((results[0]?.files ?? []).map((file) => file.path));

        assert.equal(packedFiles.has('scripts/build-sparkshell.mjs'), true);
        assert.equal(packedFiles.has('scripts/test-sparkshell.mjs'), true);
        assert.equal(packedFiles.has(packagedBinaryRelativePath.replaceAll('\\', '/')), false);
      } finally {
        rmSync(packagedBinaryPath, { force: true });
      }
    });
  });
});
