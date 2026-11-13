// Default prompts and settings, and the settings store (data/settings.json).
// Prompt wording follows OpenAI's GPT-Live guides: the voice prompt uses the
// recommended structure from "Prompting GPT-Live" (with the gpt-live-1
// <|SpawnThinking|> trigger), and the backend prompts use the template from
// "Delegation and tools" > "Start with your existing backend prompt".
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'pearl',
  'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian', 'beacon', 'delta', 'cinder', 'halo',
  'bossa', 'tempo', 'nuri', 'juni', 'flitz', 'brise', 'sillage', 'nira', 'harema', 'shida', 'noeul',
  'calandria', 'compas', 'destello', 'hornero', 'luciernaga'];
export const BACKEND_MODELS = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];
export const EFFORTS = ['none', 'low', 'medium', 'high'];

export const DEFAULT_VOICE_PROMPT = `You are Kit, a calm, friendly voice assistant on a delegation test bench.
Speak warmly and naturally, at an unhurried pace. Be clear and direct, not overly cheerful.
If the user is frustrated, acknowledge it briefly and focus on the next helpful step.

Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Research: look things up on the web and answer questions that need current or factual information.
- Background agents: start, update, check on, or stop agents that work on longer tasks.

Generate <|SpawnThinking|> when:
- The request needs current information, research, or careful reasoning.
- The user asks to start, change, check on, or stop background work.
- A correction changes the work already requested.

Do not generate <|SpawnThinking|> when:
- You can answer from the conversation or a still-current result.
- You need a brief clarification to understand the request.

Generate <|SpawnThinking|> before giving an answer that depends on backend work.
Do not guess the result while waiting. Quiet progress context is not the result; say work is done only when the result arrives.`;

export const DEFAULT_GREETING = 'Greet the user now in English. In one short sentence, say you are ready to test delegation. Then pause and listen.';

export const DEFAULT_ORCHESTRATOR_PROMPT = `## Voice conversation context
You are the orchestrator behind GPT-Live, a voice assistant in a live conversation. When the voice model delegates, you receive the recent conversation and the state of the background subagents. Transcripts can contain mistakes, unfinished phrases, and later corrections. Use the latest context. If a needed detail is still unclear, ask for that detail with tell_voice instead of guessing.

## Task instructions
You route work; you never do it yourself. On each delegation, work out what the user just asked for, then act with your tools:
- start_subagent: new, independent work. Write the task in the user's own words, with references resolved so it stands alone.
- message_subagent: a follow-up, correction, or addition to work a subagent is doing or already did.
- stop_subagent: the user wants that work stopped or cancelled.
- tell_voice: commentary to say something to the user, thinking for quiet context, instructions to direct the voice. Use it to answer status questions from the subagent list, or to ask a clarifying question.
One request can need several calls. Do not start duplicate work for a request that is already running.

## Return the result
After acting, reply with one short line describing what you did. That line goes to the operator's log, not to the user.`;

export const DEFAULT_SUBAGENT_PROMPT = `## Voice conversation context
You are a background agent working for a voice assistant in a live conversation. Your task comes from a speech transcript and can contain recognition errors; interpret it sensibly. If a detail you need is missing, say what is missing instead of guessing.

## Task instructions
Do the task. Use web search when it needs current or factual information.

## Return the result
Return the relevant facts, the task's current status, and the next step, in two to four plain sentences suited to being spoken aloud. No markdown, lists, or links. Report something as done only when it is.`;

// `boosker` carries the prompts read from the Boosker repository when the
// server started (lib/boosker.mjs); without it the Boosker texts are empty.
export function defaultSettings(boosker = {}) {
  return {
    voice: {
      prompt: DEFAULT_VOICE_PROMPT,
      voice: 'marin',
      greeting: { enabled: true, text: DEFAULT_GREETING },
      // delegation.acknowledgement_delay_ms (0..800). 0 = GPT-Live's default.
      ackDelayMs: 0,
      // Send an empty session.thinking.append as soon as a delegation arrives,
      // which cancels the automatic spoken acknowledgement.
      suppressAck: false,
      // Close a call after this many minutes with no speech and no backend work
      // (0 = never). A connected session is billed for every second.
      idleCloseMin: 5
    },
    orchestrator: {
      // agent: a Responses model routes each delegation with tools.
      // direct: no model; every delegation becomes a new subagent task.
      mode: 'agent',
      prompt: DEFAULT_ORCHESTRATOR_PROMPT,
      model: 'gpt-6-luna',
      effort: 'low',
      // Wait this long after session.delegation.created so trailing transcript
      // fragments arrive before the request is read.
      graceMs: 400,
      // auto: subagent results go straight to GPT-Live as commentary.
      // orchestrator: results go to the orchestrator, which decides what to say.
      resultRouting: 'auto'
    },
    subagents: {
      // openai: Responses API runs. mock: canned progress and result, no cost.
      engine: 'openai',
      prompt: DEFAULT_SUBAGENT_PROMPT,
      model: 'gpt-6-luna',
      effort: 'low',
      webSearch: true,
      progressToVoice: true,
      progressIntervalMs: 4000,
      mockDurationMs: 6000
    },
    boosker: {
      // On: a call runs through the Boosker broker's own code, with its real
      // dispatcher and real Claude sessions, and the three prompts below take
      // the place of the voice, orchestrator and subagent prompts above.
      enabled: false,
      // The voice's instructions: the agent prompt the phone sends, then the
      // paragraph the broker adds.
      voicePrompt: boosker.voicePrompt ?? '',
      // The dispatcher's system prompt.
      dispatcherPrompt: boosker.dispatcherPrompt ?? '',
      // The instruction added to a lookup. A session gets the request as spoken.
      lookupPrompt: boosker.lookupPrompt ?? '',
      // How long the broker waits after a delegation for late captions.
      graceMs: 500
    }
  };
}
export const BOOSKER_TEXTS = ['voicePrompt', 'dispatcherPrompt', 'lookupPrompt'];

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
function merge(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in base)) continue;
    out[key] = isObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const text = (value, name, max) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must be 1 to ${max} characters.`); };
const oneOf = (value, name, list) => { if (!list.includes(value)) fail(`${name} must be one of: ${list.join(', ')}.`); };
const int = (value, name, min, max) => { if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be a whole number from ${min} to ${max}.`); };
const bool = (value, name) => { if (typeof value !== 'boolean') fail(`${name} must be true or false.`); };

