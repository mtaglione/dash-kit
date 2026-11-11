import test from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../lib/bus.mjs';
import { defaultSettings } from '../lib/config.mjs';
import { Transcript } from '../lib/transcript.mjs';
import { SubagentPool } from '../lib/subagents.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { scriptedClient, functionCall, until } from './helpers.mjs';

function setup(script, patch = {}) {
  const settings = defaultSettings();
  settings.subagents.engine = 'mock'; settings.subagents.mockDurationMs = 500; settings.subagents.progressIntervalMs = 0;
  for (const [section, values] of Object.entries(patch)) Object.assign(settings[section], values);
  const client = scriptedClient(script);
  const bus = new Bus();
  const sent = [];
  const pool = new SubagentPool({ client, settings: () => settings });
  const orchestrator = new Orchestrator({ client, bus, settings: () => settings, pool, voice: (kind, content, delegationId, meta) => { sent.push({ kind, content, delegationId, ...meta }); return true; } });
  const transcript = new Transcript();
  transcript.add({ role: 'user', delta: 'Check the weather in Boston', startMs: 0, endMs: 1500 });
  return { client, bus, sent, pool, orchestrator, transcript, settings };
}

test('a delegation becomes a subagent whose progress and result reach the voice with the delegation id', async () => {
  const { client, sent, pool, orchestrator, transcript } = setup([
    { output: [functionCall('start_subagent', { title: 'Boston weather', task: 'Check the weather in Boston' })] },
    { output: [], output_text: 'Started s1 for the Boston weather.' }
  ]);
  await orchestrator.handleDelegation({ id: 'del_1', offsetMs: 1600 }, transcript);
  const first = client.calls[0];
  assert.match(first.input, /\[delegation del_1 at 1\.6s/);
  assert.match(first.input, /user: Check the weather in Boston/);
  assert.equal(first.tools.length, 4);
  assert.equal(client.calls[1].previous_response_id, 'resp_1');
  assert.equal(client.calls[1].input[0].type, 'function_call_output');
  assert.equal(JSON.parse(client.calls[1].input[0].output).subagent_id, 's1');
  await until(() => pool.get('s1')?.status === 'done');
  const result = sent.find(s => s.reason === 'result');
  assert.equal(result.kind, 'commentary'); assert.equal(result.delegationId, 'del_1'); assert.equal(result.sub, 's1');
  assert.ok(sent.some(s => s.kind === 'thinking' && s.reason === 'progress'));
});

test('tell_voice sends the requested kind; a follow-up delegation only carries new transcript', async () => {
  const { client, sent, orchestrator, transcript } = setup([
    { output: [functionCall('tell_voice', { kind: 'commentary', content: 'Which city do you mean?' })] },
    { output: [], output_text: 'Asked for the city.' },
    { output: [], output_text: 'Nothing to do.' }
  ]);
  await orchestrator.handleDelegation({ id: 'del_1', offsetMs: 1600 }, transcript);
  assert.deepEqual(sent.map(s => [s.kind, s.content, s.delegationId]), [['commentary', 'Which city do you mean?', 'del_1']]);
  transcript.add({ role: 'user', delta: 'Boston please', startMs: 5000, endMs: 5600 });
  await orchestrator.handleDelegation({ id: 'del_2', offsetMs: 5700 }, transcript);
  assert.doesNotMatch(client.calls[2].input, /Check the weather/);
  assert.match(client.calls[2].input, /Boston please/);
});

test('message_subagent restarts a working subagent; stop_subagent stops it; bad ids are reported to the model', async () => {
  const { client, pool, orchestrator, transcript, settings } = setup([
    { output: [functionCall('start_subagent', { title: 'Long job', task: 'Do a long job' })] },
    { output: [] },
    { output: [functionCall('message_subagent', { subagent_id: 's1', message: 'Make it short' }), functionCall('stop_subagent', { subagent_id: 's9' }, 'bad')] },
    { output: [] },
    { output: [functionCall('stop_subagent', { subagent_id: 's1' })] },
    { output: [] }
  ]);
  settings.subagents.mockDurationMs = 5000;
  await orchestrator.handleDelegation({ id: 'del_1', offsetMs: 1600 }, transcript);
  await orchestrator.handleTyped('make it short');
  const outputs = client.calls[3].input.map(o => JSON.parse(o.output));
  assert.equal(outputs[0].restarted, true);
  assert.equal(outputs[1].ok, false); assert.match(outputs[1].error, /no subagent s9/);
  assert.match(pool.get('s1').history.at(-1).text, /Make it short/);
  await orchestrator.handleTyped('stop it');
  assert.equal(pool.get('s1').status, 'stopped');
});

test('direct mode needs no model and uses the latest user speech', async () => {
  const { client, pool, orchestrator, transcript } = setup([], { orchestrator: { mode: 'direct' } });
  await orchestrator.handleDelegation({ id: 'del_1', offsetMs: 1600 }, transcript);
  assert.equal(client.calls.length, 0);
  assert.equal(pool.get('s1').task, 'Check the weather in Boston');
});

test('result routing through the orchestrator gives it a turn instead of auto-forwarding', async () => {
  const { client, sent, pool, orchestrator, transcript } = setup([
    { output: [functionCall('start_subagent', { title: 'Weather', task: 'Check the weather' })] },
    { output: [] },
    { output: [functionCall('tell_voice', { kind: 'commentary', content: 'Sunny in Boston.' })] },
    { output: [] }
  ], { orchestrator: { resultRouting: 'orchestrator' } });
  await orchestrator.handleDelegation({ id: 'del_1', offsetMs: 1600 }, transcript);
  await until(() => client.calls.length >= 4);
  assert.match(client.calls[2].input, /\[subagent s1 "Weather" finished\]/);
  assert.equal(sent.filter(s => s.reason === 'result').length, 0);
  await until(() => sent.some(s => s.content === 'Sunny in Boston.'));
  assert.equal(pool.get('s1').status, 'done');
});

test('an orchestrator failure is reported to the voice rather than dropped', async () => {
  const settings = defaultSettings();
  const bus = new Bus(); const sent = [];
  const client = { responses: { create: async () => { throw new Error('model unavailable'); } } };
  const pool = new SubagentPool({ client, settings: () => settings });
  const orchestrator = new Orchestrator({ client, bus, settings: () => settings, pool, voice: (kind, content, delegationId) => sent.push({ kind, content, delegationId }) });
  await orchestrator.handleDelegation({ id: 'del_1', offsetMs: 0 }, new Transcript());
  assert.equal(sent[0].kind, 'commentary'); assert.equal(sent[0].delegationId, 'del_1');
  assert.ok(bus.history.some(e => e.type === 'orchestrator.error'));
});
