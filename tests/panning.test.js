import test from 'node:test';
import assert from 'node:assert/strict';
import { preferredPanPositions, withPanPreference } from '../extension/shared/panning.js';
import { panPositions } from '../extension/shared/settings.js';

const entries = (count) => Array.from({ length: count }, (_, id) => ({ id, panPreference: null }));

test('unmodified streams retain the original even placement', () => {
  for (let count = 0; count <= 6; count++) {
    const actual = preferredPanPositions(entries(count), 0.65);
    const expected = panPositions(count, 0.65);
    actual.forEach((pan, index) => assert.ok(Math.abs(pan - expected[index]) < 1e-12));
  }
});

test('a drop near an occupied right edge moves the old occupant inward', () => {
  const next = withPanPreference(entries(3), 0, 0.6, 0.65);
  assert.deepEqual(next.map((entry) => entry.id), [1, 2, 0]);
  const pans = preferredPanPositions(next, 0.65);
  assert.ok(Math.abs(pans[2] - 0.6) < 0.03);
  assert.notEqual(pans[2], 0.6, 'drop is a preference, not a hard position');
  assert.equal(pans[1], 0);
  assert.ok(pans[0] < 0);
});

test('nearby preferences remain separated and bounded for two through six streams', () => {
  for (let count = 2; count <= 6; count++) {
    for (const preference of [-1, -0.4, 0, 0.4, 1]) {
      const layout = entries(count).map((entry) => ({ ...entry, panPreference: preference }));
      const pans = preferredPanPositions(layout, 0.65);
      assert.ok(pans.every((pan) => pan >= -0.65 - 1e-12 && pan <= 0.65 + 1e-12));
      for (let i = 1; i < pans.length; i++) assert.ok(pans[i] - pans[i - 1] >= 1.3 * 0.65 / (count - 1) - 1e-12);
    }
  }
});

test('preferences scale with spread and survive a temporary zero spread', () => {
  const layout = withPanPreference(entries(3), 0, 0.6, 0.65);
  const full = preferredPanPositions(layout, 1);
  const half = preferredPanPositions(layout, 0.5);
  assert.ok(preferredPanPositions(layout, 0).every((pan) => pan === 0));
  half.forEach((pan, index) => assert.equal(pan, full[index] / 2));
  assert.deepEqual(preferredPanPositions(layout, 1), full);
});

test('one stream can prefer a side, while empty and invalid requests are handled', () => {
  const solo = withPanPreference(entries(1), 0, -0.5, 0.65);
  assert.ok(Math.abs(preferredPanPositions(solo, 0.65)[0] + 0.4) < 1e-12);
  assert.deepEqual(preferredPanPositions([], 0.65), []);
  assert.throws(() => withPanPreference([], 0, 0, 1));
  assert.throws(() => withPanPreference(entries(1), 0, NaN, 1));
  assert.throws(() => withPanPreference(entries(1), 0, 0.2, 0));
  assert.equal(withPanPreference(entries(1), 0, 99, 0.65)[0].panPreference, 1);
  for (let count = 1; count <= 6; count++) {
    for (const edge of [-1, 1]) {
      const layout = withPanPreference(entries(count), 0, edge, 1);
      const pans = preferredPanPositions(layout, 1);
      assert.ok(Math.abs(pans[layout.findIndex((entry) => entry.id === 0)] - edge) < 1e-12,
        `${count} streams: an edge drop reaches ${edge}`);
    }
  }
});
