import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { appVoicePrompt, withSystemPrompt, loadBoosker } from '../lib/boosker.mjs';
import { SettingsStore } from '../lib/config.mjs';
import { FakeSideband, scriptedClient, until } from './helpers.mjs';

process.env.OPENAI_API_KEY ||= 'test-key';

const SWIFT = `
struct AgentProfile {
    static let speakingStyle = """
        Speak casually.

        Backchannel policy: often.
        """

    static let previousSpeakingStyle = """
        Speak playfully.
        """

    static func stockInstructions(name: String = "Boosker", computerAccess: Bool = false, style: String = AgentProfile.speakingStyle) -> String {
        var capabilities: [String]
        if computerAccess {
            capabilities = ["- Computer: ask the agent on your computer."]
        } else {
            capabilities = ["- Reasoning: think."]
        }
        return """
        \\(style)

        Delegation policy:
        \\(capabilities.joined(separator: "\\n"))

        Do not guess the result while waiting.
        """
    }
}`;

test('the app voice prompt is the current speaking style followed by the delegation policy with computer access', () => {
  assert.equal(appVoicePrompt(SWIFT),
    'Speak casually.\n\nBackchannel policy: often.\n\nDelegation policy:\n- Computer: ask the agent on your computer.\n\nDo not guess the result while waiting.');
  assert.throws(() => appVoicePrompt('struct Nothing {}'), /not found/);
});

test('the edited dispatcher prompt replaces the built-in one in the process arguments', () => {
  assert.deepEqual(withSystemPrompt(['-p', '--system-prompt', 'built in', '--model', 'm'], 'edited'), ['-p', '--system-prompt', 'edited', '--model', 'm']);
  assert.deepEqual(withSystemPrompt(['-p', '--model', 'm'], 'edited'), ['-p', '--model', 'm']);
});

test('a missing Boosker folder leaves Boosker mode unavailable with a reason', async () => {
  const loaded = await loadBoosker(join(tmpdir(), 'no-such-boosker-folder'));
  assert.equal(loaded.available, false);
  assert.match(loaded.reason, /No Boosker broker code/);
});

test('a Boosker text that matches the repository is not saved, so it keeps following the repository', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'dashkit-')), 'settings.json');
  const first = new SettingsStore(path, { boosker: { voicePrompt: 'repo voice v1', delegationParagraph: 'repo paragraph', dispatcherPrompt: 'repo dispatcher' } });
  first.update({ boosker: { enabled: true, dispatcherPrompt: 'edited dispatcher' } });
  const onDisk = JSON.parse(readFileSync(path, 'utf8')).boosker;
  assert.deepEqual(onDisk, { enabled: true, dispatcherPrompt: 'edited dispatcher', graceMs: 500 });
  const later = new SettingsStore(path, { boosker: { voicePrompt: 'repo voice v2', delegationParagraph: 'repo paragraph', dispatcherPrompt: 'repo dispatcher v2' } });
  assert.equal(later.get().boosker.voicePrompt, 'repo voice v2');
  assert.equal(later.get().boosker.dispatcherPrompt, 'edited dispatcher');
  assert.equal(later.reset('boosker').boosker.dispatcherPrompt, 'repo dispatcher v2');
  assert.equal(later.get().boosker.enabled, true, 'reloading the texts keeps the mode switch');
});

/* ---- A call in Boosker mode, with stand-ins for the broker code ---- */
class FakeFeed extends EventEmitter { publish(lane, type, data = {}) { const event = { lane, type, ...data }; this.emit('event', event); return event; } }
class FakeDispatcher extends EventEmitter {
  static instances = [];
  constructor(options) { super(); this.options = options; this.notes = []; this.asked = []; FakeDispatcher.instances.push(this); }
  start() { return this; }
  ask(message) { this.asked.push(message); return Promise.resolve({ text: '{"actions":[]}', ms: 7 }); }
  close() { this.closed = true; }
}
// The parts of AgentCall the bridge relies on: it reads the shared socket,
// names sessions s1…, and sends progress and results through progress()/result().
class FakeAgentCall {
  static instances = [];
  constructor(options) {
    Object.assign(this, options);
    this.threads = new Map(); this.sessionCount = 0; this.fragments = []; this.received = []; this.stopped = false;
    this.onMessage = data => this.received.push(JSON.parse(data.toString()));
    this.socket.on('message', this.onMessage);
    FakeAgentCall.instances.push(this);
  }
  async ready() {}
  send(kind, content, delegationID = null) { this.socket.send(JSON.stringify({ type: `session.${kind}.append`, event_id: `fake_${kind}_${Math.random().toString(36).slice(2, 8)}`, delegation_id: delegationID, content })); }
  progress(line) { this.send('thinking', line); }
  result(text) { this.send('commentary', text); }
  failed(message) { this.send('commentary', message); }
  ids(turnID, delegationID) { return { turnID, delegationID }; }
  mintTurnID() { return 't_typed'; }
  async delegate(id, offset, ids) { this.delegated = { id, offset, ids, text: this.fragments.at(-1)?.text }; }
  threadByKey(key) { for (const [thread, entry] of this.threads) if (entry.key === key) return thread; return null; }
  async stopThread(thread) { this.stoppedThread = thread; this.threads.delete(thread); }
  stop() { this.stopped = true; this.socket.off('message', this.onMessage); }
}

