import { test, expect, launch, source, popup, localized, state } from './helpers/browser.js';

test('drag preferences rebalance, survive bypass, and can return to automatic layout', async () => {
  const app = await launch();
  try {
    const sources = [];
    let view;
    for (let i = 0; i < 3; i++) {
      sources.push(await source(app, i));
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      if (i < 2) await view.close();
    }
    await expect.poll(async () => (await state(view)).streams.every((stream) => Math.abs(stream.pan - stream.targetPan) < 0.01)).toBe(true);
    const initial = (await state(view)).streams.map((stream) => stream.targetPan);
    let first = view.locator('.position-dot').first();
    await expect(view.locator('.position-dot.sound-active')).toHaveCount(3);
    await first.click();
    expect((await state(view)).streams.every((stream) => stream.panPreference === null)).toBe(true);
    const field = await view.locator('.stereo-field').boundingBox();
    let dot = await first.boundingBox();
    await view.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await view.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.completedStatePolls = 0;
      chrome.runtime.sendMessage = async (message, ...args) => {
        const response = await send(message, ...args);
        if (message.type === 'STATE' && response.ok) window.completedStatePolls++;
        return response;
      };
    });
    await view.mouse.down();
    await view.mouse.move(field.x + field.width * (0.5 + 0.44 * 0.9), dot.y + dot.height / 2, { steps: 8 });
    // Polling must not snap the actively dragged marker back or modify audio.
    const pollsBefore = await view.evaluate(() => window.completedStatePolls);
    await expect.poll(() => view.evaluate(() => window.completedStatePolls)).toBeGreaterThan(pollsBefore);
    await expect(first).toHaveClass(/dragging/);
    expect((await state(view)).streams.map((stream) => stream.targetPan)).toEqual(initial);
    await expect.poll(async () => {
      const current = await state(view);
      return current.soloTabId === current.streams[0].id
        && Math.max(...current.streams[0].rms) > -50
        && current.streams.slice(1).every((stream) => Math.max(...stream.rms) < -60);
    }).toBe(true);
    await expect(view.locator('.position-dot.sound-active')).toHaveCount(1);
    await view.evaluate(() => {
      window.dropPositions = new Promise((resolve) => {
        const positions = [];
        const until = performance.now() + 650;
        const sample = () => {
          positions.push(document.querySelector('.position-dot').getBoundingClientRect().x);
          if (performance.now() < until) requestAnimationFrame(sample);
          else resolve(positions);
        };
        requestAnimationFrame(sample);
      });
    });
    await view.mouse.up();
    await expect.poll(async () => (await state(view)).streams[0].targetPan).toBeGreaterThan(0.88);
    let mixed = await state(view);
    expect(mixed.streams[0].targetPan).not.toBe(0.9);
    expect(mixed.streams[1].targetPan).toBeLessThan(0);
    expect(mixed.streams[2].targetPan).toBe(0);
    await expect(view.locator('#reset-pans')).toBeVisible();
    await expect.poll(async () => (await state(view)).streams.every((stream) => Math.abs(stream.pan - stream.targetPan) < 0.01)).toBe(true);
    await expect.poll(async () => (await state(view)).soloTabId).toBe(null);
    await expect(view.locator('.position-dot.sound-active')).toHaveCount(3);
    // Audio/UI state can settle before the full visual observation window ends.
    const dropPositions = await view.evaluate(() => window.dropPositions);
    expect(dropPositions.length).toBeGreaterThan(5);
    expect(Math.min(...dropPositions)).toBeGreaterThan(field.x + field.width * 0.6);

    // Escape cancels a second drag without overwriting the saved preference.
    dot = await first.boundingBox();
    await view.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await view.mouse.down();
    await view.mouse.move(field.x + 40, dot.y + dot.height / 2, { steps: 5 });
    await view.keyboard.press('Escape');
    await view.mouse.up();
    expect((await state(view)).streams.map((stream) => stream.targetPan)).toEqual(mixed.streams.map((stream) => stream.targetPan));
    await expect.poll(async () => (await state(view)).soloTabId).toBe(null);

    // Closing a popup while holding a marker cannot leave other tabs muted.
    await first.hover();
    dot = await first.boundingBox();
    await view.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await view.mouse.down();
    await expect.poll(async () => (await state(view)).soloTabId).toBe(mixed.streams[0].id);
    await view.close();
    await sources[0].mouse.up();
    view = await popup(app, sources[0], false);
    first = view.locator('.position-dot').first();
    await expect.poll(async () => (await state(view)).soloTabId).toBe(null);
    await expect(view.locator('.position-dot.sound-active')).toHaveCount(3);
    await sources[0].locator('#pause').click();
    await expect(first).not.toHaveClass(/sound-active/);
    await sources[0].locator('#play').click();
    await expect(first).toHaveClass(/sound-active/);

    await view.locator('.settings-section > summary').click();
    await view.locator('#volume').fill('17');
    await view.locator('#volume').press('Tab');
    await expect.poll(async () => (await state(view)).settings.volume).toBe(0.17);
    await view.locator('.settings-section > summary').click();
    mixed = await state(view);
    await view.locator('main').evaluate((element) => { element.scrollTop = 0; });
    await view.locator('body').screenshot({ path: 'test-results/popup-dragged.png' });

    await view.locator('#bypass').click();
    await expect(view.locator('#bypass')).toHaveText(await localized(view, 'resumeMix'));
    await expect(view.locator('#mix-heading')).toHaveText(await localized(view, 'bypassed'));
    await expect(view.locator('#stop-all')).toBeEnabled();
    await expect(first).toBeDisabled();
    await expect(view.locator('.correction').first()).toHaveText('—');
    await expect.poll(async () => {
      const stream = (await state(view)).streams[0];
      // Original fixture is mono, upmixed equally. Its RMS is 0.035 / sqrt(2).
      return Math.abs(stream.rms[0] - stream.rms[1]) < 0.1 && Math.abs(stream.rms[0] - 20 * Math.log10(0.035 / Math.sqrt(2))) < 0.5;
    }).toBe(true);
    const bypassState = await state(view);
    expect(bypassState.streams.map((stream) => [stream.id, stream.targetPan, stream.panPreference]))
      .toEqual(mixed.streams.map((stream) => [stream.id, stream.targetPan, stream.panPreference]));
    expect(bypassState.settings).toEqual(mixed.settings);
    await view.close();
    view = await popup(app, sources[0], false);
    await expect(view.locator('#bypass')).toHaveText(await localized(view, 'resumeMix'));
    await view.locator('body').screenshot({ path: 'test-results/popup-bypassed.png' });
    await view.locator('#bypass').click();
    await expect(view.locator('#mix-heading')).toHaveText(await localized(view, 'mixing'));
    await expect.poll(async () => {
      const stream = (await state(view)).streams[0];
      return stream.rms[1] - stream.rms[0];
    }).toBeGreaterThan(3);
    expect((await state(view)).settings).toEqual(mixed.settings);
    expect((await state(view)).streams.map((stream) => stream.targetPan)).toEqual(mixed.streams.map((stream) => stream.targetPan));

    await view.locator('.position-dot').first().focus();
    await view.keyboard.press('Home');
    await expect.poll(async () => (await state(view)).streams[0].targetPan).toBe(-1);
    await expect.poll(async () => (await state(view)).streams[0].rms[1]).toBeLessThan(-60);
    await view.locator('.position-dot').first().focus();
    await view.keyboard.press('End');
    await expect.poll(async () => (await state(view)).streams[0].targetPan).toBe(1);
    await expect.poll(async () => (await state(view)).streams[0].rms[0]).toBeLessThan(-60);
    await view.locator('#reset-pans').click();
    await expect(view.locator('#reset-pans')).toBeHidden();
    expect((await state(view)).streams.map((stream) => stream.targetPan)).toEqual(initial);
    await view.locator('#bypass').click();
    await expect(view.locator('#bypass')).toHaveText(await localized(view, 'resumeMix'));
    await view.locator('#stop-all').click();
    await expect(view.locator('.stream-card')).toHaveCount(0);
    await expect(view.locator('#bypass')).toBeDisabled();
    await expect(view.locator('#mix-heading')).toHaveText(await localized(view, 'standby'));
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});
