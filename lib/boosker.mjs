// Boosker mode: a Dash Kit call handled by the Boosker broker's own code.
//
// The broker's per-call handler (backend/live-agent.mjs, AgentCall), its
// dispatcher (backend/dispatcher.mjs) and its Claude session client
// (backend/claude-host.mjs) are imported from the Boosker repository folder as
// they are. A call in the browser then behaves like a call from the phone, and
// an edit in that folder can be tried here before it is deployed.
//
// What Dash Kit adds around that code:
//   - the handler shares Dash Kit's sideband (the way it shares the Watch
//     relay's socket), so every message it sends to GPT-Live is shown and timed;
//   - the broker's event feed is translated into Dash Kit's event types, so the
//     thread and the timeline draw dispatcher turns and Claude sessions;
//   - the voice prompt, the delegation paragraph and the dispatcher prompt can
//     be edited for a test call without changing the Boosker code.
//
// Not covered: file cards on the phone, the Watch audio path, and the question
// list. Those need a device.
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const clip = (value, size) => { const t = String(value ?? '').replace(/\s+/g, ' ').trim(); return t.length > size ? t.slice(0, size - 1) + '…' : t; };

// A Swift multi-line string literal: the text between the opening """ line and
// the closing """, with the closing delimiter's indentation taken off each line.
function swiftBlock(source, opener) {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`"${opener}" not found`);
  const from = source.indexOf('"""', start) + 3;
  const to = source.indexOf('"""', from);
  if (from < 3 || to < 0) throw new Error(`no text block after "${opener}"`);
  const body = source.slice(from, to);
  const indent = body.slice(body.lastIndexOf('\n') + 1);
  return body.split('\n').slice(1, -1).map(line => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart())).join('\n');
}

// The prompt a new agent gets in the Boosker app (Shared/AgentProfile.swift,
// stockInstructions with computer access): the speaking style, then the
// delegation policy. The phone sends this, or the user's edit of it, when a
// call starts.
export function appVoicePrompt(swift) {
  const style = swiftBlock(swift, 'static let speakingStyle =');
  const stock = swift.slice(swift.indexOf('static func stockInstructions'));
  const template = swiftBlock(stock, 'return """');
  const computer = stock.match(/if computerAccess \{\s*capabilities = \["([^"]+)"\]/)?.[1];
  if (!computer || !template.includes('\\(style)')) throw new Error('the prompt template has changed shape');
  return template.replace('\\(style)', style).replace(/\\\(capabilities\.joined\(separator: "\\n"\)\)/, computer);
}

function gitVersion(dir) {
  try {
    const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }).trim();
    return git(['rev-parse', '--short', 'HEAD']) + (git(['status', '--porcelain', '--', 'backend', 'Shared/AgentProfile.swift']) ? ' with uncommitted changes' : '');
  } catch { return null; }
}

// Loads the broker code and the prompts in use from a Boosker checkout.
// `available: false` (with a reason) when the folder or its code is missing.
export async function loadBoosker(dir, { importModule = path => import(pathToFileURL(path).href) } = {}) {
  const backend = join(dir ?? '', 'backend');
  if (!dir || !existsSync(join(backend, 'live-agent.mjs'))) return { available: false, dir: dir ?? null, reason: `No Boosker broker code found in ${backend}. Set BOOSKER_DIR in .env.` };
  try {
    const [live, dispatcher, host] = await Promise.all(['live-agent.mjs', 'dispatcher.mjs', 'claude-host.mjs'].map(file => importModule(join(backend, file))));
    let voicePrompt = '', voicePromptNote = null;
    try { voicePrompt = appVoicePrompt(readFileSync(join(dir, 'Shared', 'AgentProfile.swift'), 'utf8')); }
    catch (error) { voicePromptNote = `The app's default voice prompt could not be read (${error.message}). Paste the prompt in use.`; }
    return {
      available: true, dir, version: gitVersion(dir), voicePromptNote,
      AgentCall: live.AgentCall, Dispatcher: dispatcher.Dispatcher, ClaudeHost: host.ClaudeHost,
      defaults: { voicePrompt, delegationParagraph: live.dispatcherDelegationInstructions, dispatcherPrompt: dispatcher.dispatcherPrompt },
      models: { dispatcher: dispatcher.DISPATCHER_MODEL, dispatcherEffort: dispatcher.DISPATCHER_EFFORT, worker: host.CLAUDE_MODEL, workerEffort: host.CLAUDE_EFFORT }
    };
  } catch (error) { return { available: false, dir, reason: `The Boosker broker code in ${backend} could not be loaded: ${error.message}` }; }
}

