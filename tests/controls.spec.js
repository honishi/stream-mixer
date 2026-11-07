import { test, expect, launch, source, popup, localized, state } from './helpers/browser.js';

test('Solo buttons retain selection, coexist with drag and bypass, and release on removal', async () => {
  const app = await launch();
  try {
    const sources = [];
    let view;
    for (let i = 0; i < 2; i++) {
      sources.push(await source(app, i));
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      if (i === 0) await view.close();
    }
    const ids = (await state(view)).streams.map((stream) => stream.id);
    const expectSolo = async (id) => {
      await expect.poll(async () => {
        const current = await state(view);
        return current.soloTabId === id && current.streams.every((stream) =>
          stream.id === id ? Math.max(...stream.rms) > -50 : Math.max(...stream.rms) < -60);
      }).toBe(true);
    };
    const expectAllPlaying = async () => {
      await expect.poll(async () => (await state(view)).streams.every((stream) => Math.max(...stream.rms) > -50)).toBe(true);
    };

    await view.locator('.solo-button').first().click();
    await expectSolo(ids[0]);
    await expect(view.locator('.solo-button').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('#mix-heading')).toHaveText(await localized(view, 'soloHeading'));
    await sources[0].evaluate(() => { document.title = '長い放送タイトルでも Solo ボタンと解除ボタンが popup の幅に収まることを確認する配信'; });
    await expect(view.locator('h3').first()).toContainText('長い放送タイトル');
    const layout = await view.evaluate(() => ({ width: document.querySelector('main').clientWidth,
      scrollWidth: document.querySelector('main').scrollWidth }));
    expect(layout.scrollWidth).toBe(layout.width);
    await view.locator('body').screenshot({ path: 'test-results/popup-solo.png' });
    await view.close();
    // A button selection must outlive the three-second temporary drag lease.
    await new Promise((done) => setTimeout(done, 3500));
    view = await popup(app, sources[0], false);
    await expectSolo(ids[0]);
    await expect(view.locator('.solo-button').first()).toHaveAttribute('aria-pressed', 'true');

    const secondDot = view.locator('.position-dot').nth(1);
    await secondDot.hover();
    const dot = await secondDot.boundingBox();
    await view.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await view.mouse.down();
    await expect.poll(async () => (await state(view)).focusTabIds).toEqual([ids[1]]);
    expect((await state(view)).soloTabId).toBeNull();
    await expectAllPlaying();
    expect((await state(view)).selectedSoloTabId).toBe(ids[0]);
    await view.mouse.up();
    await expectSolo(ids[0]);

    await view.locator('.solo-button').nth(1).click();
    await expectSolo(ids[1]);
    await expect(view.locator('.solo-button[aria-pressed=true]')).toHaveCount(1);
    await view.locator('.solo-button').nth(1).click();
    await expectAllPlaying();
    expect((await state(view)).selectedSoloTabId).toBe(null);

    await view.locator('.solo-button').first().click();
    await expectSolo(ids[0]);
    await view.locator('#bypass').click();
    await expect(view.locator('#bypass')).toHaveText(await localized(view, 'resumeMix'));
    await expectAllPlaying();
    await expect(view.locator('.solo-button').first()).toBeDisabled();
    expect((await state(view)).selectedSoloTabId).toBe(ids[0]);
    await view.locator('#bypass').click();
    await expectSolo(ids[0]);

    await view.close();
    sources.push(await source(app, 2));
    view = await popup(app, sources[2]);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(3);
    await expectSolo(ids[0]);
    await sources[0].close();
    await expect(view.locator('.stream-card')).toHaveCount(2);
    await expectAllPlaying();
    expect((await state(view)).selectedSoloTabId).toBe(null);
    await expect(view.locator('.solo-button[aria-pressed=true]')).toHaveCount(0);
    await view.locator('#stop-all').click();
    await expect(view.locator('.stream-card')).toHaveCount(0);
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

test('Focus lowers other streams by 18 dB and restores after drag previews, bypass, and popup reopening', async () => {
  const app = await launch();
  try {
    const sources = [];
    let view;
    for (let i = 0; i < 2; i++) {
      sources.push(await source(app, i));
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      await view.locator('.normalize-button').nth(i).click();
      await expect(view.locator('.normalize-button').nth(i)).toHaveAttribute('aria-pressed', 'false');
      if (i === 0) await view.close();
    }
    await view.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'SETTINGS', settings: { spread: 0 } }));
    await expect.poll(async () => (await state(view)).streams.every((stream) => Math.abs(stream.pan) < 0.001
      && Math.abs(stream.correctionDb) < 0.01 && Math.abs(Math.max(...stream.rms) - stream.inputDb) < 1.5)).toBe(true);
    const initial = (await state(view)).streams;
    const [firstId, secondId] = initial.map((stream) => stream.id);
    const baseline = new Map(initial.map((stream) => [stream.id, Math.max(...stream.rms)]));
    async function expectLevels(focusId, silentIds = []) {
      await expect.poll(async () => (await state(view)).streams.every((stream) => {
        const level = Math.max(...stream.rms);
        if (silentIds.includes(stream.id)) return level < -90;
        const expected = baseline.get(stream.id) - (focusId !== null && stream.id !== focusId ? 18 : 0);
        return Math.abs(level - expected) < 0.5;
      })).toBe(true);
    }
    await expect(view.locator('.focus-button[aria-pressed=true]')).toHaveCount(0);
    await view.locator('.focus-button').first().click();
    await expectLevels(firstId);
    await expect(view.locator('.stream-state').nth(1)).toHaveText(await localized(view, 'otherFocus'));
    await view.locator('.focus-button').first().click();
    await expectLevels(null);
    await view.locator('.focus-button').nth(1).click();
    await expectLevels(secondId);
    await view.locator('.focus-button').first().click();
    await expectLevels(null);
    await expect(view.locator('.focus-button[aria-pressed=true]')).toHaveCount(2);
    await view.locator('.solo-button').nth(1).click();
    await expectLevels(null, [firstId]);
    expect((await state(view)).selectedFocusTabIds).toEqual([]);
    await view.locator('.focus-button').first().click();
    await expectLevels(firstId);
    expect((await state(view)).selectedSoloTabId).toBeNull();

    // Pan dragging temporarily focuses only its stream, then restores Focus.
    await view.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'SETTINGS', settings: { spread: 1 } }));
    await expect.poll(async () => (await state(view)).streams.every((stream) => Math.abs(stream.pan - stream.targetPan) < 0.01)).toBe(true);
    await expect(view.locator('.position-dot').nth(1)).toBeEnabled();
    // Audio convergence does not imply that the popup's CSS transition has ended.
    // Hover waits for a stable, hittable marker before pressing the pointer.
    await view.locator('.position-dot').nth(1).hover();
    const beforeDrag = Math.max(...(await state(view)).streams[0].rms);
    await view.mouse.down();
    await expect.poll(async () => (await state(view)).focusTabIds).toEqual([secondId]);
    expect((await state(view)).soloTabId).toBeNull();
    expect((await state(view)).selectedFocusTabIds).toEqual([firstId]);
    await expect.poll(async () => Math.abs(Math.max(...(await state(view)).streams[0].rms) - beforeDrag + 18)).toBeLessThan(0.5);
    await view.mouse.up();
    await view.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'SETTINGS', settings: { spread: 0 } }));
    await expectLevels(firstId);
    await view.locator('.mute-button').nth(1).click();
    await expectLevels(firstId, [secondId]);
    await view.locator('.mute-button').nth(1).click();
    await expectLevels(firstId);
    await view.locator('.mute-button').first().click();
    await expectLevels(firstId, [firstId]);
    await view.locator('.mute-button').first().click();
    await expectLevels(firstId);
    await view.locator('body').screenshot({ path: 'test-results/popup-focus.png' });
    await view.locator('#bypass').click();
    await expectLevels(null);
    await expect(view.locator('.focus-button').first()).toBeDisabled();
    await view.close();
    view = await popup(app, sources[1], false);
    await expect(view.locator('.focus-button').first()).toHaveAttribute('aria-pressed', 'true');
    await view.locator('#bypass').click();
    await expectLevels(firstId);
    await view.locator('.stream-card').first().focus();
    await view.keyboard.press('End');
    await expect.poll(async () => (await state(view)).streams.map((stream) => stream.id)).toEqual([secondId, firstId]);
    await expect(view.locator('.focus-button').last()).toHaveAttribute('aria-pressed', 'true');
    await expectLevels(firstId);
    await view.close();
    const third = await source(app, 2);
    view = await popup(app, third);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(3);
    await view.locator('.normalize-button').last().click();
    await expect.poll(async () => {
      const stream = (await state(view)).streams.at(-1);
      return Math.abs(Math.max(...stream.rms) - stream.inputDb + 18);
    }).toBeLessThan(1.5);
    expect((await state(view)).focusTabIds).toEqual([firstId]);
    await view.locator('.remove-button').nth(1).click();
    await expect(view.locator('.stream-card')).toHaveCount(2);
    await expect(view.locator('.focus-button[aria-pressed=true]')).toHaveCount(0);
    expect((await state(view)).selectedFocusTabIds).toEqual([]);
    await expect.poll(async () => (await state(view)).streams.every((stream) =>
      Math.abs(Math.max(...stream.rms) - stream.inputDb) < 1.5)).toBe(true);
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

