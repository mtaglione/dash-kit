// The overlay view: one time-scaled track per call, everything on one clock.
//
// The conversation thread lists things in arrival order and the sequence view
// uses the run clock, so neither shows what overlapped what. Here the vertical
// axis is the call's own clock (the session timeline GPT-Live reports in
// start_ms / end_ms / offset_ms), and three things share it:
//   - speech: one block per transcript turn, in a "You" and a "Kit" lane;
//   - audio: the level each side actually had, as a strip beside its lane
//     (measured in the browser on the call, sent as client.audio.levels);
//   - messages: every delegation, append, typed request, orchestrator step and
//     subagent result, as a marker at the moment it landed, with a line
//     across the speech lanes.
// Events that only have a wall-clock time (orchestrator steps, audio levels)
// are placed with the nearest append acknowledgement, which gives the call
// clock and the wall clock for the same moment. Stretches with no speech, no
// sound and no messages are folded to a fixed height.
const SCALES = [14, 28, 56];            // pixels per second
const GAP_MS = 3000, GAP_PX = 30, PAD_MS = 500;
const CHIP_H = 22, CHIP_H2 = 36, CHIP_GAP = 2, STRIP_W = 14, LOUD = 6;
const TAG = { thinking: 'Silent', commentary: 'Spoken', instructions: 'Instruction', delegation: 'Delegated', typed: 'Typed', tool: 'Orchestrator', result: 'Result', end: 'Call ended', note: '' };
const WHO = { user: 'You', client: 'App', system: 'App', voice: 'GPT-Live', orchestrator: 'Orchestrator', subagent: 'Subagent' };
const KIND_LONG = { thinking: 'silent context', commentary: 'a spoken update', instructions: 'an instruction' };

