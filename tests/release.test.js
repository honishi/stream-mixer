import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/package-release.mjs');

test('release archives contain runtime assets, stamped versions, and valid checksums', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'stream-mixer-package-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const original = await readFile(join(root, 'extension/manifest.json'), 'utf8');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'extension/'], {
    cwd: root, encoding: 'utf8',
  }).split('\0').filter(Boolean).map((path) => path.slice('extension/'.length)).sort();

  for (const [tag, version, versionName] of [
    ['v1.2.3', '1.2.3', '1.2.3'],
    ['1.2.3', '1.2.3', '1.2.3'],
    ['v1.2.3-rc.1', '1.2.3', '1.2.3-rc.1'],
    ['1.2.3-rc.1', '1.2.3', '1.2.3-rc.1'],
    ['0.0.1', '0.0.1', '0.0.1'],
  ]) {
    const stepOutput = join(output, `${tag}.outputs`);
    execFileSync(process.execPath, [script, tag, output], {
      env: { ...process.env, GITHUB_OUTPUT: stepOutput },
    });
    const filename = `stream-mixer-${versionName}-${commit.slice(0, 7)}.zip`;
    const archive = join(output, filename);
    assert.equal(await readFile(stepOutput, 'utf8'), `archive=${archive}\nchecksum=${archive}.sha256\n`);
    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(entries.sort(), tracked);
    const extract = (file) => execFileSync('unzip', ['-p', archive, file]);
    const manifest = JSON.parse(extract('manifest.json'));
    assert.equal(manifest.version, version);
    assert.equal(manifest.version_name, versionName);
    for (const file of tracked.filter((file) => file !== 'manifest.json')) {
      assert.deepEqual(extract(file), await readFile(join(root, 'extension', file)), file);
    }
    const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
    assert.equal(await readFile(`${archive}.sha256`, 'utf8'), `${hash}  ${filename}\n`);
  }
  assert.equal(await readFile(join(root, 'extension/manifest.json'), 'utf8'), original);
});

test('invalid or Chrome-incompatible release tags do not produce archives', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'stream-mixer-invalid-tag-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const invalidVersions = ['', '1.2', '01.2.3', '0.0.0', '65536.0.0',
    '1.2.3-rc.01', '1.2.3-', '1.2.3+build.1', '1.2.3/../../file'];
  const invalidTags = invalidVersions.flatMap((version) => [version, `v${version}`]);
  for (const tag of [...invalidTags, 'vv1.2.3']) {
    const result = spawnSync(process.execPath, [script, tag, output], { encoding: 'utf8' });
    assert.equal(result.status, 1, tag);
    assert.match(result.stderr, /Use a version tag|Chrome version components/);
  }
  assert.deepEqual(await readdir(output), []);
});
