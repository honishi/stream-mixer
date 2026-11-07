import test from 'node:test';
import assert from 'node:assert/strict';
import { Normalizer, PeakLimiter, dbToGain, gainToDb } from '../extension/audio/dsp.js';

const sampleRate = 48000;
function feed(dsp, amplitude, seconds = 12, ratio = 1) {
  const output = [new Float32Array(128), new Float32Array(128)];
  let peak = 0;
  let tailEnergy = 0;
  let tailSamples = 0;
  const blocks = Math.ceil(seconds * sampleRate / 128);
  for (let block = 0; block < blocks; block++) {
    const left = Float32Array.from({ length: 128 }, (_, i) => amplitude * Math.sin(2 * Math.PI * 440 * (block * 128 + i) / sampleRate));
    const right = left.map((value) => value * ratio);
    dsp.process([left, right], output);
    for (const channel of output) for (const value of channel) {
      assert.ok(Number.isFinite(value), 'output must remain finite');
      peak = Math.max(peak, Math.abs(value));
      if (block >= blocks - Math.ceil(sampleRate / 128)) {
        tailEnergy += value * value;
        tailSamples++;
      }
    }
  }
  return { output, peak, rms: Math.sqrt(tailEnergy / tailSamples) };
}

test('different sustained source levels converge toward the same RMS target', () => {
  const quiet = new Normalizer(sampleRate);
  const loud = new Normalizer(sampleRate);
  quiet.strength = loud.strength = 1;
  const quietDb = gainToDb(feed(quiet, 0.04).rms);
  const loudDb = gainToDb(feed(loud, 0.4).rms);
  assert.ok(Math.abs(quietDb - loudDb) < 0.3, `${quietDb} vs ${loudDb}`);
  assert.ok(Math.abs(loudDb + 22) < 0.1);
});

test('silence and faint background noise never increase the normalization gain', () => {
  const dsp = new Normalizer(sampleRate);
  feed(dsp, 0.04, 2);
  const before = dsp.gainDb;
  feed(dsp, 0, 20);
  feed(dsp, 0.0001, 20);
  assert.equal(dsp.gainDb, before);
});

test('sudden loud input is bounded and stereo channels retain their ratio', () => {
  const dsp = new Normalizer(sampleRate);
  feed(dsp, 0.03);
  const { peak, output } = feed(dsp, 1, 0.2, 0.5);
  assert.ok(peak <= dbToGain(-4) + 1e-6);
  for (let i = 0; i < output[0].length; i++) assert.ok(Math.abs(output[1][i] - output[0][i] * 0.5) < 1e-6);
});

test('zero strength restores unity gain, even during silence', () => {
  const dsp = new Normalizer(sampleRate);
  feed(dsp, 0.03);
  dsp.strength = 0;
  feed(dsp, 0, 8);
  assert.ok(Math.abs(dsp.gainDb) < 0.001);
});

test('mixed signal limiter bounds peaks and releases smoothly', () => {
  const limiter = new PeakLimiter(sampleRate);
  assert.ok(6 * limiter.next(6) <= dbToGain(-1) + 1e-9);
  const reduced = limiter.gain;
  limiter.next(0);
  assert.ok(limiter.gain > reduced && limiter.gain < 1);
  for (let i = 0; i < sampleRate; i++) limiter.next(0);
  assert.ok(limiter.gain > 0.99);
});

test('disabling normalization smoothly removes positive and negative gain, retaining peak protection', () => {
  for (const amplitude of [0.03, 0.4]) {
    const dsp = new Normalizer(sampleRate);
    assert.equal(dsp.enabled, true);
    feed(dsp, amplitude, 6);
    const before = Math.abs(dsp.gainDb);
    assert.ok(before > 1);
    dsp.enabled = false;
    feed(dsp, 0, 128 / sampleRate);
    assert.ok(Math.abs(dsp.gainDb) < before && Math.abs(dsp.gainDb) > before * 0.8);
    feed(dsp, 0, 0.25);
    assert.ok(Math.abs(dsp.gainDb) < 0.001, 'disabling works even during silence');
    const { peak, output } = feed(dsp, 1, 0.2, 0.5);
    assert.ok(peak <= dbToGain(-4) + 1e-6);
    for (let i = 0; i < output[0].length; i++) assert.ok(Math.abs(output[1][i] - output[0][i] * 0.5) < 1e-6);
    dsp.enabled = true;
    feed(dsp, amplitude, 6);
    assert.ok(Math.abs(dsp.gainDb) > 1, 're-enabling restores correction');
  }
});

test('missing input clears reused output buffers and does not contaminate a later signal', () => {
  const dsp = new Normalizer(sampleRate);
  dsp.strength = 0;
  const output = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)];
  dsp.process([], output);
  assert.ok(output.every((channel) => channel.every((value) => value === 0)));
  const mono = new Float32Array(128).fill(0.1);
  dsp.process([mono], output);
  assert.deepEqual(output[0], mono);
  assert.ok(output[1].every((value) => value === 0));
});

test('stereo peak protection responds to the louder right channel without mutating input', () => {
  const dsp = new Normalizer(sampleRate);
  dsp.enabled = false;
  const input = [new Float32Array([0.1, -0.1, 0]), new Float32Array([2, -2, 0])];
  const before = input.map((channel) => channel.slice());
  const output = input.map((channel) => new Float32Array(channel.length));
  dsp.process(input, output);
  assert.deepEqual(input, before);
  assert.ok(output[1][0] > 0.6 && output[1][1] < -0.6, 'nonzero signal and polarity survive');
  for (let i = 0; i < output[0].length; i++) {
    assert.ok(Math.abs(output[1][i]) <= dbToGain(-4) + 1e-6);
    assert.ok(Math.abs(output[0][i] * 20 - output[1][i]) < 1e-6);
  }
});
