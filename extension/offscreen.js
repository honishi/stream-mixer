import { createNoiseNode, destroyNoiseNode } from './audio/noise-reduction.js';
import { DEFAULT_NOISE_LEVEL, NOISE_LEVELS } from './shared/noise.js';
import { preferredPanPositions, withPanPreference } from './shared/panning.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from './shared/settings.js';

const streams = new Map();
const FOCUS_BACKGROUND_GAIN = 10 ** (-18 / 20);
let notices = [];
let context;
let master;
let safety;
let settings = { ...DEFAULT_SETTINGS };
let sequence = 0;
let operation = Promise.resolve();
let panOrder = [];
let cardOrder = [];
let bypassed = false;
let solo;
let soloTimer;
let selectedSoloTabId = null;
const selectedFocusTabIds = new Set();

async function ensureAudio() {
  if (context) return;
  const next = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  try {
    await next.audioWorklet.addModule('audio/processors.js');
    master = new GainNode(next, { gain: settings.volume });
    safety = new AudioWorkletNode(next, 'stream-safety', { outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit' });
    master.connect(safety).connect(next.destination);
    safety.onprocessorerror = () => {
      for (const entry of streams.values()) notifyFailure(entry, 'The output processor stopped. The tab has been released.');
    };
    context = next;
  } catch (error) {
    await next.close();
    throw error;
  }
}

function updateNormalization(entry) {
  entry.normalize.port.postMessage({ strength: settings.strength, enabled: entry.normalizeEnabled });
}

/** @returns {object} The controlled stream and its audio nodes. */
function requireStream(tabId) {
  const entry = streams.get(tabId);
  if (!entry) throw new Error('This tab has already been released.');
  return entry;
}

/** @returns {void} */
function toggleNormalization(tabId) {
  const entry = requireStream(tabId);
  if (bypassed) throw new Error('Resume the mix before changing normalization.');
  entry.normalizeEnabled = !entry.normalizeEnabled;
  updateNormalization(entry);
}

function applySettings() {
  if (!context) return;
  master.gain.setTargetAtTime(settings.volume, context.currentTime, 0.04);
  const ordered = panOrder.map((id) => streams.get(id));
  const positions = preferredPanPositions(ordered, settings.spread);
  ordered.forEach((entry, index) => {
    entry.targetPan = positions[index];
    entry.pan.pan.setTargetAtTime(entry.targetPan, context.currentTime, 0.15);
    updateNormalization(entry);
  });
}

/** @returns {object} */
function getState() {
  return { audioState: context?.state ?? 'idle', notices, bypassed, soloTabId: effectiveSoloTabId(),
    selectedSoloTabId, dragSoloTabId: solo?.tabId ?? null,
    selectedFocusTabIds: [...selectedFocusTabIds], focusTabIds: effectiveFocusTabIds(),
    streams: cardOrder.map((id) => {
      const entry = streams.get(id);
      return {
        id: entry.id, title: entry.title, color: entry.color, pan: entry.pan.pan.value,
        targetPan: entry.targetPan, panPreference: entry.panPreference,
        normalizeEnabled: entry.normalizeEnabled, mixMuted: entry.mixMuted, trimDb: entry.trimDb,
        noiseReductionEnabled: entry.noiseReductionEnabled, noiseReductionLevel: entry.noiseReductionLevel, ...entry.stats,
      };
    }),
  };
}

async function remove(id) {
  const entry = streams.get(id);
  if (!entry) return;
  streams.delete(id);
  cardOrder = cardOrder.filter((entryId) => entryId !== id);
  if (selectedSoloTabId === id) selectedSoloTabId = null;
  selectedFocusTabIds.delete(id);
  if (solo?.tabId === id) endSolo(solo.owner);
  else applyStreamGains();
  panOrder = panOrder.filter((entryId) => entryId !== id);
  entry.stream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  for (const node of [entry.source, entry.normalize, entry.pan, entry.meter, entry.fade]) node.disconnect();
  destroyNoiseNode(entry.noise);
  for (const node of [entry.normalize, entry.meter]) {
    node.port.onmessage = null;
    node.port.postMessage({ stop: true });
    node.port.close();
  }
  applySettings();
  if (!streams.size && context) {
    const previous = context;
    context = undefined;
    master.disconnect();
    safety.disconnect();
    safety.port.postMessage({ stop: true });
    safety.port.close();
    await previous.close();
  }
}

function route(entry) {
  entry.source.disconnect();
  entry.noise?.disconnect();
  entry.noise?.port.postMessage({ type: 'suspend', value: bypassed });
  entry.pan.disconnect();
  entry.meter.disconnect();
  if (bypassed) {
    // Keep capture and explicit mute, but bypass processing, master gain,
    // and safety limiting. Meter the remaining original stereo output.
    entry.source.connect(entry.fade);
    entry.meter.connect(context.destination);
  } else {
    if (entry.noiseReductionEnabled && entry.noise) entry.source.connect(entry.noise).connect(entry.normalize);
    else entry.source.connect(entry.normalize);
    entry.pan.connect(entry.fade);
    entry.meter.connect(master);
  }
}

function noiseFailure(entry, node, error) {
  operation = operation.then(() => {
    if (!streams.has(entry.id) || entry.noise !== node) return;
    entry.noiseReductionEnabled = false;
    entry.noise = undefined;
    route(entry);
    destroyNoiseNode(node);
    notices.push({ tabId: entry.id,
      text: `${entry.title}: Noise reduction was disabled so playback can continue. ${error.message}` });
    if (notices.length > 3) notices.shift();
    chrome.runtime.sendMessage({ target: 'worker', type: 'ENGINE_CHANGED' }).catch(() => {});
  }).catch(console.error);
}

/** @returns {Promise<void>} */
async function toggleNoiseReduction(tabId) {
  const entry = requireStream(tabId);
  if (bypassed) throw new Error('Resume the mix before changing noise reduction.');
  const enabled = !entry.noiseReductionEnabled;
  let node;
  // Leave the original path intact until the model has initialized successfully.
  if (enabled) node = await createNoiseNode(context, (error) => noiseFailure(entry, node, error), NOISE_LEVELS[entry.noiseReductionLevel]);
  entry.fade.gain.cancelScheduledValues(context.currentTime);
  entry.fade.gain.setTargetAtTime(0, context.currentTime, 0.004);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const previous = entry.noise;
  entry.noiseReductionEnabled = enabled;
  entry.noise = node;
  route(entry);
  entry.fade.gain.setTargetAtTime(audibleGain(entry), context.currentTime, 0.008);
  destroyNoiseNode(previous);
}

/** @returns {void} */
function setNoiseReductionLevel(tabId, level) {
  const entry = requireStream(tabId);
  if (bypassed) throw new Error('Resume the mix before changing noise reduction.');
  if (typeof level !== 'string' || !Object.hasOwn(NOISE_LEVELS, level)) throw new Error('Invalid noise reduction strength.');
  entry.noiseReductionLevel = level;
  entry.noise?.port.postMessage({ type: 'mix', value: NOISE_LEVELS[level] });
}

function effectiveSoloTabId() { return bypassed ? null : solo?.tabId ?? selectedSoloTabId; }
function effectiveFocusTabIds() { return bypassed || effectiveSoloTabId() !== null ? [] : [...selectedFocusTabIds]; }

function audibleGain(entry) {
  if (entry.mixMuted) return 0;
  // fade sits after normalization and panning, so automatic correction cannot
  // undo the user's trim. Solo and Focus retain it; bypass plays original audio.
  const trim = bypassed ? 1 : 10 ** (entry.trimDb / 20);
  const selected = effectiveSoloTabId();
  if (selected !== null) return selected === entry.id ? trim : 0;
  const focused = effectiveFocusTabIds();
  return trim * (focused.length > 0 && !focused.includes(entry.id) ? FOCUS_BACKGROUND_GAIN : 1);
}

function applyStreamGains(timeConstant = 0.02) {
  for (const entry of streams.values()) entry.fade.gain.setTargetAtTime(audibleGain(entry), context.currentTime, timeConstant);
}

/** @returns {void} */
function setVolumeTrim(tabId, trimDb) {
  const entry = requireStream(tabId);
  if (bypassed) throw new Error('Resume the mix before adjusting stream volume.');
  if (![0, -3, -6, -9].includes(trimDb)) throw new Error('Invalid stream volume adjustment.');
  entry.trimDb = trimDb;
  applyStreamGains();
}

/** @returns {void} */
function toggleMute(tabId) {
  const entry = requireStream(tabId);
  entry.mixMuted = !entry.mixMuted;
  applyStreamGains();
}

/** @returns {void} */
function toggleSolo(tabId) {
  if (bypassed) throw new Error('Resume the mix before selecting a solo tab.');
  requireStream(tabId);
  selectedSoloTabId = selectedSoloTabId === tabId ? null : tabId;
  selectedFocusTabIds.clear();
  applyStreamGains();
}

/** @returns {void} */
function toggleFocus(tabId) {
  if (bypassed) throw new Error('Resume the mix before changing Focus.');
  requireStream(tabId);
  if (selectedFocusTabIds.has(tabId)) selectedFocusTabIds.delete(tabId);
  else selectedFocusTabIds.add(tabId);
  selectedSoloTabId = null;
  applyStreamGains();
}

function endSolo(owner) {
  if (!solo || solo.owner !== owner) return;
  solo = undefined;
  clearTimeout(soloTimer);
  applyStreamGains();
}

function beginSolo(tabId, owner) {
  if (bypassed || !streams.has(tabId)) throw new Error('This tab cannot be soloed.');
  if (typeof owner !== 'string' || !owner) throw new Error('Invalid solo operation.');
  solo = { tabId, owner };
  clearTimeout(soloTimer);
  applyStreamGains(0.01);
  // A lease is a fallback for a lost popup/worker connection. The port normally
  // releases solo immediately; a crashed owner cannot leave other streams muted.
  soloTimer = setTimeout(() => {
    operation = operation.then(() => endSolo(owner)).catch(console.error);
  }, 3000);
}

async function setBypass(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Invalid bypass setting.');
  if (enabled === bypassed) return;
  if (solo) endSolo(solo.owner);
  if (context) {
    for (const entry of streams.values()) {
      entry.fade.gain.cancelScheduledValues(context.currentTime);
      entry.fade.gain.setTargetAtTime(0, context.currentTime, 0.004);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  bypassed = enabled;
  for (const entry of streams.values()) {
    route(entry);
    entry.fade.gain.setTargetAtTime(audibleGain(entry), context.currentTime, 0.008);
  }
}

function setPanPreference(tabId, pan) {
  if (bypassed) throw new Error('Resume the mix before adjusting positions.');
  const ordered = withPanPreference(panOrder.map((id) => streams.get(id)), tabId, pan, settings.spread);
  panOrder = ordered.map((entry) => entry.id);
  streams.get(tabId).panPreference = ordered.find((entry) => entry.id === tabId).panPreference;
  applySettings();
}

function notifyFailure(entry, text) {
  operation = operation.then(async () => {
    if (!streams.has(entry.id)) return;
    notices.push({ tabId: entry.id, text: `${entry.title}: ${text}` });
    if (notices.length > 3) notices.shift();
    await remove(entry.id);
    chrome.runtime.sendMessage({ target: 'worker', type: 'ENGINE_CHANGED' }).catch(() => {});
  }).catch(console.error);
}

async function add(message) {
  if (streams.has(message.tab.id)) return;
  settings = sanitizeSettings(message.settings);
  await ensureAudio();
  let stream;
  const nodes = [];
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } },
      video: false,
    });
    const source = context.createMediaStreamSource(stream);
    nodes.push(source);
    const normalize = new AudioWorkletNode(context, 'stream-normalizer', { outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit' });
    nodes.push(normalize);
    const pan = new StereoPannerNode(context, { pan: 0 });
    nodes.push(pan);
    const meter = new AudioWorkletNode(context, 'stream-meter', { outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit' });
    nodes.push(meter);
    const fade = new GainNode(context, { gain: 0 });
    nodes.push(fade);
    const entry = { ...message.tab, stream, source, normalize, pan, meter, fade,
      color: sequence++ % 6, targetPan: 0, panPreference: null, normalizeEnabled: true, mixMuted: false, trimDb: 0,
      noiseReductionEnabled: false, noiseReductionLevel: DEFAULT_NOISE_LEVEL,
      stats: { inputDb: -120, correctionDb: 0, limitingDb: 0, rms: [-120, -120], peak: [-120, -120] },
    };
    normalize.port.onmessage = ({ data }) => Object.assign(entry.stats, data);
    meter.port.onmessage = ({ data }) => Object.assign(entry.stats, data);
    normalize.onprocessorerror = meter.onprocessorerror = () => notifyFailure(entry, 'Audio processing stopped. The tab has been released.');
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => notifyFailure(entry, 'Audio capture ended. Add the tab again.');
    });
    normalize.connect(pan);
    fade.connect(meter);
    route(entry);
    streams.set(entry.id, entry);
    panOrder.push(entry.id);
    cardOrder.push(entry.id);
    applySettings();
    await context.resume();
    fade.gain.setTargetAtTime(audibleGain(entry), context.currentTime, 0.025);
    notices.length = 0;
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (streams.has(message.tab.id)) await remove(message.tab.id);
    else for (const node of nodes) { node.disconnect(); node.port?.close(); }
    throw error;
  }
}

/** @returns {void} */
function reorderCard(tabId, beforeTabId) {
  requireStream(tabId);
  if (beforeTabId !== null) requireStream(beforeTabId);
  if (tabId === beforeTabId) return;
  const next = cardOrder.filter((id) => id !== tabId);
  const index = beforeTabId === null ? next.length : next.indexOf(beforeTabId);
  next.splice(index, 0, tabId);
  cardOrder = next;
}

/** @returns {Promise<object>} */
async function handle(message) {
  switch (message.type) {
    case 'START': await add(message); break;
    case 'STOP':
      await remove(message.tabId);
      notices = notices.filter((notice) => notice.tabId !== message.tabId);
      break;
    case 'STOP_ALL':
      for (const id of [...streams.keys()]) await remove(id);
      notices.length = 0;
      break;
    case 'REORDER': reorderCard(message.tabId, message.beforeTabId); break;
    case 'SETTINGS': settings = sanitizeSettings(message.settings); applySettings(); break;
    case 'PAN_PREFERENCE': setPanPreference(message.tabId, message.pan); break;
    case 'RESET_PANS':
      panOrder = [...streams.keys()];
      for (const entry of streams.values()) entry.panPreference = null;
      applySettings();
      break;
    case 'BYPASS': await setBypass(message.enabled); break;
    case 'VOLUME_TRIM': setVolumeTrim(message.tabId, message.trimDb); break;
    case 'TOGGLE_MUTE': toggleMute(message.tabId); break;
    case 'TOGGLE_SOLO': toggleSolo(message.tabId); break;
    case 'TOGGLE_FOCUS': toggleFocus(message.tabId); break;
    case 'TOGGLE_NR': await toggleNoiseReduction(message.tabId); break;
    case 'TOGGLE_NORMALIZE': toggleNormalization(message.tabId); break;
    case 'NR_LEVEL': setNoiseReductionLevel(message.tabId, message.level); break;
    case 'DRAG_SOLO': beginSolo(message.tabId, message.owner); break;
    case 'END_DRAG_SOLO': endSolo(message.owner); break;
    case 'RESUME': if (context) await context.resume(); break;
    default: throw new Error('Unknown audio operation.');
  }
  return getState();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'engine' || sender.id !== chrome.runtime.id) return;
  if (message.type === 'STATE') { sendResponse({ ok: true, data: getState() }); return; }
  const result = operation.then(() => handle(message));
  operation = result.catch(() => {});
  result.then((data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
