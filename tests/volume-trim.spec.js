import { test, expect, launch, source, popup, state } from './helpers/browser.js';

async function command(view, type, payload = {}) {
  return view.evaluate((message) => chrome.runtime.sendMessage({ target: 'worker', ...message }), { type, ...payload });
}

// Use whole cycles per 128-sample render block at 48 kHz so input RMS does not
// vary with the metering window's phase. The tones have equal stereo channels.
// At center pan their output
// should equal input + automatic correction + trim (+ any Focus attenuation).
async function expectLevels(view, offsets, silentIds = []) {
  await expect.poll(async () => {
    const current = await state(view);
    return current.streams.every((stream) => {
      const level = Math.max(...stream.rms);
      if (silentIds.includes(stream.id)) return level < -90;
      const expected = stream.inputDb + stream.correctionDb + (offsets.get(stream.id) ?? 0);
      return Math.abs(level - expected) < 0.5;
    });
  }).toBe(true);
}

test('all trim levels attenuate only their stream after normalization and NR', async () => {
  const app = await launch();
  try {
    let view;
    for (let i = 0; i < 2; i++) {
      const audio = await source(app, i, 'tone', 375 * (i + 1));
      view = await popup(app, audio);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      if (i === 0) await view.close();
    }
    expect(await command(view, 'SETTINGS', { settings: { spread: 0 } })).toHaveProperty('ok', true);
    const initial = (await state(view)).streams;
    const [firstId, secondId] = initial.map((stream) => stream.id);
    expect(initial.map((stream) => stream.trimDb)).toEqual([0, 0]);
    await expect(view.locator('.trim-level').first().locator('option')).toHaveText(['Normal', '−3 dB', '−6 dB', '−9 dB', '−12 dB', '−15 dB']);
    await expectLevels(view, new Map());
    const inputBefore = (await state(view)).streams[0].inputDb;
    for (const trimDb of [-3, -6, -9, -12, -15, 0]) {
      await view.locator('.trim-level').first().selectOption(String(trimDb));
      await expect.poll(async () => (await state(view)).streams.map((stream) => stream.trimDb)).toEqual([trimDb, 0]);
      await expectLevels(view, new Map([[firstId, trimDb]]));
      expect(Math.abs((await state(view)).streams[0].inputDb - inputBefore)).toBeLessThan(0.2);
    }
    await view.locator('.trim-level').first().selectOption('-15');
    await view.locator('.trim-level').last().selectOption('-3');
    const offsets = new Map([[firstId, -15], [secondId, -3]]);
    await expectLevels(view, offsets);
    await view.locator('.nr-level').first().selectOption('low');
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'true');
    await expectLevels(view, offsets);
    await view.locator('.normalize-button').first().click();
    await expect(view.locator('.normalize-button').first()).toHaveAttribute('aria-pressed', 'false');
    await expectLevels(view, offsets);
    await view.locator('.normalize-button').first().click();
    await expectLevels(view, offsets);
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'false');
    await expectLevels(view, offsets);
    // Other controls must not feed the trim back into the normalizer's input.
    expect(Math.abs((await state(view)).streams[0].inputDb - inputBefore)).toBeLessThan(0.2);
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

test('trim survives mix controls, drag, reorder and reopening, and resets when a tab is re-added', async () => {
  const app = await launch();
  try {
    const sources = [];
    let view;
    for (let i = 0; i < 2; i++) {
      sources.push(await source(app, i, 'tone', 375 * (i + 1)));
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      await view.locator('.normalize-button').nth(i).click();
      if (i === 0) await view.close();
    }
    expect(await command(view, 'SETTINGS', { settings: { spread: 0 } })).toHaveProperty('ok', true);
    const [firstId, secondId] = (await state(view)).streams.map((stream) => stream.id);
    await view.locator('.trim-level').first().selectOption('-9');
    await view.locator('.trim-level').last().selectOption('-3');
    await expectLevels(view, new Map([[firstId, -9], [secondId, -3]]));
    await view.locator('.focus-button').first().click();
    await expectLevels(view, new Map([[firstId, -9], [secondId, -21]]));
    await view.locator('.solo-button').last().click();
    await expectLevels(view, new Map([[secondId, -3]]), [firstId]);
    await view.locator('.solo-button').last().click();
    await view.locator('.focus-button').first().click();

    expect(await command(view, 'SETTINGS', { settings: { spread: 1 } })).toHaveProperty('ok', true);
    await expect.poll(async () => (await state(view)).streams.every((stream) => Math.abs(stream.pan - stream.targetPan) < 0.001)).toBe(true);
    const secondFocusedLevel = Math.max(...(await state(view)).streams[1].rms);
    const dot = await view.locator('.position-dot').last().boundingBox();
    await view.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await view.mouse.down();
    await expect.poll(async () => (await state(view)).dragFocusTabId).toBe(secondId);
    await expect.poll(async () => Math.abs(Math.max(...(await state(view)).streams[1].rms) - secondFocusedLevel - 18)).toBeLessThan(0.5);
    await view.mouse.up();
    expect(await command(view, 'SETTINGS', { settings: { spread: 0 } })).toHaveProperty('ok', true);
    await expectLevels(view, new Map([[firstId, -9], [secondId, -21]]));

    await view.locator('.mute-button').first().click();
    await view.locator('.trim-level').first().selectOption('-6');
    await expectLevels(view, new Map([[secondId, -21]]), [firstId]);
    await view.locator('.mute-button').first().click();
    await expectLevels(view, new Map([[firstId, -6], [secondId, -21]]));
    await view.locator('#bypass').click();
    await expect(view.locator('.trim-level').first()).toBeDisabled();
    await expectLevels(view, new Map());
    const bypassed = await command(view, 'VOLUME_TRIM', { tabId: firstId, trimDb: -3 });
    expect(bypassed).toEqual({ ok: false, error: 'Resume the mix before adjusting stream volume.' });
    expect((await state(view)).streams.map((stream) => stream.trimDb)).toEqual([-6, -3]);
    await view.close();
    view = await popup(app, sources[1], false);
    await expect(view.locator('.trim-level').first()).toHaveValue('-6');
    await expect(view.locator('.trim-level').first()).toBeDisabled();
    await view.locator('#bypass').click();
    await expectLevels(view, new Map([[firstId, -6], [secondId, -21]]));
    await view.locator('.stream-card').first().focus();
    await view.keyboard.press('End');
    await expect.poll(async () => (await state(view)).streams.map((stream) => stream.id)).toEqual([secondId, firstId]);
    await expect(view.locator('.trim-level').last()).toHaveValue('-6');
    await expectLevels(view, new Map([[firstId, -6], [secondId, -21]]));

    for (const trimDb of [-18, 3, -1, '-3', null]) {
      expect(await command(view, 'VOLUME_TRIM', { tabId: firstId, trimDb })).toEqual({ ok: false, error: 'Invalid stream volume adjustment.' });
    }
    expect(await command(view, 'VOLUME_TRIM', { tabId: -1, trimDb: -3 })).toEqual({ ok: false, error: 'This tab has already been released.' });
    expect((await state(view)).streams.map((stream) => stream.trimDb)).toEqual([-3, -6]);
    await view.locator('.remove-button').last().click();
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await expectLevels(view, new Map([[secondId, -3]]));
    await view.close();
    view = await popup(app, sources[0]);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(2);
    await expect(view.locator('.trim-level').last()).toHaveValue('0');
    expect((await state(view)).streams.map((stream) => stream.trimDb)).toEqual([-3, 0]);
    await expectLevels(view, new Map([[secondId, -3]]));
    await view.locator('body').screenshot({ path: 'test-results/popup-volume-trim.png' });
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});
