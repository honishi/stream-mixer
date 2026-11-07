import { test, expect, launch, source, popup, localized, state } from './helpers/browser.js';

test('multiple Focus selections retain independent levels across playback controls and tab lifetimes', async () => {
  const app = await launch();
  try {
    const sources = [];
    let view;
    for (let i = 0; i < 3; i++) {
      sources.push(await source(app, i, 'tone', 375 * (i + 1)));
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      await view.locator('.normalize-button').nth(i).click();
      if (i < 2) await view.close();
    }
    async function setSpread(spread) {
      expect(await view.evaluate((spread) => chrome.runtime.sendMessage({
        target: 'worker', type: 'SETTINGS', settings: { spread },
      }), spread)).toHaveProperty('ok', true);
    }
    await setSpread(0);
    const [firstId, secondId, thirdId] = (await state(view)).streams.map((stream) => stream.id);
    const trims = new Map([[secondId, -6], [thirdId, -3]]);
    await view.locator('.trim-level').nth(1).selectOption('-6');
    await view.locator('.trim-level').nth(2).selectOption('-3');

    async function expectSelection(ids) {
      const current = await state(view);
      expect(new Set(current.selectedFocusTabIds)).toEqual(new Set(ids));
      expect(new Set(current.focusTabIds)).toEqual(new Set(ids));
      await expect(view.locator('.focus-button[aria-pressed=true]')).toHaveCount(ids.length);
    }
    async function expectLevels(ids, silentIds = [], bypass = false) {
      await expect.poll(async () => (await state(view)).streams.every((stream) => {
        const output = Math.max(...stream.rms);
        if (silentIds.includes(stream.id)) return output < -90;
        const trim = bypass ? 0 : trims.get(stream.id) ?? 0;
        const focus = ids.length && !ids.includes(stream.id) ? -18 : 0;
        return stream.inputDb > -50 && Math.abs(output - stream.inputDb - trim - focus) < 0.5;
      })).toBe(true);
    }
    await expectLevels([]);
    await view.locator('.focus-button').nth(0).click();
    await view.locator('.focus-button').nth(1).click();
    await expectSelection([firstId, secondId]);
    await expectLevels([firstId, secondId]);
    await expect(view.locator('.stream-state').nth(0)).toHaveText(await localized(view, 'focusState'));
    await expect(view.locator('.stream-state').nth(1)).toHaveText(await localized(view, 'focusState'));
    await expect(view.locator('.stream-state').nth(2)).toHaveText(await localized(view, 'otherFocus'));
    await expect(view.locator('#mix-heading')).toHaveText(await localized(view, 'focusHeading'));

    // Selecting every card attenuates none; removing one affects only that card.
    await view.locator('.focus-button').nth(2).click();
    await expectSelection([firstId, secondId, thirdId]);
    await expectLevels([firstId, secondId, thirdId]);
    await view.locator('.focus-button').nth(2).click();
    await expectLevels([firstId, secondId]);
    await view.locator('.focus-button').nth(1).click();
    await expectSelection([firstId]);
    await expectLevels([firstId]);
    await view.locator('.focus-button').nth(0).click();
    await expectSelection([]);
    await expectLevels([]);
    await expect(view.locator('#mix-heading')).toHaveText(await localized(view, 'mixing'));
    await view.locator('.focus-button').nth(0).click();
    await view.locator('.focus-button').nth(1).click();

    // A drag focuses only its stream while preserving the selected group for release.
    await setSpread(1);
    await expect.poll(async () => (await state(view)).streams.every((stream) => Math.abs(stream.pan - stream.targetPan) < 0.001)).toBe(true);
    const beforeDrag = (await state(view)).streams.map((stream) => Math.max(...stream.rms));
    const dot = await view.locator('.position-dot').nth(2).boundingBox();
    await view.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await view.mouse.down();
    await expect.poll(async () => (await state(view)).dragFocusTabId).toBe(thirdId);
    const preview = await state(view);
    expect(preview.soloTabId).toBeNull();
    expect(preview.focusTabIds).toEqual([thirdId]);
    expect(new Set(preview.selectedFocusTabIds)).toEqual(new Set([firstId, secondId]));
    await expect(view.locator('.focus-button[aria-pressed=true]')).toHaveCount(1);
    await expect(view.locator('.focus-button').nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('.stream-state').nth(2)).toHaveText(await localized(view, 'dragFocusState'));
    await expect.poll(async () => (await state(view)).streams.every((stream, index) =>
      Math.abs(Math.max(...stream.rms) - beforeDrag[index] - (index === 2 ? 18 : -18)) < 0.5)).toBe(true);
    await view.mouse.up();
    await expect.poll(async () => (await state(view)).dragFocusTabId).toBeNull();
    await expectSelection([firstId, secondId]);

    // Canceling and closing the popup restore the complete group too, including
    // when the dragged stream was already a member of that group.
    for (const finish of ['escape', 'close']) {
      await view.locator('.position-dot').first().hover();
      await view.mouse.down();
      await expect.poll(async () => (await state(view)).focusTabIds).toEqual([firstId]);
      if (finish === 'escape') {
        await view.keyboard.press('Escape');
        await view.mouse.up();
      } else {
        await view.close();
        await sources[2].mouse.up();
        view = await popup(app, sources[2], false);
      }
      await expect.poll(async () => (await state(view)).dragFocusTabId).toBeNull();
      await expectSelection([firstId, secondId]);
    }
    await setSpread(0);
    await expectSelection([firstId, secondId]);
    await expectLevels([firstId, secondId]);
    await view.locator('.mute-button').nth(0).click();
    await expectLevels([firstId, secondId], [firstId]);
    await expectSelection([firstId, secondId]);
    await view.locator('.mute-button').nth(0).click();

    await view.locator('#bypass').click();
    await expectLevels([], [], true);
    expect((await state(view)).focusTabIds).toEqual([]);
    await view.close();
    view = await popup(app, sources[2], false);
    await expect(view.locator('.focus-button[aria-pressed=true]')).toHaveCount(2);
    await expect(view.locator('.focus-button').nth(0)).toBeDisabled();
    await view.locator('#bypass').click();
    await expectSelection([firstId, secondId]);
    await expectLevels([firstId, secondId]);

    await view.locator('.solo-button').nth(2).click();
    await expectSelection([]);
    await expectLevels([], [firstId, secondId]);
    await view.locator('.focus-button').nth(0).click();
    expect((await state(view)).selectedSoloTabId).toBeNull();
    await view.locator('.focus-button').nth(1).click();
    await expectLevels([firstId, secondId]);
    await view.locator('.stream-card').nth(0).focus();
    await view.keyboard.press('End');
    await expect.poll(async () => (await state(view)).streams.map((stream) => stream.id)).toEqual([secondId, thirdId, firstId]);
    await expectSelection([firstId, secondId]);
    await expectLevels([firstId, secondId]);
    await expect(view.locator('.focus-button').nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('.focus-button').nth(2)).toHaveAttribute('aria-pressed', 'true');

    await view.close();
    sources.push(await source(app, 3, 'tone', 1500));
    view = await popup(app, sources[3]);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(4);
    await view.locator('.normalize-button').last().click();
    await expectSelection([firstId, secondId]);
    await expectLevels([firstId, secondId]);
    const invalid = await view.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'TOGGLE_FOCUS', tabId: -1 }));
    expect(invalid).toEqual({ ok: false, error: 'This tab has already been released.' });
    await expectSelection([firstId, secondId]);
    await view.locator('body').screenshot({ path: 'test-results/popup-multiple-focus.png' });
    await view.locator('.remove-button').nth(2).click();
    await expect(view.locator('.stream-card')).toHaveCount(3);
    await expectSelection([secondId]);
    await expectLevels([secondId]);
    await sources[1].close();
    await expect(view.locator('.stream-card')).toHaveCount(2);
    await expectSelection([]);
    await expectLevels([]);
    await expect(view.locator('#mix-heading')).toHaveText(await localized(view, 'mixing'));
    await view.locator('.focus-button').first().click();
    await view.locator('.focus-button').last().click();
    await view.locator('#stop-all').click();
    await expect(view.locator('.stream-card')).toHaveCount(0);
    await view.close();
    view = await popup(app, sources[2]);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await expectSelection([]);
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});
