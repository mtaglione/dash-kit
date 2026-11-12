import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolveProvider, createClient, FoundrySideband } from '../lib/provider.mjs';
import { BACKEND_MODELS } from '../lib/config.mjs';

test('without Foundry settings everything runs on OpenAI with OPENAI_API_KEY', () => {
  const provider = resolveProvider({ OPENAI_API_KEY: 'sk-test' });
  assert.equal(provider.name, 'openai');
  assert.equal(provider.key, 'sk-test');
  assert.equal(provider.missing, null);
  assert.deepEqual(provider.models, BACKEND_MODELS);
  assert.equal(provider.exactModels, false);
  assert.equal(resolveProvider({}).missing, 'OPENAI_API_KEY');
});

test('a Foundry endpoint and key move every call to that resource, and the OpenAI key is not used', () => {
  const provider = resolveProvider({ FOUNDRY_ENDPOINT: 'https://example.openai.azure.com/', FOUNDRY_API_KEY: 'fk', OPENAI_API_KEY: 'sk-test', BACKEND_MODELS: 'model-a, model-b' });
  assert.equal(provider.name, 'foundry');
  assert.equal(provider.key, 'fk');
  assert.equal(provider.baseURL, 'https://example.openai.azure.com/openai/v1');
  assert.deepEqual(provider.models, ['model-a', 'model-b']);
  assert.equal(provider.exactModels, true);
  assert.equal(provider.Sideband, FoundrySideband);
  const client = createClient(provider);
  assert.equal(client.baseURL, 'https://example.openai.azure.com/openai/v1');
  assert.equal(client.apiKey, 'fk');
});

test('half of the Foundry settings is reported as missing, not replaced by OpenAI', () => {
  assert.equal(resolveProvider({ FOUNDRY_ENDPOINT: 'https://example.openai.azure.com', OPENAI_API_KEY: 'sk-test' }).missing, 'FOUNDRY_API_KEY');
  const provider = resolveProvider({ FOUNDRY_API_KEY: 'fk', OPENAI_API_KEY: 'sk-test' });
  assert.equal(provider.name, 'foundry');
  assert.equal(provider.missing, 'FOUNDRY_ENDPOINT');
  assert.equal(provider.key, '');
});

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 0; this.sent = []; this.closed = false; }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
}

test('the Foundry sideband attaches with the api-key header, queues until open, and passes events on', () => {
  const client = { baseURL: 'https://example.openai.azure.com/openai/v1', apiKey: 'fk' };
  const sideband = new FoundrySideband(client, { session_id: 'live_a/b' }, { Socket: FakeSocket });
  const socket = sideband.socket;
  assert.equal(socket.url, 'wss://example.openai.azure.com/openai/v1/live/sessions/live_a%2Fb/attach');
  assert.deepEqual(socket.options.headers, { 'api-key': 'fk' });
  sideband.send({ type: 'session.close', event_id: 'c1' });
  assert.deepEqual(socket.sent, [], 'held until the socket opens');
  socket.readyState = 1; socket.emit('open');
  assert.deepEqual(socket.sent.map(JSON.parse), [{ type: 'session.close', event_id: 'c1' }]);
  const events = [], closes = [];
  sideband.on('event', event => events.push(event));
  sideband.on('close', (code, reason) => closes.push([code, reason]));
  socket.emit('message', Buffer.from('{"type":"session.started"}'));
  socket.emit('message', Buffer.from('not json'));
  socket.emit('close', 1000, Buffer.from('bye'));
  assert.deepEqual(events, [{ type: 'session.started' }]);
  assert.deepEqual(closes, [[1000, 'bye']]);
  sideband.close();
  assert.equal(socket.closed, true);
});
