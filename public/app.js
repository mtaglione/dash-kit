// Dash Kit browser client: the WebRTC call (per OpenAI's GPT-Live WebRTC
// quickstart), the settings forms, the composer, and the views drawn from the
// server's event stream: the call log (grouped by call and by request; log.js),
// and a timeline shown either as the overlay (speech, audio and messages on one
// clock; overlay.js) or as the sequence diagram.
import { createOverlay } from './overlay.js';
import { createLog } from './log.js';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
};

const LANES = ['user', 'client', 'voice', 'orchestrator', 'subagent'];
const LANE_NAME = { user: 'You', client: 'App', voice: 'GPT-Live', orchestrator: 'Orchestrator', subagent: 'Subagents', system: 'App' };
const KIND_NAME = { thinking: 'Silent context', commentary: 'Spoken update', instructions: 'Instruction' };
const laneIndex = lane => (lane === 'system' ? 1 : Math.max(0, LANES.indexOf(lane)));
const QUIET_TYPES = new Set(['usage', 'event', 'subagent.usage', 'sideband.attach', 'info']);

let serverState = null;
let runStartedAt = Date.now();
const view = { thread: $('#thread'), timeline: $('#timeline') };
const rowNodes = new Map();      // event key -> timeline row
const eventsBySeq = new Map();
const log = createLog({ root: view.thread, empty: $('#thread-empty'), stop: id => api(`/api/subagents/${id}/stop`).catch(error => note(error.message, true)) });
const LIVE_STATES = ['attaching', 'live', 'closing'];
const overlay = createOverlay({ scroll: $('#ov-scroll'), detail: $('#ov-detail'), follow: () => $('#follow').checked,
  isLive: id => serverState?.call?.sessionId === id && LIVE_STATES.includes(serverState.call.state), rawEvent: seq => eventsBySeq.get(seq) });

/* ---------------- Server event stream ---------------- */
let socket, socketRetry = 500;
function connectSocket() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.addEventListener('open', () => { socketRetry = 500; });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'hello') {
      resetViews(); applyState(message.state, { force: true });
      for (const event of message.history) handleEvent(event);
      // The session rows are built from the history, so their state is set after it.
      log.setState(message.state);
    }
    else if (message.type === 'event') handleEvent(message.event);
    else if (message.type === 'state') applyState(message.state);
  });
  socket.addEventListener('close', () => { setTimeout(connectSocket, socketRetry); socketRetry = Math.min(socketRetry * 2, 8000); });
}
function clientEvent(name, label, data, extra = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'client-event', name, label, data, ...extra }));
}
async function api(path, body, method = 'POST') {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error ?? `Request failed (${response.status})`);
  return json;
}

function resetViews() {
  log.reset();
  view.timeline.replaceChildren();
  overlay.reset();
  for (const map of [rowNodes, eventsBySeq]) map.clear();
}

function handleEvent(event) {
  eventsBySeq.set(event.seq, event);
  try { log.handle(event); } catch (error) { console.error('Log row could not be drawn', event, error); }
  renderTimeline(event);
  overlay.handle(event);
}

/* ---------------- State: settings, call, subagents ---------------- */
function applyState(state, { force = false } = {}) {
  const first = !serverState;
  // Flipping the Boosker switch changes what the three tabs hold, so they are
  // filled again even where there were unsaved edits.
  const switched = !first && booskerOn(serverState) !== booskerOn(state);
  serverState = state;
  runStartedAt = state.runStartedAt ?? runStartedAt;
  if (first || force) fillOptions(state.options);
  for (const form of $$('form.settings')) if (force || switched || !form.dataset.dirty) fillForm(form, formValues(form.dataset.section, state.settings));
  // Delegation picker
  const select = $('#delegation-select');
  const chosen = select.value;
  const delegations = state.call?.state !== 'closed' ? state.call?.delegations ?? [] : [];
  select.replaceChildren(el('option', { value: '', text: 'General session context' }), el('option', { value: 'latest', text: 'Latest delegation' }),
    ...delegations.slice().reverse().map(d => el('option', { value: d.id, text: `Delegation …${d.id.slice(-6)} at ${(d.offsetMs / 1000).toFixed(1)}s` })));
  select.value = [...select.options].some(o => o.value === chosen) ? chosen : '';
  log.setState(state);
  showBoosker(state);
  if (!state.keyConfigured) note(`The server has no ${state.missingKey ?? 'API key'}. Add it to .env and restart.`, true);
}
/* Boosker mode is one switch. When it is on, a call runs through the Boosker
   broker (its real dispatcher and real Claude sessions), and the same three
   tabs hold Boosker's values in these fields: they are shown, saved and
   reloaded as Boosker's, apart from Dash Kit's own. */
