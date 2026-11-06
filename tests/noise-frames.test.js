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