// What the dashboard is told about the loaded code (no classes).
export function booskerInfo(boosker) {
  if (!boosker) return { available: false, reason: 'Boosker mode is not set up on this server.' };
  const { available, dir, reason = null, version = null, voicePromptNote = null, defaults = null, models = null } = boosker;
  return { available, dir, reason, version, voicePromptNote, defaults, models };
}

// Replaces the dispatcher's built-in system prompt with the one edited here.
export function withSystemPrompt(args, prompt) {
  const at = args.indexOf('--system-prompt');
  if (at < 0 || !prompt) return args;
  return [...args.slice(0, at + 1), prompt, ...args.slice(at + 2)];
}

const OPEN = 1;   // WebSocket.OPEN
const HEAVY = new Set(['session.input_audio.append', 'session.output_audio.delta']);

// The socket the Boosker handler is given: Dash Kit's own sideband. Events from
// GPT-Live are passed on (audio frames left out; the handler only counts them),
// and what the handler sends goes out through LiveCall so it is recorded.
class SharedSocket extends EventEmitter {
  constructor(live, origin) {
    super();
    this.live = live; this.origin = origin; this.readyState = OPEN;
    this.forward = event => { if (!HEAVY.has(event.type)) this.emit('message', JSON.stringify(event)); };
    live.on('raw', this.forward);
  }
  send(data) { this.live.sendRaw(JSON.parse(data), this.origin()); }
  close() { /* the sideband belongs to LiveCall */ }
  release() { this.live.off('raw', this.forward); }
}

// One Boosker-handled call. `agents` are the cards the dashboard shows: one per
// Claude session (s1, s2…, the dispatcher's own names) and one per lookup (l1…).
export class BooskerBridge extends EventEmitter {
  constructor({ boosker, host, live, bus, settings, dataDir, deviceID = 'dash-kit', spawnProcess = spawn }) {
    super();
    Object.assign(this, { boosker, host, live, bus, deviceID });
    this.sessionId = live.sessionId;
    this.agents = new Map(); this.byThread = new Map(); this.byTurn = new Map();
    this.lookups = 0; this.turns = 0; this.asking = 0; this.sender = null; this.closed = false; this.disposed = false;
    const s = settings().boosker;

    this.onFeed = event => { try { this.translate(event); } catch (error) { console.error('Boosker feed event could not be shown', error); } };
    host.feed?.on('event', this.onFeed);

    const dispatcher = new boosker.Dispatcher({ binary: host.binary, directory: join(dataDir, 'dispatcher'),
      spawnProcess: (binary, args, options) => spawnProcess(binary, withSystemPrompt(args, s.dispatcherPrompt), options) });
    this.watchDispatcher(dispatcher);

    this.socket = new SharedSocket(live, () => this.sender ?? { origin: 'orchestrator' });
    this.call = new boosker.AgentCall({ host, key: null, sessionID: this.sessionId, deviceID, socket: this.socket, graceMS: s.graceMs, dispatcher,
      onDisconnect: () => {}, onClosed: () => {} });
    // Progress, results and failures are sent by the handler on a session's
    // behalf. Marking them here lets the timeline say which session each
    // message to the voice came from. (Method names from live-agent.mjs; if
    // they change, those messages are shown as the broker's own.)
    for (const name of ['progress', 'result', 'failed']) {
      const inner = this.call[name];
      if (typeof inner !== 'function') continue;
      this.call[name] = (value, ids, thread) => {
        const sub = thread ? this.keyOfThread(thread) : this.byTurn.get(ids?.turnID) ?? null;
        this.sender = { origin: sub ? 'subagent' : 'orchestrator', sub: sub ?? undefined, reason: name === 'progress' ? 'progress' : name === 'result' ? 'result' : 'failure' };
        try { return inner.call(this.call, value, ids, thread); } finally { this.sender = null; }
      };
    }
  }

