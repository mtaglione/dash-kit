// Dash Kit browser client: the WebRTC call (per OpenAI's GPT-Live WebRTC
// quickstart), the settings forms, the composer, and the two views drawn
// from the server's event stream: the conversation thread and the timeline.
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
const turnNodes = new Map();     // event key -> thread node
const rowNodes = new Map();      // event key -> timeline row
const appendNodes = new Map();   // append event id -> thread step
const agentCards = new Map();    // subagent id -> card
const eventsBySeq = new Map();

/* ---------------- Server event stream ---------------- */
let socket, socketRetry = 500;
function connectSocket() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.addEventListener('open', () => { socketRetry = 500; });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'hello') { resetViews(); applyState(message.state, { force: true }); for (const event of message.history) handleEvent(event); }
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
  view.thread.replaceChildren($('#thread-empty') ?? emptyState());
  $('#thread-empty').hidden = false;
  view.timeline.replaceChildren();
  for (const map of [turnNodes, rowNodes, appendNodes, agentCards, eventsBySeq]) map.clear();
}
function emptyState() { return document.getElementById('thread-empty'); }

function handleEvent(event) {
  eventsBySeq.set(event.seq, event);
  renderThread(event);
  renderTimeline(event);
}

/* ---------------- State: settings, call, subagents ---------------- */
function applyState(state, { force = false } = {}) {
  const first = !serverState;
  serverState = state;
  runStartedAt = state.runStartedAt ?? runStartedAt;
  if (first || force) fillOptions(state.options);
  for (const form of $$('form.settings')) if (force || !form.dataset.dirty) fillForm(form, state.settings[form.dataset.section]);
  // Delegation picker
  const select = $('#delegation-select');
  const chosen = select.value;
  const delegations = state.call?.state !== 'closed' ? state.call?.delegations ?? [] : [];
  select.replaceChildren(el('option', { value: '', text: 'General session context' }), el('option', { value: 'latest', text: 'Latest delegation' }),
    ...delegations.slice().reverse().map(d => el('option', { value: d.id, text: `Delegation …${d.id.slice(-6)} at ${(d.offsetMs / 1000).toFixed(1)}s` })));
  select.value = [...select.options].some(o => o.value === chosen) ? chosen : '';
  for (const agent of state.subagents ?? []) updateAgentCard(agent);
  if (!state.keyConfigured) note('The server has no OPENAI_API_KEY. Add it to .env and restart.', true);
}
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
  form.addEventListener('input', () => setDirty(form, true));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const section = form.dataset.section;
    try {
      const saved = await api('/api/settings', { [section]: readForm(form) }, 'PUT');
      fillForm(form, saved[section]);
      note(`${$('button[type=submit]', form).textContent.replace('Save ', '')} saved.`);
    } catch (error) { note(error.message, true); }
  });
  $('[data-reset]', form).addEventListener('click', async () => {
    if (!confirm('Restore the default settings for this section? Your edits here are replaced.')) return;
    try { const saved = await api('/api/settings/reset', { section: form.dataset.section }); fillForm(form, saved[form.dataset.section]); note('Defaults restored.'); }
    catch (error) { note(error.message, true); }
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
  });
}

