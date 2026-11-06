import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [tag, outputDirectory = join(root, 'dist')] = process.argv.slice(2);
const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag ?? '');
if (!match || match[2]?.split('.').some((part) => /^0\d+$/.test(part))) {
  throw new Error('Use a version tag such as v1.2.3 or v1.2.3-rc.1.');
}
const version = match[1];
const components = version.split('.').map(Number);
if (components.some((part) => part > 65535) || components.every((part) => part === 0)) {
  throw new Error('Chrome version components must be 0–65535 and cannot all be zero.');
}

// Include tracked runtime assets and licenses, without local or development files.
const files = execFileSync('git', ['ls-files', '-z', '--', 'extension/'], {
  cwd: root, encoding: 'utf8',
}).split('\0').filter(Boolean).map((path) => path.slice('extension/'.length)).sort();
if (!files.includes('manifest.json')) throw new Error('No tracked extension manifest found.');

const staging = await mkdtemp(join(tmpdir(), 'stream-mixer-release-'));
try {
  for (const file of files) {
    const source = join(root, 'extension', file);
    if (!(await lstat(source)).isFile()) throw new Error(`Expected a regular file: ${file}`);
    const destination = join(staging, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  const manifestPath = join(staging, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = version;
  manifest.version_name = tag.slice(1);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const filename = `stream-mixer-${tag}.zip`;
  const archive = join(output, filename);
  // zip updates existing archives, so remove any previous package first.
  await rm(archive, { force: true });
  execFileSync('zip', ['-X', '-q', archive, ...files], { cwd: staging });
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${filename}\n`);
  console.log(`Packaged ${archive}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
