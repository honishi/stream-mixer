import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
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

async function launch(profile = '') {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 900, height: 700 },
    // Unlike --mute-audio, fake hardware output preserves the tab's audible signal.
    // Capture, Web Audio and permission checks are real; no sound reaches speakers.
    ignoreDefaultArgs: ['--mute-audio'],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
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

async function source(app, index = 0) {
  const page = await app.context.newPage();
  const titles = ['深夜ラジオ / 夜の雑談', 'ゲーム実況 — 配信テスト', '作業用 BGM / Live session'];
  await page.goto(`${baseUrl}/?title=${encodeURIComponent(titles[index % titles.length])}&frequency=${220 + index * 110}&amplitude=${index % 2 ? 0.2 : 0.035}&index=${index}`);
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
        expect(layout.addBottom).toBeLessThan(570);
        await view.screenshot({ path: 'test-results/popup-full.png', fullPage: true });
      }
      if (i < 5) await view.close();
    }
    let current = await state(view);
    expect(current.audioState).toBe('running');
    expect(current.streams.map((stream) => stream.targetPan)).toEqual(expect.arrayContaining([-0.5525, 0.5525]));
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
