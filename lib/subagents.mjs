// Background subagents. Each one is a separate Responses API conversation
// (chained with previous_response_id) that streams progress while it works,
// or a mock that emits canned progress and a result at no cost.
//
// Events: 'progress' (line), 'delta' (text so far), 'result' (text),
//         'failed' (message), 'stopped', 'status'.
import { EventEmitter } from 'node:events';

const clip = (value, size) => { const t = String(value ?? '').replace(/\s+/g, ' ').trim(); return t.length > size ? t.slice(0, size - 1) + '…' : t; };

class BaseSubagent extends EventEmitter {
  constructor({ id, title, task, delegationId = null, settings }) {
    super();
    Object.assign(this, { id, title, task, delegationId, settings });
    this.status = 'idle'; this.result = ''; this.lastProgress = ''; this.turns = 0; this.createdAt = Date.now(); this.updatedAt = this.createdAt;
    this.history = [];   // { role: 'task'|'message'|'result'|'failed', text }
  }
  set(status) { this.status = status; this.updatedAt = Date.now(); this.emit('status', status); }
  progress(line) { if (!line) return; this.lastProgress = line; this.updatedAt = Date.now(); this.emit('progress', line); }
  start() { this.history.push({ role: 'task', text: this.task }); return this.run(this.task); }
  // A follow-up or correction. A running turn is cancelled and restarted with
  // the update folded in (a Responses run cannot take input mid-stream).
  message(text, delegationId) {
    if (delegationId !== undefined) this.delegationId = delegationId;
    this.history.push({ role: 'message', text });
    if (this.status === 'running') {
      const pending = this.pendingInput;
      this.cancel();
      return this.run(`${pending}\n\nUpdate from the user while you were working: ${text}`, { restart: true });
    }
    return this.run(text);
  }
  stop() { if (this.status !== 'running') return false; this.cancel(); this.set('stopped'); this.emit('stopped'); return true; }
  summary() {
    return { id: this.id, title: this.title, task: this.task, status: this.status, engine: this.engine, model: this.model ?? null,
      lastProgress: this.lastProgress, result: this.result, delegationId: this.delegationId, turns: this.turns, createdAt: this.createdAt, updatedAt: this.updatedAt, history: this.history.slice(-10) };
  }
  statusLine() {
    if (this.status === 'running') return `working${this.lastProgress ? `; latest progress: ${clip(this.lastProgress, 160)}` : ''}`;
    if (this.status === 'done') return `finished; result: ${clip(this.result, 300)}`;
    if (this.status === 'failed') return `failed: ${clip(this.result, 200)}`;
    return this.status;
  }
}

