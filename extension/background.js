import { t } from './shared/i18n.js';
import { sanitizeSettings } from './shared/settings.js';
import { getVideoSnapshots } from './video-snapshot.js';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
let mutation = Promise.resolve();
let creating;

function serialize(task) {
  const next = mutation.then(task);
  mutation = next.catch(() => {});
  return next;
}

async function hasEngine() {
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL] })).length > 0;
}

async function ensureEngine() {
  if (creating) return creating;
  if (await hasEngine()) return;
  creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'],
    justification: t('offscreenPurpose') });
  try { await creating; } finally { creating = undefined; }
}

async function engine(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ target: 'engine', type, ...payload });
  if (!result?.ok) throw new Error(result?.error ?? t('engineConnectionError'));
  return result.data;
}

async function getSettings() {
  return sanitizeSettings((await chrome.storage.local.get('settings')).settings);
}

async function updateBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: '#bce780' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

/** @returns {Promise<object>} */
async function snapshot() {
  const [settings, tabs, state, session] = await Promise.all([
    getSettings(), chrome.tabs.query({}),
    hasEngine().then((exists) => exists ? engine('STATE') : { streams: [], audioState: 'idle', notices: [], bypassed: false }),
    chrome.storage.session.get('notices'),
  ]);
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const controlledIds = new Set(state.streams.map((stream) => stream.id));
  return { settings, ...state,
    notices: [...new Set([...(session.notices ?? []), ...state.notices])].slice(-3),
    streams: state.streams.map((stream) => ({ ...stream,
      title: byId.get(stream.id)?.title ?? stream.title,
      muted: byId.get(stream.id)?.mutedInfo?.muted ?? false,
    })),
    audibleTabs: tabs.filter((tab) => tab.audible && !controlledIds.has(tab.id))
      .map((tab) => ({ id: tab.id, title: tab.title, muted: tab.mutedInfo?.muted ?? false })),
  };
}

async function releaseEmptyEngine() {
  if (!(await hasEngine())) return updateBadge(0);
  const state = await engine('STATE');
  await updateBadge(state.streams.length);
  if (!state.streams.length) await chrome.offscreen.closeDocument();
}

/** @returns {Promise<void>} */
async function releaseTab(tabId) {
  if (await hasEngine()) await engine('STOP', { tabId });
  await releaseEmptyEngine();
}

async function startTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(tab.url ?? '')) throw new Error(t('webPageRequired'));
  if (tab.mutedInfo?.muted) throw new Error(t('unmuteHelp'));
  if (!tab.audible) throw new Error(t('playFirst'));
  await ensureEngine();
  try {
    const existing = await engine('STATE');
    if (existing.streams.some((stream) => stream.id === tabId)) return;
    const settings = await getSettings();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await engine('START', { streamId, tab: { id: tabId, title: tab.title }, settings });
    await chrome.storage.session.remove('notices');
    await updateBadge(existing.streams.length + 1);
  } catch (error) {
    await releaseEmptyEngine();
    throw new Error(t('captureError', [error.message]));
  }
}

async function handle(message) {
  switch (message.type) {
    case 'STATE': return serialize(snapshot);
    case 'VIDEO_SNAPSHOTS': {
      const streams = await serialize(async () => (await hasEngine()) ? (await engine('STATE')).streams : []);
      // Pixel extraction must not hold up audio controls or meter updates.
      return getVideoSnapshots(streams);
    }
    case 'START': return serialize(() => startTab(message.tabId));
    case 'STOP': return serialize(() => releaseTab(message.tabId));
    case 'STOP_ALL': return serialize(async () => {
      if (await hasEngine()) await engine('STOP_ALL');
      await releaseEmptyEngine();
    });
    case 'SETTINGS': return serialize(async () => {
      const settings = sanitizeSettings({ ...await getSettings(), ...message.settings });
      await chrome.storage.local.set({ settings });
      if (await hasEngine()) await engine('SETTINGS', { settings });
      return settings;
    });
    case 'RESUME': return serialize(async () => {
      if (await hasEngine()) await engine('RESUME');
    });
    case 'PAN_PREFERENCE':
    case 'RESET_PANS':
    case 'TOGGLE_SOLO':
    case 'TOGGLE_FOCUS':
    case 'TOGGLE_MUTE':
    case 'TOGGLE_NR':
    case 'TOGGLE_NORMALIZE':
    case 'NR_LEVEL':
    case 'REORDER':
    case 'BYPASS': return serialize(async () => {
      if (!(await hasEngine())) throw new Error(t('addFirst'));
      return engine(message.type, { tabId: message.tabId, pan: message.pan, enabled: message.enabled,
        level: message.level, beforeTabId: message.beforeTabId });
    });
    case 'ENGINE_CHANGED': return serialize(async () => {
      if (await hasEngine()) {
        const state = await engine('STATE');
        await chrome.storage.session.set({ notices: state.notices });
      }
      await releaseEmptyEngine();
    });
    default: throw new Error(t('unknownOperation'));
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'worker' || sender.id !== chrome.runtime.id) return;
  const isPopup = sender.url === chrome.runtime.getURL('popup.html');
  const isEngine = sender.url === OFFSCREEN_URL;
  if (!(isPopup || (isEngine && message.type === 'ENGINE_CHANGED'))) return;
  handle(message).then((data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pan-drag' || port.sender?.id !== chrome.runtime.id
    || port.sender?.url !== chrome.runtime.getURL('popup.html')) return;
  const owner = crypto.randomUUID();
  let tabId;
  let disconnected = false;
  port.onMessage.addListener((message) => {
    if (message.type === 'START' && Number.isInteger(message.tabId)) tabId = message.tabId;
    else if (message.type !== 'KEEP_ALIVE') return;
    serialize(async () => {
      if (disconnected || tabId === undefined) return;
      if (!(await hasEngine())) throw new Error(t('engineStopped'));
      await engine('DRAG_SOLO', { tabId, owner });
    }).catch((error) => {
      if (!disconnected) port.postMessage({ error: error.message });
    });
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    serialize(async () => {
      if (await hasEngine()) await engine('END_DRAG_SOLO', { owner });
    }).catch(console.error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => releaseTab(tabId)).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => { updateBadge(0).catch(console.error); });
chrome.runtime.onInstalled.addListener(() => { updateBadge(0).catch(console.error); });
