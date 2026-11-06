import { clamp, panPositions } from './shared/settings.js';

const $ = (id) => document.getElementById(id);
const colors = ['#c1ed8b', '#9acbe9', '#dfb1dc', '#efca83', '#9ce0cb', '#edab99'];
const cards = new Map();
const dots = new Map();
const pendingPans = new Map();
const dirtySettings = new Set();
let activeTab;
let busy = false;
let polling = false;
let candidateKey = '';
let settingsTimer;
let saving = Promise.resolve();
let latestState;
let dragging;

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'worker', type, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? '拡張に接続できませんでした。開き直してください。');
  return response.data;
}

function showError(error) {
  $('error').textContent = error?.message ?? '';
  $('error').hidden = !error;
}

const meterPercent = (db) => Math.max(0, Math.min(100, (db + 60) / 60 * 100));
function panText(pan) { return Math.abs(pan) < 0.015 ? 'CENTER' : `${pan < 0 ? 'L' : 'R'} ${Math.round(Math.abs(pan) * 100)}`; }

function panWidth() { return panPositions(2, latestState?.settings.spread ?? 0)[1]; }

function endDrag(commit = false) {
  if (!dragging) return;
  const drag = dragging;
  // Keep the dropped marker anchored while the engine decides the new layout.
  if (commit && drag.moved) pendingPans.set(drag.id, drag.pan);
  dragging = undefined;
  drag.dot.classList.remove('dragging');
  if (drag.dot.hasPointerCapture(drag.pointerId)) drag.dot.releasePointerCapture(drag.pointerId);
  const releaseSolo = () => { clearInterval(drag.heartbeat); drag.port.disconnect(); };
  if (commit && drag.moved) {
    void act('PAN_PREFERENCE', { tabId: drag.id, pan: drag.pan }).then((result) => {
      // Draw the resolved target directly from the response. Rendering the
      // AudioParam's still-moving value here would jump back to the old location.
      if (result && latestState) {
        const targets = new Map(result.streams.map((stream) => [stream.id, stream.targetPan]));
        for (const stream of latestState.streams) {
          if (targets.has(stream.id)) stream.targetPan = targets.get(stream.id);
        }
      }
      pendingPans.delete(drag.id);
      if (latestState) render(latestState);
    }).finally(releaseSolo);
  } else {
    releaseSolo();
    if (latestState) render(latestState);
  }
}

function attachPanControl(dot, id) {
  dot.type = 'button';
  dot.setAttribute('role', 'slider');
  dot.setAttribute('aria-orientation', 'horizontal');
  dot.setAttribute('aria-describedby', 'field-help');
  dot.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary || busy || dragging || latestState?.bypassed || !panWidth()) return;
    const rect = dot.getBoundingClientRect();
    const stream = latestState.streams.find((stream) => stream.id === id);
    if (!stream) return;
    event.preventDefault();
    dot.focus({ preventScroll: true });
    const port = chrome.runtime.connect({ name: 'pan-drag' });
    port.postMessage({ type: 'START', tabId: id });
    const heartbeat = setInterval(() => port.postMessage({ type: 'KEEP_ALIVE' }), 1000);
    port.onMessage.addListener((message) => {
      if (message.error) {
        showError(new Error(message.error));
        if (dragging?.port === port) endDrag();
      }
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      clearInterval(heartbeat);
      if (dragging?.port === port) {
        endDrag();
        if (error) showError(new Error(error.message));
      }
    });
    dragging = { id, dot, pointerId: event.pointerId, startX: event.clientX,
      offset: event.clientX - (rect.left + rect.width / 2), pan: stream.targetPan, moved: false, port, heartbeat };
    dot.setPointerCapture(event.pointerId);
    dot.classList.add('dragging');
    $('field-help').textContent = 'この音声をソロ再生中 · 離すと全体を再配置';
  });
  const move = (event) => {
    if (dragging?.id !== id || dragging.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - dragging.startX) > 3) dragging.moved = true;
    if (!dragging.moved) return;
    const field = document.querySelector('.stereo-field').getBoundingClientRect();
    dragging.pan = clamp(((event.clientX - dragging.offset - field.left) / field.width - 0.5) / 0.44, -panWidth(), panWidth());
    dot.style.left = `${50 + dragging.pan * 44}%`;
    dot.setAttribute('aria-valuetext', `希望位置 ${panText(dragging.pan)}。離すと全体を再配置`);
  };
  dot.addEventListener('pointermove', move);
  dot.addEventListener('pointerup', (event) => {
    if (dragging?.id !== id || dragging.pointerId !== event.pointerId) return;
    move(event);
    endDrag(true);
  });
  for (const eventName of ['pointercancel', 'lostpointercapture']) {
    dot.addEventListener(eventName, (event) => {
      if (dragging?.id === id && dragging.pointerId === event.pointerId) endDrag();
    });
  }
  dot.addEventListener('keydown', (event) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    if (busy || dragging || latestState?.bypassed || !panWidth()) return;
    const stream = latestState.streams.find((stream) => stream.id === id);
    if (!stream) return;
    const pan = event.key === 'Home' ? -panWidth() : event.key === 'End' ? panWidth()
      : stream.targetPan + (event.key === 'ArrowLeft' ? -1 : 1) * panWidth() * 0.2;
    void act('PAN_PREFERENCE', { tabId: id, pan });
  });
}

