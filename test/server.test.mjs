import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { FakeSideband, scriptedClient, functionCall, until } from './helpers.mjs';

process.env.OPENAI_API_KEY ||= 'test-key';

async function start(script = []) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dashkit-'));
  const client = scriptedClient(script);
  const kit = createApp({ client, dataDir, Sideband: FakeSideband });
  kit.store.update({ subagents: { engine: 'mock', mockDurationMs: 500 }, orchestrator: { graceMs: 0 } });
  await new Promise(resolve => kit.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${kit.server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { kit, base, post, client, dataDir, stop: () => new Promise(resolve => { kit.server.closeAllConnections?.(); kit.server.close(resolve); }) };
}

test('POST /api/session exchanges the SDP, attaches the sideband, and runs a delegation end to end', async () => {
  const { kit, post, client, dataDir, stop } = await start([
    { output: [functionCall('start_subagent', { title: 'Weather', task: 'Check the weather in Boston' })] },
    { output: [], output_text: 'Started s1.' }
  ]);
  try {
    const response = await post('/api/session', { sdp: 'v=0\r\noffer' });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).transport.sdp, 'v=0\r\nanswer');
    const ws = FakeSideband.instances.at(-1);
    assert.equal(ws.params.session_id, 'live_test123');
    ws.server({ type: 'session.started', event_id: 's', session: { id: 'live_test123' } });
    assert.equal(ws.sent[0].type, 'session.commentary.append', 'greeting goes out after session.started');
    ws.server({ type: 'session.input_transcript.delta', event_id: 't1', delta: 'Check the weather in Boston', start_ms: 0, end_ms: 1500 });
    ws.server({ type: 'session.delegation.created', event_id: 'd', offset_ms: 1600, delegation: { id: 'del_1', type: 'delegation', target: 'client' } });
    await until(() => ws.sent.some(p => p.type === 'session.commentary.append' && p.delegation_id === 'del_1'), 4000);
    assert.match(client.calls[0].input, /Check the weather in Boston/);
    const log = readdirSync(join(dataDir, 'runs'));
    assert.equal(log.length, 1);
    assert.ok(readFileSync(join(dataDir, 'runs', log[0]), 'utf8').includes('"type":"delegation"'));
  } finally { kit.shutdown(); await stop(); }
});

test('inject validates kind and delegation id and needs a live call', async () => {
  const { post, stop } = await start();
  try {
    assert.equal((await post('/api/inject', { kind: 'thinking', content: 'x' })).status, 409);
    await post('/api/session', { sdp: 'v=0\r\noffer' });
    const ws = FakeSideband.instances.at(-1);
    assert.equal((await post('/api/inject', { kind: 'shout', content: 'x' })).status, 400);
    assert.equal((await post('/api/inject', { kind: 'commentary', content: '' })).status, 400);
    assert.equal((await post('/api/inject', { kind: 'thinking', content: 'x', delegationId: 'del_nope' })).status, 400);
    ws.server({ type: 'session.delegation.created', event_id: 'd', offset_ms: 10, delegation: { id: 'del_7', type: 'delegation', target: 'client' } });
    const ok = await post('/api/inject', { kind: 'thinking', content: '', delegationId: 'latest' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ws.sent.at(-1), { ...ws.sent.at(-1), type: 'session.thinking.append', delegation_id: 'del_7', content: '' });
  } finally { await stop(); }
});

test('cross-origin API calls are refused', async () => {
  const { post, stop } = await start();
  try { assert.equal((await post('/api/session', { sdp: 'v=0' }, { Origin: 'https://evil.example' })).status, 403); }
  finally { await stop(); }
});
