const $ = (id) => document.getElementById(id);
const colors = ['#c1ed8b', '#9acbe9', '#dfb1dc', '#efca83', '#9ce0cb', '#edab99'];
const cards = new Map();
const dots = new Map();
const dirtySettings = new Set();
let activeTab;
let busy = false;
let polling = false;
let candidateKey = '';
let settingsTimer;
let saving = Promise.resolve();

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

function renderStream(stream, index) {
  let card = cards.get(stream.id);
  if (!card) {
    card = $('stream-template').content.firstElementChild.cloneNode(true);
    card.querySelector('.remove-button').addEventListener('click', () => act('STOP', { tabId: stream.id }));
    cards.set(stream.id, card);
    $('streams').append(card);
    const dot = document.createElement('div');
    dot.className = 'position-dot';
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
  const playing = stream.inputDb > -50;
  state.textContent = stream.muted ? 'タブがミュートされています' : playing ? '● 音声を調整中' : '○ 無音・一時停止';
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
  card.querySelector('.correction').textContent = `${correction > 0 ? '+' : ''}${correction.toFixed(1)} dB`;
  card.querySelector('.limiter-label').textContent = stream.limitingDb < -0.5 ? `ピーク抑制 ${stream.limitingDb.toFixed(1)}` : '';
  card.querySelector('.pan-track i').style.left = `${(stream.pan + 1) * 50}%`;
  card.querySelector('.pan-value').textContent = panText(stream.pan);
  const dot = dots.get(stream.id);
  dot.textContent = index + 1;
  dot.title = `${stream.title} · ${panText(stream.pan)}`;
  dot.style.setProperty('--stream-color', color);
  dot.style.left = `${50 + stream.pan * 44}%`;
}

function updateSlider(key) {
  $(`${key}-value`).textContent = `${$(key).value}%`;
  $(key).style.setProperty('--fill', `${$(key).value}%`);
}

function render(state) {
  const controlled = new Set(state.streams.map((stream) => stream.id));
  for (const [id, card] of cards) {
    if (!controlled.has(id)) { card.remove(); cards.delete(id); dots.get(id).remove(); dots.delete(id); }
  }
  state.streams.forEach(renderStream);
  $('empty').hidden = $('field-empty').hidden = state.streams.length > 0;
  $('count').textContent = `${state.streams.length} STREAM${state.streams.length === 1 ? '' : 'S'}`;
  $('status').textContent = !state.streams.length ? 'STANDBY' : state.audioState === 'running' ? '● LIVE MIX' : 'PAUSED';
  $('status').classList.toggle('live', state.streams.length > 0 && state.audioState === 'running');
  $('stop-all').disabled = busy || !state.streams.length;
  $('resume').hidden = !state.streams.length || state.audioState === 'running';
  $('notice').textContent = state.notices.join('\n');
  $('notice').hidden = !state.notices.length;
  for (const key of ['volume', 'strength', 'spread']) {
    if (!dirtySettings.has(key) && document.activeElement !== $(key)) $(key).value = Math.round(state.settings[key] * 100);
    updateSlider(key);
  }
  const isControlled = controlled.has(activeTab?.id);
  const canAdd = activeTab && /^https?:\/\//.test(activeTab.url ?? '') && activeTab.audible && !activeTab.mutedInfo?.muted;
  $('add').disabled = busy || isControlled || !canAdd;
  $('add-label').textContent = busy ? '処理しています…' : isControlled ? 'このタブはミックス中' : 'このタブを追加';
  $('add-help').textContent = isControlled ? 'popup を閉じても音声の調整は続きます。' : activeTab?.mutedInfo?.muted
    ? 'タブのミュートを解除してから追加してください。' : canAdd
      ? activeTab.title : '音声が出ている Web ページで拡張を開いてください。';
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
  $('add').disabled = $('stop-all').disabled = true;
  try { await request(type, payload); }
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
$('resume').addEventListener('click', () => act('RESUME'));
window.addEventListener('pagehide', saveSettings);

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
  const timer = setInterval(refresh, 200);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
init().catch(showError);