const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = ms => { const s = Math.max(0, ms) / 1000; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const exact = ms => { const s = Math.max(0, ms) / 1000; return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const span = ms => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const wall = at => `${new Date(at).toLocaleTimeString([], { hour12: false })}.${String(Math.floor(at % 1000)).padStart(3, '0')}`;

export function createOverlay({ scroll, detail, follow = () => true, isLive = () => false, rawEvent = () => null }) {
  let sessions = [], current = null, skew = -Infinity, selected = null, pending = null;
  let scale = SCALES.includes(Number(localStorage.getItem('dashkit.overlay.scale'))) ? Number(localStorage.getItem('dashkit.overlay.scale')) : 28;
  const appends = new Map();   // append event id -> its mark

  const blank = (id, at) => ({ id, number: id ? sessions.filter(s => s.id).length + 1 : 0, createdAt: at, clientStartAt: null, anchors: [],
    turns: new Map(), marks: [], spans: [], levels: { mic: [], out: [] }, closed: null, dirty: true, node: null, lay: null });
  const byId = id => (id ? sessions.findLast(s => s.id === id) : null);
  // Events before the first call go on a track of their own.
  const sessionFor = e => byId(e.sessionId) ?? current ?? (sessions.push(current = blank(null, e.at)), current);

  // Wall clock to call clock. Between two anchors the call clock is read off
  // the line through them (it can run slightly fast or slow against the wall
  // clock); outside them it runs at wall-clock speed from the nearest one.
  function toMs(s, at) {
    const a = s.anchors;
    if (!a.length) return at - s.createdAt;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].at < at) lo = mid + 1; else hi = mid; }
    const after = a[lo], before = a[lo - 1];
    if (!before || at >= after.at) return after.ms + (at - after.at);
    return before.ms + ((at - before.at) / (after.at - before.at)) * (after.ms - before.ms);
  }
  const markTime = (s, m) => m.t ?? toMs(s, m.at);

  function reset() {
    sessions = []; current = null; skew = -Infinity; selected = null; appends.clear();
    scroll.replaceChildren(); showDetail();
  }

  function handle(e) {
    skew = Math.max(skew, e.at - Date.now());
    const s = e.type === 'session.created' ? (sessions.push(current = blank(e.sessionId, e.at)), current) : sessionFor(e);
    const mark = fields => { const m = { id: `m${e.seq}`, seq: e.seq, at: e.at, t: null, from: e.from, sub: e.sub ?? null, ...fields }; s.marks.push(m); return m; };
    const openSpan = (lane, sub) => s.spans.findLast(sp => sp.lane === lane && sp.sub === sub && sp.endAt == null);
    switch (e.type) {
      case 'session.created': break;
      case 'client.session.started': s.clientStartAt = e.at; break;
      case 'transcript':
        s.turns.set(e.key, { id: `t${e.key}`, seq: e.seq, role: e.role, start: e.startMs ?? 0, end: Math.max(e.endMs ?? 0, e.startMs ?? 0), text: (e.text ?? '').trim() });
        break;
      case 'delegation': mark({ kind: 'delegation', t: e.data?.offset_ms ?? null, text: '' }); break;
      case 'append': appends.set(e.eventId, mark({ kind: e.kind, text: e.text ?? '', manual: Boolean(e.manual), state: 'waiting' })); break;
      case 'append.ack': {
        const m = appends.get(e.replyTo);
        if (!m) break;
        m.state = 'accepted'; m.ackMs = e.at - m.at; m.ackSeq = e.seq;
        if (Number.isFinite(e.data?.start_ms)) {
          m.t = e.data.start_ms;
          const end = Number.isFinite(e.data.end_ms) ? e.data.end_ms : m.t;
          s.anchors.push({ at: (m.at + e.at) / 2, ms: (m.t + end) / 2 });
          s.anchors.sort((a, b) => a.at - b.at);
        }
        break;
      }
      case 'append.unconfirmed': { const m = appends.get(e.replyTo); if (m) m.state = 'unconfirmed'; break; }
      case 'append.skipped': mark({ kind: e.kind ?? 'note', text: e.text ?? '', state: 'skipped', note: e.label }); break;
      case 'error': {
        const m = e.replyTo ? appends.get(e.replyTo) : null;
        if (m) { m.state = 'rejected'; m.note = e.label; } else mark({ kind: 'note', text: e.label, error: true });
        break;
      }
      case 'typed': mark({ kind: 'typed', from: 'user', text: e.text ?? '' }); break;
      case 'orchestrator.input': s.spans.push({ id: `o${e.seq}`, seq: e.seq, lane: 'orchestrator', sub: null, startAt: e.at, endAt: null, title: e.label, text: e.text ?? '', ticks: [] }); break;
      case 'orchestrator.tool': if (e.tool !== 'tell_voice') mark({ kind: 'tool', text: e.label }); break;
      case 'orchestrator.direct': mark({ kind: 'tool', text: e.label }); break;
      case 'orchestrator.done': case 'orchestrator.error': {
        const sp = openSpan('orchestrator', null);
        if (sp) { sp.endAt = e.at; sp.note = e.text || e.label; }
        if (e.type === 'orchestrator.error') mark({ kind: 'note', text: e.label, error: true });
        break;
      }
      case 'subagent.progress': {
        let sp = openSpan('subagent', e.sub);
        if (!sp) s.spans.push(sp = { id: `s${e.seq}`, seq: e.seq, lane: 'subagent', sub: e.sub, startAt: e.at, endAt: null, title: `Subagent ${e.sub}`, text: '', ticks: [] });
        sp.ticks.push({ at: e.at, text: e.text ?? e.label ?? '' });
        break;
      }
      case 'subagent.result': case 'subagent.failed': case 'subagent.stopped': {
        const sp = openSpan('subagent', e.sub);
        const outcome = e.type.split('.')[1];
        if (sp) { sp.endAt = e.at; sp.note = outcome === 'result' ? 'finished' : outcome; }
        mark({ kind: 'result', text: `${e.sub} ${outcome === 'result' ? 'finished' : outcome}${e.text ? ': ' + e.text : ''}`, error: outcome === 'failed' });
        break;
      }
      case 'session.closed': s.closed = { at: e.at }; mark({ kind: 'end', from: 'voice', text: (e.label ?? '').replace(/^Session closed: /, '') }); break;
      case 'idle': mark({ kind: 'note', text: e.label }); break;
      case 'command': mark({ kind: 'note', text: e.label, dim: true }); break;
      case 'session.failed': case 'sideband.error': case 'client.pc.failed': case 'client.connect.failed': mark({ kind: 'note', text: e.label, error: true }); break;
      case 'client.audio.levels': {
        const d = e.data;
        if (!d || !Array.isArray(d.mic) || !Array.isArray(d.out) || !(d.step > 0)) return;
        const base = (s.clientStartAt ?? e.at - d.t - d.mic.length * d.step) + d.t;
        d.mic.forEach((v, i) => s.levels.mic.push({ at: base + i * d.step, v }));
        d.out.forEach((v, i) => s.levels.out.push({ at: base + i * d.step, v }));
        s.step = d.step;
        break;
      }
      default: return;
    }
    s.dirty = true;
    schedule();
  }

  /* ---------------- Layout: call clock to pixels ---------------- */
  function layout(s, nowMs) {
    // A marker whose text does not fit on one line of the messages lane gets two.
    const perLine = Math.max(12, ((scroll.clientWidth - 24 - 40) * 0.46 - 31) / 5.7);
    const chipHeight = m => ((TAG[m.kind] ?? '').length + chipText(m).length + 7 > perLine ? CHIP_H2 : CHIP_H);
    const marks = s.marks.map(m => ({ m, t: markTime(s, m), h: chipHeight(m) })).sort((a, b) => a.t - b.t);
    const spans = s.spans.map(sp => ({ sp, a: toMs(s, sp.startAt), b: sp.endAt == null ? null : toMs(s, sp.endAt), ticks: sp.ticks.map(tick => toMs(s, tick.at)) }));
    const levels = {};
    for (const key of ['mic', 'out']) levels[key] = s.levels[key].map(({ at, v }) => ({ t: toMs(s, at), v }));
    const step = s.step ?? 200;
    const busy = [[0, 300]];
    for (const turn of s.turns.values()) busy.push([turn.start - PAD_MS, turn.end + PAD_MS]);
    for (const { t, h } of marks) busy.push([t - PAD_MS, t + Math.max(PAD_MS, ((h + CHIP_GAP) / scale) * 1000)]);
    for (const { a, b, ticks } of spans) { busy.push([a - 200, a + 200]); if (b != null) busy.push([b - 200, b + 200]); for (const t of ticks) busy.push([t - 100, t + 100]); }
    for (const key of ['mic', 'out']) for (const { t, v } of levels[key]) if (v >= LOUD) busy.push([t - 200, t + step + 200]);
    if (nowMs != null) busy.push([nowMs - 200, nowMs]);
    busy.sort((a, b) => a[0] - b[0]);
    // Busy stretches are drawn to scale; a quiet stretch longer than GAP_MS is folded.
    const segs = []; let y = 0, cursor = 0;
    for (const [from, to] of busy) {
      const a = Math.max(0, from);
      if (to <= cursor) continue;
      let last = segs.at(-1);
      if (last && a - cursor > GAP_MS) { segs.push({ gap: true, from: cursor, to: a, y, h: GAP_PX }); y += GAP_PX; cursor = a; last = null; }
      if (!last || last.gap) segs.push(last = { gap: false, from: cursor, to: cursor, y, h: 0 });
      last.to = to; last.h = ((last.to - last.from) / 1000) * scale; y = last.y + last.h; cursor = to;
    }
    const yOf = t => {
      if (t <= 0 || !segs.length) return 0;
      let lo = 0, hi = segs.length - 1;
      if (t >= segs[hi].to) return segs[hi].y + segs[hi].h;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].to < t) lo = mid + 1; else hi = mid; }
      const g = segs[lo];
      return g.y + (g.to === g.from ? 0 : (Math.max(0, t - g.from) / (g.to - g.from)) * g.h);
    };
    // Markers sit at their exact time unless the one above is in the way.
    let bottom = -Infinity;
    const chips = marks.map(({ m, t, h }) => { const at = yOf(t); const top = Math.max(0, at - CHIP_H / 2, bottom + CHIP_GAP); bottom = top + h; return { m, t, h, at, top }; });
    return { segs, yOf, chips, spans, levels, height: Math.max(y, bottom) + 14, end: cursor };
  }

  function levelPath(samples, yOf) {
    let d = '', open = false, lastY = 0, lastT = -Infinity;
    for (const { t, v } of samples) {
      if (t < 0) continue;
      const y = yOf(t);
      if (!open || t - lastT > 900) { if (open) d += `L0 ${lastY.toFixed(1)}Z`; d += `M0 ${y.toFixed(1)}`; open = true; }
      d += `L${((Math.min(100, v) / 100) * STRIP_W).toFixed(1)} ${y.toFixed(1)}`;
      lastY = y; lastT = t;
    }
    return open ? `${d}L0 ${lastY.toFixed(1)}Z` : '';
  }

  const chipText = m => {
    if (m.kind === 'delegation') return 'to the orchestrator';
    if (m.kind in KIND_LONG && m.text === '' && m.state !== 'skipped') return '(empty: cancels the acknowledgement)';
    return m.text;
  };
  const chipState = m => (m.error || m.state === 'rejected' ? 'error' : m.state === 'waiting' || m.state === 'unconfirmed' ? 'waiting' : m.state === 'skipped' || m.dim ? 'dim' : '');

  function draw(s, live) {
    const nowMs = live ? toMs(s, Date.now() + skew) : null;
    const lay = s.lay = layout(s, nowMs);
    const { segs, yOf, chips, spans, levels } = lay;
    const px = n => `${n.toFixed(1)}px`;
    let html = '<div class="ov-lane user"></div><div class="ov-lane assistant"></div><div class="ov-lane messages"></div>';
    const tickStep = scale >= 56 ? 1000 : scale >= 28 ? 2000 : 5000;
    for (const g of segs) {
      if (g.gap) { html += `<div class="ov-gap" style="top:${px(g.y)};height:${px(g.h)}"><span>${span(g.to - g.from)} quiet</span></div>`; continue; }
      for (let t = Math.ceil(g.from / tickStep) * tickStep; t <= g.to; t += tickStep) html += `<div class="ov-tick" style="top:${px(yOf(t))}"><span>${clock(t)}</span></div>`;
    }
    for (const [key, lane] of [['mic', 'user'], ['out', 'assistant']]) {
      const d = levelPath(levels[key], yOf);
      if (d) html += `<svg class="ov-level ${lane}" width="${STRIP_W}" height="${Math.ceil(lay.height)}" aria-hidden="true"><path d="${d}"/></svg>`;
    }
    // The block is as tall as the speech lasted. Its words may run on below
    // it, up to the next block in the same lane.
    for (const role of ['user', 'assistant']) {
      const turns = [...s.turns.values()].filter(turn => turn.role === role).sort((a, b) => a.start - b.start);
      turns.forEach((turn, index) => {
        const top = yOf(turn.start), height = Math.max(15, yOf(turn.end) - top);
        const room = (index + 1 < turns.length ? yOf(turns[index + 1].start) : lay.height) - top - 3;
        html += `<div role="button" tabindex="0" class="ov-turn ${role}${selected === turn.id ? ' sel' : ''}" data-id="${esc(turn.id)}" style="top:${px(top)};height:${px(height)}">`
          + `<span style="max-height:${px(Math.max(height, room))}">${esc(turn.text)}</span></div>`;
      });
    }
    for (const { sp, a, b, ticks } of spans) {
      const top = yOf(a), end = yOf(b ?? nowMs ?? lay.end);
      html += `<button type="button" class="ov-span ${sp.lane}${b == null ? ' open' : ''}${selected === sp.id ? ' sel' : ''}" data-id="${sp.id}" style="top:${px(top)};height:${px(Math.max(5, end - top))}" aria-label="${esc(sp.title)}">`
        + ticks.map(t => `<i style="top:${px(Math.max(0, yOf(t) - top))}"></i>`).join('') + '</button>';
    }
    for (const { m, t, h, at, top } of chips) {
      const state = chipState(m);
      html += `<div class="ov-line f-${m.from} k-${m.kind}" style="top:${px(at)}"></div>`;
      const drop = top + CHIP_H / 2 - at;
      if (Math.abs(drop) > 2) html += `<div class="ov-stem f-${m.from}" style="top:${px(Math.min(at, at + drop))};height:${px(Math.abs(drop))}"></div>`;
      html += `<button type="button" class="ov-chip f-${m.from} k-${m.kind} ${state}${selected === m.id ? ' sel' : ''}" data-id="${m.id}" style="top:${px(top)};height:${h}px">`
        + `<span><time>${exact(t).replace(' s', '')}</time>${TAG[m.kind] ? `<b>${TAG[m.kind]}</b> ` : ''}${esc(chipText(m))}</span></button>`;
    }
    if (nowMs != null) html += `<div class="ov-now" style="top:${px(yOf(nowMs))}"><span>now ${clock(nowMs)}</span></div>`;
    const title = s.id ? `Call ${s.number}, started ${new Date(s.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Before the first call';
    const length = s.id ? `<span>${live ? 'live, ' : ''}${exact(nowMs ?? lay.end)} on the call clock</span>` : '';
    if (!s.node) { s.node = document.createElement('section'); s.node.className = 'ov-session'; }
    s.node.innerHTML = `<header class="ov-title"><b>${esc(title)}</b>${length}</header><div class="ov-track" style="height:${Math.ceil(lay.height)}px">${html}</div>`;
    s.dirty = false;
  }

  function render() {
    pending = null;
    if (scroll.offsetParent === null) return;   // not on screen; redrawn when shown
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
    const shown = sessions.filter(s => s.id || s.marks.length || s.turns.size || s.spans.length);
    for (const s of shown) { const live = Boolean(s.id) && !s.closed && isLive(s.id); if (s.dirty || live || !s.node) draw(s, live); }
    const nodes = shown.map(s => s.node);
    if (nodes.length !== scroll.children.length || nodes.some((node, i) => scroll.children[i] !== node)) {
      scroll.replaceChildren(...(nodes.length ? nodes : [Object.assign(document.createElement('p'), { className: 'ov-empty', textContent: 'Start a call. Speech, audio and every message to GPT-Live are drawn here on one clock.' })]));
    }
    if (follow() && atBottom) scroll.scrollTop = scroll.scrollHeight;
  }
  function schedule() { pending ??= setTimeout(render, 150); }
  setInterval(() => { if (sessions.some(s => s.id && !s.closed && isLive(s.id))) schedule(); }, 500);

  /* ---------------- Detail for the selected item ---------------- */
  // What was being said at a moment on the call clock.
  function speaking(s, t) {
    const turns = [...s.turns.values()];
    const during = turns.filter(turn => turn.start <= t && t <= turn.end).map(turn => (turn.role === 'user' ? 'you were speaking' : 'Kit was speaking'));
    if (during.length) return `Landed while ${during.join(' and ')}.`;
    const before = turns.filter(turn => turn.end < t).sort((a, b) => b.end - a.end)[0];
    const after = turns.filter(turn => turn.start > t).sort((a, b) => a.start - b.start)[0];
    const parts = [];
    if (before) parts.push(`${span(t - before.end)} after ${before.role === 'user' ? 'you' : 'Kit'} stopped`);
    if (after) parts.push(`${span(after.start - t)} before ${after.role === 'user' ? 'you' : 'Kit'} started`);
    return parts.length ? `Landed in silence: ${parts.join(', ')}.` : 'Nobody had spoken yet.';
  }
  function describe(id) {
    for (const s of sessions) {
      const turn = [...s.turns.values()].find(item => item.id === id);
      if (turn) {
        const facts = [`${exact(turn.start)} to ${exact(turn.end)} on the call clock (${span(turn.end - turn.start)}).`];
        const other = turn.role === 'user' ? 'assistant' : 'user';
        const next = [...s.turns.values()].filter(item => item.role === other && item.start >= turn.end).sort((a, b) => a.start - b.start)[0];
        if (next) facts.push(`${other === 'assistant' ? 'Kit' : 'You'} started ${span(next.start - turn.end)} after this ended.`);
        const inside = s.marks.filter(m => { const t = markTime(s, m); return t >= turn.start && t <= turn.end; });
        if (inside.length) facts.push(`${inside.length} message${inside.length === 1 ? '' : 's'} landed during it.`);
        return { title: turn.role === 'user' ? 'You said' : 'Kit said', facts, text: turn.text, seqs: [turn.seq] };
      }
      const m = s.marks.find(item => item.id === id);
      if (m) {
        const t = markTime(s, m), facts = [];
        const sender = `${WHO[m.from] ?? m.from}${m.sub ? ` ${m.sub}` : ''}`;
        let title = TAG[m.kind] || 'Event';
        if (m.kind in KIND_LONG) {
          title = `${sender} sent ${KIND_LONG[m.kind]}${m.manual ? ' (from the composer)' : ''}`;
          facts.push(m.state === 'accepted' ? `Accepted by GPT-Live in ${span(m.ackMs)}.` : m.state === 'skipped' ? (m.note ?? 'Not sent.') : m.state === 'rejected' ? (m.note ?? 'Rejected.') : m.state === 'unconfirmed' ? 'Not confirmed before the call closed.' : 'Waiting for the acknowledgement.');
        } else if (m.kind === 'delegation') title = 'GPT-Live delegated to the orchestrator';
        else if (m.kind === 'typed') title = 'You typed a request';
        else if (m.kind === 'tool') title = 'Orchestrator step';
        else if (m.kind === 'end') title = 'Call ended';
        facts.unshift(`At ${exact(t)} on the call clock (${wall(m.at)}${m.t == null && s.id ? ', placed from the wall clock' : ''}).`);
        if (s.id && m.kind !== 'end') facts.push(speaking(s, t));
        return { title, facts, text: chipText(m), seqs: [m.seq, m.ackSeq].filter(Boolean) };
      }
      const sp = s.spans.find(item => item.id === id);
      if (sp) {
        const a = toMs(s, sp.startAt), facts = [`Started at ${exact(a)} on the call clock (${wall(sp.startAt)}).`];
        facts.push(sp.endAt == null ? 'Still running.' : `Took ${span(sp.endAt - sp.startAt)}${sp.note && sp.lane === 'subagent' ? `, ${sp.note}` : ''}.`);
        const steps = sp.ticks.map(tick => `${exact(toMs(s, tick.at))}  ${tick.text}`).join('\n');
        return { title: sp.lane === 'orchestrator' ? sp.title : `Subagent ${sp.sub} run`, facts, text: [sp.lane === 'orchestrator' ? sp.note : '', steps].filter(Boolean).join('\n'), seqs: [sp.seq] };
      }
    }
    return null;
  }
  function showDetail() {
    const item = selected ? describe(selected) : null;
    detail.hidden = !item;
    if (!item) { detail.replaceChildren(); return; }
    const raw = item.seqs.map(seq => rawEvent(seq)).filter(Boolean);
    detail.innerHTML = `<div class="ov-detail-head"><b>${esc(item.title)}</b><button type="button" class="quiet" data-close aria-label="Close">Close</button></div>`
      + `<ul>${item.facts.map(fact => `<li>${esc(fact)}</li>`).join('')}</ul>`
      + (item.text ? `<p class="ov-detail-text">${esc(item.text)}</p>` : '')
      + (raw.length ? `<details><summary>Raw event${raw.length > 1 ? 's' : ''}</summary><pre>${esc(JSON.stringify(raw.length > 1 ? raw : raw[0], null, 2))}</pre></details>` : '');
  }
  function select(id) {
    selected = selected === id ? null : id;
    for (const s of sessions) s.dirty = true;
    showDetail(); render();
  }
  scroll.addEventListener('click', event => { const node = event.target.closest('[data-id]'); if (node) select(node.dataset.id); });
  scroll.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.ov-turn')) { event.preventDefault(); select(event.target.dataset.id); } });
  detail.addEventListener('click', event => { if (event.target.closest('[data-close]')) select(selected); });

  return {
    reset, handle,
    refresh() { for (const s of sessions) s.dirty = true; render(); },
    zoom(direction) {
      const next = SCALES[Math.min(SCALES.length - 1, Math.max(0, SCALES.indexOf(scale) + direction))];
      if (next === scale) return scale;
      scale = next; localStorage.setItem('dashkit.overlay.scale', String(scale));
      for (const s of sessions) s.dirty = true;
      render();
      return scale;
    },
    get scale() { return scale; }
  };
}
