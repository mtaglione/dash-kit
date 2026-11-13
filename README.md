# Dash Kit

A test bench for GPT-Live client delegation. You talk to GPT-Live in the browser over WebRTC, and one screen shows everything that happens: your speech, the voice model's replies, each delegation, the orchestrator's decisions, every subagent, and every event sent back to GPT-Live.

Everything runs on one provider, chosen in `.env`: the OpenAI platform with a project key, or an Azure AI Foundry resource with its endpoint and key.

| Part | What runs it |
| --- | --- |
| Voice | GPT-Live (`gpt-live-1`) with `delegation: { type: "client" }`, browser WebRTC |
| App | `server.mjs`: creates the session, attaches a sideband WebSocket, owns every context append |
| Orchestrator (delegation agent) | Responses API model (default `gpt-6-luna`) with four function tools |
| Subagents | One Responses API conversation each (web search on), or a free mock engine |

Built from OpenAI's GPT-Live documentation:

- [Getting started](https://developers.openai.com/api/docs/guides/live)
- [WebRTC quickstart](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live): browser offer, `POST /v1/live/sessions`, `oai-events` data channel, graceful `session.close`
- [Server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live): sideband at `wss://api.openai.com/v1/live/sessions/{id}/attach`, 3-second replay, dedupe by `event_id`
- [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client): transcript-built requests, `delegation_id`, the three append events, acknowledgement suppression
- [Managing sessions](https://developers.openai.com/api/docs/guides/live-conversations): config fields, greeting, transcripts, usage and close
- [Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting): prompt structure and the `<|SpawnThinking|>` delegation trigger

## Run it

1. `npm install`
2. `cp .env.example .env` and set the provider:
   - OpenAI: `OPENAI_API_KEY`, a project key with GPT-Live access.
   - Azure AI Foundry: `FOUNDRY_ENDPOINT` and `FOUNDRY_API_KEY`. With both set, the voice session, the orchestrator and the subagents all run on that resource and the OpenAI key is not used. The resource needs a `gpt-live-1` deployment. Set `BACKEND_MODELS` to the deployment names the orchestrator and subagents may use (the first is the default); a saved model outside that list is replaced by the first one.
3. `npm start`, then open http://localhost:4520/

Browsers only allow the microphone on HTTPS or localhost. To use it from another device, put an HTTPS reverse proxy in front that keeps the `Host` header. `PORT` and `HOST` in `.env` change where the server listens (default `127.0.0.1:4520`).

## The screen

- **Left: prompts.** Voice agent (GPT-Live `instructions`, voice, greeting, acknowledgement delay, hang up after silence), delegation agent (orchestrator prompt, model, effort, routing), subagents (prompt, engine, model, web search, progress). Voice changes apply to the next call (GPT-Live fixes `instructions` at startup). Orchestrator and subagent changes apply on their next turn.
- **Center: call log.** One block per call, and inside it one block per request (a delegation or a typed request) holding every step that request caused, with the time since the request began: the orchestrator's turn in plain words (what it was given and its raw answer open on a tap), what was started or sent, a subagent's progress and result, and every append to GPT-Live with its acknowledgement time. Speech turns sit between the request blocks. Each call lists its sessions at the top with their state and a Stop button. The bar above the log has **Errors only**, **All rows** (also shows sounds with no words, saved settings and other low-level rows), **Export**, and **Clear log**: with no call up it starts a new run; during a call it keeps the call in progress and removes everything before it. Nothing is deleted from `data/runs`.
- **Right: timeline**, in two views:
  - **Overlay** (default). One track per call, drawn to scale on the call's own clock, with time running down. Three things share that clock: speech (a block per transcript turn, in a "You" and a "Kit" lane), audio (the level each side actually had, as a strip beside its lane), and messages (every delegation, append, typed request, orchestrator step and subagent result, as a marker at the moment it landed, with a line across the speech lanes). Orchestrator turns and subagent runs are bars beside the markers. A stretch with no speech, sound or messages is folded and labelled with its length. Tap anything for its exact times and what was being said when it landed. Zoom changes the scale.
  - **Sequence.** A sequence diagram with five lanes (You, App, GPT-Live, Orchestrator, Subagents); one arrow per event, in order, on the run clock. Click a row for the raw event.
- **Composer.** Send a `session.thinking.append` (silent context), `session.commentary.append` (spoken update) or `session.instructions.append` (instruction) as if the delegation agent sent it, for the latest delegation, a chosen one, or as general session context. Presets cover cancelling the acknowledgement, fake results, quiet progress, and "stop talking". The "Typed request" tab sends text straight to the orchestrator.
- **Top bar.** Start call / Hang up, sideband mic mute (`session.input_audio.mute`), level meters, billed seconds.

Each run is also saved to `data/runs/<run>.jsonl`. Settings are saved in `data/settings.json`.

## Idle hang-up

A connected call is billed for every second, whether or not anyone speaks. The server closes a call after "Hang up after silence" minutes (default 5) with no speech from either side, no delegation and nothing sent to the voice. It never closes a call while the orchestrator or a subagent is working; the limit starts again when the work ends. Set it to 0 to turn it off. The setting is read while a call runs, so a change applies at once.

## How the overlay keeps one clock

GPT-Live reports speech, delegations and accepted appends on the session's own timeline (`start_ms`, `end_ms`, `offset_ms`), so those are placed exactly. Events that only have a wall-clock time (orchestrator steps, subagent progress, typed requests, audio levels) are placed through the append acknowledgements, each of which gives both clocks for the same moment. Audio levels are measured in the browser that is on the call (the loudest reading per 200 ms for the microphone and for GPT-Live's output) and sent to the server as `client.audio.levels` events, so they are in the run log and show up for anyone watching. A call with no append acknowledged yet is placed from the time the session was created.

## How a delegation flows

1. GPT-Live emits `session.delegation.created` (metadata only, no task text).
2. The server waits `graceMs` for trailing transcript, then gives the orchestrator the new transcript turns and the subagent list.
3. The orchestrator calls `start_subagent`, `message_subagent`, `stop_subagent`, or `tell_voice`.
4. Subagent progress goes to GPT-Live as silent context (rate-limited); the result goes as a spoken update with the original `delegation_id`. With routing set to "Through the orchestrator", the result goes to the orchestrator instead and it decides what GPT-Live hears.

## Boosker mode

With a Boosker checkout on the same machine, a call can run through the Boosker broker's own code instead of Dash Kit's orchestrator and subagents. A browser call then behaves like a call from the phone, and a change to the broker can be tried here before it is deployed.

It is one switch, **Boosker**, in the top bar. The server looks for the checkout in `BOOSKER_DIR`, or in a `Boosker` folder beside this one.

With the switch on, the same three tabs hold Boosker's prompts, and the settings a Boosker call does not use are greyed out:

| Tab | Holds, in Boosker mode | What runs |
| --- | --- | --- |
| Voice agent | Boosker's voice prompt: the app's default agent prompt (read from `Shared/AgentProfile.swift`), then the paragraph the broker adds. Voice, greeting, acknowledgement and hang-up settings apply as usual. | GPT-Live, as before. |
| Delegation agent | The dispatcher's prompt, and the wait for captions. | The broker's call handler (`backend/live-agent.mjs`, unchanged) and its dispatcher (`backend/dispatcher.mjs`), a real `claude` process. |
| Subagents | The instruction added to a lookup. A session gets the request as it was spoken. | Real Claude sessions through the Boosker session host, and real one-shot lookups. They do real work on this machine, with the permissions a phone call has, and keep running after a hang-up. |

Boosker's prompts are kept apart from Dash Kit's own: switching off brings Dash Kit's back. A Boosker prompt edited here is used for test calls only and is marked "edited here"; one left alone keeps following the Boosker folder, and "Reload from Boosker" on a tab puts that tab's values back.

The handler shares Dash Kit's sideband, so every message it sends to GPT-Live appears in the thread and the timeline with its acknowledgement time, marked with the session it came from. Dispatcher turns show what the dispatcher was given and its answer. The call's Claude sessions are listed at the top of its block: the dispatcher's own session first (the Boosker code registers it with Remote Control as "Dash Kit dispatcher · <date and time>", so it is in the Claude session list like any other session), then each agent session and lookup (`s1`, `s2`… are the dispatcher's own names; `l1`… are lookups). Each row has an **Open in Claude** link once Claude has given the session an address. A typed request takes the path a spoken one takes.

Broker code is read when this server starts, so restart it after changing the Boosker folder. The server needs the `claude` program on its `PATH`, or `CLAUDE_BIN` set.

Not covered: file cards on the phone, the Watch audio path, and the question list. An agent prompt edited on the phone is stored only there; paste it into the Voice agent tab to test it.

## Tests

- `npm test`: unit and integration tests with a fake sideband and scripted Responses client (no API cost). When a Boosker checkout sits beside this folder, one test runs the real Boosker call handler through the shared sideband.
- `node scripts/e2e-call.mjs`: a real call. Headless Chromium plays a synthesized spoken request as its microphone ("look up the current weather in Boston"), and the script waits for the delegation, the subagent result, the spoken reply, two composer presets, and `session.closed`. Costs about 25 voice seconds plus a few backend calls.
