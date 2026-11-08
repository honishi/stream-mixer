import { localizeDocument, t } from './shared/i18n.js';
import { clamp, DEFAULT_SETTINGS, panPositions } from './shared/settings.js';

/** @returns {HTMLElement | null} */
function $(id) {
  return document.getElementById(id);
}
const colors = ['var(--stream-1)', 'var(--stream-2)', 'var(--stream-3)', 'var(--stream-4)', 'var(--stream-5)', 'var(--stream-6)'];
const cards = new Map();
const dots = new Map();
const pendingPans = new Map();
const dirtySettings = new Set();
let activeTab;
let busy = false;
let polling = false;
let previewPolling = false;
let errorSource;
let candidateKey = '';
let settingsTimer;
let saving = Promise.resolve();
let latestState;
let dragging;
let cardDrag;

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'worker', type, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? t('connectionError'));
  return response.data;
}

function showError(error, source = 'action') {
  errorSource = error ? source : undefined;
  $('error').textContent = error?.message ?? '';
  $('error').hidden = !error;
}

/** @returns {number} */
function meterPercent(db) {
  return clamp((db + 60) / 60 * 100, 0, 100);
}

/** @returns {string} */
function panText(pan) {
  if (Math.abs(pan) < 0.015) return t('center');
  return t(pan < 0 ? 'panLeft' : 'panRight', [Math.round(Math.abs(pan) * 100)]);
}

/** @returns {number} */
function panWidth() {
  return panPositions(2, latestState?.settings.spread ?? 0)[1];
}

function endDrag(commit = false) {
  if (!dragging) return;
  const drag = dragging;
  // Keep the dropped marker anchored while the engine decides the new layout.
  if (commit && drag.moved) pendingPans.set(drag.id, drag.pan);
  dragging = undefined;
  drag.dot.classList.remove('dragging');
  if (drag.dot.hasPointerCapture(drag.pointerId)) drag.dot.releasePointerCapture(drag.pointerId);
  const releaseFocus = () => { clearInterval(drag.heartbeat); drag.port.disconnect(); };
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
    }).finally(releaseFocus);
  } else {
    releaseFocus();
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
    $('field-help').textContent = t('dragFocusHelp');
  });
  const move = (event) => {
    if (dragging?.id !== id || dragging.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - dragging.startX) > 3) dragging.moved = true;
    if (!dragging.moved) return;
    const field = document.querySelector('.stereo-field').getBoundingClientRect();
    dragging.pan = clamp(((event.clientX - dragging.offset - field.left) / field.width - 0.5) / 0.44, -panWidth(), panWidth());
    dot.style.left = `${50 + dragging.pan * 44}%`;
    dot.setAttribute('aria-valuetext', t('preferredPan', [panText(dragging.pan)]));
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
    const width = panWidth();
    let pan;
    switch (event.key) {
      case 'Home': pan = -width; break;
      case 'End': pan = width; break;
      case 'ArrowLeft': pan = stream.targetPan - width * 0.2; break;
      case 'ArrowRight': pan = stream.targetPan + width * 0.2; break;
    }
    void act('PAN_PREFERENCE', { tabId: id, pan });
  });
}

function clearDropIndicators() {
  for (const card of cards.values()) card.classList.remove('drop-before', 'drop-after');
}

function endCardDrag() {
  cardDrag = undefined;
  clearDropIndicators();
  for (const card of cards.values()) card.classList.remove('card-dragging');
}

function attachCardReorder(card, id) {
  card.addEventListener('pointerdown', (event) => {
    card.draggable = event.button === 0 && !event.target.closest('button, input, select');
  });
  card.addEventListener('dragstart', (event) => {
    if (busy || dragging || latestState.streams.length < 2) { event.preventDefault(); return; }
    cardDrag = { id };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(id));
    card.classList.add('card-dragging');
  });
  card.addEventListener('dragover', (event) => {
    if (!cardDrag || busy) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDropIndicators();
    if (cardDrag.id === id) return;
    const rect = card.getBoundingClientRect();
    card.classList.add(event.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after');
  });
  card.addEventListener('dragleave', (event) => {
    if (!card.contains(event.relatedTarget)) card.classList.remove('drop-before', 'drop-after');
  });
  card.addEventListener('drop', (event) => {
    if (!cardDrag || busy) return;
    event.preventDefault();
    const tabId = cardDrag.id;
    endCardDrag();
    if (tabId === id) return;
    const remaining = latestState.streams.filter((stream) => stream.id !== tabId);
    const rect = card.getBoundingClientRect();
    const index = remaining.findIndex((stream) => stream.id === id);
    const beforeTabId = remaining[index + (event.clientX < rect.left + rect.width / 2 ? 0 : 1)]?.id ?? null;
    void act('REORDER', { tabId, beforeTabId });
  });
  card.addEventListener('dragend', endCardDrag);
  card.addEventListener('keydown', (event) => {
    if (event.target !== card || busy || dragging || cardDrag) return;
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 };
    if (!Object.hasOwn(offsets, event.key) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = latestState.streams.findIndex((stream) => stream.id === id);
    let next = clamp(index + (offsets[event.key] ?? 0), 0, latestState.streams.length - 1);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = latestState.streams.length - 1;
    if (next === index) return;
    const remaining = latestState.streams.filter((stream) => stream.id !== id);
    void act('REORDER', { tabId: id, beforeTabId: remaining[next]?.id ?? null }).then(() => card.focus({ preventScroll: true }));
  });
}

