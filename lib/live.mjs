// GPT-Live session creation and the server's sideband connection.
//
// Docs followed:
//   WebRTC quickstart  https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
//   Server controls    https://developers.openai.com/api/docs/guides/voice-server-controls?api=live
//   Client delegation  https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client
//
// The browser owns the media (WebRTC) and creates the SDP offer; the server
// exchanges it with POST /v1/live/sessions, then attaches a sideband WebSocket
// (wss://api.openai.com/v1/live/sessions/{id}/attach) that receives the
// transcript and delegation events and sends every context append. The server
// is the single owner of appends, so nothing is sent twice.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import { Transcript, splitContent } from './transcript.mjs';

export const LIVE_MODEL = 'gpt-live-1';
export const APPEND_KINDS = ['instructions', 'thinking', 'commentary'];
const KIND_LABEL = { instructions: 'instruction', thinking: 'silent context', commentary: 'spoken update' };

export function buildSessionConfig(settings) {
  const v = settings.voice;
  // Greeting: a developer message in session.input at startup, then the same
  // text once through session.commentary.append after session.started.
  const input = v.greeting.enabled
    ? [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: v.greeting.text }] }]
    : [];
  const delegation = { type: 'client' };
  if (v.ackDelayMs > 0) delegation.acknowledgement_delay_ms = v.ackDelayMs;
  return { model: LIVE_MODEL, instructions: v.prompt, input, audio: { output: { voice: v.voice } }, delegation };
}

export async function createLiveSession(client, settings, sdp) {
  return client.live.create({ session: buildSessionConfig(settings), transport: { type: 'webrtc', sdp } });
}

export class LiveCall extends EventEmitter {
  constructor({ client, sessionId, bus, settings, Sideband = SidebandWS, now = Date.now }) {
    super();
    Object.assign(this, { client, sessionId, bus, settings, Sideband, now });
    this.transcript = new Transcript();
    this.seen = new Set();
    this.pending = new Map();      // event_id -> { kind, origin, sentAt, delegationId }
    this.delegations = [];         // { id, offsetMs, at }
    this.state = 'attaching';
    this.usageSeconds = 0;
    this.closed = false;
    this.startedAt = now();
    this.audioBytes = { in: 0, out: 0 };
  }

  connect() {
    this.ws = new this.Sideband(this.client, { session_id: this.sessionId });
    this.ws.on('event', event => { try { this.receive(event); } catch (error) { console.error('Sideband event handler failed', error); } });
    // API `error` events also arrive on 'event'; this listener keeps the SDK
    // from raising them as unhandled rejections and reports socket failures.
    this.ws.on('error', error => { if (!error?.error) this.publish({ type: 'sideband.error', from: 'system', label: `Sideband error: ${error.message}` }); });
    this.ws.on('close', (code, reason) => {
      this.publish({ type: 'sideband.closed', from: 'voice', to: 'system', label: `Sideband closed (${code}${reason ? ' ' + reason : ''})` });
      this.finish(this.state === 'closed' ? 'closed' : 'sideband-closed');
    });
    this.publish({ type: 'sideband.attach', from: 'system', to: 'voice', label: 'Sideband attaching', data: { sessionId: this.sessionId } });
    return this;
  }

  publish(event) { return this.bus.publish({ sessionId: this.sessionId, ...event }); }

