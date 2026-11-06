import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(path);
    else if (/\.(?:js|mjs)$/.test(path)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
  }
}
await checkDirectory('extension');
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Expected Manifest V3');
for (const path of [manifest.background.service_worker, manifest.action.default_popup, 'offscreen.html']) {
  await access(join('extension', path));
}
if (manifest.host_permissions || manifest.content_scripts) throw new Error('Unexpected site access');
console.log('Extension JavaScript and manifest checks passed.');
