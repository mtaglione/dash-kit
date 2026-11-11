// Client delegation keeps the conversation in the application: the
// delegation event carries no task text, so requests are read from the
// transcript deltas (session.input_transcript.delta / output_transcript.delta).
// Fragments are appended exactly as received and grouped into turns by
// speaker and timeline gap; GPT-Live itself marks no turn boundaries.

export class Transcript {
  constructor({ userGapMs = 1500, assistantGapMs = 1000 } = {}) {
    Object.assign(this, { userGapMs, assistantGapMs });
    this.turns = []; this.seen = new Set(); this.count = 0;
  }
  // Returns the turn the fragment landed in, or null for a duplicate
  // (the sideband replays the last 3 s on attach; replays keep their event_id).
  add({ eventId, role, delta, startMs = 0, endMs = startMs }) {
    if (typeof delta !== 'string' || !delta) return null;
    if (eventId) { if (this.seen.has(eventId)) return null; this.seen.add(eventId); }
    const gap = role === 'user' ? this.userGapMs : this.assistantGapMs;
    let turn = null;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === role) { turn = this.turns[i]; break; }
    }
    if (turn && startMs <= turn.endMs + gap) {
      turn.text += delta; turn.endMs = Math.max(turn.endMs, endMs);
    } else {
      turn = { id: `${role === 'user' ? 'u' : 'a'}${++this.count}`, role, text: delta, startMs, endMs: Math.max(startMs, endMs) };
      this.turns.push(turn);
      this.turns.sort((a, b) => a.startMs - b.startMs);
    }
    return turn;
  }
  get endMs() { return this.turns.reduce((end, t) => Math.max(end, t.endMs), 0); }
  // Turns that ended after `afterMs` (a turn that grew is included in full).
  since(afterMs = -1) { return this.turns.filter(t => t.endMs > afterMs); }
  static render(turns) { return turns.map(t => `${t.role}: ${t.text.trim()}`).join('\n'); }
  latestUserText(beforeMs = Infinity) {
    const turn = [...this.turns].reverse().find(t => t.role === 'user' && t.startMs <= beforeMs);
    return turn ? turn.text.trim() : '';
  }
}

// Each append is limited to 500 tokens. UTF-8 bytes / 3 is a conservative
// token estimate, so parts are cut at ~1200 bytes on a word boundary.
export function splitContent(content, maxBytes = 1200) {
  if (Buffer.byteLength(content) <= maxBytes) return [content];
  const parts = []; let rest = content;
  while (Buffer.byteLength(rest) > maxBytes) {
    let cut = maxBytes;
    while (Buffer.byteLength(rest.slice(0, cut)) > maxBytes) cut--;
    const space = rest.lastIndexOf(' ', cut);
    if (space > cut / 2) cut = space + 1;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}