const BOOSKER_FIELDS = { voice: { prompt: 'voicePrompt' }, orchestrator: { prompt: 'dispatcherPrompt', graceMs: 'graceMs' }, subagents: { prompt: 'lookupPrompt' } };
// Settings a Boosker call does not use; they are greyed out and left as they are.
const BOOSKER_UNUSED = { orchestrator: ['mode', 'resultRouting', 'model', 'effort'], subagents: ['engine', 'model', 'effort', 'webSearch', 'progressToVoice', 'progressIntervalMs', 'mockDurationMs'] };
const booskerOn = (state = serverState) => Boolean(state?.settings.boosker?.enabled);
// What a tab shows: its own section, with Boosker's values in the mapped fields.
function formValues(section, settings) {
  if (!settings.boosker?.enabled) return settings[section];
  return { ...settings[section], ...Object.fromEntries(Object.entries(BOOSKER_FIELDS[section] ?? {}).map(([field, key]) => [field, settings.boosker[key]])) };
}
// What a tab saves: the mapped fields as Boosker's, the unused ones not at all.
function formPatch(section, form) {
  const values = readForm(form);
  if (!booskerOn()) return { [section]: values };
  const boosker = {};
  for (const [field, key] of Object.entries(BOOSKER_FIELDS[section] ?? {})) { boosker[key] = values[field]; delete values[field]; }
  for (const field of BOOSKER_UNUSED[section] ?? []) delete values[field];
  return { [section]: values, boosker };
}
// The switch, the note under the tabs, the labels, and the greyed-out settings.
const plainText = new Map();   // element -> its wording when the switch is off
function showBoosker(state) {
  const info = state.boosker ?? { available: false, reason: 'Boosker mode is not set up on this server.' };
  const on = booskerOn(state);
  const toggle = $('#boosker-switch');
  toggle.checked = on;
  toggle.disabled = !info.available && !on;
  $('#boosker-switch-label').title = info.available ? 'Run calls through the Boosker broker and show its prompts in the three tabs' : info.reason;
  $('#boosker-switch-label').classList.toggle('error', on && !info.available);
  const noteNode = $('#boosker-note');
  noteNode.hidden = !on;
  noteNode.textContent = !on ? '' : info.available
    ? `Boosker mode: these tabs hold Boosker's prompts, and calls use its real dispatcher (${info.models.dispatcher}, ${info.models.dispatcherEffort}) and real Claude sessions (${info.models.worker}, ${info.models.workerEffort}) on this computer. Code from ${info.dir}${info.version ? ` (${info.version})` : ''}. Greyed-out settings are not used.${info.voicePromptNote ? ' ' + info.voicePromptNote : ''}`
    : `Boosker mode is on but cannot run: ${info.reason}`;
  for (const node of $$('[data-boosker]')) {
    if (!plainText.has(node)) plainText.set(node, node.innerHTML);
    if (on) node.textContent = node.dataset.boosker; else node.innerHTML = plainText.get(node);
  }
  for (const form of $$('form.settings')) {
    const unused = on ? BOOSKER_UNUSED[form.dataset.section] ?? [] : [];
    for (const input of $$('[name]', form)) { input.disabled = unused.includes(input.name); input.closest('label')?.classList.toggle('unused', input.disabled); }
    // "edited here": a Boosker prompt that differs from the one in the Boosker folder.
    for (const mark of $$('[data-differs]', form)) {
      const field = Object.entries(BOOSKER_FIELDS[form.dataset.section] ?? {}).find(([, key]) => key === mark.dataset.differs)?.[0];
      mark.hidden = !on || !info.defaults || !field || form.elements[field].value === info.defaults[mark.dataset.differs];
    }
  }
}
$('#boosker-switch').addEventListener('change', async event => {
  const on = event.target.checked;
  try { await api('/api/settings', { boosker: { enabled: on } }, 'PUT'); note(on ? "Boosker mode on. The tabs now hold Boosker's prompts; it applies to the next call." : "Boosker mode off. The tabs hold Dash Kit's own prompts again."); }
  catch (error) { event.target.checked = !on; note(error.message, true); }
});
function fillOptions(options) {
  if (!options) return;
  $('#form-voice [name=voice]').replaceChildren(...options.voices.map(v => el('option', { value: v, text: v })));
  for (const select of $$('select[name=effort]')) select.replaceChildren(...options.efforts.map(v => el('option', { value: v, text: v })));
  $('#models').replaceChildren(...options.models.map(m => el('option', { value: m })));
}
function fillForm(form, values) {
  for (const input of $$('[name]', form)) {
    const value = input.name.split('.').reduce((obj, key) => obj?.[key], values);
    if (value === undefined) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = value;
  }
  setDirty(form, false);
}
function readForm(form) {
  const out = {};
  for (const input of $$('[name]', form)) {
    const path = input.name.split('.');
    const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    let target = out;
    for (const key of path.slice(0, -1)) target = target[key] ??= {};
    target[path.at(-1)] = value;
  }
  return out;
}
function setDirty(form, dirty) { form.dataset.dirty = dirty ? '1' : ''; if (!dirty) delete form.dataset.dirty; $('.dirty', form).hidden = !dirty; }