test('per-tab mute persists across solo, drag, bypass, ordering, and popup lifetime', async () => {
  const app = await launch();
  try {
    const sources = [];
    let view;
    for (let i = 0; i < 2; i++) {
      sources.push(await source(app, i));
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      if (i === 0) await view.close();
    }
    const [firstId, secondId] = (await state(view)).streams.map((stream) => stream.id);
    async function expectAudible(ids) {
      await expect.poll(async () => (await state(view)).streams.every((stream) => ids.includes(stream.id)
        ? Math.max(...stream.rms) > -55 : Math.max(...stream.rms) < -90)).toBe(true);
    }
    await expect(view.locator('.mute-button[aria-pressed=false]')).toHaveCount(2);
    await expectAudible([firstId, secondId]);
    await view.locator('.mute-button').first().click();
    await expectAudible([secondId]);
    await expect(view.locator('.stream-state').first()).toHaveText(await localized(view, 'mixMutedState'));
    await expect(view.locator('.position-dot').first()).toHaveClass(/solo-muted/);
    expect((await state(view)).streams[0].inputDb).toBeGreaterThan(-50);
    expect((await state(view)).streams[0].muted).toBe(false); // Native Chrome mute is untouched.
    await view.locator('.solo-button').first().click();
    await expectAudible([]);
    await view.locator('.mute-button').first().click();
    await expectAudible([firstId]);
    await view.locator('.mute-button').first().click();
    await expectAudible([]);
    await view.locator('.solo-button').first().click();
    await expectAudible([secondId]);

    const dot = await view.locator('.position-dot').first().boundingBox();
    await view.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await view.mouse.down();
    await expect.poll(async () => (await state(view)).dragFocusTabId).toBe(firstId);
    await expectAudible([secondId]);
    await view.mouse.up();
    await expectAudible([secondId]);
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'true');
    await view.locator('.normalize-button').first().click();
    await expect(view.locator('.normalize-button').first()).toHaveAttribute('aria-pressed', 'false');
    await view.locator('.stream-card').first().focus();
    await view.keyboard.press('End');
    await expect.poll(async () => (await state(view)).streams.map((stream) => stream.id)).toEqual([secondId, firstId]);
    await expect(view.locator('.mute-button').last()).toHaveAttribute('aria-pressed', 'true');
    await expectAudible([secondId]);
    await view.locator('body').screenshot({ path: 'test-results/popup-muted.png' });
    await view.close();
    view = await popup(app, sources[1], false);
    await expect(view.locator('.mute-button').last()).toHaveAttribute('aria-pressed', 'true');
    await expectAudible([secondId]);
    await view.locator('#bypass').click();
    await expect(view.locator('#bypass')).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('.mute-button').last()).toBeEnabled();
    await expectAudible([secondId]);
    await view.locator('.mute-button').last().click();
    await expectAudible([firstId, secondId]);
    await view.locator('.mute-button').last().click();
    await expectAudible([secondId]);
    await view.locator('#bypass').click();
    await expect(view.locator('#bypass')).toHaveAttribute('aria-pressed', 'false');
    await expectAudible([secondId]);
    const muted = (await state(view)).streams[1];
    expect(muted.noiseReductionEnabled).toBe(true);
    expect(muted.normalizeEnabled).toBe(false);
    await view.locator('.remove-button').first().click();
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await expectAudible([]);
    await view.locator('.remove-button').click();
    await expect(view.locator('.stream-card')).toHaveCount(0);
    await view.close();
    view = await popup(app, sources[0]);
    await view.locator('#add').click();
    await expect(view.locator('.mute-button')).toHaveAttribute('aria-pressed', 'false');
    await expectAudible([firstId]);
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

test('per-tab normalization defaults on and retains its setting across mix controls and popup lifetime', async () => {
  const app = await launch();
  try {
    const sources = [];
    let view;
    for (let i = 0; i < 2; i++) {
      sources.push(await source(app, i));
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      if (i === 0) await view.close();
    }
    await expect(view.locator('.normalize-button[aria-pressed=true]')).toHaveCount(2);
    // Settle the stereo placement before comparing output levels across the toggle.
    await view.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'SETTINGS', settings: { spread: 0 } }));
    await expect.poll(async () => (await state(view)).streams.every((stream) => Math.abs(stream.pan) < 0.001)).toBe(true);
    await expect.poll(async () => (await state(view)).streams[0].correctionDb).toBeGreaterThan(1);
    await expect.poll(async () => {
      const stream = (await state(view)).streams[0];
      return Math.max(...stream.rms) - stream.inputDb;
    }).toBeGreaterThan(1);
    const initial = await state(view);
    const [firstId, secondId] = initial.streams.map((stream) => stream.id);
    const before = Math.max(...initial.streams[0].rms);
    await view.locator('.normalize-button').first().click();
    await expect(view.locator('.normalize-button').first()).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => Math.abs((await state(view)).streams[0].correctionDb)).toBeLessThan(0.05);
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeLessThan(before - 0.5);
    expect((await state(view)).streams[1].normalizeEnabled).toBe(true);

    await view.locator('.settings-section > summary').click();
    await view.locator('#strength').fill('90');
    await view.locator('#strength').press('Tab');
    await expect.poll(async () => (await state(view)).settings.strength).toBe(0.9);
    expect(Math.abs((await state(view)).streams[0].correctionDb)).toBeLessThan(0.05);
    await view.locator('#strength').fill('0');
    await view.locator('#strength').press('Tab');
    await expect.poll(async () => (await state(view)).settings.strength).toBe(0);
    await view.locator('.normalize-button').first().click();
    await expect(view.locator('.normalize-button').first()).toHaveAttribute('aria-pressed', 'true');
    expect(Math.abs((await state(view)).streams[0].correctionDb)).toBeLessThan(0.05);
    await view.locator('#strength').fill('80');
    await view.locator('#strength').press('Tab');
    await expect.poll(async () => (await state(view)).streams[0].correctionDb).toBeGreaterThan(1);
    await view.locator('.settings-section > summary').click();
    await view.locator('.normalize-button').first().click();
    await expect(view.locator('.normalize-button').first()).toHaveAttribute('aria-pressed', 'false');
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'true');
    await view.locator('.solo-button').first().click();
    await expect(view.locator('.solo-button').first()).toHaveAttribute('aria-pressed', 'true');
    await view.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'SETTINGS', settings: { spread: 1 } }));
    await expect(view.locator('.position-dot').first()).toBeEnabled();
    await view.locator('.position-dot').first().focus();
    await view.keyboard.press('End');
    await expect(view.locator('#reset-pans')).toBeVisible();
    await expect(view.locator('#reset-pans')).toBeEnabled();
    await view.locator('.stream-card').first().focus();
    await view.keyboard.press('End');
    await expect.poll(async () => (await state(view)).streams.map((stream) => stream.id)).toEqual([secondId, firstId]);
    await expect(view.locator('.normalize-button').last()).toHaveAttribute('aria-pressed', 'false');
    await expect(view.locator('.normalize-button').first()).toHaveAttribute('aria-pressed', 'true');
    await view.locator('body').screenshot({ path: 'test-results/popup-normalize.png' });

    await view.locator('#bypass').click();
    await expect(view.locator('.normalize-button').last()).toBeDisabled();
    const blocked = await view.evaluate((tabId) => chrome.runtime.sendMessage({ target: 'worker', type: 'TOGGLE_NORMALIZE', tabId }), firstId);
    expect(blocked).toEqual({ ok: false, error: 'Resume the mix before changing normalization.' });
    await view.close();
    view = await popup(app, sources[1], false);
    await expect(view.locator('.normalize-button').last()).toHaveAttribute('aria-pressed', 'false');
    await view.locator('#bypass').click();
    await expect(view.locator('.normalize-button').last()).toBeEnabled();
    await expect.poll(async () => Math.abs((await state(view)).streams[1].correctionDb)).toBeLessThan(0.05);
    expect((await state(view)).streams[1].noiseReductionEnabled).toBe(true);
    expect((await state(view)).selectedSoloTabId).toBe(firstId);
    await view.locator('.remove-button').last().click();
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await view.close();
    view = await popup(app, sources[0]);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(2);
    await expect(view.locator('.normalize-button[aria-pressed=true]')).toHaveCount(2);
    expect((await state(view)).streams.at(-1).normalizeEnabled).toBe(true);
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});
