let messages = {};
let bundle;

export function t(key, substitutions = []) {
  if (globalThis.chrome?.i18n) return chrome.i18n.getMessage(key, substitutions.map(String)) || key;
  // Offscreen documents only have chrome.runtime. Replace markers in the
  // worker's translated template once, so user titles remain literal text.
  return messages[key]?.replace(/\u0001([0-8])\u0002/g, (_, index) => String(substitutions[index] ?? '')) || key;
}

export function setMessages(value) {
  messages = value;
}

export function getMessageBundle() {
  bundle ??= loadMessageBundle().catch((error) => { bundle = undefined; throw error; });
  return bundle;
}

async function loadMessageBundle() {
  const locale = chrome.runtime.getManifest().default_locale;
  const response = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
  if (!response.ok) throw new Error(t('translationLoadError'));
  const keys = Object.keys(await response.json());
  const markers = Array.from({ length: 9 }, (_, index) => `\u0001${index}\u0002`);
  return Object.fromEntries(keys.map((key) => [key, chrome.i18n.getMessage(key, markers)]));
}

export function localizeDocument() {
  document.documentElement.lang = t('locale');
  const roots = [document, ...Array.from(document.querySelectorAll('template'), (template) => template.content)];
  for (const root of roots) {
    for (const element of root.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.dataset.i18n);
    }
    for (const attribute of ['title', 'aria-label']) {
      for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
  }
}
