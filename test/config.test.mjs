import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, defaultSettings, validateSettings } from '../lib/config.mjs';

test('defaults are valid and the voice prompt uses the gpt-live-1 delegation trigger', () => {
  const s = validateSettings(defaultSettings());
  assert.match(s.voice.prompt, /Generate <\|SpawnThinking\|> when:/);
  assert.match(s.voice.prompt, /Backchannel policy:/);
});

test('updates merge per section, persist, and reject bad values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashkit-'));
  const store = new SettingsStore(join(dir, 'settings.json'));
  store.update({ voice: { voice: 'cedar' }, subagents: { engine: 'mock' } });
  const reloaded = new SettingsStore(join(dir, 'settings.json')).get();
  assert.equal(reloaded.voice.voice, 'cedar');
  assert.equal(reloaded.subagents.engine, 'mock');
  assert.equal(reloaded.orchestrator.model, 'gpt-6-luna');
  assert.throws(() => store.update({ voice: { ackDelayMs: 900 } }), /0 to 800/);
  assert.throws(() => store.update({ voice: { voice: 'nobody' } }), /Voice must be one of/);
  assert.equal(store.reset('voice').voice.voice, 'marin');
});

test('an unreadable settings file falls back to defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashkit-'));
  writeFileSync(join(dir, 'settings.json'), '{not json');
  assert.equal(new SettingsStore(join(dir, 'settings.json')).get().voice.voice, 'marin');
});