function renderStream(stream, index) {
  let card = cards.get(stream.id);
  if (!card) {
    card = $('stream-template').content.firstElementChild.cloneNode(true);
    card.querySelector('.remove-button').addEventListener('click', () => act('STOP', { tabId: stream.id }));
    card.querySelector('.solo-button').addEventListener('click', () => act('TOGGLE_SOLO', { tabId: stream.id }));
    card.querySelector('.nr-button').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (busy) return;
      button.textContent = '…';
      button.setAttribute('aria-busy', 'true');
      try { await act('TOGGLE_NR', { tabId: stream.id }); }
      finally { button.textContent = 'NR'; button.removeAttribute('aria-busy'); }
    });
    cards.set(stream.id, card);
    $('streams').append(card);
    const dot = document.createElement('button');
    dot.className = 'position-dot';
    attachPanControl(dot, stream.id);
    dots.set(stream.id, dot);
    $('positions').append(dot);
  }
  const color = colors[stream.color % colors.length];
  card.style.setProperty('--stream-color', color);
  card.querySelector('.stream-number').textContent = String(index + 1).padStart(2, '0');
  const heading = card.querySelector('h3');
  heading.textContent = stream.title;
  heading.title = stream.title;
  card.querySelector('.remove-button').ariaLabel = `${stream.title} の制御を解除`;
  card.querySelector('.remove-button').disabled = busy;
  const state = card.querySelector('.stream-state');
  const bypassed = latestState.bypassed;
  const nrButton = card.querySelector('.nr-button');
  nrButton.setAttribute('aria-pressed', String(stream.noiseReductionEnabled));
  nrButton.disabled = busy || bypassed;
  nrButton.ariaLabel = `${stream.title} のノイズリダクションを${stream.noiseReductionEnabled ? '無効' : '有効'}にする`;
  nrButton.title = bypassed ? '全バイパス中はノイズ抑制も停止します' : 'NR: 会話向けノイズリダクション。音楽や効果音も弱まる場合があります。';
  const soloButton = card.querySelector('.solo-button');
  const selectedSolo = latestState.selectedSoloTabId === stream.id;
  soloButton.setAttribute('aria-pressed', String(selectedSolo));
  soloButton.disabled = busy || bypassed;
  soloButton.ariaLabel = selectedSolo ? `${stream.title} のソロを解除` : `${stream.title} をソロ再生`;
  soloButton.title = selectedSolo ? 'ソロを解除して全体再生に戻す' : 'このタブだけを再生';
  const soloMuted = latestState.soloTabId != null && latestState.soloTabId !== stream.id;
  const playing = (bypassed ? Math.max(...stream.rms) : stream.inputDb) > -50;
  state.textContent = stream.muted ? 'タブがミュートされています' : soloMuted ? '他のタブをソロ再生中' : latestState.soloTabId === stream.id
    ? latestState.dragSoloTabId === stream.id ? '● ドラッグ中のソロ再生' : '● ソロ再生中'
    : bypassed ? 'バイパス中 · 元の音声' : playing ? '● 音声を調整中' : '○ 無音・一時停止';
  state.classList.toggle('playing', playing && !stream.muted);
  const rms = Math.max(...stream.rms);
  card.querySelector('.level-value').textContent = rms <= -60 ? '−∞' : `${rms.toFixed(0)} dB`;
  card.querySelector('.meter-group').ariaLabel = `補正後の音量 ${rms <= -60 ? '無音' : `${rms.toFixed(0)} dBFS`}`;
  for (const [c, side] of ['left', 'right'].entries()) {
    card.querySelector(`.meter-fill.${side}`).style.width = `${meterPercent(stream.rms[c])}%`;
    const peak = card.querySelector(`.peak-tick.${side}`);
    peak.style.left = `${Math.min(99, meterPercent(stream.peak[c]))}%`;
    peak.hidden = stream.peak[c] < -60;
  }
  const correction = Math.abs(stream.correctionDb) < 0.05 ? 0 : stream.correctionDb;
  card.querySelector('.correction').textContent = bypassed ? '—' : `${correction > 0 ? '+' : ''}${correction.toFixed(1)} dB`;
  card.querySelector('.limiter-label').textContent = !bypassed && stream.limitingDb < -0.5 ? `ピーク抑制 ${stream.limitingDb.toFixed(1)}` : '';
  card.querySelector('.pan-track i').style.left = `${((bypassed ? 0 : stream.pan) + 1) * 50}%`;
  card.querySelector('.pan-value').textContent = bypassed ? 'BYPASS' : panText(stream.pan);
  const dot = dots.get(stream.id);
  const visualPan = pendingPans.get(stream.id) ?? stream.targetPan;
  const activity = !stream.muted && !soloMuted && latestState.audioState === 'running' ? clamp((rms + 50) / 35, 0, 1) : 0;
  dot.style.setProperty('--activity', activity.toFixed(3));
  dot.classList.toggle('sound-active', activity > 0);
  dot.classList.toggle('solo-muted', soloMuted);
  dot.textContent = index + 1;
  dot.title = `${stream.title} · ${panText(visualPan)} · ドラッグまたは左右キーで配置を調整`;
  dot.disabled = busy || bypassed || !panWidth();
  dot.ariaLabel = `${index + 1}: ${stream.title} の配置`;
  dot.setAttribute('aria-valuemin', String(-Math.round(panWidth() * 100)));
  dot.setAttribute('aria-valuemax', String(Math.round(panWidth() * 100)));
  dot.setAttribute('aria-valuenow', String(Math.round(visualPan * 100)));
  if (dragging?.id !== stream.id) dot.setAttribute('aria-valuetext', panText(visualPan));
  dot.style.setProperty('--stream-color', color);
  if (dragging?.id !== stream.id) dot.style.left = `${50 + visualPan * 44}%`;
}

