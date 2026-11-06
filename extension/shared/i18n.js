let offscreenMessages = {};
let messageBundlePromise;

/** @returns {string} */
export function t(key, substitutions = []) {
  if (globalThis.chrome?.i18n) {
    return chrome.i18n.getMessage(key, substitutions.map(String)) || key;
  }
  // Offscreen documents only have chrome.runtime. Replace markers in the
  // worker's translated template once, so user titles remain literal text.
  return offscreenMessages[key]?.replace(/\u0001([0-8])\u0002/g, (_, index) => String(substitutions[index] ?? '')) || key;
}

/** @returns {void} */
export function setMessages(translations) {
  offscreenMessages = translations;
}

/** @returns {Promise<Record<string, string>>} */
export function getMessageBundle() {
  messageBundlePromise ??= loadMessageBundle().catch((error) => {
    messageBundlePromise = undefined;
    throw error;
  });
  return messageBundlePromise;
}

/** @returns {Promise<Record<string, string>>} */
async function loadMessageBundle() {
  const locale = chrome.runtime.getManifest().default_locale;
  const response = await fetch(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
  if (!response.ok) throw new Error(t('translationLoadError'));
  const keys = Object.keys(await response.json());
  const markers = Array.from({ length: 9 }, (_, index) => `\u0001${index}\u0002`);
  return Object.fromEntries(keys.map((key) => [key, chrome.i18n.getMessage(key, markers)]));
}

/** @returns {void} */
function localizeRoot(root) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const attribute of ['title', 'aria-label']) {
    const messageAttribute = `data-i18n-${attribute}`;
    for (const element of root.querySelectorAll(`[${messageAttribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(messageAttribute)));
    }
  }
}

/** @returns {void} */
export function localizeDocument() {
  document.documentElement.lang = t('locale');
  localizeRoot(document);
  for (const template of document.querySelectorAll('template')) {
    localizeRoot(template.content);
  }
}
