// The call log: the center panel, drawn from the server's event stream.
//
// Events are grouped instead of listed one after another:
//   - one block per call, with its Claude sessions at the top (the dispatcher's
//     own session in Boosker mode, then every agent session and lookup), each
//     with its state and a link that opens it in Claude;
//   - inside a call, speech in order, and one block per request (a delegation
//     or a typed request) holding every step that request caused: the
//     dispatcher's turn, what the broker did, a session's progress and result,
//     and each message sent to the voice. A step shows the time since the
//     request began.
// A dispatcher turn is one row (what it was given and its answer are inside
// it), an acknowledgement is folded into the message it confirms, a session's
// progress lines are folded into one row, and a transcript turn with no words
// in it ("[clear throat") is hidden unless "All rows" is on.
// The timeline panel still has every event, one per row, in arrival order.
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  return node;
};
const clip = (value, size) => { const t = String(value ?? '').replace(/\s+/g, ' ').trim(); return t.length > size ? t.slice(0, size - 1) + '…' : t; };
const clock = ms => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const since = ms => (ms < 0 ? '' : ms < 60000 ? `+${(ms / 1000).toFixed(1)}s` : `+${Math.floor(ms / 60000)}m${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s`);
const wallTime = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const shortId = id => (id ? `…${String(id).slice(-6)}` : 'none');

const KIND = { thinking: 'Silent', commentary: 'Spoken', instructions: 'Instruction' };
const STATUS = { running: 'working', done: 'finished', failed: 'failed', stopped: 'stopped', idle: 'waiting' };
const LISTED = { listed: 'listed in Claude', starting: 'connecting to Claude', unlisted: 'not listed in Claude', off: 'not listed in Claude' };

// A transcript turn with no words: only sound tags such as "[clear throat" or "] [inhale".
export const isNoise = text => !/[\p{L}\p{N}]/u.test(String(text ?? '').replace(/\[[^\]]*\]?/g, ' '));

// A dispatcher answer in plain words. Anything that is not the action list is
// shown as it is.
export function describeActions(reply) {
  const text = String(reply ?? '').trim();
  let parsed = null;
  try { parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? ''); } catch { /* not the action list */ }
  if (!Array.isArray(parsed?.actions)) return text ? clip(text, 240) : 'Finished its turn';
  if (!parsed.actions.length) return 'No action';
  return parsed.actions.map(action => {
    switch (action?.type) {
      case 'start': return `Start a session "${clip(action.title, 60)}"`;
      case 'send': return `Send to ${action.session}: ${clip(action.message, 120)}`;
      case 'stop': return action.session === 'all' ? 'Stop every session' : `Stop ${action.session}`;
      case 'lookup': return `Run a lookup "${clip(action.title, 60)}"`;
      case 'say': return `Say: ${clip(action.text, 140)}`;
      default: return `Unknown action ${JSON.stringify(action?.type ?? null)}`;
    }
  }).join(' · ');
}