for (const form of $$('form.settings')) {
  form.addEventListener('input', () => { setDirty(form, true); if (serverState) showBoosker(serverState); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const section = form.dataset.section;
    try {
      const saved = await api('/api/settings', formPatch(section, form), 'PUT');
      fillForm(form, formValues(section, saved));
      note(`${$('button[type=submit]', form).textContent.replace('Save ', '')} saved${booskerOn() ? ' (Boosker mode)' : ''}.`);
    } catch (error) { note(error.message, true); }
  });
  // In Boosker mode the button reloads this tab's Boosker values from the
  // Boosker folder and leaves Dash Kit's own settings alone.
  $('[data-reset]', form).addEventListener('click', async () => {
    const section = form.dataset.section, boosker = booskerOn();
    if (!confirm(boosker ? "Reload this tab's Boosker values from the Boosker folder? Your edits to them are replaced." : 'Restore the default settings for this section? Your edits here are replaced.')) return;
    try {
      const saved = await api('/api/settings/reset', boosker ? { section: 'boosker', fields: Object.values(BOOSKER_FIELDS[section] ?? {}) } : { section });
      fillForm(form, formValues(section, saved));
      note(boosker ? 'Reloaded from the Boosker folder.' : 'Defaults restored.');
    } catch (error) { note(error.message, true); }
  });
}
for (const tab of $$('#settings-tabs [role=tab]')) {
  tab.addEventListener('click', () => {
    for (const other of $$('#settings-tabs [role=tab]')) other.setAttribute('aria-selected', String(other === tab));
    for (const form of $$('form.settings')) form.hidden = form.dataset.section !== tab.dataset.tab;
  });
}
for (const button of $$('.tabs-mobile button')) {
  button.addEventListener('click', () => {
    $('#bench').dataset.show = button.dataset.show;
    for (const other of $$('.tabs-mobile button')) other.classList.toggle('active', other === button);
    if (button.dataset.show === 'right') overlay.refresh();
  });
}

