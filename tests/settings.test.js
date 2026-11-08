import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, sanitizeSettings, panPositions } from '../extension/shared/settings.js';

test('missing or malformed stored settings restore independent defaults', () => {
  for (const value of [undefined, null, {}, false, 'corrupt']) {
    const settings = sanitizeSettings(value);
    assert.deepEqual(settings, DEFAULT_SETTINGS);
    assert.notEqual(settings, DEFAULT_SETTINGS);
    settings.volume = 0;
    assert.equal(DEFAULT_SETTINGS.volume, 1);
  }
});

for (const key of ['volume', 'strength', 'spread']) {
  test(`${key} accepts only finite numbers and clamps to the supported range`, () => {
    for (const value of [NaN, Infinity, -Infinity, '0.5', null, true, {}]) {
      assert.deepEqual(sanitizeSettings({ [key]: value }), DEFAULT_SETTINGS);
    }
    for (const [value, expected] of [[-1, 0], [0, 0], [0.35, 0.35], [1, 1], [5, 1]]) {
      assert.deepEqual(sanitizeSettings({ [key]: value }), { ...DEFAULT_SETTINGS, [key]: expected });
    }
  });
}

test('sanitization preserves valid fields without mutating storage or retaining unknown fields', () => {
  const stored = Object.freeze({ volume: 0.2, strength: 2, spread: 0, ignored: true });
  assert.deepEqual(sanitizeSettings(stored), { volume: 0.2, strength: 1, spread: 0 });
  assert.equal(stored.strength, 2);
});

test('automatic positions are evenly spaced, symmetric and bounded for zero through six streams', () => {
  assert.deepEqual(panPositions(0, 1), []);
  assert.deepEqual(panPositions(1, 1), [0]);
  assert.deepEqual(panPositions(3, 0.5), [-0.5, 0, 0.5]);
  for (const [spread, width] of [[0, 0], [0.65, 0.65], [1, 1], [-1, 0], [2, 1], [NaN, 1], [Infinity, 1]]) {
    for (let count = 2; count <= 6; count++) {
      const pans = panPositions(count, spread);
      assert.equal(pans.length, count);
      for (let i = 0; i < count; i++) {
        assert.ok(Math.abs(pans[i]) <= width);
        assert.ok(Math.abs(pans[i] + pans[count - 1 - i]) < 1e-12);
        if (i) assert.ok(Math.abs(pans[i] - pans[i - 1] - 2 * width / (count - 1)) < 1e-12);
      }
    }
  }
});
