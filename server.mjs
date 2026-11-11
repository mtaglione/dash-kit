// LiveKit Dash Kit Testing: a GPT-Live client-delegation sandbox.
// The browser talks to GPT-Live over WebRTC; this server creates the session,
// attaches a sideband, runs the orchestrator and subagents, and streams every
// event to the dashboard over /ws.
import express from 'express';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from './lib/bus.mjs';
import { SettingsStore, VOICES, BACKEND_MODELS, EFFORTS } from './lib/config.mjs';
import { LiveCall, createLiveSession, buildSessionConfig, APPEND_KINDS, short } from './lib/live.mjs';
import { SubagentPool } from './lib/subagents.mjs';
import { Orchestrator } from './lib/orchestrator.mjs';

const root = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const PORT = Number(process.env.PORT ?? 4520);
const HOST = process.env.HOST ?? '127.0.0.1';

export function createApp({ client = new OpenAI({ maxRetries: 1 }), dataDir = join(root, 'data'), Sideband, createSession = createLiveSession } = {}) {
  const bus = new Bus({ logDir: join(dataDir, 'runs') });
  const store = new SettingsStore(join(dataDir, 'settings.json'));
  const settings = () => store.get();
  const pool = new SubagentPool({ client, settings });
  let call = null;
  let greeted = false;

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
    call: call ? call.status() : null, orchestratorBusy: orchestrator.busy,
    subagents: pool.list().map(a => a.summary()),
    options: { voices: VOICES, models: BACKEND_MODELS, efforts: EFFORTS, appendKinds: APPEND_KINDS },
    keyConfigured: Boolean(process.env.OPENAI_API_KEY)
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
    const changed = ['voice', 'orchestrator', 'subagents'].filter(section => JSON.stringify(before[section]) !== JSON.stringify(next[section]));
    if (changed.length) bus.publish({ type: 'settings', from: 'client', to: 'system', label: `Settings saved: ${changed.join(', ')}` + (changed.includes('voice') && call && !call.closed ? ' (voice changes apply to the next call)' : '') });
    broadcastState();
    res.json(next);
  }));
  app.post('/api/settings/reset', wrap((req, res) => {
    const section = req.body?.section;
    if (section && !['voice', 'orchestrator', 'subagents'].includes(section)) throw Object.assign(new Error('Unknown section'), { status: 400 });
    const next = store.reset(section);
    bus.publish({ type: 'settings', from: 'client', to: 'system', label: `Settings reset to defaults: ${section ?? 'all'}` });
    broadcastState();
    res.json(next);
  }));

  app.post('/api/session', wrap(async (req, res) => {
    const sdp = req.body?.sdp;
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0')) throw Object.assign(new Error('An SDP offer is required'), { status: 400 });
    if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('Set OPENAI_API_KEY in .env'), { status: 503 });
    if (call && !call.closed) { bus.publish({ type: 'command', from: 'system', to: 'voice', label: 'New call requested; closing the previous one' }); call.close(); }
    bus.publish({ type: 'session.create', from: 'client', to: 'voice', label: `POST /v1/live/sessions (gpt-live-1, voice ${settings().voice.voice})`, data: { session: buildSessionConfig(settings()) } });
    let result;
    try { result = await createSession(client, settings(), sdp); }
    catch (error) {
      bus.publish({ type: 'session.failed', from: 'voice', to: 'client', label: `Session creation failed: ${error.status ?? ''} ${error.message}` });
      throw Object.assign(new Error(`Live session creation failed: ${error.message}`), { status: error.status ?? 502 });
    }
    const sessionId = result.session.id;
    greeted = false;
    const live = new LiveCall({ client, sessionId, bus, settings, ...(Sideband ? { Sideband } : {}) });
    call = live;
    live.on('started', () => greet(live));
    live.on('delegation', d => setTimeout(() => { orchestrator.handleDelegation(d, live.transcript); }, settings().orchestrator.graceMs));
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
    bus.publish({ type: 'typed', from: 'user', to: 'orchestrator', label: `Typed request: ${text}`, text });
    if (req.body?.mirror && call && !call.closed) call.append('thinking', `The user typed this request instead of saying it: ${text}`, null, { origin: 'client', reason: 'typed input' });
    orchestrator.handleTyped(text);
    res.json({ ok: true });
  }));
  app.post('/api/mute', wrap((req, res) => { requireCall().setMuted(Boolean(req.body?.muted)); res.json({ ok: true }); }));
  app.post('/api/subagents/:id/stop', wrap((req, res) => {
    const agent = pool.get(req.params.id);
    if (!agent) throw Object.assign(new Error('No such subagent'), { status: 404 });
    bus.publish({ type: 'command', from: 'client', to: 'subagent', sub: agent.id, label: `Stop ${agent.id} (dashboard)` });
    res.json({ ok: agent.stop() });
  }));
  app.post('/api/reset', wrap((req, res) => {
    if (call && !call.closed) throw Object.assign(new Error('Hang up before starting a new run'), { status: 409 });
    pool.clear(); orchestrator.reset(); call = null; bus.reset();
    broadcast({ type: 'hello', history: bus.history, state: state() });
    res.json({ ok: true, runId: bus.runId });
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

  const shutdown = () => { if (call && !call.closed) call.close(); pool.stopAll(); };
  return { app, server, bus, store, pool, orchestrator, getCall: () => call, shutdown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const kit = createApp();
  kit.server.listen(PORT, HOST, () => console.log(`Dash kit on http://${HOST}:${PORT}/ (key ${process.env.OPENAI_API_KEY ? 'loaded' : 'MISSING'})`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { kit.shutdown(); setTimeout(() => process.exit(0), 1500).unref(); });
}