async function startBoosker() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dashkit-'));
  const host = { feed: new FakeFeed(), binary: 'claude', stop() {} };
  const boosker = { available: true, dir: '/repos/Boosker', version: 'abc1234', AgentCall: FakeAgentCall, Dispatcher: FakeDispatcher, ClaudeHost: class {},
    defaults: { voicePrompt: 'VOICE PROMPT', delegationParagraph: 'DELEGATION PARAGRAPH', dispatcherPrompt: 'DISPATCHER PROMPT' },
    models: { dispatcher: 'sonnet', dispatcherEffort: 'low', worker: 'opus', workerEffort: 'xhigh' } };
  const sessions = [];
  const client = scriptedClient([]);
  const kit = createApp({ client, dataDir, Sideband: FakeSideband, boosker, booskerHost: host, createSession: async (c, settings, sdp) => { sessions.push(settings); return c.live.create(); } });
  await new Promise(done => kit.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${kit.server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const types = () => kit.bus.history.map(event => event.type);
  return { kit, host, post, base, sessions, types, stop: () => new Promise(done => { kit.shutdown(); kit.server.closeAllConnections?.(); kit.server.close(done); }) };
}

test('Boosker mode: the call uses Boosker texts, the handler shares the sideband, and its feed is drawn as dispatcher turns and session cards', async () => {
  const { kit, host, post, base, stop } = await startBoosker();
  try {
    kit.store.update({ boosker: { enabled: true, graceMs: 900 }, voice: { greeting: { enabled: false } } });
    const config = await (await fetch(base + '/api/session-config')).json();
    assert.equal(config.instructions, 'VOICE PROMPT\nDELEGATION PARAGRAPH');
    assert.equal(config.store, false);
    assert.equal((await post('/api/session', { sdp: 'v=0\r\noffer' })).status, 201);
    const ws = FakeSideband.instances.at(-1), call = FakeAgentCall.instances.at(-1), dispatcher = FakeDispatcher.instances.at(-1);
    assert.equal(call.graceMS, 900);
    assert.equal(call.sessionID, 'live_test123');
    assert.equal(call.dispatcher, dispatcher);
    assert.deepEqual(dispatcher.options.spawnProcess && withSystemPrompt(['--system-prompt', 'x'], kit.store.get().boosker.dispatcherPrompt), ['--system-prompt', 'DISPATCHER PROMPT']);

    // Events from GPT-Live reach the handler; audio frames are left out.
    ws.server({ type: 'session.started', event_id: 's', session: { id: 'live_test123' } });
    ws.server({ type: 'session.output_audio.delta', delta: 'AAAA' });
    ws.server({ type: 'session.input_transcript.delta', event_id: 't1', delta: 'Start a task', start_ms: 0, end_ms: 900 });
    ws.server({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1000, delegation: { id: 'del_1', type: 'delegation', target: 'client' } });
    assert.deepEqual(call.received.map(event => event.type), ['session.started', 'session.input_transcript.delta', 'session.delegation.created']);
    assert.equal(kit.orchestrator.turns, 0, "Dash Kit's own orchestrator stays out of a Boosker call");

    // A dispatcher turn is shown with what it was given and what it answered.
    await call.dispatcher.ask('[request]\nUser said: "Start a task"');
    const input = kit.bus.history.find(event => event.type === 'orchestrator.input');
    assert.match(input.text, /User said: "Start a task"/);
    assert.equal(kit.bus.history.find(event => event.type === 'orchestrator.done').text, '{"actions":[]}');

    // The broker starts a session: a card appears under the dispatcher's name for it.
    const thread = { id: 'thread-1', title: 'Task one' };
    host.feed.publish('live', 'request', { sessionID: 'live_test123', action: 'start', title: 'Task one', text: 'Do the task', cwd: '/repos/dash-kit', turnID: 't1' });
    call.threads.set(thread, { key: `s${++call.sessionCount}` });
    host.feed.publish('codex', 'run.started', { sessionID: 'live_test123', threadID: 'thread-1', cwd: '/repos/dash-kit', prompt: 'Do the task' });
    host.feed.publish('codex', 'event', { sessionID: 'live_test123', threadID: 'thread-1', event: 'item.completed', item: 'command_execution', command: 'ls', exitCode: 0 });
    let state = await (await fetch(base + '/api/state')).json();
    assert.deepEqual(state.subagents.map(agent => [agent.id, agent.title, agent.folder, agent.status]), [['s1', 'Task one', 'dash-kit', 'running']]);
    assert.equal(state.boosker.active, true);
    assert.ok(kit.getCall().isBusy(), 'a working session keeps the idle cutoff away');

    // What the handler sends goes out on Dash Kit's sideband, and a session's
    // progress and result are marked with the session they came from.
    call.progress('Reading files', { turnID: 't1' }, thread);
    call.result('All done', { turnID: 't1' }, thread);
    call.send('commentary', 'Session "Task one" started on your computer.', 'del_1');
    assert.deepEqual(ws.sent.map(payload => [payload.type, payload.content]), [
      ['session.thinking.append', 'Reading files'], ['session.commentary.append', 'All done'], ['session.commentary.append', 'Session "Task one" started on your computer.']]);
    const appends = kit.bus.history.filter(event => event.type === 'append');
    assert.deepEqual(appends.map(event => [event.from, event.sub ?? null, event.kind]), [['subagent', 's1', 'thinking'], ['subagent', 's1', 'commentary'], ['orchestrator', null, 'commentary']]);
    ws.server({ type: 'session.commentary.appended', event_id: 'a1', client_event_id: ws.sent[1].event_id, start_ms: 10, end_ms: 20 });
    assert.equal(kit.bus.history.find(event => event.type === 'append.ack').replyTo, ws.sent[1].event_id);

    host.feed.publish('codex', 'result', { sessionID: 'live_test123', threadID: 'thread-1', text: 'All done' });
    host.feed.publish('codex', 'classified', { cwd: null, error: '429: no credits remaining' });
    host.feed.publish('live', 'request', { sessionID: 'another_call', action: 'start', title: 'Not ours', text: 'x' });
    state = await (await fetch(base + '/api/state')).json();
    assert.deepEqual(state.subagents.map(agent => [agent.id, agent.status, agent.result]), [['s1', 'done', 'All done']]);
    assert.match(kit.bus.history.findLast(event => event.type === 'orchestrator.error').label, /Router failed: 429/);

    // A typed request takes the path of a spoken one.
    assert.equal((await post('/api/request', { text: 'what is running' })).status, 200);
    await until(() => call.delegated);
    assert.equal(call.delegated.text, 'what is running');
    assert.equal(call.delegated.id, null);

    // The Stop button closes the session through the handler.
    assert.equal((await post('/api/subagents/s1/stop')).status, 200);
    assert.equal(call.stoppedThread, thread);

    // Hanging up stops the handler and its dispatcher.
    ws.server({ type: 'session.closed', event_id: 'c', reason: 'close_requested', usage: { seconds: 3 } });
    assert.equal(call.stopped, true);
    assert.equal((await (await fetch(base + '/api/state')).json()).boosker.active, false);
  } finally { await stop(); }
});

test('Boosker mode off: delegations go to Dash Kit\'s own orchestrator and no handler is made', async () => {
  const { kit, post, stop } = await startBoosker();
  try {
    const before = FakeAgentCall.instances.length;
    kit.store.update({ voice: { greeting: { enabled: false } }, orchestrator: { graceMs: 0 } });
    assert.equal((await post('/api/session', { sdp: 'v=0\r\noffer' })).status, 201);
    assert.equal(FakeAgentCall.instances.length, before);
    const ws = FakeSideband.instances.at(-1);
    ws.server({ type: 'session.delegation.created', event_id: 'd', offset_ms: 10, delegation: { id: 'del_9', type: 'delegation', target: 'client' } });
    await until(() => kit.orchestrator.turns === 1);
  } finally { await stop(); }
});

test('Boosker mode on without the Boosker code refuses the call and says why', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dashkit-'));
  const kit = createApp({ client: scriptedClient([]), dataDir, Sideband: FakeSideband, boosker: { available: false, dir: '/nowhere', reason: 'No Boosker broker code found in /nowhere/backend.' } });
  await new Promise(done => kit.server.listen(0, '127.0.0.1', done));
  try {
    kit.store.update({ boosker: { enabled: true } });
    const response = await fetch(`http://127.0.0.1:${kit.server.address().port}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp: 'v=0\r\noffer' }) });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /No Boosker broker code/);
  } finally { kit.shutdown(); kit.server.closeAllConnections?.(); await new Promise(done => kit.server.close(done)); }
});

/* ---- The real broker code, when a Boosker checkout sits beside this one ---- */
const booskerDir = process.env.BOOSKER_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'Boosker');
test('the real Boosker call handler answers a delegation through the shared sideband', { skip: !existsSync(join(booskerDir, 'backend', 'live-agent.mjs')) && 'no Boosker checkout beside this one' }, async () => {
  const real = await loadBoosker(booskerDir);
  assert.equal(real.available, true, real.reason);
  assert.match(real.defaults.voicePrompt, /Delegation policy:/);
  assert.match(real.defaults.delegationParagraph, /dispatcher/i);
  assert.match(real.defaults.dispatcherPrompt, /"actions"/);

  class SayingDispatcher extends FakeDispatcher {
    get usable() { return !this.closed; }
    note(line) { this.notes.push(line); }
    ask(message) { this.asked.push(message); return Promise.resolve({ text: '{"actions":[{"type":"say","text":"Nothing is running right now."}]}', ms: 5 }); }
  }
  const host = { feed: new FakeFeed(), binary: 'claude', ensure: async () => {}, threadsFor: () => [], threadFor: () => undefined, release() {}, stop() {} };
  const dataDir = mkdtempSync(join(tmpdir(), 'dashkit-'));
  const kit = createApp({ client: scriptedClient([]), dataDir, Sideband: FakeSideband, boosker: { ...real, Dispatcher: SayingDispatcher }, booskerHost: host });
  await new Promise(done => kit.server.listen(0, '127.0.0.1', done));
  try {
    kit.store.update({ boosker: { enabled: true, graceMs: 0 }, voice: { greeting: { enabled: false } } });
    const response = await fetch(`http://127.0.0.1:${kit.server.address().port}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp: 'v=0\r\noffer' }) });
    assert.equal(response.status, 201);
    const ws = FakeSideband.instances.at(-1);
    ws.server({ type: 'session.started', event_id: 's', session: { id: 'live_test123' } });
    ws.server({ type: 'session.input_transcript.delta', event_id: 't1', delta: 'What other sessions are you running right now', start_ms: 0, end_ms: 1500 });
    ws.server({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1600, delegation: { id: 'del_1', type: 'delegation', target: 'client' } });
    await until(() => ws.sent.some(payload => payload.type === 'session.commentary.append'), 4000);
    const spoken = ws.sent.find(payload => payload.type === 'session.commentary.append');
    assert.equal(spoken.content, 'Nothing is running right now.');
    assert.equal(spoken.delegation_id, 'del_1');
    const dispatcher = FakeDispatcher.instances.at(-1);
    assert.match(dispatcher.asked[0], /User said: "What other sessions are you running right now"/);
    assert.match(dispatcher.asked[0], /Sessions:\n- none/);
    const types = kit.bus.history.map(event => event.type);
    for (const type of ['delegation', 'orchestrator.input', 'orchestrator.done', 'orchestrator.tool', 'append']) assert.ok(types.includes(type), `${type} is on the timeline`);
    ws.server({ type: 'session.closed', event_id: 'c', reason: 'close_requested', usage: { seconds: 2 } });
    assert.equal(dispatcher.closed, true);
  } finally { kit.shutdown(); kit.server.closeAllConnections?.(); await new Promise(done => kit.server.close(done)); }
});
