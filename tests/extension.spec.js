import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

let server;
let baseUrl;
const extensionPath = resolve('extension');

test.beforeAll(async () => {
  const fixture = await readFile('tests/fixtures/audio.html');
  server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await mkdir('test-results', { recursive: true });
});

test.afterAll(() => new Promise((done) => server.close(done)));

async function launch(profile = '', directory = extensionPath) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 900, height: 700 },
    // Unlike --mute-audio, fake hardware output preserves the tab's audible signal.
    // Capture, Web Audio and permission checks are real; no sound reaches speakers.
    ignoreDefaultArgs: ['--mute-audio'],
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`,
      '--disable-audio-output', '--enable-unsafe-extension-debugging'],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = worker.url().split('/')[2];
  const browserCdp = await context.browser().newBrowserCDPSession();
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  return { context, worker, id, browserCdp, errors };
}

async function source(app, index = 0, mode = 'tone') {
  const page = await app.context.newPage();
  const titles = ['深夜ラジオ / 夜の雑談', 'ゲーム実況 — 配信テスト', '作業用 BGM / Live session'];
  await page.goto(`${baseUrl}/?title=${encodeURIComponent(titles[index % titles.length])}&frequency=${220 + index * 110}&amplitude=${mode === 'tone' && index % 2 === 0 ? 0.035 : 0.2}&index=${index}&mode=${mode}`);
  await page.locator('#play').click();
  await expect.poll(async () => app.worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.audible;
  }, page.url())).toBe(true);
  return page;
}

async function popup(app, activeSource, grant = true) {
  if (activeSource && grant) {
    await activeSource.bringToFront();
    const { targetInfos } = await app.browserCdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const target = targetInfos.find((item) => item.url === activeSource.url());
    // Equivalent to the toolbar action: exercise the real activeTab grant.
    await app.browserCdp.send('Extensions.triggerAction', { id: app.id, targetId: target.targetId });
  }
  // Render the actual popup document in a background tab for Playwright access.
  // Browser toolbar popups are CDP "other" targets, not Playwright Pages.
  const page = await app.context.newPage();
  if (activeSource) await activeSource.bringToFront();
  await page.goto(`chrome-extension://${app.id}/popup.html`);
  await expect(page.locator('#count')).toHaveText(/^\d+ STREAMS?$/);
  return page;
}

async function localized(page, key, substitutions = []) {
  return page.evaluate(({ key, substitutions }) => chrome.i18n.getMessage(key, substitutions), { key, substitutions });
}

async function state(popupPage) {
  const result = await popupPage.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'STATE' }));
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

async function addTestVideo(page, { color, width = 320, height = 180, nested = false, paused = false }) {
  await page.evaluate(async ({ color, width, height, nested, paused }) => {
    let root = document.body;
    if (nested) {
      const frame = document.createElement('iframe');
      frame.srcdoc = '<!doctype html><body></body>';
      const loaded = new Promise((resolve) => { frame.onload = resolve; });
      document.body.append(frame);
      await loaded;
      const host = frame.contentDocument.createElement('div');
      frame.contentDocument.body.append(host);
      root = host.attachShadow({ mode: 'open' });
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const video = document.createElement('video');
    video.width = width;
    video.height = height;
    video.muted = true;
    video.srcObject = canvas.captureStream(5);
    root.append(video);
    const fixture = { video, color };
    (window.testVideos ??= []).push(fixture);
    function paint() {
      context.fillStyle = fixture.color;
      context.fillRect(0, 0, width, height);
    }
    paint();
    fixture.timer = setInterval(paint, 100);
    await video.play();
    if (paused) video.pause();
  }, { color, width, height, nested, paused });
}

async function previewColor(preview) {
  return preview.evaluate((image) => {
    if (!image.complete || !image.naturalWidth) return [];
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => Math.round(value / 255));
  });
}