/* ---------------- Call log (log.js) ---------------- */
const fmtTime = at => { const s = Math.max(0, (at - runStartedAt) / 1000); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const shortId = id => (id ? `…${String(id).slice(-6)}` : 'none');
// What the log shows is remembered on this device.
for (const [id, name] of [['#log-errors', 'only-errors'], ['#log-everything', 'show-low']]) {
  const box = $(id);
  const apply = () => { view.thread.classList.toggle(name, box.checked); localStorage.setItem(`dashkit.log.${name}`, box.checked ? '1' : ''); };
  box.checked = localStorage.getItem(`dashkit.log.${name}`) === '1';
  box.addEventListener('change', apply);
  apply();
}
// The composer folds away so the log has the screen; folded by default on a phone.
function showComposer(open) {
  $('#composer').classList.toggle('folded', !open);
  $('#btn-composer').setAttribute('aria-expanded', String(open));
  $('#btn-composer').textContent = open ? 'Hide composer' : 'Show composer';
  localStorage.setItem('dashkit.composer', open ? 'open' : 'folded');
}
$('#btn-composer').addEventListener('click', () => showComposer($('#composer').classList.contains('folded')));
showComposer((localStorage.getItem('dashkit.composer') ?? (window.innerWidth < 700 ? 'folded' : 'open')) === 'open');

/* ---------------- Timeline (sequence diagram) ---------------- */
$('#lanes-head').replaceChildren(el('span', { text: '' }), ...LANES.map(lane => el('span', { class: lane, text: LANE_NAME[lane] })));
function renderTimeline(e) {
  if (e.ephemeral || e.type === 'client.audio.levels') return;   // levels are drawn in the overlay
  const quiet = e.quiet || QUIET_TYPES.has(e.type) || e.type.startsWith('client.dc.') ;
  let row = e.key ? rowNodes.get(e.key) : null;
  const label = e.type === 'transcript' ? `${e.role === 'user' ? 'You' : 'Kit'}: ${e.text.trim()}` : e.label ?? e.type;
  const tag = e.sub ?? null;
  if (row) { row.dataset.seq = e.seq; $('.ev-text', row).textContent = label; return; }
  const a = laneIndex(e.from), b = laneIndex(e.to ?? e.from);
  const lanes = el('div', { class: 'ev-lanes' });
  if (a === b) lanes.append(el('span', { class: 'ev-dot', style: `left:${a * 20 + 10}%` }));
  else {
    const left = Math.min(a, b) * 20 + 10, width = Math.abs(a - b) * 20;
    lanes.append(el('span', { class: 'ev-dot', style: `left:${a * 20 + 10}%` }), el('span', { class: `ev-wire ${b > a ? 'to-right' : 'to-left'}`, style: `left:${left}%;width:${width}%` }));
  }
  lanes.append(el('div', { class: 'ev-label' }, tag ? el('span', { class: 'tag', text: tag }) : null, el('span', { class: 'ev-text', text: label })));
  row = el('li', { class: `ev c-${e.from} ${e.error || e.type.includes('error') || e.type === 'session.failed' ? 'is-error' : ''} ${quiet ? 'is-quiet' : ''}`, 'data-seq': e.seq, 'data-quiet': quiet || null, tabindex: 0 },
    el('span', { class: 'ev-time', text: fmtTime(e.at) }), lanes);
  if (e.key) rowNodes.set(e.key, row);
  view.timeline.append(row);
  if ($('#follow').checked) view.timeline.scrollTop = view.timeline.scrollHeight;
}
function toggleDetail(row) {
  const open = row.classList.toggle('open');
  $('.ev-detail', row)?.remove();
  if (!open) return;
  const event = eventsBySeq.get(Number(row.dataset.seq));
  row.append(el('pre', { class: 'ev-detail', text: JSON.stringify(event, null, 2) }));
}
view.timeline.addEventListener('click', event => { const row = event.target.closest('.ev'); if (row && !event.target.closest('.ev-detail')) toggleDetail(row); });
view.timeline.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('ev')) { event.preventDefault(); toggleDetail(event.target); } });
$('#show-quiet').addEventListener('change', event => view.timeline.classList.toggle('show-quiet', event.target.checked));

/* Timeline views: the overlay (default) or the sequence diagram. */
function showTimelineView(name) {
  $('.panel.right').dataset.view = name;
  for (const tab of $$('#timeline-views [role=tab]')) tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  localStorage.setItem('dashkit.timeline.view', name);
  if (name === 'overlay') overlay.refresh(); else if ($('#follow').checked) view.timeline.scrollTop = view.timeline.scrollHeight;
}
for (const tab of $$('#timeline-views [role=tab]')) tab.addEventListener('click', () => showTimelineView(tab.dataset.view));
showTimelineView(localStorage.getItem('dashkit.timeline.view') === 'sequence' ? 'sequence' : 'overlay');
for (const button of $$('[data-zoom]')) button.addEventListener('click', () => overlay.zoom(Number(button.dataset.zoom)));