  // Sessions still running for this device from an earlier call are adopted,
  // as the broker does when a new call starts.
  async start() { await this.call.ready(); }

  publish(event) { return this.bus.publish({ sessionId: this.sessionId, ...event }); }
  changed() { this.emit('change'); }

  // Every dispatcher turn: what it was given, what it answered, how long it took.
  watchDispatcher(dispatcher) {
    const ask = dispatcher.ask.bind(dispatcher);
    dispatcher.ask = (message, options) => {
      const turn = ++this.turns;
      const kind = /^\[(\w+)\]/.exec(message)?.[1] ?? 'request';
      const given = [...(dispatcher.notes ?? []), message].join('\n');
      this.asking += 1; this.changed();
      this.publish({ type: 'orchestrator.input', from: kind === 'request' ? 'voice' : 'subagent', to: 'orchestrator', key: `dispatcher-in:${this.sessionId}:${turn}`,
        label: `Dispatcher turn ${turn} (${kind})`, text: given });
      return ask(message, options).then(reply => {
        this.publish({ type: 'orchestrator.done', from: 'orchestrator', label: `Turn ${turn} done in ${reply.ms} ms: ${clip(reply.text, 160)}`, text: reply.text });
        return reply;
      }, error => {
        if (!this.closed) this.publish({ type: 'orchestrator.error', from: 'orchestrator', label: `Dispatcher turn ${turn} failed: ${error.message}` });
        throw error;
      }).finally(() => { this.asking -= 1; this.changed(); });
    };
  }

  keyOfThread(thread) {
    const key = this.call.threads?.get(thread)?.key ?? this.byThread.get(thread.id) ?? null;
    if (key && thread.id) this.byThread.set(thread.id, key);
    return key;
  }
  keyFor(event) {
    if (event.threadID) {
      if (this.byThread.has(event.threadID)) return this.byThread.get(event.threadID);
      for (const [thread, entry] of this.call.threads ?? []) if (thread.id === event.threadID) { this.byThread.set(thread.id, entry.key); return entry.key; }
      return null;
    }
    return this.byTurn.get(event.turnID) ?? null;
  }
  agent(key, fields = {}) {
    let agent = this.agents.get(key);
    if (!agent) { agent = { id: key, kind: key.startsWith('l') ? 'lookup' : 'session', title: '', task: '', folder: null, status: 'running', result: '' }; this.agents.set(key, agent); }
    Object.assign(agent, fields);
    this.changed();
    return agent;
  }
  summaries() { return [...this.agents.values()].map(agent => ({ ...agent })); }
  busy() { return !this.closed && (this.asking > 0 || [...this.agents.values()].some(agent => agent.status === 'running')); }

