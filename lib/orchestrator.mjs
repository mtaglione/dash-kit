// The orchestrating agent for client delegation. GPT-Live's
// session.delegation.created carries only metadata, so each request is built
// from the application's transcript and task state (docs: "Keep the
// conversation context in your application"). A Responses model reads it and
// acts through function tools: start, message, or stop a subagent, or send
// context to GPT-Live. One orchestrator conversation per call, chained with
// previous_response_id; turns run one at a time, in order.
import { EventEmitter } from 'node:events';
import { Transcript } from './transcript.mjs';
import { secs, short } from './live.mjs';

const MAX_STEPS = 6;
const clip = (value, size) => { const t = String(value ?? '').replace(/\s+/g, ' ').trim(); return t.length > size ? t.slice(0, size - 1) + '…' : t; };

const fn = (name, description, properties, required = Object.keys(properties)) => ({
  type: 'function', name, description, strict: true,
  parameters: { type: 'object', properties, required, additionalProperties: false }
});
export const ORCHESTRATOR_TOOLS = [
  fn('start_subagent', 'Start a new background subagent for independent work.', {
    title: { type: 'string', description: 'Plain summary in at most four words.' },
    task: { type: 'string', description: "The task in the user's words, with references resolved so it stands alone." }
  }),
  fn('message_subagent', 'Send a follow-up, correction, or addition to an existing subagent. A working subagent restarts with the update folded in.', {
    subagent_id: { type: 'string', description: 'For example s1.' },
    message: { type: 'string' }
  }),
  fn('stop_subagent', 'Stop a working subagent. Use "all" to stop every working subagent.', {
    subagent_id: { type: 'string' }
  }),
  fn('tell_voice', 'Send context to GPT-Live. commentary: something to say to the user now. thinking: quiet context, not spoken on arrival. instructions: direct how the voice behaves.', {
    kind: { type: 'string', enum: ['commentary', 'thinking', 'instructions'] },
    content: { type: 'string', description: 'Plain text, under 500 tokens.' }
  })
];

export class Orchestrator extends EventEmitter {
  constructor({ client, bus, settings, pool, voice }) {
    super();
    // voice(kind, content, delegationId, meta) sends to GPT-Live, or reports a
    // skipped send when no call is connected.
    Object.assign(this, { client, bus, settings, pool, voice });
    this.queue = Promise.resolve(); this.previousResponseId = null; this.transcriptCursor = -1; this.turns = 0; this.busy = false;
    this.lastProgressAt = new Map();
    pool.on('created', agent => this.watch(agent));
  }
  reset() { this.previousResponseId = null; this.transcriptCursor = -1; this.turns = 0; }
  publish(event) { return this.bus.publish(event); }