test('video previews refresh per tab, prefer playback, and disappear when video is unavailable', async () => {
  const app = await launch();
  try {
    const first = await source(app);
    await addTestVideo(first, { color: '#0000ff', paused: true });
    await addTestVideo(first, { color: '#ff0000', width: 160, height: 90, nested: true });
    const ungranted = await popup(app, first, false);
    const inaccessible = await ungranted.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      const { getVideoSnapshots } = await import(chrome.runtime.getURL('video-snapshot.js'));
      return getVideoSnapshots([{ id: tab.id }]);
    }, first.url());
    expect(inaccessible[0].image).toBeNull();
    await ungranted.close();
    let view = await popup(app, first);
    await view.locator('#add').click();
    const preview = view.locator('.stream-preview').first();
    await expect.poll(() => previewColor(preview)).toEqual([1, 0, 0]);
    expect(await preview.evaluate((image) => image.naturalWidth)).toBeLessThanOrEqual(240);
    await first.evaluate(() => { window.testVideos[1].color = '#00ff00'; });
    await expect.poll(() => previewColor(preview)).toEqual([0, 1, 0]);
    await view.close();

    const second = await source(app, 1);
    view = await popup(app, second);
    await view.locator('#add').click();
    await expect(view.locator('.stream-preview').nth(1)).toBeHidden();
    const heightWithoutPreview = await view.locator('.stream-card').nth(1).evaluate((card) => card.getBoundingClientRect().height);
    await addTestVideo(second, { color: '#0000ff' });
    await expect.poll(() => previewColor(view.locator('.stream-preview').nth(1))).toEqual([0, 0, 1]);
    const heightWithPreview = await view.locator('.stream-card').nth(1).evaluate((card) => card.getBoundingClientRect().height);
    expect(heightWithPreview).toBe(heightWithoutPreview);
    const previewSize = await view.locator('.stream-preview').nth(1).boundingBox();
    expect(previewSize.width).toBeLessThanOrEqual(54);
    expect(previewSize.height).toBeLessThanOrEqual(30);
    await expect.poll(() => previewColor(view.locator('.stream-preview').first())).toEqual([0, 1, 0]);
    await expect.poll(async () => (await state(view)).streams.every((stream) => Math.max(...stream.rms) > -55)).toBe(true);
    expect(await view.evaluate(() => document.body.scrollWidth)).toBe(680);
    await view.locator('body').screenshot({ path: 'test-results/popup-video.png' });

    await first.evaluate(() => {
      for (const fixture of window.testVideos) {
        fixture.video.remove();
        fixture.video.srcObject.getTracks().forEach((track) => track.stop());
        clearInterval(fixture.timer);
      }
    });
    await expect(view.locator('.stream-preview').first()).toBeHidden();
    await expect(view.locator('.stream-preview').first()).not.toHaveAttribute('src');
    await expect(view.locator('#error')).toBeHidden();

    // No background capture loop: once the popup closes, injection stops.
    await app.worker.evaluate(() => {
      const execute = chrome.scripting.executeScript.bind(chrome.scripting);
      globalThis.previewCalls = 0;
      chrome.scripting.executeScript = (...args) => { globalThis.previewCalls++; return execute(...args); };
    });
    await view.close();
    // triggerAction can also leave a native toolbar popup; close its document.
    const { targetInfos } = await app.browserCdp.send('Target.getTargets');
    for (const target of targetInfos.filter((target) => target.url === `chrome-extension://${app.id}/popup.html`)) {
      await app.browserCdp.send('Target.closeTarget', { targetId: target.targetId });
    }
    const before = await app.worker.evaluate(() => globalThis.previewCalls);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(await app.worker.evaluate(() => globalThis.previewCalls)).toBe(before);
    view = await popup(app, second, false);
    await expect.poll(() => previewColor(view.locator('.stream-preview').nth(1))).toEqual([0, 0, 1]);
    await view.locator('.remove-button').nth(1).click();
    await expect(view.locator('.stream-card')).toHaveCount(1);
    const snapshots = await view.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'VIDEO_SNAPSHOTS' }));
    expect(snapshots.data).toEqual([{ id: (await state(view)).streams[0].id, image: null }]);
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

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
          controlsRight: card.querySelector('.solo-button').getBoundingClientRect().right,
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
    await view.mouse.down();
    await view.mouse.move(field.x + field.width * (0.5 + 0.44 * 0.9), dot.y + dot.height / 2, { steps: 8 });
    // Polling must not snap the actively dragged marker back or modify audio.
    await view.waitForTimeout(250);
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
      window.dropPositions = [];
      const until = performance.now() + 650;
      const sample = () => {
        window.dropPositions.push(document.querySelector('.position-dot').getBoundingClientRect().x);
        if (performance.now() < until) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
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
    await expectSolo(ids[1]);
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
    expect(blocked).toEqual({ ok: false, error: await localized(view, 'resumeBeforeNormalize') });
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

test('per-tab NR suppresses noise, preserves a voiced signal, and survives solo and bypass', async () => {
  const app = await launch();
  try {
    const sources = [];
    let view;
    for (let i = 0; i < 2; i++) {
      sources.push(await source(app, i, i === 0 ? 'noise' : 'speech-like'));
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      if (i === 0) await view.close();
    }
    await view.locator('.settings-section > summary').click();
    await view.locator('#strength').fill('0');
    await view.locator('#spread').fill('0');
    await view.locator('#spread').press('Tab');
    await expect.poll(async () => (await state(view)).settings.strength).toBe(0);
    await view.locator('.settings-section > summary').click();
    await expect.poll(async () => (await state(view)).streams[0].correctionDb).toBeLessThan(0.1);
    await expect.poll(async () => (await state(view)).streams[0].rms[0]).toBeGreaterThan(-45);
    const raw = (await state(view)).streams[0].rms[0];
    await expect(view.locator('.nr-button[aria-pressed=true]')).toHaveCount(0);
    await expect(view.locator('.nr-level').first()).toHaveValue('medium');
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('#error')).toBeHidden();
    // Medium and Low retain original audio even when the model removes it.
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeLessThan(raw - 3);
    expect(Math.max(...(await state(view)).streams[0].rms)).toBeGreaterThan(raw - 9);
    await view.locator('.nr-level').first().selectOption('low');
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeGreaterThan(raw - 4);
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeLessThan(raw - 1);
    expect((await state(view)).streams[1].noiseReductionLevel).toBe('medium');
    const invalidLevel = await view.evaluate(async () => {
      const { data } = await chrome.runtime.sendMessage({ target: 'worker', type: 'STATE' });
      return chrome.runtime.sendMessage({ target: 'worker', type: 'NR_LEVEL', tabId: data.streams[0].id, level: '__proto__' });
    });
    expect(invalidLevel).toEqual({ ok: false, error: await localized(view, 'invalidNrLevel') });
    await view.locator('.nr-level').first().selectOption('high');
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms), { timeout: 10000 }).toBeLessThan(raw - 12);
    expect((await state(view)).streams[1].noiseReductionEnabled).toBe(false);

    await view.locator('.nr-level').nth(1).selectOption('high');
    await view.locator('.nr-button').nth(1).click();
    await expect(view.locator('.nr-button').nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => {
      const [left, right] = (await state(view)).streams[1].rms;
      return left > -45 && left - right > 8;
    }, { timeout: 10000 }).toBe(true);
    await view.locator('main').evaluate((element) => { element.scrollTop = 0; });
    await view.locator('body').screenshot({ path: 'test-results/popup-noise-reduction.png' });
    await view.locator('.solo-button').nth(1).click();
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeLessThan(-60);
    await view.locator('.solo-button').nth(1).click();
    await view.locator('#bypass').click();
    await expect(view.locator('#bypass')).toHaveText(await localized(view, 'resumeMix'));
    await expect(view.locator('.nr-button').first()).toBeDisabled();
    await expect(view.locator('.nr-level').first()).toBeDisabled();
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeGreaterThan(raw - 2);
    expect((await state(view)).streams.every((stream) => stream.noiseReductionEnabled)).toBe(true);
    await view.close();
    view = await popup(app, sources[0], false);
    await expect(view.locator('.nr-button[aria-pressed=true]')).toHaveCount(2);
    await expect(view.locator('.nr-level').first()).toHaveValue('high');
    await expect(view.locator('.nr-level').nth(1)).toHaveValue('high');
    await view.locator('#bypass').click();
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms), { timeout: 10000 }).toBeLessThan(raw - 12);
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'false');
    await expect(view.locator('.nr-level').first()).toHaveValue('high');
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeGreaterThan(raw - 2);
    // Recreate the channel states after disposal, rather than leaving a dead node.
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms), { timeout: 10000 }).toBeLessThan(raw - 12);
    // Exercise the full six-tab scope with separate left/right RNNoise states.
    for (let i = 2; i < 6; i++) {
      await view.close();
      sources.push(await source(app, i, 'speech-like'));
      view = await popup(app, sources[i]);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(i + 1);
      await view.locator('.nr-button').nth(i).click();
      await expect(view.locator('.nr-button').nth(i)).toHaveAttribute('aria-pressed', 'true');
    }
    await expect.poll(async () => (await state(view)).streams.slice(1).every((stream) => stream.rms[0] > -45)).toBe(true);
    await expect(view.locator('.nr-button[aria-pressed=true]')).toHaveCount(6);
    await view.locator('#stop-all').click();
    await expect(view.locator('.stream-card')).toHaveCount(0);
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

