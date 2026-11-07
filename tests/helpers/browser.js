import { test as base, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

let baseUrl;
const extensionPath = resolve('extension');

const test = base.extend({
  audioServer: [async ({}, use) => {
    const fixture = await readFile(new URL('../fixtures/audio.html', import.meta.url));
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(fixture);
    });
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    try {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      await mkdir('test-results', { recursive: true });
      await use(baseUrl);
    } finally {
      await new Promise((done) => server.close(done));
    }
  }, { scope: 'worker', auto: true }],
});

async function launch(profile = '', directory = extensionPath) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 900, height: 700 },
    // Unlike --mute-audio, fake hardware output preserves the tab's audible signal.
    // Capture, Web Audio and permission checks are real; no sound reaches speakers.
    ignoreDefaultArgs: ['--mute-audio'],
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`,
      '--disable-audio-output', '--enable-unsafe-extension-debugging'],
  });
  try {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2];
    const browserCdp = await context.browser().newBrowserCDPSession();
    const errors = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    return { context, worker, id, browserCdp, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function source(app, index = 0, mode = 'tone', frequency = 220 + index * 110) {
  const page = await app.context.newPage();
  const titles = ['深夜ラジオ / 夜の雑談', 'ゲーム実況 — 配信テスト', '作業用 BGM / Live session'];
  await page.goto(`${baseUrl}/?title=${encodeURIComponent(titles[index % titles.length])}&frequency=${frequency}&amplitude=${mode === 'tone' && index % 2 === 0 ? 0.035 : 0.2}&index=${index}&mode=${mode}`);
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
  // Keep the source active until init captures its tab ID, then show the popup.
  // Background tabs throttle animation frames on Linux, unlike a visible popup.
  await page.bringToFront();
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

async function expectStablePeakLayout(view, audio) {
  const label = view.locator('.limiter-label').first();
  await expect(label).toHaveText('');
  const geometry = () => view.evaluate(() => ({
    cards: [...document.querySelectorAll('.stream-card')].map((card) => card.getBoundingClientRect().toJSON()),
    bodyHeight: document.body.getBoundingClientRect().height,
    scrollHeight: document.querySelector('main').scrollHeight,
    scrollWidth: document.querySelector('main').scrollWidth,
  }));
  const before = await geometry();
  const originalGain = await audio.evaluate(() => {
    const previous = gain.gain.value;
    gain.gain.value = 8;
    return previous;
  });
  try {
    await expect(label).not.toHaveText('');
    expect(await geometry()).toEqual(before);
    expect(await label.evaluate((element) => element.title === element.textContent)).toBe(true);
    const locale = await view.locator('html').getAttribute('lang');
    await view.locator('body').screenshot({ path: `test-results/popup-peak-${locale}.png` });
  } finally {
    await audio.evaluate((value) => { gain.gain.value = value; }, originalGain);
  }
  await expect(label).toHaveText('');
  expect(await geometry()).toEqual(before);
}


export { test, expect, extensionPath, launch, source, popup, localized, state, addTestVideo, previewColor, expectStablePeakLayout };

// Fault injection must fail loudly if a refactor removes or duplicates its anchor.
export async function injectFault(path, anchor, replacement) {
  const source = await readFile(path, 'utf8');
  expect(source.split(anchor), `Expected exactly one fault injection anchor in ${path}`).toHaveLength(2);
  await writeFile(path, source.replace(anchor, () => replacement));
}