/** @returns {HTMLElement} */
function createStreamCard(id) {
  const card = $('stream-template').content.firstElementChild.cloneNode(true);
  attachCardReorder(card, id);
  card.querySelector('.remove-button').addEventListener('click', () => act('STOP', { tabId: id }));
  card.querySelector('.solo-button').addEventListener('click', () => act('TOGGLE_SOLO', { tabId: id }));
  card.querySelector('.focus-button').addEventListener('click', () => act('TOGGLE_FOCUS', { tabId: id }));
  card.querySelector('.mute-button').addEventListener('click', () => act('TOGGLE_MUTE', { tabId: id }));
  card.querySelector('.normalize-button').addEventListener('click', () => act('TOGGLE_NORMALIZE', { tabId: id }));
  card.querySelector('.trim-level').addEventListener('change', (event) => {
    void act('VOLUME_TRIM', { tabId: id, trimDb: Number(event.currentTarget.value) });
  });
  card.querySelector('.nr-level').addEventListener('change', (event) => {
    void act('NR_LEVEL', { tabId: id, level: event.currentTarget.value });
  });
  card.querySelector('.nr-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (busy) return;
    button.setAttribute('aria-busy', 'true');
    try { await act('TOGGLE_NR', { tabId: id }); }
    finally { button.removeAttribute('aria-busy'); }
  });
  cards.set(id, card);
  $('streams').append(card);
  const dot = document.createElement('button');
  dot.className = 'position-dot';
  const number = document.createElement('span');
  number.className = 'position-number';
  const preview = document.createElement('img');
  preview.className = 'position-preview';
  preview.alt = '';
  preview.draggable = false;
  preview.hidden = true;
  dot.append(number, preview);
  attachPanControl(dot, id);
  dots.set(id, dot);
  $('positions').append(dot);
  return card;
}

/** @returns {void} */
function renderStreamControls(card, stream) {
  const bypassed = latestState.bypassed;
  const muteButton = card.querySelector('.mute-button');
  muteButton.setAttribute('aria-pressed', String(stream.mixMuted));
  muteButton.disabled = busy;
  muteButton.ariaLabel = t(stream.mixMuted ? 'unmuteStream' : 'muteStream', [stream.title]);
  muteButton.title = t(stream.mixMuted ? 'unmuteHint' : 'muteHint');
  const normalizeButton = card.querySelector('.normalize-button');
  normalizeButton.setAttribute('aria-pressed', String(stream.normalizeEnabled));
  normalizeButton.disabled = busy || bypassed;
  normalizeButton.ariaLabel = t(stream.normalizeEnabled ? 'normalizeDisable' : 'normalizeEnable', [stream.title]);
  const normalizeHint = stream.normalizeEnabled ? 'normalizeDisableHint' : 'normalizeEnableHint';
  normalizeButton.title = bypassed ? t('resumeBeforeNormalize')
    : `${t('normalize')}: ${t(normalizeHint)}`;
  const trimLevel = card.querySelector('.trim-level');
  if (!busy) trimLevel.value = String(stream.trimDb);
  trimLevel.disabled = busy || bypassed;
  trimLevel.dataset.reduced = String(stream.trimDb < 0);
  trimLevel.ariaLabel = t('trimLabel', [stream.title]);
  trimLevel.title = t(bypassed ? 'trimBypassed' : 'trimHint');
  const nrButton = card.querySelector('.nr-button');
  nrButton.setAttribute('aria-pressed', String(stream.noiseReductionEnabled));
  nrButton.disabled = busy || bypassed;
  nrButton.ariaLabel = t(stream.noiseReductionEnabled ? 'nrDisable' : 'nrEnable', [stream.title]);
  nrButton.title = bypassed ? t('nrBypassed') : t('nrHint');
  const nrLevel = card.querySelector('.nr-level');
  if (!busy) nrLevel.value = stream.noiseReductionLevel;
  nrLevel.disabled = busy || bypassed;
  nrLevel.ariaLabel = t('nrStrengthLabel', [stream.title]);
  nrLevel.title = bypassed ? t('nrBypassed') : t('nrStrengthHint');
  const soloButton = card.querySelector('.solo-button');
  const selectedSolo = latestState.dragFocusTabId == null && latestState.selectedSoloTabId === stream.id;
  soloButton.setAttribute('aria-pressed', String(selectedSolo));
  soloButton.disabled = busy || bypassed;
  soloButton.ariaLabel = t(selectedSolo ? 'soloDisable' : 'soloEnable', [stream.title]);
  soloButton.title = `${t('solo')}: ${t(selectedSolo ? 'soloDisableHint' : 'soloEnableHint')}`;
  const focusButton = card.querySelector('.focus-button');
  const selectedFocus = (latestState.dragFocusTabId == null
    ? latestState.selectedFocusTabIds : latestState.focusTabIds).includes(stream.id);
  focusButton.setAttribute('aria-pressed', String(selectedFocus));
  focusButton.disabled = busy || bypassed;
  focusButton.ariaLabel = t(selectedFocus ? 'focusDisable' : 'focusEnable', [stream.title]);
  const focusHint = selectedFocus ? 'focusDisableHint' : 'focusEnableHint';
  focusButton.title = t(bypassed ? 'resumeBeforeFocus' : focusHint);
}

