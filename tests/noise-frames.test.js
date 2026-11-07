import test from 'node:test';
import assert from 'node:assert/strict';
import { NoiseFrames } from '../extension/audio/noise-frames.js';

test('480-sample denoising frames preserve stereo and continuity across 128-sample blocks', () => {
  const calls = [0, 0];
  const adapter = new NoiseFrames([0, 1].map((channel) => ({
    processFrame(frame) {
      assert.equal(frame.length, 480);
      assert.ok(Math.max(...frame.map(Math.abs)) > 1, 'RNNoise receives PCM amplitude units');
      calls[channel]++;
      for (let i = 0; i < frame.length; i++) frame[i] *= channel ? 0.25 : 0.5;
    },
    destroy() {},
  })));
  const result = [[], []];
  for (let offset = 0; offset < 1920; offset += 128) {
    const input = [0, 1].map((channel) => Float32Array.from({ length: 128 }, (_, i) =>
      (channel ? -1 : 1) * (0.1 + (offset + i) / 10000)));
    const before = input.map((channel) => channel.slice());
    const output = [new Float32Array(128), new Float32Array(128)];
    adapter.process(input, output);
    assert.deepEqual(input, before);
    output.forEach((channel, index) => result[index].push(...channel));
  }
  assert.deepEqual(calls, [4, 4]);
  for (let i = 0; i < 1920; i++) {
    const original = i < 480 ? 0 : 0.1 + (i - 480) / 10000;
    assert.ok(Math.abs(result[0][i] - original * 0.5) < 1e-7);
    assert.ok(Math.abs(result[1][i] + original * 0.25) < 1e-7);
  }
});

test('reset clears buffered audio and each channel state is destroyed once', () => {
  let destroyed = 0;
  const adapter = new NoiseFrames([0, 1].map(() => ({ processFrame() {}, destroy() { destroyed++; } })));
  const output = [new Float32Array(480), new Float32Array(480)];
  adapter.process([new Float32Array(480).fill(0.2), new Float32Array(480).fill(0.1)], output);
  adapter.reset();
  adapter.process([], output);
  assert.ok(output.every((channel) => channel.every((sample) => sample === 0)));
  adapter.destroy();
  adapter.destroy();
  assert.equal(destroyed, 2);
});

// Model the RNNoise lookahead independently from the adapter's render buffering.
function delayedState(scale = 1) {
  let previous = new Float32Array(480);
  return {
    processFrame(frame) {
      const next = frame.slice();
      for (let i = 0; i < frame.length; i++) frame[i] = previous[i] * scale;
      previous = next;
    },
    destroy() {},
  };
}

test('partial NR aligns dry and processed audio without echoes or doubled peaks', () => {
  for (const mix of [0.25, 0.5, 1]) {
    const adapter = new NoiseFrames([delayedState(), delayedState()], 480, mix);
    const result = [[], []];
    for (let offset = 0; offset < 4096; offset += 128) {
      const input = [0, 1].map((c) => Float32Array.from({ length: 128 }, (_, i) => {
        const n = offset + i;
        return (c ? -0.5 : 1) * (n === 37 ? 0.8 : n > 100 ? Math.sin(n * 0.27) * 0.3 : 0);
      }));
      const output = [new Float32Array(128), new Float32Array(128)];
      adapter.process(input, output);
      output.forEach((channel, c) => result[c].push(...channel));
    }
    for (let i = 0; i < result[0].length; i++) {
      const n = i - 960;
      const expected = n === 37 ? 0.8 : n > 100 ? Math.sin(n * 0.27) * 0.3 : 0;
      assert.ok(Math.abs(result[0][i] - expected) < 1e-7, `${mix} wet at sample ${i}`);
      assert.ok(Math.abs(result[1][i] + expected * 0.5) < 1e-7);
    }
  }
});

test('Low and Medium retain speech discarded by the model; live changes ramp smoothly', () => {
  const adapter = new NoiseFrames([delayedState(0), delayedState(0)], 480, 0.5);
  const input = [new Float32Array(128).fill(0.4), new Float32Array(128).fill(-0.2)];
  const output = [new Float32Array(128), new Float32Array(128)];
  for (let i = 0; i < 20; i++) adapter.process(input, output);
  assert.ok(Math.abs(output[0][127] - 0.2) < 1e-7);
  adapter.setMix(0.25);
  let previous = output[0][127];
  for (let i = 0; i < 8; i++) {
    adapter.process(input, output);
    for (const sample of output[0]) {
      assert.ok(sample >= previous - 1e-7 && sample - previous < 0.001, 'no level-change discontinuity');
      previous = sample;
    }
  }
  assert.ok(Math.abs(previous - 0.3) < 1e-7);
  assert.ok(Math.abs(output[1][127] + 0.15) < 1e-7);
  adapter.setMix(1);
  for (let i = 0; i < 8; i++) adapter.process(input, output);
  assert.equal(output[0][127], 0, 'High retains the original fully processed behavior');
  adapter.setMix(0.25);
  adapter.reset();
  for (let i = 0; i < 12; i++) {
    adapter.process([], output);
    assert.ok(output.every((channel) => channel.every((sample) => sample === 0)), 'reset flushes buffered dry audio');
  }
});

test('uneven render blocks and missing channels preserve frame continuity without stale output', () => {
  const adapter = new NoiseFrames([{ processFrame() {}, destroy() {} }, { processFrame() {}, destroy() {} }]);
  let offset = 0;
  const rendered = [[], []];
  // Cross frame boundaries both within a block and between successive calls.
  for (const length of [1, 479, 7, 1024, 33, 480, 1024]) {
    const input = Float32Array.from({ length }, (_, i) => (offset + i + 1) / 10000);
    const output = [new Float32Array(length).fill(9), new Float32Array(length).fill(9)];
    adapter.process([input], output);
    output.forEach((channel, c) => rendered[c].push(...channel));
    offset += length;
  }
  assert.equal(rendered[0].length, offset);
  for (let i = 0; i < offset; i++) {
    const expected = i < 480 ? 0 : (i - 480 + 1) / 10000;
    assert.ok(Math.abs(rendered[0][i] - expected) < 1e-7, `sample ${i}`);
    assert.equal(rendered[1][i], 0);
  }
  adapter.destroy();
});