  receive(event) {
    if (this.closed && event.type !== 'session.closed') return;
    // Replayed events keep their event_id; reflected audio has none.
    if (event.event_id) { if (this.seen.has(event.event_id)) return; this.seen.add(event.event_id); }
    switch (event.type) {
      case 'session.input_audio.append': this.audioBytes.in += event.audio?.length ?? 0; return;
      case 'session.output_audio.delta': this.audioBytes.out += event.delta?.length ?? 0; return;
      case 'session.started':
        this.state = 'live';
        this.publish({ type: 'session.started', from: 'voice', to: 'system', label: 'Session started', data: event });
        this.emit('started');
        return;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
        const turn = this.transcript.add({ eventId: event.event_id, role, delta: event.delta, startMs: event.start_ms, endMs: event.end_ms });
        if (!turn) return;
        this.publish({ type: 'transcript', key: `turn:${this.sessionId}:${turn.id}`, from: role === 'user' ? 'user' : 'voice', to: role === 'user' ? 'voice' : 'user',
          role, label: turn.text.trim(), text: turn.text, turnId: turn.id, startMs: turn.startMs, endMs: turn.endMs });
        return;
      }
      case 'session.delegation.created': {
        const d = event.delegation ?? {};
        const record = { id: d.id, target: d.target, offsetMs: event.offset_ms, at: this.now() };
        this.delegations.push(record);
        this.publish({ type: 'delegation', from: 'voice', to: 'orchestrator', delegationId: d.id, label: `Delegation ${short(d.id)} at ${secs(event.offset_ms)}`, data: event });
        if (d.target === 'client') {
          // Docs: an empty thinking append sent before the acknowledgement is
          // generated cancels it (pair with delegation.acknowledgement_delay_ms).
          if (this.settings().voice.suppressAck) this.append('thinking', '', d.id, { origin: 'orchestrator', reason: 'suppress acknowledgement' });
          this.emit('delegation', record);
        }
        return;
      }
      case 'session.instructions.appended':
      case 'session.thinking.appended':
      case 'session.commentary.appended': {
        const sent = this.pending.get(event.client_event_id);
        this.pending.delete(event.client_event_id);
        const kind = event.type.split('.')[1];
        this.publish({ type: 'append.ack', from: 'voice', to: sent?.origin ?? 'orchestrator', sub: sent?.sub, delegationId: sent?.delegationId ?? null,
          label: `${KIND_LABEL[kind]} accepted${sent ? ` in ${this.now() - sent.sentAt} ms` : ''} (timeline ${secs(event.start_ms)}–${secs(event.end_ms)})`,
          replyTo: event.client_event_id, data: event });
        return;
      }
      case 'session.input_audio.muted':
      case 'session.input_audio.unmuted':
        this.publish({ type: event.type, from: 'voice', to: 'client', label: event.type.endsWith('unmuted') ? 'Microphone input unmuted' : 'Microphone input muted', data: event });
        this.emit('mute', event.type.endsWith('.muted'));
        return;
      case 'session.usage.updated':
        this.usageSeconds = event.usage?.seconds ?? this.usageSeconds;
        this.emit('usage', { seconds: this.usageSeconds, contextRatio: event.context_window?.usage_ratio ?? null });
        this.publish({ type: 'usage', from: 'voice', label: `Usage ${this.usageSeconds}s` + (event.context_window ? `, context ${Math.round(event.context_window.usage_ratio * 100)}%` : ''), data: event, quiet: true });
        return;
      case 'session.closed':
        this.usageSeconds = event.usage?.seconds ?? this.usageSeconds;
        this.publish({ type: 'session.closed', from: 'voice', to: 'system', label: `Session closed: ${event.reason ?? 'unknown'} (${this.usageSeconds}s billed)`, data: { reason: event.reason, usage: event.usage } });
        this.state = 'closed';
        for (const [id, sent] of this.pending) this.publish({ type: 'append.unconfirmed', from: 'voice', to: sent.origin, label: `${KIND_LABEL[sent.kind]} not confirmed before close`, replyTo: id });
        this.pending.clear();
        this.finish('closed', event.reason);
        try { this.ws?.close(); } catch { /* already closed */ }
        return;
      case 'error': {
        const error = event.error ?? {};
        const sent = error.client_event_id ? this.pending.get(error.client_event_id) : null;
        if (sent) this.pending.delete(error.client_event_id);
        this.publish({ type: 'error', from: 'voice', to: sent?.origin ?? 'system', label: `Error${error.code ? ' ' + error.code : ''}: ${error.message ?? 'unknown'}`, replyTo: error.client_event_id, data: event });
        return;
      }
      case 'info':
        this.publish({ type: 'info', from: 'voice', to: 'system', label: `${event.code}: ${event.message}`, data: event });
        return;
      default:
        this.publish({ type: 'event', from: 'voice', to: 'system', label: event.type, data: event });
    }
  }

  // Sends one context update (split into parts under the 500-token limit).
  // `origin` is the lane drawn as the sender: orchestrator, subagent, client.
  append(kind, content, delegationId = null, { origin = 'orchestrator', sub, reason, manual = false } = {}) {
    if (!APPEND_KINDS.includes(kind)) throw new Error(`Unknown append kind: ${kind}`);
    if (this.closed) {
      this.publish({ type: 'append.skipped', from: origin, to: 'voice', sub, delegationId, kind, label: `Not sent (session closed): ${KIND_LABEL[kind]}`, text: content });
      return [];
    }
    const parts = content === '' ? [''] : splitContent(String(content));
    return parts.map((part, index) => {
      const eventId = `${kind}_${randomUUID().slice(0, 8)}`;
      const payload = { type: `session.${kind}.append`, event_id: eventId, delegation_id: delegationId, content: part };
      this.pending.set(eventId, { kind, origin, sub, sentAt: this.now(), delegationId });
      this.ws.send(payload);
      const what = part === '' ? '(empty)' : part;
      this.publish({ type: 'append', kind, from: origin, to: 'voice', sub, delegationId, manual, eventId,
        label: `${KIND_LABEL[kind]}${parts.length > 1 ? ` ${index + 1}/${parts.length}` : ''}${reason ? ` (${reason})` : ''}: ${what}`, text: part, data: payload });
      return eventId;
    });
  }

  setMuted(muted) {
    if (this.closed) return;
    const payload = { type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute', event_id: `mute_${randomUUID().slice(0, 8)}` };
    this.ws.send(payload);
    this.publish({ type: 'command', from: 'client', to: 'voice', label: muted ? 'Mute microphone input' : 'Unmute microphone input', data: payload });
  }

  // Graceful close from the server side (the browser normally closes over its
  // data channel). session.closed finishes the call.
  close() {
    if (this.closed || this.state === 'closing') return;
    this.state = 'closing';
    const payload = { type: 'session.close', event_id: `close_${randomUUID().slice(0, 8)}` };
    try { this.ws.send(payload); } catch { /* socket gone */ }
    this.publish({ type: 'command', from: 'system', to: 'voice', label: 'session.close', data: payload });
    this.closeTimer = setTimeout(() => { if (!this.closed) { this.publish({ type: 'session.unconfirmed', from: 'system', label: 'No session.closed within 15 s; final usage unconfirmed' }); this.finish('timeout'); try { this.ws.close(); } catch {} } }, 15000);
    this.closeTimer.unref?.();
  }

  finish(state, reason) {
    if (this.closed) return;
    this.closed = true; this.state = state === 'closed' ? 'closed' : state;
    clearTimeout(this.closeTimer);
    this.emit('closed', { reason: reason ?? state, usageSeconds: this.usageSeconds });
  }

  latestDelegationId() { return this.delegations.at(-1)?.id ?? null; }
  status() {
    return { sessionId: this.sessionId, state: this.state, usageSeconds: this.usageSeconds, startedAt: this.startedAt,
      delegations: this.delegations.slice(-20).map(d => ({ id: d.id, offsetMs: d.offsetMs, at: d.at })) };
  }
}

export const short = id => (id ? String(id).slice(-6) : '—');
export const secs = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '?');
