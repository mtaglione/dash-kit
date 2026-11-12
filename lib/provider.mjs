// Where the models run. With FOUNDRY_ENDPOINT and FOUNDRY_API_KEY set, GPT-Live,
// the orchestrator and the subagents all run on that Azure AI Foundry resource,
// through its OpenAI-compatible surface (<endpoint>/openai/v1), and the OpenAI
// key is not used. Otherwise everything runs on the OpenAI platform with
// OPENAI_API_KEY.
//
// On Foundry a model is addressed by its deployment name, so BACKEND_MODELS
// (comma-separated) lists the deployments the orchestrator and subagents may
// use; the first one is the default.
import OpenAI from 'openai';
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { BACKEND_MODELS } from './config.mjs';

const value = text => String(text ?? '').trim();
const list = text => value(text).split(',').map(item => item.trim()).filter(Boolean);

// `missing` names the setting that still has to be added to .env, or is null.
// `exactModels` is true when BACKEND_MODELS was given: a saved model outside
// the list cannot run and is replaced (see fitModels in server.mjs).
export function resolveProvider(env = process.env) {
  const named = list(env.BACKEND_MODELS);
  const models = { models: named.length ? named : BACKEND_MODELS, exactModels: named.length > 0 };
  const endpoint = value(env.FOUNDRY_ENDPOINT).replace(/\/+$/, '');
  const foundryKey = value(env.FOUNDRY_API_KEY);
  if (endpoint || foundryKey) {
    const missing = !endpoint ? 'FOUNDRY_ENDPOINT' : !foundryKey ? 'FOUNDRY_API_KEY' : null;
    return { name: 'foundry', label: 'Azure AI Foundry', key: missing ? '' : foundryKey, missing, baseURL: endpoint ? `${endpoint}/openai/v1` : '', Sideband: FoundrySideband, ...models };
  }
  const key = value(env.OPENAI_API_KEY);
  return { name: 'openai', label: 'OpenAI', key, missing: key ? null : 'OPENAI_API_KEY', baseURL: '', Sideband: null, ...models };
}

export function createClient(provider) {
  // Without a key the server still starts, so the dashboard can say what is missing.
  const apiKey = provider.key || 'missing';
  if (provider.name !== 'foundry') return new OpenAI({ apiKey, maxRetries: 1 });
  return new OpenAI({ apiKey, baseURL: provider.baseURL || undefined, maxRetries: 1, defaultHeaders: { 'api-key': apiKey, Authorization: null } });
}

// The sideband for a Foundry session. Foundry answers a sideband attach that
// carries a bearer API key (all the SDK's SidebandWS sends) with a redirect, so
// this one authenticates with the api-key header. Same surface as SidebandWS as
// LiveCall uses it: 'event', 'error' and 'close' events, send(), close().
export class FoundrySideband extends EventEmitter {
  constructor(client, { session_id }, { Socket = WebSocket } = {}) {
    super();
    this.url = `${String(client.baseURL).replace(/^http/, 'ws').replace(/\/+$/, '')}/live/sessions/${encodeURIComponent(session_id)}/attach`;
    this.Socket = Socket; this.queue = [];
    this.socket = new Socket(this.url, { headers: { 'api-key': client.apiKey }, handshakeTimeout: 8000, maxPayload: 4 * 1024 * 1024 });
    this.socket.on('open', () => { for (const data of this.queue.splice(0)) this.socket.send(data); });
    this.socket.on('message', data => {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      if (event && typeof event.type === 'string') this.emit('event', event);
    });
    this.socket.on('error', error => this.emit('error', error));
    this.socket.on('close', (code, reason) => this.emit('close', code, reason?.toString() ?? ''));
  }
  // Commands sent before the socket opens go out when it does.
  send(event) {
    const data = JSON.stringify(event);
    if (this.socket.readyState === this.Socket.OPEN) this.socket.send(data); else this.queue.push(data);
  }
  close() { try { this.socket.close(); } catch { /* already closed */ } }
}
