// One event stream for the dashboard. Every participant publishes here; the
// browser draws the conversation thread and the timeline from it, and each run
// is also written to data/runs/<run>.jsonl for later review.
//
// Event fields:
//   type   what happened ('transcript', 'delegation', 'append', ...)
//   from   lane the arrow starts at: user | client | voice | orchestrator | subagent | system
//   to     lane the arrow ends at (same as from for a point event)
//   label  short text for the timeline row
//   text   longer text for the thread (optional)
//   key    rows with the same key replace each other (streaming text, transcript turns)
//   sub    subagent id (s1, s2...) when one is involved
//   delegationId, data (raw payload)
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const LANES = ['user', 'client', 'voice', 'orchestrator', 'subagent', 'system'];

export class Bus extends EventEmitter {
  constructor({ logDir = null, limit = 4000, now = Date.now } = {}) {
    super();
    Object.assign(this, { logDir, limit, now });
    this.seq = 0;
    this.reset();
  }
  reset() {
    this.history = [];
    this.runId = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    this.runStartedAt = this.now();
    this.logPath = this.logDir ? join(this.logDir, `${this.runId}.jsonl`) : null;
    this.emit('reset', { runId: this.runId, startedAt: this.runStartedAt });
  }
  publish(event) {
    const from = LANES.includes(event.from) ? event.from : 'system';
    const to = LANES.includes(event.to) ? event.to : from;
    const record = { seq: ++this.seq, at: this.now(), ...event, from, to };
    if (record.key) {
      const index = this.history.findIndex(e => e.key === record.key);
      if (index >= 0) this.history.splice(index, 1);
    }
    this.history.push(record);
    if (this.history.length > this.limit) this.history.splice(0, this.history.length - this.limit);
    if (this.logPath && !record.ephemeral) {
      try { mkdirSync(this.logDir, { recursive: true }); appendFileSync(this.logPath, JSON.stringify(record) + '\n'); }
      catch (error) { console.warn('Run log write failed:', error.message); }
    }
    this.emit('event', record);
    return record;
  }
}