  // Turns run serially so a later request always sees the earlier one's actions.
  enqueue(work) {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  // From the live call: a delegation (id, offsetMs) and the call's transcript.
  handleDelegation({ id, offsetMs }, transcript) {
    return this.enqueue(async () => {
      const turns = transcript.since(this.transcriptCursor);
      this.transcriptCursor = Math.max(this.transcriptCursor, transcript.endMs);
      const conversation = Transcript.render(turns) || '(no transcript received yet)';
      const message = [`[delegation ${id} at ${secs(offsetMs)} on the session timeline]`,
        `Conversation since your last turn (speech transcript; may contain recognition errors):\n${conversation}`,
        this.pool.statusBlock()].join('\n\n');
      if (this.settings().orchestrator.mode === 'direct') return this.direct(transcript.latestUserText(offsetMs + 1500), id);
      return this.turn(message, id, { trigger: 'delegation' });
    });
  }
  // Typed input from the dashboard. Docs: with client delegation, send typed
  // values directly to the backend that handles the conversation.
  handleTyped(text) {
    return this.enqueue(() => {
      const message = [`[typed request from the user, not spoken; no delegation id]`, `User typed: ${JSON.stringify(text)}`, this.pool.statusBlock()].join('\n\n');
      if (this.settings().orchestrator.mode === 'direct') return this.direct(text, null);
      return this.turn(message, null, { trigger: 'typed' });
    });
  }
  // Result routing "orchestrator": a finished subagent is reported to the
  // orchestrator, which decides what GPT-Live hears.
  handleSubagentOutcome(agent, outcome, text) {
    return this.enqueue(() => this.turn([`[subagent ${agent.id} "${agent.title}" ${outcome}]`, `${outcome === 'finished' ? 'Result' : 'Error'}: ${text}`,
      'Tell the user with tell_voice commentary if they should hear it.', this.pool.statusBlock()].join('\n\n'), agent.delegationId, { trigger: `subagent ${outcome}` }));
  }

  // Mode "direct": no routing model; the latest user speech becomes a task.
  direct(text, delegationId) {
    if (!text) { this.voice('commentary', "I didn't catch a request to hand off. Ask the user to say it again.", delegationId, { origin: 'orchestrator' }); return; }
    this.publish({ type: 'orchestrator.direct', from: 'orchestrator', label: `Direct mode: new subagent for "${clip(text, 80)}"`, delegationId });
    this.startSubagent({ title: clip(text, 30), task: text }, delegationId);
  }

  async turn(message, delegationId, { trigger }) {
    const s = this.settings().orchestrator;
    const turnNo = ++this.turns;
    this.busy = true; this.emit('busy', true);
    this.publish({ type: 'orchestrator.input', from: delegationId ? 'voice' : 'client', to: 'orchestrator', delegationId, key: `orch-in:${turnNo}`,
      label: `Orchestrator turn ${turnNo} (${trigger})`, text: message });
    const startedAt = Date.now();
    let input = message, steps = 0;
    try {
      while (steps++ < MAX_STEPS) {
        const response = await this.client.responses.create({
          model: s.model, instructions: s.prompt, input, tools: ORCHESTRATOR_TOOLS, parallel_tool_calls: true,
          previous_response_id: this.previousResponseId ?? undefined, reasoning: { effort: s.effort }
        });
        this.previousResponseId = response.id;
        const calls = response.output.filter(item => item.type === 'function_call');
        const note = response.output_text?.trim();
        if (!calls.length) {
          this.publish({ type: 'orchestrator.done', from: 'orchestrator', delegationId, label: `Turn ${turnNo} done in ${Date.now() - startedAt} ms${note ? `: ${clip(note, 160)}` : ''}`, text: note || '',
            data: { usage: response.usage, responseId: response.id } });
          return;
        }
        const outputs = [];
        for (const call of calls) {
          let args = {};
          try { args = JSON.parse(call.arguments || '{}'); } catch { /* reported below */ }
          const result = this.execute(call.name, args, delegationId);
          outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
        }
        input = outputs;
      }
      this.publish({ type: 'orchestrator.done', from: 'orchestrator', delegationId, label: `Turn ${turnNo} stopped after ${MAX_STEPS} tool rounds` });
    } catch (error) {
      this.publish({ type: 'orchestrator.error', from: 'orchestrator', delegationId, label: `Orchestrator failed: ${error.message}` });
      // A delegation is never dropped in silence.
      this.voice('commentary', 'The backend could not handle that request. Tell the user it failed and offer to try again.', delegationId, { origin: 'orchestrator', reason: 'orchestrator error' });
    } finally { this.busy = false; this.emit('busy', false); }
  }

  execute(name, args, delegationId) {
    const record = (label, extra = {}) => this.publish({ type: 'orchestrator.tool', from: 'orchestrator', tool: name, args, delegationId, label, ...extra });
    try {
      switch (name) {
        case 'start_subagent': {
          if (!args.task?.trim()) throw new Error('task is required');
          const agent = this.startSubagent({ title: args.title, task: args.task }, delegationId, record);
          return { ok: true, subagent_id: agent.id };
        }
        case 'message_subagent': {
          const agent = this.pool.get(args.subagent_id);
          if (!agent) throw new Error(`there is no subagent ${args.subagent_id}`);
          const wasRunning = agent.status === 'running';
          record(`message_subagent → ${agent.id}: ${clip(args.message, 120)}`, { to: 'subagent', sub: agent.id, text: args.message });
          agent.message(args.message, delegationId ?? agent.delegationId);
          return { ok: true, subagent_id: agent.id, restarted: wasRunning };
        }
        case 'stop_subagent': {
          const targets = args.subagent_id === 'all' ? this.pool.running() : [this.pool.get(args.subagent_id)].filter(Boolean);
          if (!targets.length) throw new Error(args.subagent_id === 'all' ? 'no subagent is working' : `there is no subagent ${args.subagent_id}`);
          const stopped = targets.filter(agent => agent.stop()).map(agent => agent.id);
          record(`stop_subagent → ${targets.map(a => a.id).join(', ')}`, { to: 'subagent', sub: targets[0].id });
          return { ok: true, stopped };
        }
        case 'tell_voice': {
          if (!['commentary', 'thinking', 'instructions'].includes(args.kind)) throw new Error('kind must be commentary, thinking, or instructions');
          record(`tell_voice (${args.kind})`, { text: args.content });
          const sent = this.voice(args.kind, String(args.content ?? ''), delegationId, { origin: 'orchestrator' });
          return { ok: true, delivered: sent };
        }
        default: throw new Error(`unknown tool ${name}`);
      }
    } catch (error) {
      record(`${name} rejected: ${error.message}`, { error: true });
      return { ok: false, error: error.message };
    }
  }

  startSubagent({ title, task }, delegationId, record = null) {
    const agent = this.pool.create({ title: clip(title || task, 40), task, delegationId });
    const label = `start_subagent → ${agent.id} "${agent.title}"`;
    if (record) record(label, { to: 'subagent', sub: agent.id, text: task });
    else this.publish({ type: 'orchestrator.tool', tool: 'start_subagent', from: 'orchestrator', to: 'subagent', sub: agent.id, delegationId, label, text: task });
    agent.start();
    return agent;
  }

  // Subagent output → bus, and to GPT-Live per the routing settings.
  watch(agent) {
    const pub = event => this.publish({ from: 'subagent', sub: agent.id, delegationId: agent.delegationId, ...event });
    agent.on('status', status => this.emit('subagents'));
    agent.on('progress', line => {
      pub({ type: 'subagent.progress', label: line, text: line });
      const s = this.settings().subagents;
      if (!s.progressToVoice || line === 'Started') return;
      const last = this.lastProgressAt.get(agent.id) ?? 0;
      if (Date.now() - last < s.progressIntervalMs) return;
      this.lastProgressAt.set(agent.id, Date.now());
      this.voice('thinking', `${agent.title} (${agent.id}) progress: ${line}`, agent.delegationId, { origin: 'subagent', sub: agent.id, reason: 'progress' });
    });
    agent.on('delta', text => pub({ type: 'subagent.delta', key: `delta:${agent.id}:${agent.turns}`, label: `writing: ${clip(text, 100)}`, text, ephemeral: true }));
    agent.on('usage', usage => usage && pub({ type: 'subagent.usage', label: `tokens: ${usage.input_tokens} in / ${usage.output_tokens} out`, data: usage, quiet: true }));
    agent.on('result', text => {
      pub({ type: 'subagent.result', to: 'orchestrator', label: `finished: ${clip(text, 140)}`, text });
      this.lastProgressAt.delete(agent.id);
      if (this.settings().orchestrator.resultRouting === 'orchestrator' && this.settings().orchestrator.mode === 'agent') { this.handleSubagentOutcome(agent, 'finished', text); return; }
      const label = this.pool.list().length > 1 ? `${agent.title} finished: ` : '';
      this.voice('commentary', label + text, agent.delegationId, { origin: 'subagent', sub: agent.id, reason: 'result' });
    });
    agent.on('failed', message => {
      pub({ type: 'subagent.failed', to: 'orchestrator', label: `failed: ${clip(message, 140)}`, text: message, error: true });
      if (this.settings().orchestrator.resultRouting === 'orchestrator' && this.settings().orchestrator.mode === 'agent') { this.handleSubagentOutcome(agent, 'failed', message); return; }
      this.voice('commentary', `${agent.title} could not finish: ${clip(message, 300)}`, agent.delegationId, { origin: 'subagent', sub: agent.id, reason: 'failure' });
    });
    agent.on('stopped', () => pub({ type: 'subagent.stopped', label: 'stopped' }));
  }
}

export { short };
