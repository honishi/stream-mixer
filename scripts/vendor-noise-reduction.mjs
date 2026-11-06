import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = 'node_modules/@sapphi-red/web-noise-suppressor';
const target = 'extension/vendor/rnnoise';
const metadata = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
if (metadata.version !== '0.4.1') throw new Error('Review the new dependency before updating the vendored assets.');
const worklet = await readFile(`${root}/dist/rnnoise/workletProcessor.js`);
if (createHash('sha256').update(worklet).digest('hex') !== '1e06facbb3d7459b89769aa4247cd4b71263e6662e4da0c54763f3bf06f5893b') {
  throw new Error('Unexpected RNNoise bundle.');
}
// The shipped source map contains the self-contained, AudioWorklet-compatible
// RNNoise runtime. Keep it readable and use our own lifecycle/frame adapter.
const map = JSON.parse(await readFile(`${root}/dist/rnnoise/workletProcessor.js.map`, 'utf8'));
const index = map.sources.findIndex((path) => path.endsWith('/rnnoise-wasm/dist/rnnoise.mjs'));
if (index < 0 || !map.sourcesContent[index].includes('export { DenoiseState, Model, Rnnoise };')) {
  throw new Error('RNNoise runtime source is missing.');
}
await mkdir(target, { recursive: true });
const source = map.sourcesContent[index].replace(/[\t ]+$/gm, '');
await writeFile(`${target}/runtime.js`, `// Vendored from @sapphi-red/web-noise-suppressor 0.4.1 source map.\n// Modified: module-local window shim, equivalent to upstream's worklet build define.\n// Trailing whitespace removed. See THIRD_PARTY_NOTICES.md for sources and licenses.\nconst window = {};\n${source}`);
// Keep the upstream API documentation in English when regenerating the runtime.
execFileSync('git', ['apply', 'scripts/rnnoise-comments.patch']);
for (const file of ['rnnoise.wasm', 'rnnoise_simd.wasm']) await copyFile(`${root}/dist/${file}`, `${target}/${file}`);
await copyFile(`${root}/LICENSE`, `${target}/LICENSE.web-noise-suppressor`);
console.log('Vendored RNNoise runtime and both WASM variants.');
