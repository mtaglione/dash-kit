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
//   - the voice prompt, the dispatcher prompt and the lookup instruction can be
//     edited for a test call without changing the Boosker code;
//   - the call's Claude sessions are listed with where each can be opened in
//     Claude: the dispatcher's own session ("Dash Kit dispatcher · <time>",
//     registered with Remote Control by the Boosker code) and every agent session.
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
    // The voice's instructions as a phone call sends them: the app's agent
    // prompt, then the paragraph the broker adds.
    let voicePrompt = '', voicePromptNote = null;
    try { voicePrompt = `${appVoicePrompt(readFileSync(join(dir, 'Shared', 'AgentProfile.swift'), 'utf8'))}\n${live.dispatcherDelegationInstructions}`; }
    catch (error) { voicePromptNote = `The app's default voice prompt could not be read (${error.message}). Paste the prompt in use.`; }
    return {
      available: true, dir, version: gitVersion(dir), voicePromptNote,
      AgentCall: live.AgentCall, Dispatcher: dispatcher.Dispatcher, ClaudeHost: host.ClaudeHost, dispatcherTitle: dispatcher.dispatcherTitle ?? null,
      // The three prompts of a Boosker call. A session gets the request as it
      // was spoken; only a lookup has an instruction added.
      defaults: { voicePrompt, dispatcherPrompt: dispatcher.dispatcherPrompt, lookupPrompt: host.retrievalInstructions },
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

// A lookup's instruction is written into its prompt; an edit made here takes
// the built-in text's place wherever it appears in the process arguments.
export function withLookupPrompt(args, builtIn, edited) {
  if (!builtIn || !edited || edited === builtIn) return args;
  return args.map(arg => (typeof arg === 'string' && arg.includes(builtIn) ? arg.replace(builtIn, () => edited) : arg));
}

// The Claude session client for Boosker mode. Lookups it starts use the lookup
// instruction as it is set when each one starts.
export function createBooskerHost(boosker, { cwd, settings, spawnProcess = spawn }) {
  return new boosker.ClaudeHost({ cwd, spawnProcess: (binary, args, options) => spawnProcess(binary, withLookupPrompt(args, boosker.defaults.lookupPrompt, settings().boosker.lookupPrompt), options) });
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
    this.agents = new Map(); this.byThread = new Map(); this.byTurn = new Map(); this.linking = new Set();
    this.lookups = 0; this.turns = 0; this.asking = 0; this.sender = null; this.closed = false; this.disposed = false;
    const s = settings().boosker;

    this.onFeed = event => { try { this.translate(event); } catch (error) { console.error('Boosker feed event could not be shown', error); } };
    host.feed?.on('event', this.onFeed);

    // The dispatcher's Claude session is named for this call, so it can be
    // found in the Claude session list ("Dash Kit dispatcher · Nov 12, 2:25 PM").
    const title = boosker.dispatcherTitle?.('Dash Kit dispatcher') ?? 'Dash Kit dispatcher';
    const dispatcher = new boosker.Dispatcher({ binary: host.binary, directory: join(dataDir, 'dispatcher'), title,
      spawnProcess: (binary, args, options) => spawnProcess(binary, withSystemPrompt(args, s.dispatcherPrompt), options) });
    // `listed`: 'starting' until Claude answers, then 'listed' (with `url`),
    // 'unlisted' (with `error`), or 'off' when the Boosker code does not register it.
    this.dispatcherSession = { title, claudeSessionId: dispatcher.sessionID ?? null, listed: { starting: 'starting', enabled: 'listed', unavailable: 'unlisted' }[dispatcher.remote?.state] ?? 'off', url: null, error: null, process: 'starting' };
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

  // What the dashboard shows of the dispatcher's own Claude session.
  dispatcherInfo() { return { ...this.dispatcherSession, turns: this.turns, asking: this.asking > 0 }; }
  // The dispatcher's process and its place in the Claude session list, then
  // every dispatcher turn: what it was given, what it answered, how long it took.
  watchDispatcher(dispatcher) {
    const session = this.dispatcherSession;
    const set = fields => { Object.assign(session, fields); this.changed(); };
    const told = () => ({ title: session.title, claudeSessionId: session.claudeSessionId, listed: session.listed, url: session.url, error: session.error });
    dispatcher.on?.('spawn', ({ sessionID, resume }) => {
      set({ claudeSessionId: sessionID ?? session.claudeSessionId, process: 'running' });
      this.publish({ type: 'dispatcher.started', from: 'orchestrator', label: `Dispatcher session ${resume ? 'resumed' : 'started'}: "${session.title}"`, quiet: true, ...told() });
    });
    dispatcher.on?.('exit', ({ message, code }) => {
      set({ process: 'ended' });
      this.publish({ type: 'dispatcher.exited', from: 'orchestrator', label: `Dispatcher process ended: ${message ?? code}`, quiet: true });
    });
    dispatcher.on?.('remote', remote => {
      const listed = remote.state === 'enabled' && remote.sessionUrl ? 'listed' : remote.state === 'unavailable' ? 'unlisted' : remote.state === 'off' ? 'off' : 'starting';
      const news = listed !== session.listed || (remote.sessionUrl ?? null) !== session.url;
      set({ listed, url: remote.sessionUrl ?? session.url, error: listed === 'unlisted' ? remote.error ?? 'Remote Control is not available' : null });
      if (!news || listed === 'starting') return;
      this.publish({ type: 'dispatcher.session', from: 'orchestrator', ...told(),
        label: listed === 'listed' ? `Dispatcher session listed in Claude as "${session.title}"` : `Dispatcher session is not listed in Claude: ${session.error ?? 'Remote Control is off'}` });
    });
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
    if (e.threadID && key.startsWith('s')) this.linkSession(key, e.threadID);
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

  // Where an agent session can be opened in Claude. The session host registers
  // each one with Remote Control a moment after it starts, so its address is
  // asked for a few times.
  linkSession(key, threadID, { tries = 8, everyMs = 3000 } = {}) {
    if (this.linking.has(key) || typeof this.host.request !== 'function') return;
    this.linking.add(key);
    const attempt = left => {
      if (this.disposed) return;
      const again = () => { if (left > 1) setTimeout(() => attempt(left - 1), everyMs).unref?.(); };
      Promise.resolve().then(() => this.host.request('GET', `/sessions/${threadID}`)).then(snapshot => {
        const url = snapshot?.remoteControl?.sessionUrl;
        if (!url) { again(); return; }
        this.agent(key, { url, claudeSessionId: threadID });
        this.publish({ type: 'subagent.session', from: 'subagent', sub: key, url, claudeSessionId: threadID, label: `${key} can be opened in Claude`, quiet: true });
      }, again);
    };
    attempt(tries);
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
