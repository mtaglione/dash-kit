# Dash Kit

A test bench for GPT-Live client delegation. You talk to GPT-Live in the browser over WebRTC, and one screen shows everything that happens: your speech, the voice model's replies, each delegation, the orchestrator's decisions, every subagent, and every event sent back to GPT-Live.

Everything runs on the OpenAI platform with the project key in `.env`:

| Part | What runs it |
| --- | --- |
| Voice | GPT-Live (`gpt-live-1`) with `delegation: { type: "client" }`, browser WebRTC |
| App | `server.mjs`: creates the session, attaches a sideband WebSocket, owns every context append |
| Orchestrator (delegation agent) | Responses API model (default `gpt-6-luna`) with four function tools |
| Subagents | One Responses API conversation each (web search on), or a free mock engine |

Built from OpenAI's GPT-Live documentation, not from the Boosker code:

- [Getting started](https://developers.openai.com/api/docs/guides/live)
- [WebRTC quickstart](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live): browser offer, `POST /v1/live/sessions`, `oai-events` data channel, graceful `session.close`
- [Server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live): sideband at `wss://api.openai.com/v1/live/sessions/{id}/attach`, 3-second replay, dedupe by `event_id`
- [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client): transcript-built requests, `delegation_id`, the three append events, acknowledgement suppression
- [Managing sessions](https://developers.openai.com/api/docs/guides/live-conversations): config fields, greeting, transcripts, usage and close
- [Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting): prompt structure and the `<|SpawnThinking|>` delegation trigger

## Use it

- Mac: http://127.0.0.1:4520/
- Phone (tailnet only, HTTPS so the mic works): https://mikes-mac-mini.tail045cfd.ts.net:8452/

A LaunchAgent (`com.miketaglione.dash-kit`) keeps the server running. `scripts/install-launchagent.sh` installs or restarts it and adds the Tailscale route; `scripts/install-launchagent.sh remove` takes both down.

To run it by hand instead: `npm install`, then `PORT=4520 node server.mjs`.

## The screen

- **Left: prompts.** Voice agent (GPT-Live `instructions`, voice, greeting, acknowledgement delay), delegation agent (orchestrator prompt, model, effort, routing), subagents (prompt, engine, model, web search, progress). Voice changes apply to the next call (GPT-Live fixes `instructions` at startup). Orchestrator and subagent changes apply on their next turn.
- **Center: conversation.** Speech turns, delegation rows, orchestrator steps, subagent cards with live progress and a Stop button, and every append to GPT-Live with its acknowledgement time.
- **Right: timeline.** A sequence diagram with five lanes (You, App, GPT-Live, Orchestrator, Subagents); one arrow per event. Click a row for the raw event.
- **Composer.** Send a `session.thinking.append` (silent context), `session.commentary.append` (spoken update) or `session.instructions.append` (instruction) as if the delegation agent sent it, for the latest delegation, a chosen one, or as general session context. Presets cover cancelling the acknowledgement, fake results, quiet progress, and "stop talking". The "Typed request" tab sends text straight to the orchestrator.
- **Top bar.** Start call / Hang up, sideband mic mute (`session.input_audio.mute`), level meters, billed seconds, New run, Export log.

Each run is also saved to `data/runs/<run>.jsonl`. Settings are saved in `data/settings.json`.

## How a delegation flows

1. GPT-Live emits `session.delegation.created` (metadata only, no task text).
2. The server waits `graceMs` for trailing transcript, then gives the orchestrator the new transcript turns and the subagent list.
3. The orchestrator calls `start_subagent`, `message_subagent`, `stop_subagent`, or `tell_voice`.
4. Subagent progress goes to GPT-Live as silent context (rate-limited); the result goes as a spoken update with the original `delegation_id`. With routing set to "Through the orchestrator", the result goes to the orchestrator instead and it decides what GPT-Live hears.

## Tests

- `npm test`: unit and integration tests with a fake sideband and scripted Responses client (no API cost).
- `node scripts/e2e-call.mjs`: a real call. Headless Chromium plays a synthesized spoken request as its microphone ("look up the current weather in Boston"), and the script waits for the delegation, the subagent result, the spoken reply, two composer presets, and `session.closed`. Costs about 25 voice seconds plus a few backend calls.