export function createLog({ root, empty, stop = () => {} }) {
  let calls = new Map();       // GPT-Live session id -> call scope
  let scopes = [];             // every scope, oldest first (calls, and stretches outside a call)
  let appends = new Map();     // append event id -> its row
  let turns = new Map();       // transcript key -> { node, scope }
  let callCount = 0;

  const atBottom = () => root.scrollHeight - root.scrollTop - root.clientHeight < 120;
  const stick = was => { if (was) root.scrollTop = root.scrollHeight; };

  function reset() {
    calls = new Map(); scopes = []; appends = new Map(); turns = new Map(); callCount = 0;
    root.replaceChildren(empty);
    empty.hidden = false;
  }

  /* ---- Scopes: a call, or what happens outside one ---- */
  const newScope = fields => ({ id: null, reqs: new Map(), reqCount: 0, current: null, subs: new Map(), sessions: null, rows: new Map(), pending: [], errors: 0, closed: false, lastUser: null, boosker: false, ...fields });
  function callScope(id, at) {
    let scope = calls.get(id);
    if (scope) return scope;
    // The calls before this one fold away; the newest stays open.
    for (const other of scopes) if (other.block?.open && other.closed) other.block.open = false;
    const number = ++callCount;
    const head = el('summary', { class: 'call-head' },
      el('span', { class: 'call-name', text: `Call ${number}` }), el('span', { class: 'call-when', text: wallTime(at) }),
      el('span', { class: 'call-state', text: 'connecting' }), el('span', { class: 'call-counts' }));
    const body = el('div', { class: 'call-body' });
    const block = el('details', { class: 'call-block', open: true, 'data-session': id }, head, body);
    scope = newScope({ id, number, block, body, head, startedAt: at });
    calls.set(id, scope); scopes.push(scope);
    empty.hidden = true;
    root.append(block);
    return scope;
  }
  const liveCall = () => { const last = scopes.findLast(scope => scope.id); return last && !last.closed ? last : null; };
  function looseScope() {
    const last = scopes.at(-1);
    if (last && !last.id) return last;
    const body = el('div', { class: 'loose' });
    const scope = newScope({ body });
    scopes.push(scope);
    empty.hidden = true;
    root.append(body);
    return scope;
  }
  function scopeOf(e) {
    if (e.sessionId) return callScope(e.sessionId, e.at);
    if (e.sub) { const known = scopes.findLast(scope => scope.subs.has(e.sub)); if (known) return known; }
    if (e.delegationId) { const known = scopes.findLast(scope => scope.reqs.has(e.delegationId)); if (known) return known; }
    return liveCall() ?? looseScope();
  }
  function counts(scope) {
    if (!scope.head) return;
    const parts = [];
    if (scope.reqCount) parts.push(`${scope.reqCount} request${scope.reqCount === 1 ? '' : 's'}`);
    if (scope.errors) parts.push(`${scope.errors} error${scope.errors === 1 ? '' : 's'}`);
    const node = scope.head.querySelector('.call-counts');
    node.textContent = parts.join(', ');
    node.classList.toggle('error', scope.errors > 0);
    scope.block.classList.toggle('has-error', scope.errors > 0);
  }
  const orchestratorName = scope => (scope.boosker ? 'Dispatcher' : 'Orchestrator');

  /* ---- Requests ---- */
  function openRequest(scope, e, { id = null, typed = false } = {}) {
    const number = ++scope.reqCount;
    const title = el('span', { class: 'req-said' });
    const head = el('summary', { class: 'req-head' },
      el('span', { class: 'req-name', text: typed ? `Typed request ${number}` : `Request ${number}` }),
      el('time', { text: scope.id ? clock(e.data?.offset_ms ?? e.at - scope.startedAt) : wallTime(e.at) }),
      title, el('span', { class: 'req-outcome' }));
    const steps = el('ol', { class: 'steps' });
    const block = el('details', { class: 'req', open: true }, head, steps);
    const req = { id, number, block, steps, title, startedAt: e.at, scope, last: null, said: null, errors: 0 };
    if (id) scope.reqs.set(id, req);
    scope.current = req;
    scope.body.append(block);
    counts(scope);
    return req;
  }
  const setSaid = (req, text) => { req.title.textContent = text ? `“${clip(text, 160)}”` : ''; };
  // The request a step belongs to: by its delegation, by the session it is
  // about, or the newest request of the call.
  function requestOf(scope, e) {
    if (e.delegationId && scope.reqs.has(e.delegationId)) return scope.reqs.get(e.delegationId);
    if (e.type === 'orchestrator.input') {
      const notice = /^\[notice\] Session (\w+)/m.exec(e.text ?? '')?.[1];
      if (notice && scope.subs.has(notice)) return scope.subs.get(notice).req;
    }
    if (e.sub && scope.subs.get(e.sub)?.req) return scope.subs.get(e.sub).req;
    return /^(orchestrator|subagent)\./.test(e.type) ? scope.current : null;
  }

  /* ---- Rows ---- */
  // One row. `who` is the sender, `tone` its lane (voice, orchestrator, subagent,
  // client, user), `details` a list of { summary, text } shown when opened.
  function row({ who, tone, text = '', pill = null, meta = '', details = [], error = false, dim = false, low = false, manual = false }) {
    const node = el('li', { class: `st tone-${tone}${error ? ' error' : ''}${dim ? ' dim' : ''}${low ? ' low' : ''}` },
      el('span', { class: 'st-t' }),
      el('span', { class: 'st-who' }, who, pill ? el('span', { class: 'pill', text: pill }) : null, manual ? el('span', { class: 'you', text: 'you' }) : null),
      el('div', { class: 'st-body' }, el('span', { class: 'st-words', text }), el('span', { class: 'st-meta', text: meta })));
    for (const detail of details) addDetail(node, detail);
    return node;
  }
  function addDetail(node, { summary, text }) {
    if (!text) return;
    node.querySelector('.st-body').append(el('details', {}, el('summary', { text: summary }), el('pre', { text })));
  }
  const words = (node, text) => { node.querySelector('.st-words').textContent = text; };
  const meta = (node, text) => { node.querySelector('.st-meta').textContent = text; };
  function fail(node, scope, req) {
    if (node.classList.contains('error')) return;
    node.classList.add('error');
    markError(scope, req);
  }
  function markError(scope, req) {
    scope.errors += 1; counts(scope);
    if (!req) return;
    req.errors += 1; req.block.classList.add('has-error');
    outcome(req);
  }
  function outcome(req, text) {
    if (text !== undefined) req.outcomeText = text;
    const node = req.block.querySelector('.req-outcome');
    node.replaceChildren(...(req.outcomeText ? [el('span', { class: 'chip', text: clip(req.outcomeText, 70) })] : []), ...(req.errors ? [el('span', { class: 'chip error', text: req.errors === 1 ? 'error' : `${req.errors} errors` })] : []));
  }
  // Puts a row in its request (with the time since the request began), or in
  // the call itself when it belongs to no request.
  function place(scope, req, node, e) {
    const was = atBottom();
    if (req) {
      node.querySelector('.st-t').textContent = since(e.at - req.startedAt);
      req.steps.append(node); req.last = node;
    } else {
      node.querySelector('.st-t').textContent = scope.id ? clock(e.at - scope.startedAt) : wallTime(e.at);
      let list = scope.body.lastElementChild;
      if (!list?.classList.contains('notes')) scope.body.append(list = el('ol', { class: 'steps notes' }));
      list.append(node);
    }
    if (node.classList.contains('error')) markError(scope, req);
    stick(was);
    return node;
  }

  /* ---- The Claude sessions of a call ---- */
  function sessionRow(scope, key, fields = {}) {
    if (!scope.sessions) {
      scope.sessions = el('ul', { class: 'sessions', 'aria-label': 'Claude sessions' });
      scope.body.prepend(scope.sessions);
    }
    let node = scope.rows.get(key);
    if (!node) {
      node = el('li', { class: 'sess', 'data-status': 'running', 'data-kind': key === 'dispatcher' ? 'dispatcher' : 'session' },
        el('span', { class: 'sess-id', text: key === 'dispatcher' ? 'Dispatcher' : key }),
        el('span', { class: 'sess-title' }),
        el('span', { class: 'sess-state' }),
        el('a', { class: 'sess-open', target: '_blank', rel: 'noopener', hidden: true, text: 'Open in Claude' }),
        key === 'dispatcher' ? null : el('button', { class: 'sess-stop', type: 'button', hidden: true, text: 'Stop', onclick: () => stop(key) }),
        el('details', { class: 'sess-more', hidden: true }, el('summary', { text: 'Details' }), el('dl', {})));
      scope.rows.set(key, node);
      // The dispatcher first, then sessions in the order they started.
      if (key === 'dispatcher') scope.sessions.prepend(node); else scope.sessions.append(node);
    }
    const info = node.info = { ...(node.info ?? {}), ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
    node.querySelector('.sess-title').textContent = [info.title, info.folder ? `in ${info.folder}` : ''].filter(Boolean).join(' ');
    if (key === 'dispatcher') {
      node.dataset.status = info.listed === 'listed' ? 'done' : info.listed === 'starting' ? 'running' : 'idle';
      node.querySelector('.sess-state').textContent = LISTED[info.listed] ?? '';
    } else {
      node.dataset.status = info.status ?? 'running';
      node.querySelector('.sess-state').textContent = STATUS[info.status ?? 'running'] ?? info.status;
      node.querySelector('.sess-stop').hidden = !(info.stoppable && info.status === 'running');
    }
    const link = node.querySelector('.sess-open');
    link.hidden = !info.url;
    if (info.url) link.href = info.url;
    const facts = [['Task', info.task], ['Last result', info.result], ['Not listed because', info.error], ['Claude session id', info.claudeSessionId], ['Dispatcher turns', info.turns || null]].filter(([, value]) => value);
    node.querySelector('.sess-more').hidden = !facts.length;
    node.querySelector('dl').replaceChildren(...facts.flatMap(([name, value]) => [el('dt', { text: name }), el('dd', { text: String(value) })]));
    return node;
  }
  // A session named in a step is tied to that step's request, so its later
  // progress and result are filed there.
  function tie(scope, sub, req) {
    const entry = scope.subs.get(sub) ?? {};
    scope.subs.set(sub, { ...entry, req: req ?? entry.req ?? null });
  }
  const whoOf = e => (e.sub ?? { voice: 'Voice', orchestrator: null, subagent: 'Session', client: 'App', system: 'App', user: 'You' }[e.from] ?? 'App');

  /* ---- Events ---- */
  function handle(e) {
    switch (e.type) {
      case 'transcript': return speech(e);
      case 'session.created': { const scope = callScope(e.sessionId, e.at); scope.startedAt = e.at; return; }
      case 'boosker': {
        const scope = callScope(e.sessionId, e.at);
        scope.boosker = true;
        scope.head.querySelector('.call-name').textContent = `Call ${scope.number} · Boosker`;
        scope.block.title = e.label;
        return;
      }
      case 'session.started': { const scope = callScope(e.sessionId, e.at); if (!scope.closed) scope.head.querySelector('.call-state').textContent = 'live'; scope.block.dataset.state = 'live'; return; }
      case 'session.closed': {
        const scope = callScope(e.sessionId, e.at);
        scope.closed = true; scope.block.dataset.state = 'closed';
        scope.head.querySelector('.call-state').textContent = `ended after ${clock(e.at - scope.startedAt)}, ${(e.label.match(/\((\d+s billed)\)/)?.[1] ?? '').replace('s billed', ' s billed')}`.replace(/, $/, '');
        place(scope, null, row({ who: 'Call', tone: 'client', text: e.label.replace(/^Session closed: /, 'Call ended: '), dim: true }), e);
        return;
      }
      case 'session.failed': case 'sideband.error': case 'client.pc.failed': case 'client.connect.failed': {
        const scope = scopeOf(e);
        place(scope, null, row({ who: e.type === 'session.failed' ? 'GPT-Live' : 'App', tone: e.type === 'session.failed' ? 'voice' : 'client', text: e.label, error: true }), e);
        return;
      }
      case 'idle': { const scope = scopeOf(e); place(scope, null, row({ who: 'App', tone: 'client', text: e.label }), e); return; }
      case 'command': case 'settings': { const scope = scopeOf(e); place(scope, null, row({ who: e.from === 'client' ? 'You' : 'App', tone: 'client', text: e.label, dim: true, low: true }), e); return; }

      case 'dispatcher.started': case 'dispatcher.session': {
        const scope = scopeOf(e);
        scope.boosker = true;
        sessionRow(scope, 'dispatcher', { title: e.title, claudeSessionId: e.claudeSessionId, listed: e.listed, url: e.url ?? undefined, error: e.error ?? undefined });
        return;
      }
      case 'subagent.session': { const scope = scopeOf(e); sessionRow(scope, e.sub, { url: e.url, claudeSessionId: e.claudeSessionId }); return; }

      case 'delegation': {
        const scope = scopeOf(e);
        const req = openRequest(scope, e, { id: e.delegationId });
        // The words are the user turn being spoken as the request is handed over.
        req.said = scope.lastUser;
        setSaid(req, scope.lastUser ? turns.get(scope.lastUser)?.text : '');
        place(scope, req, row({ who: 'Voice', tone: 'voice', text: `Handed the request to the ${orchestratorName(scope).toLowerCase()}`, meta: `delegation ${shortId(e.delegationId)}` }), e);
        return;
      }
      case 'typed': {
        const scope = scopeOf(e);
        const req = openRequest(scope, e, { typed: true });
        setSaid(req, e.text);
        place(scope, req, row({ who: 'You', tone: 'user', text: `Typed: ${e.text}` }), e);
        return;
      }
      case 'orchestrator.input': {
        const scope = scopeOf(e), req = requestOf(scope, e);
        const said = /^User said: (".*")$/m.exec(e.text ?? '')?.[1];
        if (req && said) { try { setSaid(req, JSON.parse(said)); req.said = null; } catch { /* keep the transcript's words */ } }
        const notice = /^\[notice\] Session (\w+) "[^"]*" (\w+)/m.exec(e.text ?? '');
        const node = row({ who: orchestratorName(scope), tone: 'orchestrator', text: 'Deciding…', meta: notice ? `told that ${notice[1]} ${notice[2]}` : '', details: [{ summary: 'What it was given', text: e.text }] });
        node.notice = notice?.[1] ?? null;
        scope.pending.push({ node, req });
        place(scope, req, node, e);
        return;
      }
      case 'orchestrator.done': case 'orchestrator.error': {
        const scope = scopeOf(e);
        const turn = scope.pending.shift();
        if (e.type === 'orchestrator.error') {
          // A failed turn, or an error with no turn of its own (the router, a refused action).
          if (turn && /turn \d+ failed|Orchestrator failed/i.test(e.label)) { words(turn.node, e.label); fail(turn.node, scope, turn.req); return; }
          if (turn) scope.pending.unshift(turn);
          const req = requestOf(scope, e);
          const router = /^Folder router: /.test(e.label);
          place(scope, req, row({ who: router ? 'Router' : orchestratorName(scope), tone: 'orchestrator', text: e.label.replace(/^Folder router: /, ''), error: true }), e);
          return;
        }
        const took = /done in (\d+) ms/.exec(e.label)?.[1];
        const summary = describeActions(e.text);
        if (!turn) { place(scope, requestOf(scope, e), row({ who: orchestratorName(scope), tone: 'orchestrator', text: summary, meta: took ? `answered in ${took} ms` : '' }), e); return; }
        words(turn.node, summary);
        meta(turn.node, [turn.node.querySelector('.st-meta').textContent, took ? `answered in ${took} ms` : ''].filter(Boolean).join(', '));
        if (summary !== (e.text ?? '').trim()) addDetail(turn.node, { summary: 'Its answer as sent', text: e.text });
        if (turn.req && !turn.node.notice) outcome(turn.req, summary);
        return;
      }
      case 'orchestrator.tool': {
        if (e.tool === 'tell_voice') return;   // the message itself is shown
        const scope = scopeOf(e), req = requestOf(scope, e);
        if (e.sub) {
          tie(scope, e.sub, req);
          // A Boosker lookup (l1…) keeps no session, so it has nothing to stop.
          if (e.tool === 'start_subagent') sessionRow(scope, e.sub, { title: e.label.split('"')[1], task: e.text, status: 'running', folder: / in (.+)$/.exec(e.label)?.[1], stoppable: !(scope.boosker && e.sub.startsWith('l')) });
        }
        const router = e.tool === 'route';
        place(scope, req, row({ who: router ? 'Router' : scope.boosker ? 'Broker' : 'Orchestrator', tone: 'orchestrator', text: e.label.replace(/^Folder router: /, 'Folder: '),
          details: e.text && !e.label.includes(clip(e.text, 100)) ? [{ summary: e.tool === 'start_subagent' ? 'Task given' : 'Full text', text: e.text }] : [] }), e);
        return;
      }
      case 'orchestrator.direct': { const scope = scopeOf(e); place(scope, requestOf(scope, e), row({ who: scope.boosker ? 'Broker' : 'Orchestrator', tone: 'orchestrator', text: e.label }), e); return; }

      case 'subagent.progress': case 'subagent.delta': {
        const scope = scopeOf(e), req = requestOf(scope, e);
        if (!scope.subs.has(e.sub)) tie(scope, e.sub, req);
        if (!scope.rows.has(e.sub)) sessionRow(scope, e.sub, { status: 'running', stoppable: true });
        const line = (e.text ?? e.label ?? '').trim();
        // Progress lines of one session, one after another, share a row.
        let group = req?.last?.group?.sub === e.sub ? req.last : null;
        if (!group) {
          if (e.type === 'subagent.delta' && !line) return;
          group = row({ who: e.sub, tone: 'subagent', text: '' });
          group.group = { sub: e.sub, lines: 0, list: el('ol', {}) };
          group.querySelector('.st-body').append(el('details', { class: 'more' }, el('summary', { text: 'All steps' }), group.group.list));
          place(scope, req, group, e);
        }
        const was = atBottom();
        if (e.type === 'subagent.progress') { group.group.lines += 1; group.group.list.append(el('li', { text: `${since(e.at - (req?.startedAt ?? e.at))} ${line}`.trim() })); }
        words(group, clip(line, 220));
        meta(group, group.group.lines > 1 ? `${group.group.lines} steps` : '');
        group.querySelector('details.more').hidden = group.group.lines < 2;
        group.classList.toggle('draft', e.type === 'subagent.delta');
        stick(was);
        return;
      }
      case 'subagent.result': case 'subagent.failed': case 'subagent.stopped': {
        const scope = scopeOf(e), req = requestOf(scope, e);
        const result = e.type === 'subagent.result', stopped = e.type === 'subagent.stopped';
        sessionRow(scope, e.sub, { status: result ? 'done' : stopped ? 'stopped' : 'failed', result: e.text });
        place(scope, req, row({ who: e.sub, tone: 'subagent', pill: result ? 'Finished' : stopped ? 'Stopped' : 'Failed', text: clip(e.text, 260), error: e.type === 'subagent.failed',
          details: (e.text ?? '').length > 260 ? [{ summary: 'Full text', text: e.text }] : [] }), e);
        return;
      }

      case 'append': {
        const scope = scopeOf(e), req = requestOf(scope, e) ?? null;
        const reason = /^[a-z ]+ \(([^)]+)\):/.exec(e.label ?? '')?.[1];
        const sender = e.sub ?? (e.from === 'orchestrator' ? orchestratorName(scope) : whoOf(e));
        const node = row({ who: `${sender} → Voice`, tone: e.sub ? 'subagent' : e.from, pill: KIND[e.kind] ?? e.kind, manual: Boolean(e.manual),
          text: e.text === '' ? '(empty: cancels the automatic acknowledgement)' : e.text, meta: [reason, 'waiting for the voice to accept it'].filter(Boolean).join(', ') });
        node.reason = reason ?? '';
        node.querySelector('.st-words').classList.add('clamp');
        node.querySelector('.st-words').addEventListener('click', event => event.currentTarget.classList.toggle('open'));
        appends.set(e.eventId, { node, scope, req });
        place(scope, req, node, e);
        return;
      }
      case 'append.ack': {
        const sent = appends.get(e.replyTo);
        if (sent) meta(sent.node, [sent.node.reason, `accepted${/ in \d+ ms/.exec(e.label)?.[0] ?? ''}`].filter(Boolean).join(', '));
        return;
      }
      case 'append.unconfirmed': { const sent = appends.get(e.replyTo); if (sent) meta(sent.node, [sent.node.reason, 'not confirmed before the call closed'].filter(Boolean).join(', ')); return; }
      case 'append.skipped': { const scope = scopeOf(e); place(scope, requestOf(scope, e), row({ who: `${e.sub ?? whoOf(e) ?? orchestratorName(scope)} → Voice`, tone: e.sub ? 'subagent' : e.from, text: e.label, dim: true }), e); return; }
      case 'error': {
        const sent = e.replyTo ? appends.get(e.replyTo) : null;
        if (sent) { meta(sent.node, e.label); fail(sent.node, sent.scope, sent.req); return; }
        const scope = scopeOf(e);
        place(scope, null, row({ who: 'GPT-Live', tone: 'voice', text: e.label, error: true }), e);
        return;
      }
    }
  }

  function speech(e) {
    const scope = scopeOf(e);
    let turn = turns.get(e.key);
    const was = atBottom();
    if (!turn) {
      const node = el('div', { class: `turn ${e.role}` },
        el('div', { class: 'who' }, el('span', { text: e.role === 'user' ? 'You' : 'Kit' }), el('time', { text: clock(e.startMs ?? 0) })),
        el('div', { class: 'said' }));
      turn = { node, scope, text: '' };
      turns.set(e.key, turn);
      scope.body.append(node);
    }
    turn.text = (e.text ?? '').trim();
    turn.node.querySelector('.said').textContent = turn.text;
    turn.node.classList.toggle('low', e.role === 'user' && isNoise(turn.text));
    if (e.role === 'user' && !isNoise(turn.text)) {
      scope.lastUser = e.key;
      // A request handed over while these words were still arriving.
      for (const req of scope.reqs.values()) if (req.said === e.key) setSaid(req, turn.text);
    }
    stick(was);
  }

  // The server's view of the sessions that can still change: the current
  // call's dispatcher and agents (or Dash Kit's own subagents).
  function setState(state) {
    const scope = (state.call?.sessionId && calls.get(state.call.sessionId)) || null;
    if (state.dispatcher && scope) {
      const d = state.dispatcher;
      sessionRow(scope, 'dispatcher', { title: d.title, claudeSessionId: d.claudeSessionId, listed: d.listed, url: d.url ?? undefined, error: d.error ?? '', turns: d.turns });
    }
    for (const agent of state.subagents ?? []) {
      const home = (scope?.rows.has(agent.id) ? scope : null) ?? scopes.findLast(other => other.rows.has(agent.id));
      if (!home) continue;
      sessionRow(home, agent.id, { title: agent.title, task: agent.task, folder: agent.folder ?? undefined, status: agent.status, url: agent.url ?? undefined, claudeSessionId: agent.claudeSessionId ?? undefined,
        result: agent.status !== 'running' ? agent.result || undefined : undefined, stoppable: agent.kind !== 'lookup' });
    }
  }

  return { handle, reset, setState };
}