/** @returns {void} */
function renderStreamMeters(card, stream) {
  const bypassed = latestState.bypassed;
  const rms = Math.max(...stream.rms);
  card.querySelector('.level-value').textContent = rms <= -60 ? '−∞' : `${rms.toFixed(0)} dB`;
  card.querySelector('.meter-group').ariaLabel = t('outputLevel', [rms <= -60 ? t('silent') : `${rms.toFixed(0)} dBFS`]);
  for (const [c, side] of ['left', 'right'].entries()) {
    card.querySelector(`.meter-fill.${side}`).style.width = `${meterPercent(stream.rms[c])}%`;
    const peak = card.querySelector(`.peak-tick.${side}`);
    peak.style.left = `${Math.min(99, meterPercent(stream.peak[c]))}%`;
    peak.hidden = stream.peak[c] < -60;
  }
  const correction = Math.abs(stream.correctionDb) < 0.05 ? 0 : stream.correctionDb;
  const correctionText = `${correction > 0 ? '+' : ''}${correction.toFixed(1)} dB`;
  card.querySelector('.correction').textContent = bypassed ? '—' : correctionText;
  const limiterLabel = card.querySelector('.limiter-label');
  limiterLabel.textContent = !bypassed && stream.limitingDb < -0.5 ? t('limiting', [stream.limitingDb.toFixed(1)]) : '';
  limiterLabel.title = limiterLabel.textContent;
  card.querySelector('.pan-track i').style.left = `${((bypassed ? 0 : stream.pan) + 1) * 50}%`;
  card.querySelector('.pan-value').textContent = bypassed ? t('bypassMeter') : panText(stream.pan);
}

/** @returns {void} */
function renderPositionDot(stream, index) {
  const bypassed = latestState.bypassed;
  const soloMuted = latestState.soloTabId != null && latestState.soloTabId !== stream.id;
  const rms = Math.max(...stream.rms);
  const color = colors[stream.color % colors.length];
  const dot = dots.get(stream.id);
  const visualPan = pendingPans.get(stream.id) ?? stream.targetPan;
  const activity = !stream.muted && !stream.mixMuted && !soloMuted && latestState.audioState === 'running' ? clamp((rms + 50) / 35, 0, 1) : 0;
  dot.style.setProperty('--activity', activity.toFixed(3));
  dot.classList.toggle('sound-active', activity > 0);
  dot.classList.toggle('solo-muted', soloMuted || stream.mixMuted);
  dot.querySelector('.position-number').textContent = index + 1;
  dot.title = t('panHint', [stream.title, panText(visualPan)]);
  dot.disabled = busy || bypassed || !panWidth();
  dot.ariaLabel = t('panLabel', [index + 1, stream.title]);
  dot.setAttribute('aria-valuemin', String(-Math.round(panWidth() * 100)));
  dot.setAttribute('aria-valuemax', String(Math.round(panWidth() * 100)));
  dot.setAttribute('aria-valuenow', String(Math.round(visualPan * 100)));
  if (dragging?.id !== stream.id) dot.setAttribute('aria-valuetext', panText(visualPan));
  dot.style.setProperty('--stream-color', color);
  if (dragging?.id !== stream.id) dot.style.left = `${50 + visualPan * 44}%`;
}

