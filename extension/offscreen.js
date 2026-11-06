import { DEFAULT_SETTINGS, sanitizeSettings, panPositions } from './shared/settings.js';

const streams = new Map();
const notices = [];
let context;
let master;
let safety;
let settings = { ...DEFAULT_SETTINGS };
let sequence = 0;
let operation = Promise.resolve();

async function ensureAudio() {
  if (context) return;
  const next = new AudioContext({ latencyHint: 'interactive' });
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
  const positions = panPositions(streams.size, settings.spread);
  [...streams.values()].forEach((entry, index) => {
    entry.targetPan = positions[index];
    entry.pan.pan.setTargetAtTime(entry.targetPan, context.currentTime, 0.15);
    entry.normalize.port.postMessage({ strength: settings.strength });
  });
}

function getState() {
  return { audioState: context?.state ?? 'idle', notices,
    streams: [...streams.values()].map((entry) => ({
      id: entry.id, title: entry.title, color: entry.color, pan: entry.pan.pan.value,
      targetPan: entry.targetPan, ...entry.stats,
    })),
  };
}

async function remove(id) {
  const entry = streams.get(id);
  if (!entry) return;
  streams.delete(id);
  entry.stream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  for (const node of [entry.source, entry.normalize, entry.pan, entry.meter, entry.fade]) node.disconnect();
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
      color: sequence++ % 6, targetPan: 0,
      stats: { inputDb: -120, correctionDb: 0, limitingDb: 0, rms: [-120, -120], peak: [-120, -120] },
    };
    normalize.port.onmessage = ({ data }) => Object.assign(entry.stats, data);
    meter.port.onmessage = ({ data }) => Object.assign(entry.stats, data);
    normalize.onprocessorerror = meter.onprocessorerror = () => notifyFailure(entry, '音声処理が停止したため制御を解除しました。');
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => notifyFailure(entry, '音声の取得が終了しました。再追加してください。');
    });
    source.connect(normalize).connect(pan).connect(meter).connect(fade).connect(master);
    streams.set(entry.id, entry);
    applySettings();
    await context.resume();
    fade.gain.setTargetAtTime(1, context.currentTime, 0.025);
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
