import { DEFAULT_SETTINGS, sanitizeSettings } from './shared/settings.js';
import { preferredPanPositions, withPanPreference } from './shared/panning.js';
import { createNoiseNode, destroyNoiseNode } from './audio/noise-reduction.js';

const streams = new Map();
const notices = [];
let context;
let master;
let safety;
let settings = { ...DEFAULT_SETTINGS };
let sequence = 0;
let operation = Promise.resolve();
let panOrder = [];
let bypassed = false;
let solo;
let soloTimer;
let selectedSoloTabId = null;

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
      for (const entry of streams.values()) notifyFailure(entry, '出力処理が停止したため制御を解除しました。');
    };
    context = next;
  } catch (error) {
    await next.close();
    throw error;
  }
}

function applySettings() {
  if (!context) return;
  master.gain.setTargetAtTime(settings.volume, context.currentTime, 0.04);
  const ordered = panOrder.map((id) => streams.get(id));
  const positions = preferredPanPositions(ordered, settings.spread);
  ordered.forEach((entry, index) => {
    entry.targetPan = positions[index];
    entry.pan.pan.setTargetAtTime(entry.targetPan, context.currentTime, 0.15);
    entry.normalize.port.postMessage({ strength: settings.strength });
  });
}

function getState() {
  return { audioState: context?.state ?? 'idle', notices, bypassed, soloTabId: effectiveSoloTabId(),
    selectedSoloTabId, dragSoloTabId: solo?.tabId ?? null,
    streams: [...streams.values()].map((entry) => ({
      id: entry.id, title: entry.title, color: entry.color, pan: entry.pan.pan.value,
      targetPan: entry.targetPan, panPreference: entry.panPreference, noiseReductionEnabled: entry.noiseReductionEnabled, ...entry.stats,
    })),
  };
}

async function remove(id) {
  const entry = streams.get(id);
  if (!entry) return;
  streams.delete(id);
  if (selectedSoloTabId === id) selectedSoloTabId = null;
  if (solo?.tabId === id) endSolo(solo.owner);
  else applySoloGains();
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
    // Keep the captured stream, but bypass every sound-changing stage,
    // including the master gain and safety limiter. Meter the original stereo.
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
    notices.push(`${entry.title}: ノイズ抑制を解除して再生を継続します。${error.message}`);
    if (notices.length > 3) notices.shift();
    chrome.runtime.sendMessage({ target: 'worker', type: 'ENGINE_CHANGED' }).catch(() => {});
  }).catch(console.error);
}

async function toggleNoiseReduction(tabId) {
  const entry = streams.get(tabId);
  if (!entry) throw new Error('このタブはすでに制御を解除されています。');
  if (bypassed) throw new Error('ミックスを再開してからノイズ抑制を切り替えてください。');
  const enabled = !entry.noiseReductionEnabled;
  let node;
  // Leave the original path intact until the model has initialized successfully.
  if (enabled) node = await createNoiseNode(context, (error) => noiseFailure(entry, node, error));
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

function effectiveSoloTabId() { return bypassed ? null : solo?.tabId ?? selectedSoloTabId; }

function audibleGain(entry) {
  const selected = effectiveSoloTabId();
  return selected === null || selected === entry.id ? 1 : 0;
}

function applySoloGains(timeConstant = 0.02) {
  for (const entry of streams.values()) entry.fade.gain.setTargetAtTime(audibleGain(entry), context.currentTime, timeConstant);
}

function toggleSolo(tabId) {
  if (bypassed) throw new Error('ミックスを再開してからソロを選択してください。');
  if (!streams.has(tabId)) throw new Error('このタブはすでに制御を解除されています。');
  selectedSoloTabId = selectedSoloTabId === tabId ? null : tabId;
  applySoloGains();
}

function endSolo(owner) {
  if (!solo || solo.owner !== owner) return;
  solo = undefined;
  clearTimeout(soloTimer);
  applySoloGains();
}

function beginSolo(tabId, owner) {
  if (bypassed || !streams.has(tabId)) throw new Error('このタブをソロ再生できません。');
  if (typeof owner !== 'string' || !owner) throw new Error('ソロ操作が正しくありません。');
  solo = { tabId, owner };
  clearTimeout(soloTimer);
  applySoloGains(0.01);
  // A lease is a fallback for a lost popup/worker connection. The port normally
  // releases solo immediately; a crashed owner cannot leave other streams muted.
  soloTimer = setTimeout(() => {
    operation = operation.then(() => endSolo(owner)).catch(console.error);
  }, 3000);
}

async function setBypass(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('バイパス設定が正しくありません。');
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
  if (bypassed) throw new Error('ミックスを再開してから配置を調整してください。');
  const ordered = withPanPreference(panOrder.map((id) => streams.get(id)), tabId, pan, settings.spread);
  panOrder = ordered.map((entry) => entry.id);
  streams.get(tabId).panPreference = ordered.find((entry) => entry.id === tabId).panPreference;
  applySettings();
}

function notifyFailure(entry, text) {
  operation = operation.then(async () => {
    if (!streams.has(entry.id)) return;
    notices.push(`${entry.title}: ${text}`);
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
      color: sequence++ % 6, targetPan: 0, panPreference: null, noiseReductionEnabled: false,
      stats: { inputDb: -120, correctionDb: 0, limitingDb: 0, rms: [-120, -120], peak: [-120, -120] },
    };
    normalize.port.onmessage = ({ data }) => Object.assign(entry.stats, data);
    meter.port.onmessage = ({ data }) => Object.assign(entry.stats, data);
    normalize.onprocessorerror = meter.onprocessorerror = () => notifyFailure(entry, '音声処理が停止したため制御を解除しました。');
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => notifyFailure(entry, '音声の取得が終了しました。再追加してください。');
    });
    normalize.connect(pan);
    fade.connect(meter);
    route(entry);
    streams.set(entry.id, entry);
    panOrder.push(entry.id);
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

async function handle(message) {
  switch (message.type) {
    case 'START': await add(message); break;
    case 'STOP': await remove(message.tabId); break;
    case 'STOP_ALL': for (const id of [...streams.keys()]) await remove(id); break;
    case 'SETTINGS': settings = sanitizeSettings(message.settings); applySettings(); break;
    case 'PAN_PREFERENCE': setPanPreference(message.tabId, message.pan); break;
    case 'RESET_PANS':
      panOrder = [...streams.keys()];
      for (const entry of streams.values()) entry.panPreference = null;
      applySettings();
      break;
    case 'BYPASS': await setBypass(message.enabled); break;
    case 'TOGGLE_SOLO': toggleSolo(message.tabId); break;
    case 'TOGGLE_NR': await toggleNoiseReduction(message.tabId); break;
    case 'DRAG_SOLO': beginSolo(message.tabId, message.owner); break;
    case 'END_DRAG_SOLO': endSolo(message.owner); break;
    case 'RESUME': if (context) await context.resume(); break;
    default: throw new Error('不明な音声操作です。');
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