/** @returns {void} */
function renderStream(stream, index) {
  const card = cards.get(stream.id) ?? createStreamCard(stream.id);
  const color = colors[stream.color % colors.length];
  card.ariaLabel = t('reorderCard', [stream.title]);
  card.querySelector('.stream-visual').title = t('reorderHint');
  card.style.setProperty('--stream-color', color);
  card.querySelector('.stream-number').textContent = String(index + 1).padStart(2, '0');
  const heading = card.querySelector('h3');
  heading.textContent = stream.title;
  heading.title = stream.title;
  card.querySelector('.stream-preview').alt = t('videoSnapshot', [stream.title]);
  card.querySelector('.remove-button').ariaLabel = t('removeTab', [stream.title]);
  card.querySelector('.remove-button').disabled = busy;
  const state = card.querySelector('.stream-state');
  const bypassed = latestState.bypassed;
  renderStreamControls(card, stream);
  const soloMuted = latestState.soloTabId != null && latestState.soloTabId !== stream.id;
  const playing = (bypassed ? Math.max(...stream.rms) : stream.inputDb) > -50;
  let stateKey = 'silentState';
  if (stream.muted) stateKey = 'tabMuted';
  else if (stream.mixMuted) stateKey = 'mixMutedState';
  else if (soloMuted) stateKey = 'otherSolo';
  else if (latestState.dragFocusTabId === stream.id && latestState.focusTabIds.includes(stream.id)) stateKey = 'dragFocusState';
  else if (latestState.soloTabId === stream.id) stateKey = 'soloState';
  else if (bypassed) stateKey = 'bypassState';
  else if (latestState.focusTabIds.includes(stream.id)) stateKey = 'focusState';
  else if (latestState.focusTabIds.length > 0) stateKey = 'otherFocus';
  else if (playing) stateKey = 'playingState';
  state.textContent = t(stateKey);
  state.title = state.textContent;
  state.classList.toggle('playing', playing && !stream.muted && !stream.mixMuted && !soloMuted);
  renderStreamMeters(card, stream);
  renderPositionDot(stream, index);
}

function updateSlider(key) {
  $(`${key}-value`).textContent = `${$(key).value}%`;
  $(key).style.setProperty('--fill', `${$(key).value}%`);
}

/** @returns {void} */
function renderAddButton(isControlled) {
  const canAdd = activeTab && /^https?:\/\//.test(activeTab.url ?? '') && activeTab.audible && !activeTab.mutedInfo?.muted;
  $('add').disabled = busy || isControlled || !canAdd;
  let labelKey = 'addTab';
  if (busy) labelKey = 'processing';
  else if (isControlled) labelKey = 'added';
  $('add-label').textContent = t(labelKey);
  $('add-icon').textContent = isControlled ? '✓' : '＋';
  let addHelp = t('addHelp');
  if (isControlled) addHelp = t('addedHelp');
  else if (activeTab?.mutedInfo?.muted) addHelp = t('unmuteHelp');
  else if (canAdd) addHelp = activeTab.title;
  $('add-help').textContent = addHelp;
  $('add').title = addHelp;
  $('add-help').hidden = Boolean(isControlled || canAdd);
}

