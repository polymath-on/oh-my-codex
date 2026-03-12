import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type PackageJson = {
  bin?: string | Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
};

type NpmPackDryRunFile = {
	path: string;
	mode?: number;
};

type NpmPackDryRunResult = {
	files?: NpmPackDryRunFile[];
};

describe('package bin contract', () => {
  it('declares omx with an explicit relative bin path and avoids packaging platform-specific native binaries', () => {
    const packageJsonPath = join(process.cwd(), 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as PackageJson;

    assert.deepEqual(pkg.bin, { omx: 'bin/omx' });
    assert.equal(pkg.scripts?.['build:explore'], 'cargo build -p omx-explore-harness');
    assert.equal(pkg.scripts?.['build:explore:release'], 'node scripts/build-explore-harness.js');
    assert.equal(pkg.scripts?.['clean:native-package-assets'], 'node scripts/cleanup-explore-harness.js');
    assert.equal(pkg.scripts?.prepack, 'npm run build && npm run clean:native-package-assets');
    assert.equal(pkg.scripts?.postpack, 'npm run clean:native-package-assets');
    assert.equal(pkg.scripts?.['build:sparkshell'], 'node scripts/build-sparkshell.mjs');
    assert.equal(pkg.scripts?.['test:sparkshell'], 'node scripts/test-sparkshell.mjs');
    assert.equal(pkg.files?.includes('scripts/build-sparkshell.mjs'), true);
    assert.equal(pkg.files?.includes('scripts/test-sparkshell.mjs'), true);
    assert.equal(pkg.files?.includes('bin/native/'), false);

    const binPath = join(process.cwd(), 'bin', 'omx');
    assert.equal(existsSync(binPath), true, 'expected bin/omx to exist');

    const binSource = readFileSync(binPath, 'utf-8');
    assert.match(binSource, /^#!\/bin\/sh/);

    const stat = statSync(binPath);
    assert.notEqual(stat.mode & 0o111, 0, 'expected bin/omx to be executable');

    const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    assert.equal(packed.status, 0, packed.stderr || packed.stdout);

    const jsonStart = packed.stdout.indexOf('[');
    assert.notEqual(jsonStart, -1, `expected npm pack --json output in stdout\n${packed.stdout}`);
    const results = JSON.parse(packed.stdout.slice(jsonStart)) as NpmPackDryRunResult[];
    assert.equal(Array.isArray(results), true, 'expected npm pack --json array output');

    const binEntry = results[0]?.files?.find((file) => file.path === 'bin/omx');
    assert.ok(binEntry, 'expected npm pack output to include bin/omx');
    assert.notEqual((binEntry.mode ?? 0) & 0o111, 0, 'expected packed bin/omx to keep execute bits');

    const packagedHarnessPath = process.platform === 'win32' ? 'bin/omx-explore-harness.exe' : 'bin/omx-explore-harness';
    const packagedHarnessEntry = results[0]?.files?.find((file) => file.path === packagedHarnessPath);
    const packagedHarnessMetaEntry = results[0]?.files?.find((file) => file.path === 'bin/omx-explore-harness.meta.json');
    const sparkshellEntry = results[0]?.files?.find((file) => file.path.includes('bin/native/'));

    assert.equal(packagedHarnessEntry, undefined, `did not expect ${packagedHarnessPath} in npm pack output`);
    assert.equal(packagedHarnessMetaEntry, undefined, 'did not expect packaged explore harness metadata in npm pack output');
    assert.equal(sparkshellEntry, undefined, 'did not expect staged sparkshell binaries in npm pack output');
  });
});
