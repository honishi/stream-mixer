import { test, expect, launch, source, popup, addTestVideo, previewColor } from './helpers/browser.js';

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
