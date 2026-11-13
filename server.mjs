// LiveKit Dash Kit Testing: a GPT-Live client-delegation sandbox.
// The browser talks to GPT-Live over WebRTC; this server creates the session,
// attaches a sideband, runs the orchestrator and subagents, and streams every
// event to the dashboard over /ws.
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from './lib/bus.mjs';
import { SettingsStore, VOICES, EFFORTS } from './lib/config.mjs';
import { LiveCall, createLiveSession, buildSessionConfig, APPEND_KINDS, short } from './lib/live.mjs';
import { SubagentPool } from './lib/subagents.mjs';
import { Orchestrator } from './lib/orchestrator.mjs';
import { resolveProvider, createClient } from './lib/provider.mjs';
import { loadBoosker, booskerInfo, BooskerBridge, createBooskerHost } from './lib/boosker.mjs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const PORT = Number(process.env.PORT ?? 4520);
const HOST = process.env.HOST ?? '127.0.0.1';

// `boosker` is the Boosker broker code loaded by loadBoosker (or null): with it,
// a call can run through that code instead of Dash Kit's own orchestrator.
// `booskerHost` is its Claude session client; one is made on first use.
// `reposRoot` is where a session starts when no repository folder is chosen:
// the folder that holds the Boosker checkout, as on the broker.
export function createApp({ provider = resolveProvider(), client = createClient(provider), dataDir = join(root, 'data'), Sideband = provider.Sideband, createSession = createLiveSession,
  boosker = null, booskerHost = null, reposRoot = process.env.BOOSKER_REPOS_ROOT ?? (boosker?.dir ? dirname(boosker.dir) : homedir()) } = {}) {
  const bus = new Bus({ logDir: join(dataDir, 'runs') });
  const store = new SettingsStore(join(dataDir, 'settings.json'), { boosker: boosker?.available ? boosker.defaults : {} });
  const settings = () => store.get();
  // With BACKEND_MODELS set, only those models (Foundry deployments) can run.
  // A saved or default model outside the list is replaced by the first one.
  const fitModels = () => {
    if (!provider.exactModels) return;
    const patch = {};
    for (const section of ['orchestrator', 'subagents']) {
      const model = settings()[section].model;
      if (provider.models.includes(model)) continue;
      patch[section] = { model: provider.models[0] };
      bus.publish({ type: 'settings', from: 'system', to: 'system', label: `${section} model ${model} is not available on ${provider.label}; using ${provider.models[0]}` });
    }
    if (Object.keys(patch).length) store.update(patch);
  };
  fitModels();
  const pool = new SubagentPool({ client, settings });
  let call = null;
  let greeted = false;
  // The Boosker handler of the current or the last call. It is kept after the
  // call ends so its session cards stay up, and replaced by the next call.
  let bridge = null;
  const dropBridge = () => { bridge?.dispose(); bridge = null; };

  // Sends to GPT-Live when a call is up; otherwise records that nothing was sent.
  const voice = (kind, content, delegationId, meta = {}) => {
    const live = call && !call.closed ? call : null;
    // A delegation id from an earlier call is unknown to this session.
    const id = live && delegationId && live.delegations.some(d => d.id === delegationId) ? delegationId : null;
    if (!live) {
      bus.publish({ type: 'append.skipped', from: meta.origin ?? 'orchestrator', to: 'voice', sub: meta.sub, kind, delegationId,
        label: `Not sent (no live call): ${kind}${meta.reason ? ` (${meta.reason})` : ''}: ${content}`, text: content });
      return false;
    }
    live.append(kind, content, id, meta);
    return true;
  };
  const orchestrator = new Orchestrator({ client, bus, settings, pool, voice });

  const state = () => ({
    runId: bus.runId, runStartedAt: bus.runStartedAt, settings: settings(),
    call: call ? call.status() : null, orchestratorBusy: bridge ? bridge.busy() : orchestrator.busy,
    subagents: bridge ? bridge.summaries() : pool.list().map(a => a.summary()),
    // The dispatcher's own Claude session in Boosker mode: its name and where it opens.
    dispatcher: bridge ? bridge.dispatcherInfo() : null,
    boosker: { ...booskerInfo(boosker), active: Boolean(bridge && !bridge.closed) },
    options: { voices: VOICES, models: provider.models, efforts: EFFORTS, appendKinds: APPEND_KINDS },
    provider: provider.label, keyConfigured: !provider.missing, missingKey: provider.missing
  });

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  // Same-origin check, as in the WebRTC quickstart: the page that calls the
  // API must be served by this server (a proxy in front must keep the Host header).
  const sameOrigin = req => { const origin = req.headers.origin; if (!origin) return true; try { return new URL(origin).host === req.headers.host; } catch { return false; } };
  app.use('/api', (req, res, next) => (req.method === 'GET' || sameOrigin(req) ? next() : res.status(403).json({ error: 'Unexpected request origin' })));
  app.use(express.static(join(root, 'public'), { index: 'index.html', extensions: ['html'] }));

  const wrap = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const status = error.status && error.status < 600 ? error.status : 500;
      if (status >= 500) console.error(error);
      res.status(status).json({ error: error.message ?? 'Request failed' });
    }
  };
  const requireCall = () => { if (!call || call.closed) throw Object.assign(new Error('No live call. Connect first.'), { status: 409 }); return call; };

  app.get('/api/state', (req, res) => res.json(state()));
  app.get('/api/session-config', (req, res) => res.json(buildSessionConfig(settings())));
  app.put('/api/settings', wrap((req, res) => {
    const before = settings();
    const next = store.update(req.body ?? {});
    const changed = ['voice', 'orchestrator', 'subagents', 'boosker'].filter(section => JSON.stringify(before[section]) !== JSON.stringify(next[section]));
    if (changed.length) bus.publish({ type: 'settings', from: 'client', to: 'system', label: `Settings saved: ${changed.join(', ')}` + ((changed.includes('voice') || changed.includes('boosker')) && call && !call.closed ? ' (voice and Boosker changes apply to the next call)' : '') });
    broadcastState();
    res.json(next);
  }));
  app.post('/api/settings/reset', wrap((req, res) => {
    const section = req.body?.section;
    if (section && !['voice', 'orchestrator', 'subagents', 'boosker'].includes(section)) throw Object.assign(new Error('Unknown section'), { status: 400 });
    // For Boosker, `fields` limits the reload to those values (one tab's worth).
    const fields = section === 'boosker' && Array.isArray(req.body?.fields) ? req.body.fields.map(String) : null;
    store.reset(section, fields);
    bus.publish({ type: 'settings', from: 'client', to: 'system', label: section === 'boosker' ? `Reloaded from the Boosker folder: ${fields?.join(', ') ?? 'all Boosker values'}` : `Settings reset to defaults: ${section ?? 'all'}` });
    fitModels();
    broadcastState();
    res.json(settings());
  }));

  app.post('/api/session', wrap(async (req, res) => {
    const sdp = req.body?.sdp;
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0')) throw Object.assign(new Error('An SDP offer is required'), { status: 400 });
    if (provider.missing) throw Object.assign(new Error(`Set ${provider.missing} in .env`), { status: 503 });
    const useBoosker = settings().boosker.enabled;
    if (useBoosker) {
      if (!boosker?.available) throw Object.assign(new Error(`Boosker mode is on, but its code is not loaded. ${booskerInfo(boosker).reason}`), { status: 409 });
      const b = settings().boosker;
      if (!b.voicePrompt.trim() || !b.dispatcherPrompt.trim()) throw Object.assign(new Error('Boosker mode needs a voice prompt (Voice agent tab) and a dispatcher prompt (Delegation agent tab).'), { status: 400 });
    }
    if (call && !call.closed) { bus.publish({ type: 'command', from: 'system', to: 'voice', label: 'New call requested; closing the previous one' }); call.close(); }
    bus.publish({ type: 'session.create', from: 'client', to: 'voice', label: `POST /v1/live/sessions (gpt-live-1, voice ${settings().voice.voice}${useBoosker ? ', Boosker mode' : ''})`, data: { session: buildSessionConfig(settings()) } });
    let result;
    try { result = await createSession(client, settings(), sdp); }
    catch (error) {
      bus.publish({ type: 'session.failed', from: 'voice', to: 'client', label: `Session creation failed: ${error.status ?? ''} ${error.message}` });
      throw Object.assign(new Error(`Live session creation failed: ${error.message}`), { status: error.status ?? 502 });
    }
    const sessionId = result.session.id;
    greeted = false;
    const live = new LiveCall({ client, sessionId, bus, settings, ...(Sideband ? { Sideband } : {}), isBusy: () => (bridge && !bridge.closed ? bridge.busy() : orchestrator.busy || pool.running().length > 0) });
    call = live;
    dropBridge();
    live.on('started', () => greet(live));
    if (useBoosker) {
      // The Boosker handler reads the same sideband and takes every delegation;
      // Dash Kit's own orchestrator and subagents stay out of this call.
      booskerHost ??= createBooskerHost(boosker, { cwd: reposRoot, settings });
      const handler = bridge = new BooskerBridge({ boosker, host: booskerHost, live, bus, settings, dataDir });
      handler.on('change', broadcastState);
      live.on('closed', () => handler.close());
      bus.publish({ type: 'boosker', from: 'system', to: 'orchestrator', sessionId,
        label: `Boosker mode: broker code from ${boosker.dir}${boosker.version ? ` (${boosker.version})` : ''}; dispatcher ${boosker.models.dispatcher}, sessions ${boosker.models.worker} ${boosker.models.workerEffort}` });
      handler.start().catch(error => bus.publish({ type: 'orchestrator.error', from: 'orchestrator', sessionId, label: `Boosker handler could not start: ${error.message}` }));
    } else live.on('delegation', d => setTimeout(() => { orchestrator.handleDelegation(d, live.transcript); }, settings().orchestrator.graceMs));
    live.on('usage', () => broadcastState());
    live.on('closed', () => broadcastState());
    live.connect();
    orchestrator.reset();
    bus.publish({ type: 'session.created', from: 'voice', to: 'client', label: `Session ${short(sessionId)} created; SDP answer returned`, sessionId });
    broadcastState();
    res.status(201).json(result);
  }));
  app.post('/api/session/close', wrap((req, res) => { requireCall().close(); res.json({ ok: true }); }));

  app.post('/api/inject', wrap((req, res) => {
    const live = requireCall();
    const { kind, content = '' } = req.body ?? {};
    if (!APPEND_KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of ${APPEND_KINDS.join(', ')}`), { status: 400 });
    if (typeof content !== 'string' || content.length > 20000) throw Object.assign(new Error('content must be a string under 20,000 characters'), { status: 400 });
    if (content === '' && kind !== 'thinking') throw Object.assign(new Error('Only silent context may be empty'), { status: 400 });
    let delegationId = req.body?.delegationId ?? null;
    if (delegationId === 'latest') delegationId = live.latestDelegationId();
    if (delegationId && !live.delegations.some(d => d.id === delegationId)) throw Object.assign(new Error('Unknown delegation id for this call'), { status: 400 });
    const eventIds = live.append(kind, content, delegationId, { origin: 'orchestrator', manual: true, reason: 'manual' });
    res.json({ ok: true, eventIds, delegationId });
  }));
  app.post('/api/request', wrap((req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text || text.length > 4000) throw Object.assign(new Error('Enter a request of 1 to 4000 characters'), { status: 400 });
    // Boosker has no typed input; here the text takes the path a spoken request
    // takes, and the voice hears of it only through what the broker sends back.
    const viaBoosker = bridge && !bridge.closed;
    if (settings().boosker.enabled && !viaBoosker) throw Object.assign(new Error('Boosker mode handles requests during a call. Start a call first.'), { status: 409 });
    bus.publish({ type: 'typed', from: 'user', to: 'orchestrator', label: `Typed request: ${text}`, text });
    if (req.body?.mirror && call && !call.closed) call.append('thinking', `The user typed this request instead of saying it: ${text}`, null, { origin: 'client', reason: 'typed input' });
    if (viaBoosker) bridge.typed(text).catch(error => bus.publish({ type: 'orchestrator.error', from: 'orchestrator', label: `Typed request failed: ${error.message}` }));
    else orchestrator.handleTyped(text);
    res.json({ ok: true });
  }));
  app.post('/api/mute', wrap((req, res) => { requireCall().setMuted(Boolean(req.body?.muted)); res.json({ ok: true }); }));
  app.post('/api/subagents/:id/stop', wrap(async (req, res) => {
    if (bridge) {
      bus.publish({ type: 'command', from: 'client', to: 'subagent', sub: req.params.id, label: `Stop ${req.params.id} (dashboard)` });
      const stopped = await bridge.stop(req.params.id);
      if (!stopped) throw Object.assign(new Error('That session cannot be stopped from here (a lookup, or the call has ended).'), { status: 409 });
      res.json({ ok: true });
      return;
    }
    const agent = pool.get(req.params.id);
    if (!agent) throw Object.assign(new Error('No such subagent'), { status: 404 });
    bus.publish({ type: 'command', from: 'client', to: 'subagent', sub: agent.id, label: `Stop ${agent.id} (dashboard)` });
    res.json({ ok: agent.stop() });
  }));
  // Clear log. With no call up, a new run starts: the log, the subagents and the
  // last call's session cards are cleared. During a call, the call in progress
  // stays (its events from session creation on, and its sessions) and everything
  // before it goes. Nothing is removed from data/runs.
  app.post('/api/reset', wrap((req, res) => {
    const live = Boolean(call && !call.closed);
    if (live) bus.keepFrom(bus.history.findLastIndex(event => event.type === 'session.create'));
    else { pool.clear(); orchestrator.reset(); dropBridge(); call = null; bus.reset(); }
    broadcast({ type: 'hello', history: bus.history, state: state() });
    res.json({ ok: true, runId: bus.runId, keptCall: live });
  }));
  app.get('/api/export', (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="dash-kit-${bus.runId}.json"`);
    res.json({ runId: bus.runId, exportedAt: new Date().toISOString(), settings: settings(), events: bus.history });
  });

  function greet(live) {
    if (greeted || live !== call || live.closed || !settings().voice.greeting.enabled) return;
    greeted = true;
    live.append('commentary', settings().voice.greeting.text, null, { origin: 'client', reason: 'greeting' });
  }

  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true });
  const broadcast = message => { const data = JSON.stringify(message); for (const socket of sockets.clients) if (socket.readyState === 1) socket.send(data); };
  let stateTimer = null;
  const broadcastState = () => { if (stateTimer) return; stateTimer = setTimeout(() => { stateTimer = null; broadcast({ type: 'state', state: state() }); }, 100); };
  bus.on('event', event => broadcast({ type: 'event', event }));
  pool.on('created', agent => { agent.on('status', broadcastState); agent.on('progress', broadcastState); broadcastState(); });
  orchestrator.on('busy', broadcastState);

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const origin = req.headers.origin;
    let ok = path === '/ws';
    if (ok && origin) { try { ok = new URL(origin).host === req.headers.host; } catch { ok = false; } }
    if (!ok) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      ws.send(JSON.stringify({ type: 'hello', history: bus.history, state: state() }));
      ws.on('message', raw => {
        let message; try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message?.type !== 'client-event' || typeof message.name !== 'string') return;
        const name = message.name.slice(0, 80);
        bus.publish({ type: `client.${name}`, from: message.from === 'voice' ? 'voice' : 'client', to: message.to ?? 'client', label: String(message.label ?? name).slice(0, 300), data: message.data, quiet: Boolean(message.quiet) });
        if (name === 'session.started' && call) greet(call);
      });
    });
  });

  // Claude sessions started in Boosker mode keep running in the session host.
  const shutdown = () => { if (call && !call.closed) call.close(); pool.stopAll(); dropBridge(); booskerHost?.stop(); };
  return { app, server, bus, store, pool, orchestrator, getCall: () => call, shutdown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const provider = resolveProvider();
  // The Boosker checkout: BOOSKER_DIR, or a Boosker folder beside this one.
  const boosker = await loadBoosker(process.env.BOOSKER_DIR ?? resolve(root, '..', 'Boosker'));
  const kit = createApp({ provider, boosker });
  kit.server.listen(PORT, HOST, () => console.log(`Dash kit on http://${HOST}:${PORT}/ (${provider.label}, ${provider.missing ? provider.missing + ' MISSING' : 'key loaded'}; Boosker mode ${boosker.available ? `ready from ${boosker.dir}` : 'unavailable: ' + boosker.reason})`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { kit.shutdown(); setTimeout(() => process.exit(0), 1500).unref(); });
}