/* ---------------- Composer ---------------- */
const composer = $('#composer');
let composerMode = 'inject';
for (const tab of $$('.composer-modes [role=tab]')) {
  tab.addEventListener('click', () => {
    composerMode = tab.dataset.mode;
    for (const other of $$('.composer-modes [role=tab]')) other.setAttribute('aria-selected', String(other === tab));
    for (const body of $$('.composer-body', composer)) body.hidden = body.dataset.mode !== composerMode;
  });
}
function note(text, isError = false) { const node = $('#composer-note'); node.textContent = text; node.classList.toggle('error', isError); }
async function inject(kind, content, delegationId) {
  try {
    const result = await api('/api/inject', { kind, content, delegationId: delegationId || null });
    note(`Sent ${KIND_NAME[kind].toLowerCase()}${result.delegationId ? ` for delegation ${shortId(result.delegationId)}` : ' as general session context'}.`);
    return true;
  } catch (error) { note(error.message, true); return false; }
}
composer.addEventListener('submit', async event => {
  event.preventDefault();
  if (composerMode === 'inject') {
    const kind = composer.kind.value, content = composer.content.value;
    if (!content.trim() && kind !== 'thinking') { note('Write something to send.', true); return; }
    if (await inject(kind, content, composer.delegationId.value)) composer.content.value = '';
  } else {
    const text = composer.typed.value.trim();
    if (!text) { note('Type a request first.', true); return; }
    try { await api('/api/request', { text, mirror: composer.mirror.checked }); composer.typed.value = ''; note('Sent to the orchestrator.'); }
    catch (error) { note(error.message, true); }
  }
});
composer.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) composer.requestSubmit(); });
const PRESETS = [
  { label: 'Cancel acknowledgement', kind: 'thinking', delegation: 'latest', content: '', title: 'Empty silent context on the latest delegation; cancels the pending spoken acknowledgement' },
  { label: 'Still working', kind: 'commentary', delegation: 'latest', content: "I'm still working on that. It should take a few more seconds." },
  { label: 'Fake result', kind: 'commentary', delegation: 'latest', content: 'The lookup finished: it is 64 degrees and sunny in Boston right now.' },
  { label: 'Quiet progress', kind: 'thinking', delegation: 'latest', content: 'Lookup in progress. No result yet.' },
  { label: 'Stop talking', kind: 'instructions', delegation: '', content: 'Stop speaking now. Wait silently until the user speaks.' },
  { label: 'Share UI context', kind: 'thinking', delegation: '', content: 'The user is watching the Dash Kit test bench: the conversation is in the middle, and a timeline of delegation events is on the right.' }
];
$('#presets').replaceChildren(...PRESETS.map(preset => el('button', { type: 'button', title: preset.title ?? `${KIND_NAME[preset.kind]}: ${preset.content}`, text: preset.label,
  onclick: () => inject(preset.kind, preset.content, preset.delegation) })));

/* ---------------- The call: WebRTC to GPT-Live ---------------- */
const audio = $('#remote-audio');
const call = { peer: null, events: null, microphone: null, closeTimer: null, ready: false, finalized: false, startedAt: 0, muted: false, sessionId: null };
let audioContext = null, meters = [];

function setStatus(state, text) { const node = $('#status'); node.dataset.state = state; node.textContent = text; }
function setButtons(phase) {
  $('#btn-connect').hidden = phase !== 'idle';
  $('#btn-hangup').hidden = phase === 'idle';
  $('#btn-hangup').disabled = phase !== 'live';
  $('#btn-mute').hidden = phase !== 'live';
}

