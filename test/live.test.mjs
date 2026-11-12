import test from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../lib/bus.mjs';
import { defaultSettings } from '../lib/config.mjs';
import { LiveCall, buildSessionConfig } from '../lib/live.mjs';
import { FakeSideband } from './helpers.mjs';

const make = (patch = {}) => {
  const settings = defaultSettings();
  Object.assign(settings.voice, patch);
  const bus = new Bus();
  const call = new LiveCall({ client: {}, sessionId: 'live_abc', bus, settings: () => settings, Sideband: FakeSideband }).connect();
  return { call, bus, ws: call.ws, settings };
};

test('session config: client delegation, voice, greeting as a developer message', () => {
  const s = defaultSettings();
  const config = buildSessionConfig(s);
  assert.equal(config.model, 'gpt-live-1');
  assert.deepEqual(config.delegation, { type: 'client' });
  assert.equal(config.audio.output.voice, 'marin');
  assert.equal(config.input[0].role, 'developer');
  assert.equal(config.input[0].content[0].type, 'input_text');
  s.voice.ackDelayMs = 800; s.voice.greeting.enabled = false;
  const quiet = buildSessionConfig(s);
  assert.deepEqual(quiet.delegation, { type: 'client', acknowledgement_delay_ms: 800 });
  assert.deepEqual(quiet.input, []);
  assert.equal('format' in quiet.audio, false);
});

test('attaches the sideband to the session id and groups transcript turns', () => {
  const { ws, bus, call } = make();
  assert.deepEqual(ws.params, { session_id: 'live_abc' });
  ws.server({ type: 'session.input_transcript.delta', event_id: 'a', delta: 'Check the', start_ms: 100, end_ms: 400 });
  ws.server({ type: 'session.input_transcript.delta', event_id: 'b', delta: ' weather', start_ms: 450, end_ms: 800 });
  ws.server({ type: 'session.input_transcript.delta', event_id: 'b', delta: ' weather', start_ms: 450, end_ms: 800 });
  assert.equal(call.transcript.turns.length, 1);
  assert.equal(call.transcript.turns[0].text, 'Check the weather');
  const rows = bus.history.filter(e => e.type === 'transcript');
  assert.equal(rows.length, 1, 'turn rows replace each other by key');
  assert.equal(rows[0].from, 'user'); assert.equal(rows[0].to, 'voice');
});

test('a client delegation is recorded and emitted; suppressAck sends an empty thinking append first', () => {
  const { ws, call } = make({ suppressAck: true });
  let emitted = null;
  call.on('delegation', d => { emitted = d; });
  ws.server({ type: 'session.delegation.created', event_id: 'd1', offset_ms: 3600, delegation: { id: 'del_1', type: 'delegation', target: 'client' } });
  assert.equal(emitted.id, 'del_1');
  assert.equal(call.latestDelegationId(), 'del_1');
  assert.deepEqual({ ...ws.sent[0], event_id: undefined }, { type: 'session.thinking.append', event_id: undefined, delegation_id: 'del_1', content: '' });
});

test('appends carry delegation_id, are acknowledged by client_event_id, and errors are matched', () => {
  const { ws, bus, call } = make();
  const [id] = call.append('commentary', 'It is sunny.', null, { origin: 'subagent', sub: 's1' });
  assert.equal(ws.sent[0].type, 'session.commentary.append');
  assert.equal(ws.sent[0].delegation_id, null);
  ws.server({ type: 'session.commentary.appended', event_id: 'ack1', client_event_id: id, start_ms: 4600, end_ms: 4800 });
  const ack = bus.history.find(e => e.type === 'append.ack');
  assert.equal(ack.replyTo, id); assert.equal(ack.to, 'subagent');
  const [bad] = call.append('thinking', 'x', 'del_unknown');
  ws.server({ type: 'error', event_id: 'err1', error: { code: 'invalid_delegation', message: 'unknown delegation', client_event_id: bad } });
  const error = bus.history.find(e => e.type === 'error');
  assert.equal(error.replyTo, bad); assert.equal(error.to, 'orchestrator');
});

test('long content is split; session.closed finishes the call and later appends are skipped', () => {
  const { ws, bus, call } = make();
  call.append('thinking', 'word '.repeat(800));
  assert.ok(ws.sent.length >= 3);
  let closed = null; call.on('closed', info => { closed = info; });
  ws.server({ type: 'session.closed', event_id: 'c1', reason: 'close_requested', usage: { seconds: 42 } });
  assert.deepEqual(closed, { reason: 'close_requested', usageSeconds: 42 });
  assert.equal(ws.closed, true);
  call.append('commentary', 'late');
  assert.equal(bus.history.at(-1).type, 'append.skipped');
});

// Idle cutoff.
const idleCall = ({ minutes = 5, isBusy = () => false } = {}) => {
  const settings = defaultSettings();
  settings.voice.idleCloseMin = minutes;
  const clock = { at: 1_000_000 };
  const bus = new Bus();
  const call = new LiveCall({ client: {}, sessionId: 'live_idle', bus, settings: () => settings, Sideband: FakeSideband, now: () => clock.at, isBusy, idleCheckMs: 0 }).connect();
  call.ws.server({ type: 'session.started', event_id: 's1' });
  return { call, bus, ws: call.ws, clock, settings };
};
const closesSent = ws => ws.sent.filter(payload => payload.type === 'session.close').length;

test('a call with no speech is closed after the idle limit, and says why', () => {
  const { call, ws, bus, clock } = idleCall();
  clock.at += 4 * 60000 + 59000;
  assert.equal(call.checkIdle(), false);
  assert.equal(closesSent(ws), 0);
  clock.at += 2000;
  assert.equal(call.checkIdle(), true);
  assert.equal(closesSent(ws), 1);
  assert.match(bus.history.find(e => e.type === 'idle').label, /No speech for 5 min/);
  assert.equal(call.checkIdle(), false, 'a call that is closing is not closed twice');
  assert.equal(closesSent(ws), 1);
});

test('speech from either side, a delegation, or an append restarts the idle limit', () => {
  const { call, ws, clock } = idleCall();
  const wait = () => { clock.at += 4 * 60000; return call.checkIdle(); };
  assert.equal(wait(), false);
  ws.server({ type: 'session.input_transcript.delta', event_id: 'u1', delta: 'hello', start_ms: 0, end_ms: 300 });
  assert.equal(wait(), false);
  ws.server({ type: 'session.output_transcript.delta', event_id: 'a1', delta: 'hi', start_ms: 400, end_ms: 600 });
  assert.equal(wait(), false);
  ws.server({ type: 'session.delegation.created', event_id: 'd1', offset_ms: 700, delegation: { id: 'del_1', target: 'client' } });
  assert.equal(wait(), false);
  call.append('commentary', 'Here is the result.');
  assert.equal(wait(), false);
  assert.equal(wait(), true);
});

test('a call is not closed while backend work is running, and the limit starts again when it ends', () => {
  let busy = true;
  const { call, clock } = idleCall({ isBusy: () => busy });
  clock.at += 20 * 60000;
  assert.equal(call.checkIdle(), false);
  busy = false;
  clock.at += 4 * 60000;
  assert.equal(call.checkIdle(), false);
  clock.at += 2 * 60000;
  assert.equal(call.checkIdle(), true);
});

test('an idle limit of 0 turns the cutoff off', () => {
  const { call, ws, clock } = idleCall({ minutes: 0 });
  clock.at += 119 * 60000;
  assert.equal(call.checkIdle(), false);
  assert.equal(closesSent(ws), 0);
});
