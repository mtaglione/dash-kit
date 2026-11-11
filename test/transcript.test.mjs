import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcript, splitContent } from '../lib/transcript.mjs';

test('fragments join into turns by speaker and gap, preserving spaces', () => {
  const t = new Transcript();
  t.add({ eventId: 'e1', role: 'user', delta: 'What is', startMs: 1000, endMs: 1200 });
  t.add({ eventId: 'e2', role: 'assistant', delta: 'Mm-hmm.', startMs: 1300, endMs: 1500 });
  t.add({ eventId: 'e3', role: 'user', delta: ' the weather', startMs: 1400, endMs: 1900 });
  t.add({ eventId: 'e4', role: 'user', delta: 'Thanks', startMs: 9000, endMs: 9400 });
  assert.deepEqual(t.turns.map(x => [x.role, x.text]), [['user', 'What is the weather'], ['assistant', 'Mm-hmm.'], ['user', 'Thanks']]);
  assert.equal(t.latestUserText(5000), 'What is the weather');
  assert.equal(t.latestUserText(), 'Thanks');
});

test('replayed fragments with a known event_id are ignored', () => {
  const t = new Transcript();
  assert.ok(t.add({ eventId: 'e1', role: 'user', delta: 'hi', startMs: 0, endMs: 100 }));
  assert.equal(t.add({ eventId: 'e1', role: 'user', delta: 'hi', startMs: 0, endMs: 100 }), null);
  assert.equal(t.turns[0].text, 'hi');
});

test('since() returns turns that ended after the cursor, in full', () => {
  const t = new Transcript();
  t.add({ role: 'user', delta: 'one', startMs: 0, endMs: 500 });
  t.add({ role: 'assistant', delta: 'two', startMs: 3000, endMs: 3500 });
  assert.equal(Transcript.render(t.since(600)), 'assistant: two');
  t.add({ role: 'assistant', delta: ' more', startMs: 3600, endMs: 3900 });
  assert.equal(Transcript.render(t.since(3500)), 'assistant: two more');
});

test('splitContent keeps parts under the byte budget on word boundaries', () => {
  const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
  const parts = splitContent(words, 1200);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 1200));
  assert.equal(parts.join(''), words);
  assert.deepEqual(splitContent('short'), ['short']);
});