  // The broker's feed, in Dash Kit's event vocabulary.
  translate(e) {
    if (this.disposed || (e.sessionID && e.sessionID !== this.sessionId)) return;
    if (e.lane === 'live') return this.fromCall(e);
    if (e.lane === 'codex') return this.fromWorker(e);
  }
  fromCall(e) {
    const tool = (name, label, extra = {}) => this.publish({ type: 'orchestrator.tool', from: 'orchestrator', tool: name, delegationId: e.delegationID ?? null, label, ...extra });
    switch (e.type) {
      case 'request': {
        const folder = e.cwd ? basename(e.cwd) : 'repos root';
        if (e.action === 'start') {
          // The request is published just before the session gets its name.
          const key = `s${(this.call.sessionCount ?? this.agents.size) + 1}`;
          this.agent(key, { title: e.title ?? '', task: e.text ?? '', folder, status: 'running' });
          tool('start_subagent', `start → ${key} "${e.title ?? ''}" in ${folder}`, { to: 'subagent', sub: key, text: e.text });
        } else if (e.action === 'retrieve') {
          const key = `l${++this.lookups}`;
          this.byTurn.set(e.turnID, key);
          this.agent(key, { title: e.title ?? '', task: e.text ?? '', folder, status: 'running' });
          tool('start_subagent', `lookup → ${key} "${e.title ?? ''}" in ${folder}`, { to: 'subagent', sub: key, text: e.text });
        } else if (e.action === 'send') {
          const key = this.keyFor(e);
          tool('message_subagent', `send → ${key ?? 'session'}: ${clip(e.text, 140)}`, { to: 'subagent', sub: key ?? undefined, text: e.text });
        } else if (e.action === 'stop') tool('stop_subagent', `stop: ${clip(e.text, 140) || 'everything running'}`);
        else if (e.action === 'say') tool('tell_voice', `say: ${clip(e.text, 140)}`, { text: e.text });
        else this.publish({ type: 'orchestrator.direct', from: 'orchestrator', delegationId: e.delegationID ?? null, label: `Broker rule "${e.action}"${e.text ? ` for "${clip(e.text, 100)}"` : ''}` });
        return;
      }
      case 'dispatcher.turn':
        for (const refused of e.rejected ?? []) this.publish({ type: 'orchestrator.error', from: 'orchestrator', label: `Dispatcher action ignored: ${refused.type} (${refused.reason})` });
        return;
      case 'dispatcher.unused':
        this.publish({ type: 'orchestrator.direct', from: 'orchestrator', label: e.notice ? `Dispatcher notice turn failed: ${e.reason}` : `Dispatcher answer not used (${e.reason}); the broker's fixed rules took the request` });
        return;
      case 'dispatcher.action.failed': this.publish({ type: 'orchestrator.error', from: 'orchestrator', label: `Dispatcher ${e.action} action failed: ${e.message}` }); return;
      case 'dispatcher.failed': this.publish({ type: 'orchestrator.error', from: 'orchestrator', label: `Dispatcher unavailable: ${e.message}` }); return;
      case 'dispatcher.started': this.publish({ type: 'dispatcher.started', from: 'orchestrator', label: `Dispatcher process started${e.resume ? ' (resumed)' : ''}`, quiet: true }); return;
      case 'dispatcher.exited': this.publish({ type: 'dispatcher.exited', from: 'orchestrator', label: `Dispatcher process ended: ${e.message ?? e.code}`, quiet: true }); return;
      case 'progress.suppressed': this.publish({ type: 'progress.suppressed', from: 'subagent', label: `Progress line not sent to the voice (${e.reason}, ${e.chars} characters)`, quiet: true }); return;
      case 'append.skipped': this.publish({ type: 'append.skipped', from: 'orchestrator', to: 'voice', kind: e.kind, label: `Not sent (${e.reason}): ${e.kind}, ${e.chars} characters` }); return;
      default: return;   // transcript, audio, appends and acks are already shown from the sideband
    }
  }
  fromWorker(e) {
    if (e.type === 'classified') {
      const where = e.cwd ? basename(e.cwd) : 'repos root (no folder chosen)';
      const detail = [e.claudeModel, e.reasoningEffort].filter(Boolean).join(', ');
      this.publish({ type: e.error ? 'orchestrator.error' : 'orchestrator.tool', from: 'orchestrator', tool: 'route',
        label: `Folder router: ${where}${detail ? `, ${detail}` : ''}${e.error ? `. Router failed: ${clip(e.error, 160)}` : ''}` });
      return;
    }
    const key = this.keyFor(e);
    if (!key) return;
    const progress = text => this.publish({ type: 'subagent.progress', from: 'subagent', sub: key, label: `${key}: ${clip(text, 200)}`, text });
    switch (e.type) {
      case 'run.started': {
        const agent = this.agent(key, { status: 'running', ...(e.cwd ? { folder: basename(e.cwd) } : {}) });
        if (!agent.task && e.prompt) agent.task = clip(e.prompt, 600);
        progress(e.oneShot ? `Lookup started in ${agent.folder ?? 'repos root'}` : e.steered ? 'Took in a follow-up while working' : e.resume ? 'Started another turn' : `Session started in ${agent.folder ?? 'repos root'}`);
        return;
      }
      case 'event': {
        if (e.event !== 'item.completed') return;
        if (e.item === 'command_execution') progress(`Ran: ${clip(e.command, 160)} (exit ${e.exitCode ?? '?'})`);
        else if (e.item === 'file_change') progress(`Edited: ${clip(e.paths, 200)}`);
        else if (e.item === 'tool_use') progress(`Used: ${clip(e.text, 80)}`);
        else if (e.item === 'agent_message') progress(`Wrote: ${clip(e.text, 200)}`);
        else if (e.item === 'error') progress(`Error: ${clip(e.message, 200)}`);
        return;
      }
      case 'queued': progress('Follow-up queued behind the current turn'); return;
      case 'waiting': progress('Waiting: the session is busy'); return;
      case 'interrupt': progress('Interrupted'); return;
      case 'steer.refused': progress(`Follow-up not accepted while working: ${clip(e.message, 160)}`); return;
      case 'result':
        if (e.absorbed) { progress('An earlier turn was folded into the next one'); return; }
        this.agent(key, { status: 'done', result: e.text ?? '' });
        this.publish({ type: 'subagent.result', from: 'subagent', to: 'orchestrator', sub: key, label: `${key} finished: ${clip(e.text, 140)}`, text: e.text ?? '' });
        return;
      case 'failed': {
        if (e.absorbed) return;
        const stopped = e.message === 'The agent stopped.';
        this.agent(key, { status: stopped ? 'stopped' : 'failed', result: e.message ?? '' });
        this.publish({ type: stopped ? 'subagent.stopped' : 'subagent.failed', from: 'subagent', to: 'orchestrator', sub: key, label: `${key} ${stopped ? 'stopped' : `failed: ${clip(e.message, 140)}`}`, text: e.message ?? '' });
        return;
      }
      default: return;
    }
  }