function updateSlider(key) {
  $(`${key}-value`).textContent = `${$(key).value}%`;
  $(key).style.setProperty('--fill', `${$(key).value}%`);
}

function render(state) {
  latestState = state;
  const controlled = new Set(state.streams.map((stream) => stream.id));
  if (dragging && (!controlled.has(dragging.id) || state.bypassed || !panWidth())) endDrag();
  for (const [id, card] of cards) {
    if (!controlled.has(id)) { card.remove(); cards.delete(id); dots.get(id).remove(); dots.delete(id); pendingPans.delete(id); }
  }
  state.streams.forEach(renderStream);
  $('empty').hidden = $('field-empty').hidden = state.streams.length > 0;
  $('count').textContent = `${state.streams.length} STREAM${state.streams.length === 1 ? '' : 'S'}`;
  document.querySelector('.stage-section').classList.toggle('bypassed', state.bypassed);
  $('bypass').textContent = state.bypassed ? 'ミックスを再開' : '全バイパス';
  $('bypass').setAttribute('aria-pressed', String(state.bypassed));
  $('bypass').disabled = busy || !state.streams.length;
  let heading = 'ミックス中';
  if (!state.streams.length) heading = '待機中';
  else if (state.bypassed) heading = 'バイパス中';
  else if (state.audioState !== 'running') heading = '一時停止中';
  else if (state.soloTabId != null) heading = 'ソロ再生中';
  $('mix-heading').textContent = heading;
  $('field-toolbar').hidden = !state.streams.length;
  if (!dragging) $('field-help').textContent = state.bypassed ? '配置を保持中 · 元の音声を再生' : !panWidth()
    ? '広がりを上げると配置を調整できます' : '数字をドラッグして配置を調整';
  $('reset-pans').hidden = !state.streams.some((stream) => Number.isFinite(stream.panPreference));
  $('reset-pans').disabled = busy || state.bypassed;
  $('stop-all').disabled = busy || !state.streams.length;
  $('resume').hidden = !state.streams.length || state.audioState === 'running';
  $('notice').textContent = state.notices.join('\n');
  $('notice').hidden = !state.notices.length;
  for (const key of ['volume', 'strength', 'spread']) {
    $(key).disabled = state.bypassed;
    if (!dirtySettings.has(key) && document.activeElement !== $(key)) $(key).value = Math.round(state.settings[key] * 100);
    updateSlider(key);
  }
  const isControlled = controlled.has(activeTab?.id);
  const canAdd = activeTab && /^https?:\/\//.test(activeTab.url ?? '') && activeTab.audible && !activeTab.mutedInfo?.muted;
  $('add').disabled = busy || isControlled || !canAdd;
  let addLabel = 'このタブを追加';
  if (busy) addLabel = '処理中…';
  else if (isControlled) addLabel = '追加済み';
  $('add-label').textContent = addLabel;
  $('add-icon').textContent = isControlled ? '✓' : '＋';
  let addHelp = '音声が出ている Web ページで拡張を開いてください。';
  if (isControlled) addHelp = 'このタブは追加済みです。popup を閉じても音声の調整は続きます。';
  else if (activeTab?.mutedInfo?.muted) addHelp = 'タブのミュートを解除してから追加してください。';
  else if (canAdd) addHelp = activeTab.title;
  $('add-help').textContent = addHelp;
  $('add').title = addHelp;
  $('add-help').hidden = Boolean(isControlled || canAdd);
  const candidates = state.audibleTabs.filter((tab) => tab.id !== activeTab?.id);
  $('candidates-section').hidden = !candidates.length;
  $('candidate-count').textContent = candidates.length;
  const key = JSON.stringify(candidates);
  if (candidateKey !== key) {
    candidateKey = key;
    $('candidates').replaceChildren(...candidates.map((tab) => {
      const button = document.createElement('button');
      button.className = 'candidate-button';
      button.textContent = `↗ ${tab.title}${tab.muted ? '（ミュート）' : ''}`;
      button.title = tab.title;
      button.addEventListener('click', async () => {
        try {
          const selected = await chrome.tabs.update(tab.id, { active: true });
          await chrome.windows.update(selected.windowId, { focused: true });
          window.close();
        } catch (error) { showError(error); }
      });
      return button;
    }));
  }
}

