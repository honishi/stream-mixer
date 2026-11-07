import { test, expect, extensionPath, launch, source, popup, localized, state, addTestVideo, expectStablePeakLayout } from './helpers/browser.js';
import { readFile, writeFile, mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('system theme changes update the open popup without changing the mix or layout', async () => {
  const app = await launch();
  try {
    let view;
    for (let index = 0; index < 6; index++) {
      const audio = await source(app, index);
      if (index === 0) await addTestVideo(audio, { color: '#426b22' });
      view = await popup(app, audio);
      await view.locator('#add').click();
      await expect(view.locator('.stream-card')).toHaveCount(index + 1);
      if (index < 5) await view.close();
    }
    await view.locator('.trim-level').first().selectOption('-15');
    await view.locator('.focus-button').first().click();
    await view.locator('.nr-button').first().click();
    await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'true');
    const before = await state(view);
    const card = view.locator('.stream-card').first();
    const size = await card.evaluate((element) => [element.offsetWidth, element.offsetHeight]);

    for (const colorScheme of ['dark', 'light', 'dark']) {
      await view.emulateMedia({ colorScheme });
      await expect(view.locator('html')).toHaveCSS('color-scheme', colorScheme);
      await expect(view.locator('body')).toHaveCSS('background-color', colorScheme === 'dark' ? 'rgb(20, 23, 20)' : 'rgb(245, 247, 241)');
      // Check actual rendered foreground/background pairs, including all six stream colors.
      const contrasts = await view.evaluate(() => {
        const context = document.createElement('canvas').getContext('2d');
        const luminance = (color) => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const selectors = ['body', '#add-help', '.position-dot', '.normalize-button', '.trim-level', '#notice', '#error'];
        return selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => {
          const style = getComputedStyle(element);
          const background = element.id === 'add-help' ? getComputedStyle(document.body).backgroundColor : style.backgroundColor;
          const foregroundLuminance = luminance(style.color);
          const backgroundLuminance = luminance(background);
          return { selector, ratio: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05) };
        }));
      });
      for (const { selector, ratio } of contrasts) expect(ratio, `${colorScheme}: ${selector}`).toBeGreaterThanOrEqual(4.5);
      expect(await card.evaluate((element) => [element.offsetWidth, element.offsetHeight])).toEqual(size);
      await expect(view.locator('.trim-level').first()).toHaveValue('-15');
      await expect(view.locator('.focus-button').first()).toHaveAttribute('aria-pressed', 'true');
      await expect(view.locator('.nr-button').first()).toHaveAttribute('aria-pressed', 'true');
      const after = await state(view);
      expect(after.streams.map((stream) => stream.id)).toEqual(before.streams.map((stream) => stream.id));
      expect(after.settings).toEqual(before.settings);
      expect(after.selectedFocusTabIds).toEqual(before.selectedFocusTabIds);
      expect(after.audioState).toBe('running');
      await view.locator('main').evaluate((element) => { element.scrollTop = 0; });
      await view.locator('body').screenshot({ path: `test-results/popup-theme-${colorScheme}.png` });
    }
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

test('polling errors clear after recovery without hiding action errors', async () => {
  const app = await launch();
  try {
    const audio = await source(app);
    const view = await popup(app, audio);
    await view.locator('#add').click();
    await expect(view.locator('.stream-card')).toHaveCount(1);
    await view.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.failPolling = true;
      window.failedPolls = 0;
      window.successfulPolls = 0;
      chrome.runtime.sendMessage = async (message, ...args) => {
        if (message.type === 'STATE' && window.failPolling) {
          window.failedPolls++;
          throw new Error('Injected polling failure');
        }
        if (message.type === 'TOGGLE_SOLO') throw new Error('Injected action failure');
        const result = await send(message, ...args);
        if (message.type === 'STATE' && result.ok) window.successfulPolls++;
        return result;
      };
    });
    await expect(view.locator('#error')).toHaveText('Injected polling failure');
    await view.evaluate(() => { window.failPolling = false; });
    await expect(view.locator('#error')).toBeHidden();
    await view.locator('.solo-button').click();
    await expect(view.locator('#error')).toHaveText('Injected action failure');
    const previousPolls = await view.evaluate(() => window.successfulPolls);
    await expect.poll(() => view.evaluate(() => window.successfulPolls)).toBeGreaterThan(previousPolls + 1);
    await expect(view.locator('#error')).toHaveText('Injected action failure');
    await view.evaluate(() => { window.failPolling = true; window.failedPolls = 0; });
    // Even a later polling failure must not replace the failed action's details.
    await expect.poll(() => view.evaluate(() => window.failedPolls)).toBeGreaterThan(0);
    await expect(view.locator('#error')).toHaveText('Injected action failure');
    await audio.evaluate(() => { document.title = 'Polling recovered'; });
    await view.evaluate(() => { window.failPolling = false; });
    await expect(view.locator('h3')).toHaveText('Polling recovered');
    await expect(view.locator('#error')).toHaveText('Injected action failure');
    await view.locator('#bypass').click();
    await expect(view.locator('#error')).toBeHidden();
    expect(app.errors).toEqual([]);
  } finally { await app.context.close(); }
});