/* ---------------- Conversation thread ---------------- */
const fmtTime = at => { const s = Math.max(0, (at - runStartedAt) / 1000); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const shortId = id => (id ? `…${String(id).slice(-6)}` : 'none');
function addToThread(node) {
  $('#thread-empty').hidden = true;
  const atBottom = view.thread.scrollHeight - view.thread.scrollTop - view.thread.clientHeight < 80;
  view.thread.append(node);
  if (atBottom) view.thread.scrollTop = view.thread.scrollHeight;
  return node;
}
function step(event, route, body, { meta, details, cls = '' } = {}) {
  const node = el('div', { class: `step from-${event.from} ${cls} ${event.manual ? 'manual' : ''} ${event.error ? 'error' : ''}` },
    el('span', { class: 'route', text: route }), el('span', { class: 'body', text: body }));
  if (meta) node.append(el('span', { class: 'meta', text: meta }));
  if (details) node.append(el('details', {}, el('summary', { text: details.summary }), el('pre', { text: details.text })));
  return addToThread(node);
}
function divider(text) { return addToThread(el('div', { class: 'divider', text })); }

function renderThread(e) {
  switch (e.type) {
    case 'transcript': {
      let node = turnNodes.get(e.key);
      if (!node) {
        node = addToThread(el('div', { class: `turn ${e.role}` },
          el('div', { class: 'who' }, el('span', { text: e.role === 'user' ? 'You' : 'Kit on GPT-Live' }), el('time', { text: `${(e.startMs / 1000).toFixed(1)}s` })),
          el('div', { class: 'said' })));
        turnNodes.set(e.key, node);
      }
      $('.said', node).textContent = e.text.trim();
      if (view.thread.scrollHeight - view.thread.scrollTop - view.thread.clientHeight < 160) view.thread.scrollTop = view.thread.scrollHeight;
      return;
    }
    case 'typed':
      addToThread(el('div', { class: 'turn user typed' }, el('div', { class: 'who' }, el('span', { text: 'You typed' }), el('time', { text: fmtTime(e.at) })), el('div', { class: 'said', text: e.text })));
      return;
    case 'session.created': divider(`Call started: session ${shortId(e.sessionId)}`); return;
    case 'session.closed': divider(e.label); return;
    case 'session.failed': step({ ...e, error: true }, 'GPT-Live', e.label); return;
    case 'delegation':
      step(e, 'GPT-Live to Orchestrator', 'Delegated a request', { meta: `delegation ${shortId(e.delegationId)}, ${e.label.split(' at ')[1] ?? ''} on the call` });
      return;
    case 'orchestrator.input':
      step(e, 'Orchestrator', 'Read the request', { details: { summary: 'What it was given', text: e.text } });
      return;
    case 'orchestrator.tool':
      if (e.tool === 'tell_voice') return;   // the append itself is shown
      if (e.tool === 'start_subagent' && e.sub) { ensureAgentCard(e.sub, { title: e.label.split('"')[1], task: e.text }); return; }
      step(e, 'Orchestrator', e.label, e.text ? { meta: e.text } : {});
      return;
    case 'orchestrator.direct': step(e, 'Orchestrator', e.label); return;
    case 'orchestrator.done': step(e, 'Orchestrator', e.text || 'Finished its turn', { meta: e.label.split(':')[0], cls: 'dim' }); return;
    case 'orchestrator.error': step({ ...e, error: true }, 'Orchestrator', e.label); return;
    case 'subagent.progress': agentProgress(e.sub, e.text); return;
    case 'subagent.delta': { const card = ensureAgentCard(e.sub); $('.agent-draft', card).textContent = e.text; $('.agent-draft', card).hidden = false; return; }
    case 'subagent.result': case 'subagent.failed': {
      const card = ensureAgentCard(e.sub);
      $('.agent-draft', card).hidden = true;
      $('.agent-result', card).textContent = e.text; $('.agent-result', card).hidden = false;
      return;
    }
    case 'append': {
      const kind = KIND_NAME[e.kind] ?? e.kind;
      const node = step(e, `${LANE_NAME[e.from]} to GPT-Live`, `${kind}: ${e.text === '' ? '(empty, cancels the automatic acknowledgement)' : e.text}`,
        { meta: `${e.sub ? e.sub + ', ' : ''}delegation ${shortId(e.delegationId)}, waiting for acknowledgement` });
      appendNodes.set(e.eventId, node);
      return;
    }
    case 'append.ack': {
      const node = appendNodes.get(e.replyTo);
      if (node) $('.meta', node).textContent = $('.meta', node).textContent.replace('waiting for acknowledgement', e.label.replace(/^[a-z ]+accepted/i, 'accepted'));
      return;
    }
    case 'append.skipped': step(e, `${LANE_NAME[e.from]} to GPT-Live`, e.label, { cls: 'dim' }); return;
    case 'error': {
      const node = e.replyTo && appendNodes.get(e.replyTo);
      if (node) { node.classList.add('error'); $('.meta', node).textContent = e.label; return; }
      step({ ...e, error: true }, 'GPT-Live', e.label);
      return;
    }
    case 'sideband.error': step({ ...e, error: true }, 'App', e.label); return;
    case 'command': case 'settings': step(e, LANE_NAME[e.from], e.label, { cls: 'dim' }); return;
    case 'client.pc.failed': step({ ...e, error: true }, 'App', e.label); return;
  }
}

/* Subagent cards */
function ensureAgentCard(id, info = {}) {
  let card = agentCards.get(id);
  if (!card) {
    card = el('div', { class: 'agent', 'data-status': 'running' },
      el('div', { class: 'agent-head' }, el('span', { class: 'agent-id', text: id }), el('span', { class: 'agent-title', text: info.title ?? '' }), el('span', { class: 'agent-state', text: 'starting' })),
      el('div', { class: 'agent-task', text: info.task ?? '' }),
      el('ol', { class: 'agent-progress' }),
      el('div', { class: 'agent-draft', hidden: true }),
      el('div', { class: 'agent-result', hidden: true }),
      el('button', { class: 'agent-stop', type: 'button', text: 'Stop', onclick: () => api(`/api/subagents/${id}/stop`).catch(error => note(error.message, true)) }));
    agentCards.set(id, card);
    addToThread(card);
  }
  if (info.title) $('.agent-title', card).textContent = info.title;
  if (info.task) $('.agent-task', card).textContent = info.task;
  return card;
}
function agentProgress(id, line) {
  const card = ensureAgentCard(id);
  const list = $('.agent-progress', card);
  list.append(el('li', { text: line }));
  while (list.children.length > 8) list.firstChild.remove();
}
function updateAgentCard(agent) {
  const card = agentCards.get(agent.id);
  if (!card) return;
  card.dataset.status = agent.status;
  $('.agent-title', card).textContent = agent.title;
  $('.agent-task', card).textContent = agent.task;
  $('.agent-state', card).textContent = { running: 'working', done: 'finished', failed: 'failed', stopped: 'stopped', idle: 'waiting' }[agent.status] ?? agent.status;
  $('.agent-stop', card).hidden = agent.status !== 'running';
  if (agent.result && agent.status !== 'running') { $('.agent-result', card).textContent = agent.result; $('.agent-result', card).hidden = false; $('.agent-draft', card).hidden = true; }
}

/* ---------------- Timeline (sequence diagram) ---------------- */
$('#lanes-head').replaceChildren(el('span', { text: '' }), ...LANES.map(lane => el('span', { class: lane, text: LANE_NAME[lane] })));
function renderTimeline(e) {
  if (e.ephemeral) return;
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
const call = { peer: null, events: null, microphone: null, closeTimer: null, ready: false, finalized: false, startedAt: 0, muted: false };
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
      call.ready = true; call.startedAt = Date.now();
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
    meters.push({ analyser, bar, data: new Uint8Array(analyser.fftSize) });
  } catch { /* meters are optional */ }
}
(function drawMeters() {
  for (const meter of meters) {
    meter.analyser.getByteTimeDomainData(meter.data);
    let sum = 0; for (const v of meter.data) { const x = (v - 128) / 128; sum += x * x; }
    meter.bar.style.width = `${Math.min(100, Math.sqrt(sum / meter.data.length) * 320)}%`;
  }
  const clock = $('#clock');
  if (call.ready) {
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} on call, ${serverState?.call?.usageSeconds ?? 0}s billed`;
  } else if (serverState?.call?.state === 'closed') clock.textContent = `Last call: ${serverState.call.usageSeconds}s billed`;
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
  if (!confirm('Start a new run? The thread, timeline and subagents are cleared. The current run stays in data/runs.')) return;
  try { await api('/api/reset'); note('New run started.'); } catch (error) { note(error.message, true); }
});
window.addEventListener('pagehide', () => { if (call.ready && call.events?.readyState === 'open') call.events.send(JSON.stringify({ type: 'session.close' })); });

connectSocket();