  // A request typed in the dashboard, handled as if it had just been spoken:
  // it joins the handler's transcript as its own utterance and takes the same
  // path as a delegation (stop and status phrases, then the dispatcher).
  async typed(text) {
    const call = this.call;
    const at = call.fragments.reduce((end, f) => Math.max(end, f.end), 0) + 3000;
    call.fragments.push({ id: `typed_${randomUUID().slice(0, 8)}`, role: 'user', text, start: at, end: at });
    const ids = call.ids(call.mintTurnID(), null);
    call.currentIDs = ids;
    await call.delegate(null, at, ids);
  }

  // The Stop button on a session card: the session is closed for good, as when
  // the dispatcher stops it.
  async stop(key) {
    const thread = this.call.threadByKey?.(key);
    if (!thread || this.closed) return false;
    await this.call.stopThread(thread);
    this.agent(key, { status: 'stopped' });
    return true;
  }

  // The call ended: the handler and its dispatcher stop. Claude sessions keep
  // working, as they do when a phone call ends, and their later events still
  // reach the cards until dispose().
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.call.stop(); } catch (error) { console.error('Boosker call handler did not stop cleanly', error); }
    this.socket.release();
    this.changed();
  }
  dispose() { this.close(); this.disposed = true; this.host.feed?.off('event', this.onFeed); }
}