async function startCall() {
  setButtons('connecting'); setStatus('connecting', 'Connecting');
  call.finalized = false; call.ready = false;
  try {
    audioContext ??= new AudioContext();
    await audioContext.resume();
    const connection = new RTCPeerConnection();
    call.peer = connection;
    connection.addEventListener('track', event => {
      const stream = new MediaStream([event.track]);
      audio.srcObject = stream;
      audio.play().then(() => { $('#btn-play').hidden = true; }).catch(() => { $('#btn-play').hidden = false; note('Tap "Play audio" to hear GPT-Live.'); });
      addMeter(stream, $('#meter-out'));
    });
    connection.addEventListener('connectionstatechange', () => {
      clientEvent(`pc.${connection.connectionState}`, `WebRTC ${connection.connectionState}`, null, { quiet: connection.connectionState !== 'failed' });
      if (connection.connectionState === 'failed' && call.peer === connection) { setStatus('error', 'Connection failed'); cleanup(); }
    });
    call.microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    for (const track of call.microphone.getAudioTracks()) connection.addTrack(track, call.microphone);
    addMeter(call.microphone, $('#meter-mic'));
    clientEvent('mic', 'Microphone on', null, { quiet: true });

    // Create the event channel before the SDP offer.
    const events = connection.createDataChannel('oai-events');
    call.events = events;
    events.addEventListener('message', ({ data }) => onChannelEvent(JSON.parse(data)));
    events.addEventListener('close', () => {
      if (call.events !== events) return;
      if (!call.finalized) { setStatus('error', 'Disconnected before the session closed'); clientEvent('dc.closed', 'Data channel closed before session.closed; final usage unconfirmed'); cleanup(); }
    });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await iceGathered(connection);
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error('Missing local SDP offer');
    const result = await api('/api/session', { sdp });
    await connection.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp });
    // The HTTP request started the session. session.start is never sent here.
  } catch (error) {
    setStatus('error', error.name === 'NotAllowedError' ? 'Microphone blocked' : 'Could not connect');
    note(error.name === 'NotAllowedError' ? 'Allow microphone access for this page, then start the call again.' : error.message, true);
    clientEvent('connect.failed', `Connect failed: ${error.message}`);
    cleanup();
  }
}
function iceGathered(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { connection.removeEventListener('icegatheringstatechange', check); reject(new Error('Timed out while gathering ICE candidates')); }, 10000);
    function check() { if (connection.iceGatheringState !== 'complete') return; clearTimeout(timeout); connection.removeEventListener('icegatheringstatechange', check); resolve(); }
    connection.addEventListener('icegatheringstatechange', check);
  });
}
function onChannelEvent(event) {
  switch (event.type) {
    case 'session.started':
      call.ready = true; call.startedAt = Date.now(); call.sessionId = event.session?.id ?? null;
      levels.mic = []; levels.out = []; levels.peak = { mic: 0, out: 0 }; levels.bucketAt = call.startedAt; levels.firstAt = call.startedAt;
      setButtons('live'); setStatus('live', 'Live');
      clientEvent('session.started', `Data channel: session.started (${shortId(event.session?.id)})`, { sessionId: event.session?.id }, { from: 'voice', to: 'client' });
      break;
    case 'session.closed':
      call.finalized = true;
      setStatus('idle', 'Call ended');
      clientEvent('session.closed', `Data channel: session.closed (${event.reason ?? 'unknown'})`, { reason: event.reason, usage: event.usage }, { from: 'voice', to: 'client', quiet: true });
      cleanup();
      break;
    case 'error':
      clientEvent('dc.error', `Data channel error: ${event.error?.message ?? 'unknown'}`, event, { from: 'voice', to: 'client' });
      break;
    case 'info':
      clientEvent('dc.info', `Data channel: ${event.code}: ${event.message}`, event, { from: 'voice', to: 'client', quiet: true });
      break;
  }
}
function hangUp() {
  if (!call.ready || call.events?.readyState !== 'open') { api('/api/session/close').catch(() => {}); cleanup(); setStatus('idle', 'Idle'); return; }
  $('#btn-hangup').disabled = true;
  setStatus('closing', 'Finishing');
  // Keep media and events open until session.closed arrives.
  call.events.send(JSON.stringify({ type: 'session.close', event_id: `close_${Date.now()}` }));
  clientEvent('session.close', 'Data channel: session.close', null, { to: 'voice' });
  call.closeTimer = setTimeout(() => { setStatus('error', 'No session.closed; usage unconfirmed'); cleanup(); }, 15000);
}
function cleanup() {
  clearTimeout(call.closeTimer);
  sendLevels();
  call.microphone?.getTracks().forEach(track => track.stop());
  const events = call.events; call.events = null; events?.close();
  call.peer?.close(); call.peer = null;
  audio.srcObject = null; call.ready = false; call.muted = false;
  $('#btn-mute').setAttribute('aria-pressed', 'false'); $('#btn-mute').textContent = 'Mute mic';
  meters = [];
  for (const id of ['#meter-mic', '#meter-out']) $(id).style.width = '0';
  setButtons('idle');
}