test('NR asset failure leaves the original audio playing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-mixer-broken-nr-'));
  let app;
  try {
    await cp(extensionPath, directory, { recursive: true });
    await rm(join(directory, 'vendor/rnnoise/rnnoise.wasm'));
    await rm(join(directory, 'vendor/rnnoise/rnnoise_simd.wasm'));
    app = await launch('', directory);
    const audio = await source(app);
    const view = await popup(app, audio);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await view.locator('.nr-button').click();
    await expect(view.locator('#error')).toBeVisible();
    await expect(view.locator('.nr-button')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeGreaterThan(-50);
    expect((await state(view)).streams[0].noiseReductionEnabled).toBe(false);
    expect(app.errors).toEqual([]);
  } finally { await app?.context.close(); await rm(directory, { recursive: true, force: true }); }
});

test('NR processing failure restores the original audio without releasing capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-mixer-failing-nr-'));
  let app;
  try {
    await cp(extensionPath, directory, { recursive: true });
    const processorPath = join(directory, 'audio/noise-processor.js');
    const processor = await readFile(processorPath, 'utf8');
    // Inject a DSP fault after startup while retaining the real WASM graph.
    await writeFile(processorPath, processor.replace('if (this.frames) this.frames.process',
      "if (this.frames && (this.testFrames = (this.testFrames ?? 0) + 1) > 750) throw new Error('Injected NR failure');\n      if (this.frames) this.frames.process"));
    app = await launch('', directory);
    const audio = await source(app, 0, 'speech-like');
    const view = await popup(app, audio);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await view.locator('.nr-button').click();
    await expect(view.locator('.nr-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('#notice')).toContainText(await localized(view, 'nrRecovered', ['', '']));
    await expect(view.locator('.nr-button')).toHaveAttribute('aria-pressed', 'false');
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeGreaterThan(-50);
    expect(app.errors).toEqual([]);
  } finally { await app?.context.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const locale of ['en', 'ja']) {
  test(`localized popup and engine use the ${locale} catalog through native i18n`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `stream-mixer-${locale}-`));
    let app;
    try {
      // macOS headless Chrome ignores --lang. Exercise its real i18n fallback
      // using a copy with one catalog; leave the OS and installed extension alone.
      await cp(extensionPath, directory, { recursive: true });
      const manifestPath = join(directory, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.default_locale = locale;
      await writeFile(manifestPath, JSON.stringify(manifest));
      await rm(join(directory, '_locales', locale === 'en' ? 'ja' : 'en'), { recursive: true });
      app = await launch('', directory);
      const audio = await source(app, 0, 'speech-like');
      const title = '<b>Radio</b> $1';
      await audio.evaluate((title) => { document.title = title; }, title);
      let view = await popup(app, audio, false);
      await expect(view.locator('html')).toHaveAttribute('lang', locale);
      await expect(view.locator('#add-label')).toHaveText(locale === 'ja' ? 'このタブを追加' : 'Add this tab');
      await expect(view.locator('.settings-summary')).toHaveText(await localized(view, 'settingsSummary'));
      const metadata = await app.worker.evaluate(() => chrome.runtime.getManifest());
      expect(metadata.description).toBe(await localized(view, 'extensionDescription'));
      await view.locator('#add').click();
      await expect(view.locator('#error')).toContainText(await localized(view, 'captureError', ['']));
      await view.close();
      view = await popup(app, audio);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(1);
      await expect(view.locator('#add-label')).toHaveText(locale === 'ja' ? '追加済み' : 'Added');
      await expect(view.locator('#count')).toHaveText('1 STREAM');
      await expect(view.locator('h3')).toHaveText(title);
      await expect(view.locator('.normalize-button')).toHaveAttribute('aria-pressed', 'true');
      await expect(view.locator('.normalize-button')).toHaveAttribute('aria-label', await localized(view, 'normalizeDisable', [title]));
      await view.locator('.normalize-button').click();
      await expect(view.locator('.normalize-button')).toHaveAttribute('aria-label', await localized(view, 'normalizeEnable', [title]));
      expect(await view.locator('h3 b').count()).toBe(0);
      await expect(view.locator('.solo-button')).toHaveAttribute('aria-label', await localized(view, 'soloEnable', [title]));
      await view.locator('.nr-button').click();
      await expect(view.locator('.nr-button')).toHaveAttribute('aria-pressed', 'true');
      await expect(view.locator('.nr-button')).toHaveAttribute('aria-label', await localized(view, 'nrDisable', [title]));
      await expect(view.locator('.nr-button')).not.toHaveAttribute('aria-busy');
      for (const selector of ['.nr-button', '.solo-button', '.normalize-button', '.remove-button']) {
        const button = view.locator(selector);
        await expect(button.locator('svg')).toBeVisible();
        await expect(button).toHaveText('');
        await expect(button).toHaveAttribute('aria-label', /.+/);
        await expect(button).toHaveAttribute('title', /.+/);
      }
      await expect(view.locator('.nr-level option:checked')).toHaveText(locale === 'ja' ? '中' : 'Medium');
      await view.locator('.nr-level').selectOption('low');
      await expect(view.locator('.nr-level option:checked')).toHaveText(locale === 'ja' ? '小' : 'Low');
      await expect(view.locator('.nr-level')).toHaveAttribute('aria-label', await localized(view, 'nrStrengthLabel', [title]));
      await view.locator('.solo-button').click();
      await expect(view.locator('#mix-heading')).toHaveText(locale === 'ja' ? 'ソロ再生中' : 'Solo playback');
      await view.locator('.position-dot').focus();
      await view.keyboard.press('End');
      await expect(view.locator('#reset-pans')).toBeVisible();
      // Exercise translated validation in the offscreen engine as well as worker errors.
      const invalidPan = await view.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'PAN_PREFERENCE', tabId: -1, pan: 0 }));
      expect(invalidPan).toEqual({ ok: false, error: await localized(view, 'tabReleased') });
      await view.locator('.settings-section > summary').click();
      await view.locator('main').evaluate((main) => { main.scrollTop = 0; });
      const layout = await view.evaluate(() => ({
        height: document.body.getBoundingClientRect().height,
        width: document.body.clientWidth, scrollWidth: document.body.scrollWidth,
        mainWidth: document.querySelector('main').clientWidth, mainScrollWidth: document.querySelector('main').scrollWidth,
        addRight: document.querySelector('#add').getBoundingClientRect().right,
      }));
      expect(layout.height).toBeLessThanOrEqual(600);
      expect(layout.scrollWidth).toBe(layout.width);
      expect(layout.mainScrollWidth).toBe(layout.mainWidth);
      expect(layout.addRight).toBeLessThanOrEqual(680);
      await view.locator('body').screenshot({ path: `test-results/popup-i18n-${locale}.png` });
      await view.locator('#bypass').click();
      await expect(view.locator('#mix-heading')).toHaveText(locale === 'ja' ? 'バイパス中' : 'Bypassed');
      await expect(view.locator('#bypass')).toHaveText(await localized(view, 'resumeMix'));
      await expect(view.locator('.nr-button')).toHaveAttribute('title', await localized(view, 'nrBypassed'));
      await view.close();
      view = await popup(app, audio, false);
      await expect(view.locator('html')).toHaveAttribute('lang', locale);
      await expect(view.locator('#bypass')).toHaveText(await localized(view, 'resumeMix'));
      await view.locator('#stop-all').click();
      await expect(view.locator('#mix-heading')).toHaveText(locale === 'ja' ? '待機中' : 'Standby');
      expect(app.errors).toEqual([]);
    } finally { await app?.context.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('the bundled RNNoise model aligns with the dry signal at 960 samples', async () => {
  const app = await launch();
  try {
    const view = await popup(app);
    const measured = await view.evaluate(async () => {
      const { Rnnoise } = await import('./vendor/rnnoise/runtime.js');
      const { NoiseFrames } = await import('./audio/noise-frames.js');
      const binary = await (await fetch('./vendor/rnnoise/rnnoise.wasm')).arrayBuffer();
      const runtime = await Rnnoise.loadBinary(binary);
      const adapter = new NoiseFrames([runtime.createDenoiseState()], 480, 1);
      let seed = 123456;
      const original = Float32Array.from({ length: 24576 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        return ((seed >>> 0) / 2147483648 - 1) * 0.0175;
      });
      const processed = new Float32Array(original.length);
      for (let offset = 0; offset < original.length; offset += 128) {
        adapter.process([original.subarray(offset, offset + 128)], [processed.subarray(offset, offset + 128)]);
      }
      adapter.destroy();
      let bestLag = 0;
      let bestCorrelation = -Infinity;
      // Broadband input makes a misaligned dry path show a distinct correlation peak.
      for (let lag = 0; lag <= 1440; lag++) {
        let correlation = 0;
        for (let i = 3000; i < original.length; i++) correlation += processed[i] * original[i - lag];
        if (correlation > bestCorrelation) { bestLag = lag; bestCorrelation = correlation; }
      }
      return { bestLag, bestCorrelation };
    });
    expect(measured.bestLag).toBe(960);
    expect(measured.bestCorrelation).toBeGreaterThan(0);
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});
