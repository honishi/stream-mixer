import test from 'node:test';
import assert from 'node:assert/strict';

let moduleId = 0;

// Only emulate the browser boundary. Initialization, cache eviction, callbacks,
// and disposal below run the production module with a fresh cache per test.
async function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const binary = new ArrayBuffer(8);
  const fetch = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, arrayBuffer: async () => binary }));
  const context = { sampleRate: 48000, audioWorklet: { addModule: t.mock.fn(async () => {}) } };
  const nodes = [];
  let onCreated;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
  globalThis.AudioWorkletNode = class {
    constructor(context, name, options) {
      this.context = context;
      this.name = name;
      this.options = options;
      this.disconnect = t.mock.fn();
      this.port = { postMessage: t.mock.fn(), close: t.mock.fn() };
      nodes.push(this);
      onCreated?.(this);
    }
  };
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'AudioWorkletNode', descriptor);
    else delete globalThis.AudioWorkletNode;
  });
  const api = await import(`../extension/audio/noise-reduction.js?test=${moduleId++}`);
  function start(target = context, onFailure = t.mock.fn(), mix = 0.5) {
    const created = new Promise((resolve) => { onCreated = resolve; });
    const result = api.createNoiseNode(target, onFailure, mix);
    return { created, result, onFailure };
  }
  return { ...api, start, context, nodes, fetch, binary };
}

function message(node, data) {
  node.port.onmessage({ data });
}

test('NR waits for readiness, shares assets, and registers the worklet once per context', async (t) => {
  const h = await setup(t);
  const first = h.start();
  const node = await first.created;
  let settled = false;
  first.result.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(node.name, 'stream-noise-reduction');
  assert.equal(node.context, h.context);
  assert.deepEqual(node.options.outputChannelCount, [2]);
  assert.equal(node.options.processorOptions.wasmBinary, h.binary);
  assert.equal(node.options.processorOptions.mix, 0.5);
  message(node, { type: 'ready' });
  assert.equal(await first.result, node);
  t.mock.timers.tick(5000);
  assert.equal(first.onFailure.mock.callCount(), 0);

  const second = h.start(h.context, undefined, 0.25);
  const secondNode = await second.created;
  message(secondNode, { type: 'ready' });
  await second.result;
  assert.equal(secondNode.options.processorOptions.mix, 0.25);
  assert.equal(h.context.audioWorklet.addModule.mock.callCount(), 1);
  assert.equal(h.fetch.mock.callCount(), 1);

  const other = { ...h.context, audioWorklet: { addModule: t.mock.fn(async () => {}) } };
  const third = h.start(other);
  message(await third.created, { type: 'ready' });
  await third.result;
  assert.equal(other.audioWorklet.addModule.mock.callCount(), 1);
  assert.equal(h.fetch.mock.callCount(), 1);
});

test('unsupported sample rates fail before loading assets or creating nodes', async (t) => {
  const h = await setup(t);
  await assert.rejects(h.createNoiseNode({ ...h.context, sampleRate: 44100 }, () => {}, 1), /48 kHz/);
  assert.equal(h.fetch.mock.callCount(), 0);
  assert.equal(h.context.audioWorklet.addModule.mock.callCount(), 0);
  assert.equal(h.nodes.length, 0);
});

for (const failure of ['fetch', 'module']) {
  test(`a failed ${failure} load is evicted so the next attempt can recover`, async (t) => {
    const h = await setup(t);
    if (failure === 'fetch') h.fetch.mock.mockImplementationOnce(async () => ({ ok: false }));
    else h.context.audioWorklet.addModule.mock.mockImplementationOnce(async () => { throw new Error('Module failed'); });
    await assert.rejects(h.createNoiseNode(h.context, () => {}, 1), failure === 'fetch' ? /load the noise reduction data/ : /Module failed/);
    assert.equal(h.nodes.length, 0);
    const retry = h.start();
    message(await retry.created, { type: 'ready' });
    await retry.result;
    assert.equal(h.fetch.mock.callCount(), failure === 'fetch' ? 2 : 1);
    assert.equal(h.context.audioWorklet.addModule.mock.callCount(), failure === 'module' ? 2 : 1);
  });
}

for (const failure of ['message', 'processor', 'timeout']) {
  test(`initialization ${failure} failure rejects and disposes the incomplete node`, async (t) => {
    const h = await setup(t);
    const pending = h.start();
    const rejected = assert.rejects(pending.result, /failed|stopped|timed out/);
    const node = await pending.created;
    if (failure === 'message') message(node, { type: 'error', error: 'bad model' });
    else if (failure === 'processor') node.onprocessorerror();
    else t.mock.timers.tick(5000);
    await rejected;
    assert.equal(pending.onFailure.mock.callCount(), 0, 'startup failure belongs to the caller');
    assert.equal(node.disconnect.mock.callCount(), 1);
    assert.equal(node.onprocessorerror, null);
    assert.deepEqual(node.port.postMessage.mock.calls.map(({ arguments: args }) => args), [[{ type: 'destroy' }]]);
    assert.equal(node.port.close.mock.callCount(), 0, 'allow worklet state to be freed first');
    message(node, { type: 'destroyed' });
    assert.equal(node.port.close.mock.callCount(), 1);
    t.mock.timers.tick(6000);
    assert.equal(node.port.close.mock.callCount(), 1, 'acknowledgement cancels the fallback timer');
  });
}

for (const failure of ['message', 'processor']) {
  test(`a runtime ${failure} failure notifies the owner after successful initialization`, async (t) => {
    const h = await setup(t);
    const pending = h.start();
    const node = await pending.created;
    message(node, { type: 'ready' });
    await pending.result;
    if (failure === 'message') message(node, { type: 'error', error: 'model crashed' });
    else node.onprocessorerror();
    assert.equal(pending.onFailure.mock.callCount(), 1);
    assert.match(pending.onFailure.mock.calls[0].arguments[0].message, failure === 'message' ? /model crashed/ : /processor stopped/);
  });
}

test('disposal closes an unresponsive worklet port after the grace period', async (t) => {
  const h = await setup(t);
  const pending = h.start();
  const node = await pending.created;
  message(node, { type: 'ready' });
  await pending.result;
  assert.doesNotThrow(() => h.destroyNoiseNode(null));
  h.destroyNoiseNode(node);
  message(node, { type: 'unrelated' });
  t.mock.timers.tick(999);
  assert.equal(node.port.close.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(node.port.close.mock.callCount(), 1);
});
