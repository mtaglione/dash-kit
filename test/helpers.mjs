import { EventEmitter } from 'node:events';

// Stands in for the SDK's SidebandWS: records sent commands; tests push
// server events with emit('event', ...).
export class FakeSideband extends EventEmitter {
  static instances = [];
  constructor(client, params) { super(); this.params = params; this.sent = []; this.closed = false; FakeSideband.instances.push(this); }
  send(payload) { this.sent.push(payload); }
  close() { this.closed = true; }
  server(event) { this.emit('event', event); }
}

// A Responses client that replays scripted outputs, one per create() call.
export function scriptedClient(script) {
  const calls = [];
  return {
    calls,
    responses: {
      create: async params => {
        calls.push(params);
        const next = script.shift() ?? { output: [], output_text: '' };
        return { id: `resp_${calls.length}`, usage: null, ...next };
      }
    },
    live: { create: async () => ({ session: { id: 'live_test123' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } }) }
  };
}
export const functionCall = (name, args, id = name) => ({ type: 'function_call', name, call_id: `call_${id}`, arguments: JSON.stringify(args) });
export const until = async (check, timeoutMS = 3000) => {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeoutMS) throw new Error('condition not met in time'); await new Promise(r => setTimeout(r, 10)); }
};