export class OpenAISubagent extends BaseSubagent {
  constructor({ client, ...rest }) {
    super(rest);
    this.client = client; this.engine = 'openai';
    this.model = rest.settings.model; this.previousResponseId = null; this.controller = null; this.generation = 0;
  }
  cancel() { this.generation++; this.controller?.abort(); this.controller = null; }
  async run(input, { restart = false } = {}) {
    const s = this.settings;
    const generation = ++this.generation;
    this.pendingInput = input; this.controller = new AbortController(); this.turns++;
    this.set('running');
    this.progress(restart ? 'Restarting with the update' : 'Started');
    let text = '', lastDeltaAt = 0;
    try {
      const reasoning = s.effort === 'none' ? { effort: 'none' } : { effort: s.effort, summary: 'auto' };
      const stream = await this.client.responses.create({
        model: s.model, instructions: s.prompt, input, previous_response_id: this.previousResponseId ?? undefined,
        tools: s.webSearch ? [{ type: 'web_search' }] : [], reasoning, stream: true
      }, { signal: this.controller.signal });
      for await (const event of stream) {
        if (generation !== this.generation) return;
        switch (event.type) {
          case 'response.created': this.emit('response', { id: event.response.id }); break;
          case 'response.web_search_call.searching': this.progress('Searching the web'); break;
          case 'response.output_item.done':
            if (event.item?.type === 'web_search_call') {
              const action = event.item.action ?? {};
              const what = action.query ?? action.queries?.join('; ') ?? action.url ?? '';
              this.progress(what ? `Searched: ${clip(what, 140)}` : 'Finished a web search');
            }
            break;
          case 'response.reasoning_summary_text.done': this.progress(clip(event.text.replace(/\*\*/g, ''), 220)); break;
          case 'response.output_text.delta':
            text += event.delta;
            if (Date.now() - lastDeltaAt > 250) { lastDeltaAt = Date.now(); this.emit('delta', text); }
            break;
          case 'response.output_text.done': text = event.text; break;
          case 'response.completed':
            this.previousResponseId = event.response.id;
            this.emit('usage', event.response.usage ?? null);
            break;
          case 'response.failed':
          case 'response.incomplete':
            throw new Error(event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? event.type);
          case 'error': throw new Error(event.message ?? 'stream error');
        }
      }
      if (generation !== this.generation) return;
      this.controller = null;
      this.result = text.trim() || 'The agent finished with no summary.';
      this.history.push({ role: 'result', text: this.result });
      this.set('done');
      this.emit('result', this.result);
    } catch (error) {
      if (generation !== this.generation) return;   // cancelled or superseded
      this.controller = null;
      this.result = error.message;
      this.history.push({ role: 'failed', text: error.message });
      this.set('failed');
      this.emit('failed', error.message);
    }
  }
}

const MOCK_STEPS = ['Reading the request', 'Looking things up', 'Checking the details', 'Writing the answer'];
export class MockSubagent extends BaseSubagent {
  constructor(options) { super(options); this.engine = 'mock'; this.model = 'mock'; this.timers = []; }
  cancel() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }
  run(input, { restart = false } = {}) {
    this.pendingInput = input; this.turns++;
    this.set('running');
    this.progress(restart ? 'Restarting with the update' : 'Started');
    const total = this.settings.mockDurationMs;
    MOCK_STEPS.forEach((step, index) => this.timers.push(setTimeout(() => this.progress(step), ((index + 1) * total) / (MOCK_STEPS.length + 1))));
    this.timers.push(setTimeout(() => {
      this.timers = [];
      const request = clip(input.split('\n')[0], 160);
      this.result = /\b(fail|error|broken)\b/i.test(input)
        ? `Mock failure for "${request}".`
        : `Mock result for "${request}": the check is complete and everything looks fine.`;
      if (this.result.startsWith('Mock failure')) { this.history.push({ role: 'failed', text: this.result }); this.set('failed'); this.emit('failed', this.result); return; }
      this.history.push({ role: 'result', text: this.result });
      this.set('done'); this.emit('result', this.result);
    }, total));
  }
}

export class SubagentPool extends EventEmitter {
  constructor({ client, settings }) { super(); Object.assign(this, { client, settings }); this.agents = new Map(); this.count = 0; }
  create({ title, task, delegationId }) {
    const s = this.settings().subagents;
    const id = `s${++this.count}`;
    const options = { id, title, task, delegationId, settings: { ...s } };
    const agent = s.engine === 'mock' ? new MockSubagent(options) : new OpenAISubagent({ ...options, client: this.client });
    this.agents.set(id, agent);
    this.emit('created', agent);
    return agent;
  }
  get(id) { return this.agents.get(id) ?? null; }
  list() { return [...this.agents.values()]; }
  running() { return this.list().filter(a => a.status === 'running'); }
  stopAll() { for (const agent of this.running()) agent.stop(); }
  clear() { for (const agent of this.list()) agent.cancel(); this.agents.clear(); this.count = 0; }
  statusBlock() {
    const agents = this.list();
    if (!agents.length) return 'Subagents: none yet.';
    return 'Subagents:\n' + agents.map(a => `- ${a.id} "${a.title}" (${a.status}): ${a.statusLine()}`).join('\n');
  }
}
