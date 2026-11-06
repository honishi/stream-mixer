/** @returns {string} */
export function t(key, substitutions = []) {
  return chrome.i18n.getMessage(key, substitutions.map(String)) || key;
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
