import test from 'node:test';
import assert from 'node:assert/strict';
import { Normalizer, PeakLimiter, dbToGain, gainToDb } from '../extension/audio/dsp.js';
import { DEFAULT_SETTINGS, sanitizeSettings, panPositions } from '../extension/shared/settings.js';

const sampleRate = 48000;
function feed(dsp, amplitude, seconds = 12, ratio = 1) {
  const output = [new Float32Array(128), new Float32Array(128)];
  let peak = 0;
  for (let block = 0; block < Math.ceil(seconds * sampleRate / 128); block++) {
    const left = Float32Array.from({ length: 128 }, (_, i) => amplitude * Math.sin(2 * Math.PI * 440 * (block * 128 + i) / sampleRate));
    const right = left.map((value) => value * ratio);
    dsp.process([left, right], output);
    for (const channel of output) for (const value of channel) peak = Math.max(peak, Math.abs(value));
  }
  return { output, peak };
}

test('different sustained source levels converge toward the same RMS target', () => {
  const quiet = new Normalizer(sampleRate);
  const loud = new Normalizer(sampleRate);
  quiet.strength = loud.strength = 1;
  feed(quiet, 0.04);
  feed(loud, 0.4);
  const quietDb = gainToDb(0.04 / Math.sqrt(2)) + quiet.gainDb;
  const loudDb = gainToDb(0.4 / Math.sqrt(2)) + loud.gainDb;
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

test('pan positions stay symmetric with centered mono and bounded extremes', () => {
  assert.deepEqual(panPositions(0, 1), []);
  assert.deepEqual(panPositions(1, 1), [0]);
  for (let count = 2; count <= 6; count++) {
    const positions = panPositions(count, 1);
    assert.equal(positions[0], -0.85);
    assert.equal(positions.at(-1), 0.85);
    assert.ok(Math.abs(positions.reduce((a, b) => a + b, 0)) < 1e-9);
  }
  assert.ok(panPositions(6, 0).every((pan) => pan === 0));
});

test('stored settings cannot inject invalid gain or pan values', () => {
  assert.deepEqual(sanitizeSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings({ volume: 5, strength: -1, spread: NaN, ignored: true }),
    { volume: 1, strength: 0, spread: 0.65 });
});
