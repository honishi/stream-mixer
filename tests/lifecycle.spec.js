import { test, expect, launch, source, popup, localized, state, addTestVideo, expectStablePeakLayout } from './helpers/browser.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('card reordering renumbers cards and field markers while preserving audio settings and popup lifetime', async () => {
  const app = await launch();
  try {
    let view;
    const sources = [];
    for (let i = 0; i < 3; i++) {
      sources.push(await source(app, i));
      if (i === 0) await addTestVideo(sources[i], { color: '#ff0000' });
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      if (i < 2) await view.close();
    }
    await view.locator('.nr-level').first().selectOption('low');
    await view.locator('.nr-button').first().click();
    await view.locator('.solo-button').nth(1).click();
    const initial = await state(view);
    const ids = initial.streams.map((stream) => stream.id);
    async function expectOrder(expected) {
      await expect.poll(async () => (await state(view)).streams.map((stream) => stream.id)).toEqual(expected);
      const ordered = (await state(view)).streams;
      await expect(view.locator('.stream-card h3')).toHaveText(ordered.map((stream) => stream.title));
      await expect(view.locator('.stream-number')).toHaveText(ordered.map((_, i) => String(i + 1).padStart(2, '0')));
      await expect(view.locator('.position-dot')).toHaveText(ordered.map((_, i) => String(i + 1)));
      for (const [index, stream] of ordered.entries()) {
        await expect(view.locator('.position-dot').nth(index)).toHaveAttribute('aria-label', await localized(view, 'panLabel', [index + 1, stream.title]));
      }
    }
    const target = await view.locator('.stream-card').nth(2).boundingBox();
    await expect(view.locator('.stream-preview').first()).toBeVisible();
    await view.locator('.stream-card').first().dragTo(view.locator('.stream-card').nth(2), {
      sourcePosition: { x: 20, y: 18 }, targetPosition: { x: target.width - 30, y: 18 },
    });
    await expectOrder([ids[1], ids[2], ids[0]]);
    const reordered = await state(view);
    expect(reordered.soloTabId).toBe(initial.soloTabId);
    expect(reordered.dragSoloTabId).toBeNull();
    for (const stream of reordered.streams) {
      const previous = initial.streams.find((entry) => entry.id === stream.id);
      for (const key of ['targetPan', 'panPreference', 'color', 'noiseReductionEnabled', 'noiseReductionLevel']) {
        expect(stream[key]).toEqual(previous[key]);
      }
    }
    await view.locator('body').screenshot({ path: 'test-results/popup-reordered.png' });

    await view.locator('.stream-card').first().focus();
    await view.keyboard.press('ArrowDown');
    await expectOrder([ids[2], ids[0], ids[1]]);
    await expect(view.locator('.stream-card').last()).toBeFocused();
    await view.locator('#bypass').click();
    await expect(view.locator('#bypass')).toBeEnabled();
    await view.locator('.stream-card').last().focus();
    await view.keyboard.press('Home');
    await expectOrder([ids[1], ids[2], ids[0]]);
    expect((await state(view)).bypassed).toBe(true);

    const start = await view.locator('.stream-card').first().boundingBox();
    const end = await view.locator('.stream-card').nth(1).boundingBox();
    await view.mouse.move(start.x + 80, start.y + 18);
    await view.mouse.down();
    await view.mouse.move(end.x + 80, end.y + 18, { steps: 8 });
    await view.keyboard.press('Escape');
    await view.mouse.up();
    await expectOrder([ids[1], ids[2], ids[0]]);
    await expect(view.locator('.card-dragging, .drop-before, .drop-after')).toHaveCount(0);

    await view.close();
    view = await popup(app, sources[2], false);
    await expectOrder([ids[1], ids[2], ids[0]]);
    const invalid = await view.evaluate((tabId) => chrome.runtime.sendMessage({ target: 'worker', type: 'REORDER', tabId, beforeTabId: -1 }), ids[0]);
    expect(invalid.ok).toBe(false);
    await expectOrder([ids[1], ids[2], ids[0]]);
    await view.locator('.remove-button').nth(1).click();
    await expectOrder([ids[1], ids[0]]);
    await view.close();
    const added = await source(app, 3);
    view = await popup(app, added);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(3);
    const addedId = (await state(view)).streams.at(-1).id;
    expect(ids).not.toContain(addedId);
    await expectOrder([ids[1], ids[0], addedId]);
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

test('six captured tabs, live meters, silence, popup/worker lifetime, removal and cleanup', async () => {
  const app = await launch();
  try {
    const sources = [];
    let view;
    for (let i = 0; i < 6; i++) {
      sources.push(await source(app, i));
      view = await popup(app, sources[i]);
      await expect(view.locator('#add')).toBeEnabled();
      if (i === 0) await view.locator('body').screenshot({ path: 'test-results/popup-empty.png' });
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      await expect(view.locator('#error')).toBeHidden();
      await expect.poll(async () => (await state(view)).streams.every((stream) => Math.max(...stream.rms) > -55)).toBe(true);
      if (i === 2) {
        await expect.poll(async () => (await state(view)).streams.every((stream) => Math.abs(stream.pan - stream.targetPan) < 0.01)).toBe(true);
        await view.locator('main').evaluate((element) => { element.scrollTop = 0; });
        await view.locator('body').screenshot({ path: 'test-results/popup-mixing.png' });
        const layout = await view.evaluate(() => ({ bodyHeight: document.body.getBoundingClientRect().height,
          addBottom: document.querySelector('#add').getBoundingClientRect().bottom }));
        expect(layout.bodyHeight).toBeLessThanOrEqual(600);
        expect(layout.addBottom).toBeLessThan(52);
        const cardLayout = await view.locator('.stream-card').evaluateAll((cards) => cards.map((card) => ({
          rect: card.getBoundingClientRect().toJSON(),
          width: card.clientWidth, scrollWidth: card.scrollWidth,
          controlsRight: card.querySelector('.focus-button').getBoundingClientRect().right,
          gainLeft: card.querySelector('.gain-reading').getBoundingClientRect().left,
        })));
        expect(cardLayout[0].rect.y).toBe(cardLayout[1].rect.y);
        expect(cardLayout[1].rect.x).toBeGreaterThan(cardLayout[0].rect.right);
        expect(cardLayout[2].rect.x).toBe(cardLayout[0].rect.x);
        expect(cardLayout[2].rect.y).toBeGreaterThan(cardLayout[0].rect.bottom);
        for (const card of cardLayout) {
          expect(card.rect.width).toBeLessThan(320);
          expect(card.rect.height).toBeLessThanOrEqual(112);
          expect(card.scrollWidth).toBe(card.width);
          expect(card.controlsRight).toBeLessThan(card.gainLeft);
        }
        await view.screenshot({ path: 'test-results/popup-full.png', fullPage: true });
      }
      if (i < 5) await view.close();
    }
    let current = await state(view);
    expect(current.audioState).toBe('running');
    expect(current.streams.map((stream) => stream.targetPan)).toEqual(expect.arrayContaining([-1, 1]));
    expect(current.streams[0].correctionDb).toBeGreaterThan(0);
    expect(current.streams[1].correctionDb).toBeLessThan(0);
    await view.locator('.normalize-button').first().click();
    await expect(view.locator('.normalize-button').first()).toHaveAttribute('aria-pressed', 'false');
    await expectStablePeakLayout(view, sources[0]);
    await view.locator('.normalize-button').first().click();
    await expect(view.locator('.normalize-button').first()).toHaveAttribute('aria-pressed', 'true');
    const ids = current.streams.map((stream) => stream.id);
    const positions = current.streams.map((stream) => stream.targetPan);

    // Pausing every source must not remove or rearrange streams, including past
    // the 30-second offscreen AUDIO_PLAYBACK timeout we deliberately avoid.
    for (const page of sources) await page.locator('#pause').click();
    await expect.poll(async () => (await state(view)).streams.every((stream) => stream.inputDb < -50)).toBe(true);
    const gains = (await state(view)).streams.map((stream) => stream.correctionDb);
    await view.close();
    const session = await app.context.newCDPSession(sources[0]);
    await session.send('ServiceWorker.enable');
    await session.send('ServiceWorker.stopAllWorkers');
    await new Promise((done) => setTimeout(done, 31000));
    view = await popup(app, sources[0], false);
    current = await state(view);
    expect(current.streams.map((stream) => stream.id)).toEqual(ids);
    expect(current.streams.map((stream) => stream.targetPan)).toEqual(positions);
    current.streams.forEach((stream, index) => expect(stream.correctionDb).toBeLessThanOrEqual(gains[index] + 0.01));
    await expect(view.locator('.stream-state').first()).toHaveText(await localized(view, 'silentState'));
    await sources[0].locator('#play').click();
    await expect.poll(async () => (await state(view)).streams[0].inputDb).toBeGreaterThan(-50);

    await sources[5].close();
    await expect(view.locator('.stream-card')).toHaveCount(5);
    await expect(view.locator('#notice')).toBeHidden();
    expect((await state(view)).notices).toEqual([]);
    await expect.poll(async () => app.worker.evaluate(async () =>
      (await chrome.storage.session.get('notices')).notices ?? [])).toEqual([]);
    await view.locator('.remove-button').first().click();
    await expect(view.locator('.stream-card')).toHaveCount(4);
    await expect.poll(async () => {
      const tab = await app.worker.evaluate((id) => chrome.tabs.get(id), ids[0]);
      return tab.audible && !tab.mutedInfo.muted;
    }).toBe(true);
    await view.locator('#stop-all').click();
    await expect(view.locator('.stream-card')).toHaveCount(0);
    await expect.poll(async () => app.worker.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter((tab) => tab.status === 'active').length)).toBe(0);
    await expect.poll(async () => app.worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length)).toBe(0);
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

test('unapproved capture is rejected, while settings survive a browser restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'stream-mixer-test-'));
  let app = await launch(profile);
  try {
    const audio = await source(app);
    const view = await popup(app, audio, false);
    await view.locator('#add').click();
    await expect(view.locator('#error')).toContainText(await localized(view, 'captureError', ['']));
    await expect(view.locator('.stream-card')).toHaveCount(0);
    await view.locator('.settings-section > summary').click();
    await view.locator('#volume').fill('47');
    await view.locator('#strength').fill('62');
    await view.locator('#spread').fill('25');
    await view.locator('#spread').press('Tab');
    await expect.poll(async () => (await state(view)).settings).toEqual({ volume: 0.47, strength: 0.62, spread: 0.25 });
    await app.context.close();
    app = await launch(profile);
    const reopened = await popup(app);
    await expect(reopened.locator('#volume')).toHaveValue('47');
    await expect(reopened.locator('#strength')).toHaveValue('62');
    await expect(reopened.locator('#spread')).toHaveValue('25');
    expect((await state(reopened)).streams).toEqual([]);
    await expect(reopened.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); await rm(profile, { recursive: true, force: true }); }
});