/** @returns {void} */
function render(state) {
  latestState = state;
  const controlled = new Set(state.streams.map((stream) => stream.id));
  if (cardDrag && !controlled.has(cardDrag.id)) endCardDrag();
  if (dragging && (!controlled.has(dragging.id) || state.bypassed || !panWidth())) endDrag();
  for (const [id, card] of cards) {
    if (controlled.has(id)) continue;
    card.remove();
    cards.delete(id);
    dots.get(id).remove();
    dots.delete(id);
    pendingPans.delete(id);
  }
  state.streams.forEach(renderStream);
  state.streams.forEach((stream, index) => {
    // Move existing elements only when order changes, preserving controls and drags during polling.
    for (const [container, element] of [[$('streams'), cards.get(stream.id)], [$('positions'), dots.get(stream.id)]]) {
      if (container.children[index] !== element) container.insertBefore(element, container.children[index] ?? null);
    }
  });
  $('empty').hidden = $('field-empty').hidden = state.streams.length > 0;
  $('count').textContent = t(state.streams.length === 1 ? 'streamCountOne' : 'streamCountOther', [state.streams.length]);
  document.querySelector('.stage-section').classList.toggle('bypassed', state.bypassed);
  $('bypass').textContent = state.bypassed ? t('resumeMix') : t('bypassAll');
  $('bypass').setAttribute('aria-pressed', String(state.bypassed));
  $('bypass').disabled = busy || !state.streams.length;
  let headingKey = 'mixing';
  if (!state.streams.length) headingKey = 'standby';
  else if (state.bypassed) headingKey = 'bypassed';
  else if (state.audioState !== 'running') headingKey = 'paused';
  else if (state.soloTabId != null) headingKey = 'soloHeading';
  else if (state.focusTabIds?.length > 0) headingKey = 'focusHeading';
  $('mix-heading').textContent = t(headingKey);
  $('field-toolbar').hidden = !state.streams.length;
  if (!dragging) {
    let helpKey = 'dragHelp';
    if (state.bypassed) helpKey = 'bypassHelp';
    else if (!panWidth()) helpKey = 'spreadHelp';
    $('field-help').textContent = t(helpKey);
  }
  $('reset-pans').hidden = !state.streams.some((stream) => Number.isFinite(stream.panPreference));
  $('reset-pans').disabled = busy || state.bypassed;
  $('reset-settings').disabled = state.bypassed;
  $('stop-all').disabled = busy || !state.streams.length;
  $('resume').hidden = !state.streams.length || state.audioState === 'running';
  $('notice').textContent = state.notices.join('\n');
  $('notice').hidden = !state.notices.length;
  for (const key of ['volume', 'strength', 'spread']) {
    $(key).disabled = state.bypassed;
    if (!dirtySettings.has(key) && document.activeElement !== $(key)) $(key).value = Math.round(state.settings[key] * 100);
    updateSlider(key);
  }
  renderAddButton(controlled.has(activeTab?.id));
  const candidates = state.audibleTabs.filter((tab) => tab.id !== activeTab?.id);
  $('candidates-section').hidden = !candidates.length;
  $('candidate-count').textContent = candidates.length;
  const key = JSON.stringify(candidates);
  if (candidateKey !== key) {
    candidateKey = key;
    $('candidates').replaceChildren(...candidates.map((tab) => {
      const button = document.createElement('button');
      button.className = 'candidate-button';
      button.textContent = t(tab.muted ? 'candidateMuted' : 'candidate', [tab.title]);
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
    if (errorSource === 'poll') showError(null);
  } catch (error) {
    if (errorSource !== 'action') showError(error, 'poll');
  }
  finally { polling = false; }
}

/** @returns {void} */
function updateStreamPreviews(id, card, image) {
  // Ignore captures from a card that was removed or replaced while awaiting a snapshot.
  if (!card || cards.get(id) !== card) return;
  for (const preview of [card.querySelector('.stream-preview'), dots.get(id).querySelector('.position-preview')]) {
    preview.hidden = !image;
    if (image) {
      if (preview.getAttribute('src') !== image) preview.src = image;
    } else preview.removeAttribute('src');
  }
}

async function refreshPreviews() {
  if (previewPolling || !cards.size) return;
  previewPolling = true;
  const requestedCards = new Map(cards);
  try {
    const snapshots = await request('VIDEO_SNAPSHOTS');
    for (const { id, image } of snapshots) {
      updateStreamPreviews(id, requestedCards.get(id), image);
    }
  } catch {
    // Thumbnails are optional; failures must not interrupt audio controls.
    for (const [id, card] of requestedCards) updateStreamPreviews(id, card, null);
  } finally { previewPolling = false; }
}

async function act(type, payload) {
  if (busy) return;
  busy = true;
  showError(null);
  $('add').disabled = $('stop-all').disabled = $('bypass').disabled = $('reset-pans').disabled = true;
  for (const control of document.querySelectorAll('.nr-button, .nr-level, .trim-level, .normalize-button, .solo-button, .focus-button, .mute-button, .remove-button, .position-dot')) control.disabled = true;
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

localizeDocument();

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
$('reset-settings').addEventListener('click', () => {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    $(key).value = Math.round(value * 100);
    dirtySettings.add(key);
    updateSlider(key);
  }
  saveSettings();
});
$('resume').addEventListener('click', () => act('RESUME'));
window.addEventListener('pagehide', saveSettings);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && dragging) { event.preventDefault(); event.stopPropagation(); endDrag(); }
});

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
  void refreshPreviews();
  const timer = setInterval(refresh, 200);
  const previewTimer = setInterval(refreshPreviews, 3000);
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    clearInterval(previewTimer);
  }, { once: true });
}
init().catch(showError);