for (const locale of ['en', 'ja']) {
  test(`localized popup uses the ${locale} catalog while audio diagnostics stay in English`, async () => {
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
      await expect(view.locator('.mute-button')).toHaveAttribute('aria-label', await localized(view, 'muteStream', [title]));
      await view.locator('.mute-button').click();
      await expect(view.locator('.mute-button')).toHaveAttribute('aria-label', await localized(view, 'unmuteStream', [title]));
      await expect(view.locator('.stream-state')).toHaveText(await localized(view, 'mixMutedState'));
      await view.locator('.mute-button').click();
      await expect(view.locator('.normalize-button')).toHaveAttribute('aria-pressed', 'true');
      await expect(view.locator('.normalize-button')).toHaveAttribute('aria-label', await localized(view, 'normalizeDisable', [title]));
      await view.locator('.normalize-button').click();
      await expect(view.locator('.normalize-button')).toHaveAttribute('aria-label', await localized(view, 'normalizeEnable', [title]));
      await expectStablePeakLayout(view, audio);
      await expect(view.locator('.trim-level option:checked')).toHaveText(locale === 'ja' ? '通常' : 'Normal');
      await expect(view.locator('.trim-level')).toHaveAttribute('aria-label', await localized(view, 'trimLabel', [title]));
      await view.locator('.trim-level').selectOption('-6');
      await expect(view.locator('.trim-level')).toHaveValue('-6');
      await expect(view.locator('.trim-level')).toHaveAttribute('title', await localized(view, 'trimHint'));
      expect(await view.locator('h3 b').count()).toBe(0);
      await expect(view.locator('.solo-button')).toHaveAttribute('aria-label', await localized(view, 'soloEnable', [title]));
      await view.locator('.nr-button').click();
      await expect(view.locator('.nr-button')).toHaveAttribute('aria-pressed', 'true');
      await expect(view.locator('.nr-button')).toHaveAttribute('aria-label', await localized(view, 'nrDisable', [title]));
      await expect(view.locator('.nr-button')).not.toHaveAttribute('aria-busy');
      for (const selector of ['.nr-button', '.solo-button', '.focus-button', '.normalize-button', '.mute-button', '.remove-button']) {
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
      await expect(view.locator('.focus-button')).toHaveAttribute('aria-label', await localized(view, 'focusEnable', [title]));
      await view.locator('.focus-button').click();
      await expect(view.locator('.focus-button')).toHaveAttribute('aria-label', await localized(view, 'focusDisable', [title]));
      await expect(view.locator('.solo-button')).toHaveAttribute('aria-pressed', 'false');
      await expect(view.locator('#mix-heading')).toHaveText(await localized(view, 'focusHeading'));
      const panLabelGap = await view.locator('.pan-reading').evaluate((element) =>
        element.querySelector('.pan-value').getBoundingClientRect().left
        - element.querySelector('[data-i18n="pan"]').getBoundingClientRect().right);
      expect(panLabelGap).toBeGreaterThanOrEqual(4);
      await view.locator('.position-dot').focus();
      await view.keyboard.press('End');
      await expect(view.locator('#reset-pans')).toBeVisible();
      // Audio diagnostics remain readable without a translation bundle in either locale.
      const invalidPan = await view.evaluate(() => chrome.runtime.sendMessage({ target: 'worker', type: 'PAN_PREFERENCE', tabId: -1, pan: 0 }));
      expect(invalidPan).toEqual({ ok: false, error: 'This tab has already been released.' });
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
      await expect(view.locator('.trim-level')).toBeDisabled();
      await expect(view.locator('.trim-level')).toHaveAttribute('title', await localized(view, 'trimBypassed'));
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
