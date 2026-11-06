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
if (!manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'")) {
  throw new Error('Packaged noise reduction requires WASM permission.');
}
for (const variant of ['rnnoise', 'rnnoise_simd']) {
  if (!WebAssembly.validate(await readFile(`extension/vendor/rnnoise/${variant}.wasm`))) {
    throw new Error(`Invalid noise reduction binary: ${variant}`);
  }
}
console.log('Extension JavaScript, manifest, and packaged WASM checks passed.');