/* Level meters from Web Audio analysers */
function addMeter(stream, bar) {
  try {
    const analyser = audioContext.createAnalyser(); analyser.fftSize = 512;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    meters.push({ analyser, bar, data: new Uint8Array(analyser.fftSize), side: bar.id === 'meter-mic' ? 'mic' : 'out' });
  } catch { /* meters are optional */ }
}
function meterLevel(meter) {
  meter.analyser.getByteTimeDomainData(meter.data);
  let sum = 0; for (const v of meter.data) { const x = (v - 128) / 128; sum += x * x; }
  return Math.min(100, Math.sqrt(sum / meter.data.length) * 320);
}
// Audio levels for the overlay. Each side's loudest reading per LEVEL_STEP is
// kept, and a batch goes to the server every LEVEL_BATCH readings as a
// client.audio.levels event, timed from this call's session.started. A batch
// with no sound on either side is not sent.
const LEVEL_STEP = 200, LEVEL_BATCH = 10;
const levels = { mic: [], out: [], peak: { mic: 0, out: 0 }, bucketAt: 0, firstAt: 0 };
function sendLevels() {
  if (levels.mic.length && call.sessionId && [...levels.mic, ...levels.out].some(v => v >= 3)) {
    clientEvent('audio.levels', 'Audio levels', { sessionId: call.sessionId, t: levels.firstAt - call.startedAt, step: LEVEL_STEP, mic: levels.mic, out: levels.out }, { quiet: true });
  }
  levels.mic = []; levels.out = []; levels.firstAt = levels.bucketAt;
}
setInterval(() => {
  if (!call.ready) return;
  for (const meter of meters) levels.peak[meter.side] = Math.max(levels.peak[meter.side], meterLevel(meter));
  const now = Date.now();
  while (now - levels.bucketAt >= LEVEL_STEP) {
    if (!levels.mic.length) levels.firstAt = levels.bucketAt;
    levels.mic.push(Math.round(levels.peak.mic)); levels.out.push(Math.round(levels.peak.out));
    levels.peak = { mic: 0, out: 0 }; levels.bucketAt += LEVEL_STEP;
    if (levels.mic.length >= LEVEL_BATCH) sendLevels();
  }
}, 50);
(function drawMeters() {
  for (const meter of meters) meter.bar.style.width = `${meterLevel(meter)}%`;
  const clock = $('#clock');
  if (call.ready) {
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} on call, ${serverState?.call?.usageSeconds ?? 0}s billed`;
  } else clock.textContent = serverState?.call?.state === 'closed' ? `Last call: ${serverState.call.usageSeconds}s billed` : '—';
  requestAnimationFrame(drawMeters);
})();

$('#btn-connect').addEventListener('click', startCall);
$('#btn-hangup').addEventListener('click', hangUp);
$('#btn-play').addEventListener('click', () => audio.play().then(() => { $('#btn-play').hidden = true; }));
$('#btn-mute').addEventListener('click', async () => {
  const muted = !call.muted;
  try { await api('/api/mute', { muted }); call.muted = muted; $('#btn-mute').setAttribute('aria-pressed', String(muted)); $('#btn-mute').textContent = muted ? 'Unmute mic' : 'Mute mic'; }
  catch (error) { note(error.message, true); }
});
$('#btn-reset').addEventListener('click', async () => {
  const live = LIVE_STATES.includes(serverState?.call?.state);
  if (!confirm(live ? 'Clear the log? Everything before the call in progress is removed from the screen. The call stays. Nothing is deleted from data/runs.'
    : 'Clear the log? The log, the timeline and the session list are emptied. Nothing is deleted from data/runs.')) return;
  try { const cleared = await api('/api/reset'); note(cleared.keptCall ? 'Log cleared. The call in progress was kept.' : 'Log cleared.'); } catch (error) { note(error.message, true); }
});
window.addEventListener('pagehide', () => { if (call.ready && call.events?.readyState === 'open') call.events.send(JSON.stringify({ type: 'session.close' })); });

connectSocket();