async function refresh() {
  if (polling) return;
  polling = true;
  try {
    if (activeTab) activeTab = await chrome.tabs.get(activeTab.id).catch(() => undefined);
    render(await request('STATE'));
  } catch (error) { showError(error); }
  finally { polling = false; }
}

async function act(type, payload) {
  if (busy) return;
  busy = true;
  showError(null);
  $('add').disabled = $('stop-all').disabled = $('bypass').disabled = $('reset-pans').disabled = true;
  for (const control of document.querySelectorAll('.nr-button, .solo-button, .remove-button, .position-dot')) control.disabled = true;
  try { return await request(type, payload); }
  catch (error) { showError(error); }
  finally { busy = false; await refresh(); }
}

function saveSettings() {
  clearTimeout(settingsTimer);
  if (!dirtySettings.size) return;
  const keys = [...dirtySettings];
  const settings = Object.fromEntries(keys.map((key) => [key, Number($(key).value) / 100]));
  saving = saving.then(async () => {
    try {
      await request('SETTINGS', { settings });
      for (const key of keys) if (Number($(key).value) / 100 === settings[key]) dirtySettings.delete(key);
    } catch (error) { showError(error); }
  });
}

for (const key of ['volume', 'strength', 'spread']) {
  updateSlider(key);
  $(key).addEventListener('input', () => {
    dirtySettings.add(key);
    updateSlider(key);
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(saveSettings, 60);
  });
  $(key).addEventListener('change', saveSettings);
}
$('add').addEventListener('click', () => act('START', { tabId: activeTab?.id }));
$('stop-all').addEventListener('click', () => act('STOP_ALL'));
$('bypass').addEventListener('click', () => act('BYPASS', { enabled: !latestState?.bypassed }));
$('reset-pans').addEventListener('click', () => act('RESET_PANS'));
$('resume').addEventListener('click', () => act('RESUME'));
window.addEventListener('pagehide', saveSettings);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && dragging) { event.preventDefault(); event.stopPropagation(); endDrag(); }
});

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
  const timer = setInterval(refresh, 200);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
init().catch(showError);
