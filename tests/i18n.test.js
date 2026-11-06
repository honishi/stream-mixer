import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const locales = await readdir('extension/_locales');
const catalogs = Object.fromEntries(await Promise.all(locales.map(async (locale) => [
  locale, JSON.parse(await readFile(`extension/_locales/${locale}/messages.json`, 'utf8')),
])));
const fallback = catalogs[manifest.default_locale];

test('every locale has matching messages and substitution contracts', () => {
  assert.ok(fallback, 'manifest default_locale exists');
  for (const [locale, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(fallback).sort(), locale);
    for (const [key, entry] of Object.entries(catalog)) {
      assert.ok(entry.message.trim(), `${locale}/${key} is not empty`);
      assert.deepEqual(entry.placeholders, fallback[key].placeholders, `${locale}/${key} substitutions`);
      const used = [...entry.message.matchAll(/\$([a-zA-Z]\w*)\$/g)].map((match) => match[1]);
      assert.deepEqual([...new Set(used)].sort(), Object.keys(entry.placeholders ?? {}).sort(), `${locale}/${key} placeholders`);
    }
  }
});

test('manifest, markup, and literal translation references exist in the default catalog', async () => {
  const manifestKeys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((match) => match[1]);
  const markup = await readFile('extension/popup.html', 'utf8');
  const markupKeys = [...markup.matchAll(/data-i18n(?:-title|-aria-label)?="(\w+)"/g)].map((match) => match[1]);
  const files = ['popup.js', 'background.js', 'offscreen.js', 'shared/panning.js', 'shared/i18n.js', 'audio/noise-reduction.js'];
  const scripts = (await Promise.all(files.map((file) => readFile(`extension/${file}`, 'utf8')))).join('\n');
  const scriptKeys = [...scripts.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]);
  for (const key of [...manifestKeys, ...markupKeys, ...scriptKeys]) assert.ok(fallback[key], `Missing message: ${key}`);
  assert.doesNotMatch(scripts, /[ぁ-んァ-ン一-龯]/, 'user-facing Japanese belongs in the catalog');
});
