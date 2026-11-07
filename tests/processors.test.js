import test from 'node:test';
import assert from 'node:assert/strict';

let moduleId = 0;
async function processors(t) {
  const registry = new Map();
  const globals = {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: t.mock.fn() }; }
    },
    registerProcessor(name, processor) { registry.set(name, processor); },
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    globalThis[name] = value;
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  await import(`../extension/audio/processors.js?test=${moduleId++}`);
  return registry;
}

function stereo(left, right, length = 128) {
  return [new Float32Array(length).fill(left), new Float32Array(length).fill(right)];
}

function approximately(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${actual} vs ${expected}`);
}

test('meter passes through stereo and reports independent RMS/peaks for each interval', async (t) => {
  const Meter = (await processors(t)).get('stream-meter');
  const meter = new Meter();
  const input = stereo(0, -0.25);
  input[0][0] = 0.5;
  const output = stereo(0, 0);
  for (let block = 0; block < 37; block++) assert.equal(meter.process([input], [output]), true);
  assert.equal(meter.port.postMessage.mock.callCount(), 0, 'no report before 100 ms');
  meter.process([input], [output]);
  assert.deepEqual(output, input);
  const first = meter.port.postMessage.mock.calls[0].arguments[0];
  approximately(first.rms[0], 20 * Math.log10(0.5 / Math.sqrt(128)));
  approximately(first.peak[0], 20 * Math.log10(0.5));
  approximately(first.rms[1], 20 * Math.log10(0.25));
  approximately(first.peak[1], 20 * Math.log10(0.25));
  // Web Audio supplies zero-initialized render buffers when a channel is absent.
  for (let block = 0; block < 38; block++) meter.process([[]], [stereo(0, 0)]);
  assert.equal(meter.port.postMessage.mock.callCount(), 2);
  assert.deepEqual(meter.port.postMessage.mock.calls[1].arguments[0], { rms: [-120, -120], peak: [-120, -120] });
});

test('normalizer messages change audible correction and emit diagnostics', async (t) => {
  const Normalize = (await processors(t)).get('stream-normalizer');
  const processor = new Normalize();
  const input = stereo(0.02, -0.02);
  const output = stereo(0, 0);
  processor.port.onmessage({ data: { strength: 1 } });
  for (let block = 0; block < 2000; block++) processor.process([input], [output]);
  assert.ok(output[0][127] > 0.05, 'quiet audio is boosted');
  const diagnostic = processor.port.postMessage.mock.calls.at(-1).arguments[0];
  approximately(diagnostic.inputDb, 20 * Math.log10(input[0][0]));
  assert.ok(diagnostic.correctionDb > 6);
  assert.equal(diagnostic.limitingDb, 0);
  processor.port.onmessage({ data: { enabled: false } });
  for (let block = 0; block < 100; block++) processor.process([input], [output]);
  approximately(output[0][127], input[0][127]);
  approximately(output[1][127], input[1][127]);
  processor.port.onmessage({ data: { enabled: true, strength: 0 } });
  for (let block = 0; block < 100; block++) processor.process([input], [output]);
  approximately(output[0][127], input[0][127]);
  processor.port.onmessage({ data: { strength: 1 } });
  for (let block = 0; block < 2000; block++) processor.process([input], [output]);
  assert.ok(output[0][127] > 0.05, 're-enabling restores correction');
});

test('safety worklet limits the louder channel while preserving polarity and stereo balance', async (t) => {
  const Safety = (await processors(t)).get('stream-safety');
  const processor = new Safety();
  const output = stereo(0, 0);
  assert.equal(processor.process([stereo(-0.5, 2)], [output]), true);
  for (let i = 0; i < 128; i++) {
    assert.ok(output[1][i] > 0.8 && output[1][i] <= 10 ** (-1 / 20) + 1e-7);
    approximately(output[0][i], -output[1][i] / 4);
  }
  processor.process([[]], [output]);
  assert.ok(output.every((channel) => channel.every((sample) => sample === 0)));
});

test('stop messages end every worklet without producing more output or diagnostics', async (t) => {
  const registry = await processors(t);
  assert.deepEqual([...registry.keys()].sort(), ['stream-meter', 'stream-normalizer', 'stream-safety']);
  for (const Processor of registry.values()) {
    const processor = new Processor();
    processor.port.onmessage({ data: { stop: true } });
    const output = stereo(0, 0);
    assert.equal(processor.process([stereo(1, 1)], [output]), false);
    assert.deepEqual(output, stereo(0, 0));
    assert.equal(processor.port.postMessage.mock.callCount(), 0);
  }
});

for (const [requested, bounded] of [[5, 1], [-1, 0]]) {
  test(`normalizer strength ${requested} produces the same audio as ${bounded}`, async (t) => {
    const Normalize = (await processors(t)).get('stream-normalizer');
    const actual = new Normalize();
    const reference = new Normalize();
    actual.port.onmessage({ data: { strength: requested } });
    reference.port.onmessage({ data: { strength: bounded } });
    const input = stereo(0.02, -0.01);
    const output = stereo(0, 0);
    const expected = stereo(0, 0);
    for (let block = 0; block < 2000; block++) {
      actual.process([input], [output]);
      reference.process([input], [expected]);
      assert.deepEqual(output, expected);
    }
    assert.ok(output[0][127] > 0, 'signal survives');
  });
}

test('normalizer reports diagnostics every 100 ms and starts a fresh reporting interval', async (t) => {
  const Normalize = (await processors(t)).get('stream-normalizer');
  const processor = new Normalize();
  const input = stereo(0.02, -0.02);
  const output = stereo(0, 0);
  for (let interval = 0; interval < 2; interval++) {
    for (let block = 0; block < 37; block++) processor.process([input], [output]);
    assert.equal(processor.port.postMessage.mock.callCount(), interval);
    processor.process([input], [output]);
    assert.equal(processor.port.postMessage.mock.callCount(), interval + 1);
  }
});
