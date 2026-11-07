import { test, expect, extensionPath, launch, source, popup, localized, state, injectFault } from './helpers/browser.js';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    expect(invalidLevel).toEqual({ ok: false, error: 'Invalid noise reduction strength.' });
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

for (const releaseAll of [false, true]) {
  test(`NR failure notices clear after ${releaseAll ? 'full' : 'individual'} release`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stream-mixer-failing-nr-'));
    let app;
    try {
      await cp(extensionPath, directory, { recursive: true });
      const processorPath = join(directory, 'audio/noise-processor.js');
      // Inject a DSP fault after startup while retaining the real WASM graph.
      await injectFault(processorPath, 'if (this.frames) this.frames.process',
        "if (this.frames && (this.testFrames = (this.testFrames ?? 0) + 1) > 750) throw new Error('Injected NR failure');\n      if (this.frames) this.frames.process");
      app = await launch('', directory);
      const other = await source(app, 1);
      let view = await popup(app, other);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(1);
      await view.close();
      const audio = await source(app, 0, 'speech-like');
      view = await popup(app, audio);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(2);
      await view.locator('.nr-button').last().click();
      await expect(view.locator('.nr-button').last()).toHaveAttribute('aria-pressed', 'true');
      await expect(view.locator('#notice')).toContainText('Noise reduction was disabled so playback can continue.');
      await expect(view.locator('#notice')).toContainText('Injected NR failure');
      await expect(view.locator('.nr-button').last()).toHaveAttribute('aria-pressed', 'false');
      await expect(view.locator('.stream-card')).toHaveCount(2);
      await expect.poll(async () => Math.max(...(await state(view)).streams[1].rms)).toBeGreaterThan(-50);
      await expect.poll(async () => app.worker.evaluate(async () =>
        (await chrome.storage.session.get('notices')).notices?.length ?? 0)).toBe(1);
      if (releaseAll) await view.locator('#stop-all').click();
      else await view.locator('.remove-button').last().click();
      await expect(view.locator('.stream-card')).toHaveCount(releaseAll ? 0 : 1);
      await expect(view.locator('#notice')).toBeHidden();
      expect((await state(view)).notices).toEqual([]);
      await view.close();
      view = await popup(app, other, false);
      await expect(view.locator('#notice')).toBeHidden();
      expect((await state(view)).notices).toEqual([]);
      expect(await app.worker.evaluate(async () =>
        (await chrome.storage.session.get('notices')).notices ?? [])).toEqual([]);
      expect(app.errors).toEqual([]);
    } finally { await app?.context.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('unexpected audio failure stays visible until its tab closes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stream-mixer-capture-failure-'));
  let app;
  try {
    await cp(extensionPath, directory, { recursive: true });
    const processorPath = join(directory, 'audio/processors.js');
    await injectFault(processorPath, 'this.dsp.process(inputs[0]',
      "if ((this.testBlocks = (this.testBlocks ?? 0) + 1) > 750) throw new Error('Injected audio failure');\n    this.dsp.process(inputs[0]");
    app = await launch('', directory);
    const audio = await source(app);
    let view = await popup(app, audio);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await expect(view.locator('#notice')).toContainText('Audio processing stopped.');
    await expect(view.locator('.stream-card')).toHaveCount(0);
    await expect.poll(async () => app.worker.evaluate(async () =>
      (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length)).toBe(0);
    await view.close();
    view = await popup(app, audio, false);
    await expect(view.locator('#notice')).toContainText('Audio processing stopped.');
    await audio.close();
    await expect(view.locator('#notice')).toBeHidden();
    await expect.poll(async () => app.worker.evaluate(async () =>
      (await chrome.storage.session.get('notices')).notices ?? [])).toEqual([]);
    expect((await state(view)).notices).toEqual([]);
  } finally { await app?.context.close(); await rm(directory, { recursive: true, force: true }); }
});

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