export function validateSettings(s) {
  text(s.voice.prompt, 'Voice prompt', 60000);
  oneOf(s.voice.voice, 'Voice', VOICES);
  bool(s.voice.greeting.enabled, 'Greeting');
  text(s.voice.greeting.text, 'Greeting text', 2000);
  int(s.voice.ackDelayMs, 'Acknowledgement delay', 0, 800);
  bool(s.voice.suppressAck, 'Suppress acknowledgement');
  int(s.voice.idleCloseMin, 'Idle hang-up', 0, 120);
  oneOf(s.orchestrator.mode, 'Orchestrator mode', ['agent', 'direct']);
  text(s.orchestrator.prompt, 'Orchestrator prompt', 60000);
  text(s.orchestrator.model, 'Orchestrator model', 100);
  oneOf(s.orchestrator.effort, 'Orchestrator effort', EFFORTS);
  int(s.orchestrator.graceMs, 'Grace period', 0, 5000);
  oneOf(s.orchestrator.resultRouting, 'Result routing', ['auto', 'orchestrator']);
  oneOf(s.subagents.engine, 'Subagent engine', ['openai', 'mock']);
  text(s.subagents.prompt, 'Subagent prompt', 60000);
  text(s.subagents.model, 'Subagent model', 100);
  oneOf(s.subagents.effort, 'Subagent effort', EFFORTS);
  bool(s.subagents.webSearch, 'Web search');
  bool(s.subagents.progressToVoice, 'Progress to voice');
  int(s.subagents.progressIntervalMs, 'Progress interval', 0, 60000);
  int(s.subagents.mockDurationMs, 'Mock duration', 500, 120000);
  bool(s.boosker.enabled, 'Boosker mode');
  for (const key of BOOSKER_TEXTS) if (typeof s.boosker[key] !== 'string' || s.boosker[key].length > 60000) fail(`Boosker ${key} must be text of at most 60000 characters.`);
  int(s.boosker.graceMs, 'Boosker wait for transcript', 0, 5000);
  return s;
}

export class SettingsStore {
  constructor(path, { boosker = {} } = {}) { this.path = path; this.boosker = boosker; this.settings = this.load(); }
  defaults() { return defaultSettings(this.boosker); }
  load() {
    try { return validateSettings(merge(this.defaults(), JSON.parse(readFileSync(this.path, 'utf8')))); }
    catch (error) {
      if (error.code !== 'ENOENT') console.warn('Settings file unreadable; using defaults:', error.message);
      return this.defaults();
    }
  }
  get() { return this.settings; }
  update(patch) {
    const next = validateSettings(merge(this.settings, patch));
    // A Boosker text that still matches the repository is not written, so it
    // keeps following the repository; only an edit made here is saved.
    const saved = { ...next, boosker: { ...next.boosker } };
    const defaults = this.defaults().boosker;
    for (const key of BOOSKER_TEXTS) if (saved.boosker[key] === defaults[key]) delete saved.boosker[key];
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + '.tmp', JSON.stringify(saved, null, 2));
    renameSync(this.path + '.tmp', this.path);
    this.settings = next;
    return next;
  }
  // Reset one section ('voice', 'orchestrator', 'subagents', 'boosker') or all
  // of them. Resetting Boosker reloads its values from the Boosker folder,
  // all of them or only the named `fields`, and keeps the mode switch.
  reset(section, fields = null) {
    const defaults = this.defaults();
    if (section === 'boosker') {
      const { enabled: _enabled, ...values } = defaults.boosker;
      return this.update({ boosker: fields ? Object.fromEntries(fields.filter(field => field in values).map(field => [field, values[field]])) : values });
    }
    return this.update(section ? { [section]: defaults[section] } : defaults);
  }
}
