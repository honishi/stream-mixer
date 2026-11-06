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
  await expect(page.locator('#add-help')).not.toHaveText('タブを確認しています…');
  return page;
}

async function state(popupPage) {
  const result = await popupPage.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'STATE' }));
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

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
    await expect(view.locator('.stream-state').first()).toHaveText('○ 無音・一時停止');
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
    await expect(view.locator('#error')).toContainText('追加できませんでした');
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
    await expect(view.locator('#bypass')).toHaveText('ミックスを再開');
    await expect(view.locator('#mix-heading')).toHaveText('バイパス中');
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
    await expect(view.locator('#bypass')).toHaveText('ミックスを再開');
    await view.locator('body').screenshot({ path: 'test-results/popup-bypassed.png' });
    await view.locator('#bypass').click();
    await expect(view.locator('#mix-heading')).toHaveText('ミックス中');
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
    await expect(view.locator('#bypass')).toHaveText('ミックスを再開');
    await view.locator('#stop-all').click();
    await expect(view.locator('.stream-card')).toHaveCount(0);
    await expect(view.locator('#bypass')).toBeDisabled();
    await expect(view.locator('#mix-heading')).toHaveText('待機中');
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
    await expect(view.locator('#mix-heading')).toHaveText('ソロ再生中');
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
    await expect(view.locator('#bypass')).toHaveText('ミックスを再開');
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
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(view.locator('#error')).toBeHidden();
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms), { timeout: 10000 }).toBeLessThan(raw - 12);
    expect((await state(view)).streams[1].noiseReductionEnabled).toBe(false);

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
    await expect(view.locator('#bypass')).toHaveText('ミックスを再開');
    await expect(view.locator('.nr-button').first()).toBeDisabled();
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeGreaterThan(raw - 2);
    expect((await state(view)).streams.every((stream) => stream.noiseReductionEnabled)).toBe(true);
    await view.close();
    view = await popup(app, sources[0], false);
    await expect(view.locator('.nr-button[aria-pressed=true]')).toHaveCount(2);
    await view.locator('#bypass').click();
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms), { timeout: 10000 }).toBeLessThan(raw - 12);
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'false');
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
    await expect(view.locator('#notice')).toContainText('ノイズ抑制を解除して再生を継続');
    await expect(view.locator('.nr-button')).toHaveAttribute('aria-pressed', 'false');
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await expect.poll(async () => Math.max(...(await state(view)).streams[0].rms)).toBeGreaterThan(-50);
    expect(app.errors).toEqual([]);
  } finally { await app?.context.close(); await rm(directory, { recursive: true, force: true }); }
});
