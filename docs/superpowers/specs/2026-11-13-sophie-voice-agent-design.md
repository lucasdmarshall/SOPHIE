# SOPHIE — Voice + Gesture Agent (v2) Design

Date: 2026-11-13
Status: Draft for discussion
Builds on: `2026-11-11-sophie-gesture-control-design.md` (v1 explicitly deferred voice,
LLM agent features and the HUD; this document picks them up).

## 1. Goal

Turn SOPHIE from a gesture mouse into a JARVIS-style desktop assistant:
**point with a hand, speak in English, and get an answer or an action fast.**

The product bet (from market research, 2026-11-12):

- Webcam gesture mice are crowded and mostly free or under $10.
- "Point at the screen and ask AI" tools exist (AIPointer, Pointer AI, VoiceOS), but they
  point with the mouse cursor and a hotkey, not with a webcam-tracked hand.
- No polished Windows product was found that fuses webcam pointing + voice + an agent with
  tools. GitHub has many hobby "JARVIS" demos; none reached product quality.
- So the moat is not the idea; it is **latency, stability and polish**.

## 2. Decisions so far

| Decision | Choice | Reason |
|---|---|---|
| First voice language | English | Mature, fast local STT; largest early-adopter market |
| Gesture layer | Existing SOPHIE engine + adaptive stabilizer | Already built |
| Tools | Hirara (`lucasdmarshall/hirara`) subset + new `sophie-desktop` tools | Reuse own work |
| Long-term memory | Gyrfalcon (`lucasdmarshall/gyrfalcon`) embedded as a Rust crate | 2.7 ms p50 query, no server, same language as the Tauri backend |
| LLM hosting | Cloud, behind a pluggable provider interface (§4.6) | Lowest latency and best quality now; a local provider can be added later without touching the router or tools |

## 3. Latency budget

Target: speech end → first audible reply **under ~1 s**; reflex commands **under ~300 ms**.
These are targets, not measurements. Every request must log the timeline in §8 so the
claim can be checked.

| Stage | Target | Notes |
|---|---|---|
| End-of-speech detection (VAD) | 200–300 ms | Largest hidden cost; tune silence window |
| STT final text | 100–200 ms | Stream during speech; only the tail remains |
| Reflex match (no LLM) | < 20 ms | Grammar over the final or partial transcript |
| LLM first token | 200–400 ms | Context pre-built while the user is still speaking |
| TTS first audio | 100–300 ms | Speak the first sentence while the rest streams |

Perceived-latency rule: the HUD acknowledges within one frame of speech end
(listening → thinking animation + soft sound), before any model answers.

## 4. Architecture

```
Webcam ─► MediaPipe (TS) ─► Rust gesture engine ─► SendInput        (exists)
                                  │
                                  ▼ pointed screen point + pose
Mic ─► VAD ─► streaming STT ─► Intent router ─┬─► Reflex executor ──► sophie-desktop tools
                                              │
                    Context builder ◄─────────┤
                    (UIA element, window,     └─► Agent loop (LLM) ─► tools (sophie-desktop,
                     session, Gyrfalcon)               │                Hirara subset, memory)
                                                       ▼
                                             TTS ─► speaker      HUD overlay (Tauri window)
```

### 4.1 Three response tiers

1. **Reflex** — fixed grammar, no model: "volume up", "next track", "move this to the left
   screen", "open Spotify", "close this". Target < 300 ms end to end.
2. **Fast agent** — small, fast model for questions about the pointed element and for
   choosing a tool. Most requests land here.
3. **Deep agent** — larger model for multi-step or research work. Runs in the background;
   the HUD shows progress and SOPHIE speaks when done.

The router tries Reflex on partial transcripts so simple commands can start before
the end of speech is detected.

### 4.2 Context is built before the user stops speaking

When listening starts, SOPHIE freezes the pointed screen point and in parallel collects:

- **Working context:** Windows UI Automation element under the point (name, control
  type, value / text pattern), its window title and process name. Text, not pixels: faster
  and cheaper than a screenshot. Fallback: a cropped screenshot sent to a vision model
  only when UIA returns nothing useful (games, canvases, video).
- **Session context:** the last few turns of this conversation.
- **Long-term memory:** Gyrfalcon search over the user's notes, saved facts and past
  interactions, queried with the partial transcript.

### 4.3 Tools

- **`sophie-desktop` (new, Rust):** window move / snap / minimize / close, monitor
  targeting, app launch, media keys, volume, UIA invoke (click a named element), type
  text, clipboard read/write. Built on the existing `input.rs` and the `windows` crate.
- **Hirara subset:** `web_search` / `web_fetch`, `pdf_read`, `ocr_read`, `office_read`,
  `schedule`, `memory`, `time_now`, `date_calc`. Allowlist only.
  Excluded for a voice-driven consumer agent: network probing tools (`port_scan`,
  `directory_enum`, `service_enum`, …), raw `http_request`, `file_delete`, `execute_code`.
- **Packaging problem:** Hirara currently expects a self-hosted hub (Docker, SearXNG).
  A paying user cannot be asked to run Docker. Options: (a) bundle the pure-Python local
  tools as a sidecar, (b) port the needed subset to Rust (`hirara-connectors` is already
  Rust), (c) hosted search behind SOPHIE's own service. Decide before M2.

### 4.4 Safety and confirmation

Any tool with side effects outside SOPHIE (closing apps, writing files, sending anything,
clicking UIA elements chosen by the model) requires confirmation. Confirmation is a
**thumbs-up gesture** (or "yes"); thumbs-down / "no" cancels. Read-only tools need none.
Model output and web content are data and never grant permissions.

### 4.6 LLM provider (cloud, pluggable)

A Rust `LlmProvider` trait owns one streaming call: `(system, messages, tools) ->`
stream of text deltas, tool calls and a final usage record. The router, context builder,
tools and HUD only see this trait.

First implementation: Anthropic Messages API, called from Rust over HTTPS with SSE
streaming (there is no official Rust SDK, so raw HTTP is the documented route).

| Tier | Proposed model | Price (input / output per 1M tokens) | Settings |
|---|---|---|---|
| Fast | `claude-haiku-5-5` | $0.10 / $0.50 (up to 100K-token prompts) | Streaming; effort `low` for voice turns |
| Deep | `claude-opus-5-5` | $4 / $20 | Streaming; adaptive thinking; effort `medium` default, raised per task |

Model choice per tier is a setting, not code, and is confirmed by measuring the §8
timeline and answer quality on the user's PC before M1 is called done.

Rough fast-tier cost: a ~3K-token prompt with a ~200-token reply is about $0.0004, so
100 voice turns a day is roughly $1 a month. This supports a cheap subscription or a
bring-your-own-key mode.

Low time-to-first-token rules:
- Always stream; start TTS on the first complete sentence.
- **Prompt caching:** tools and the frozen system prompt first, behind a cache
  breakpoint; volatile context (pointed element text, time, memory snippets) after it.
  Never put timestamps or IDs in the system prompt. Check `cache_read_input_tokens`.
- **Pre-warm on push-to-talk down:** send a cache pre-warm request while the user is
  still speaking, so the real request hits a warm cache.
- Keep the fast tier's tool list small and fixed; deep-tier tools load only there.
- Handle `refusal` and `max_tokens` stop reasons before running any tool.
- The API key is stored with Windows Credential Manager, never in plain config files.

### 4.7 Privacy

Hand tracking and audio stay local. Only the transcript, the UIA text of the pointed
element and retrieved memory snippets are sent to a cloud model, and only after the
user speaks to SOPHIE. Screenshots are sent only in the vision fallback. A visible HUD
state shows whenever the microphone is open.

## 5. Component candidates (to benchmark on the target PC, not trust from blogs)

| Stage | Candidates | Notes |
|---|---|---|
| VAD | Silero VAD (ONNX) | Small, CPU |
| STT | Moonshine (MIT, streaming-first), NVIDIA Parakeet TDT 0.6B, Nemotron streaming | Blog comparisons rank Parakeet best on English accuracy and Moonshine/Nemotron best for streaming; verify runtime (sherpa-onnx / ONNX Runtime) on Windows |
| TTS | Piper (fast), Kokoro (better voice, slower first audio), pocket-tts | Reported first-audio numbers disagree widely; measure |
| LLM | `claude-haiku-5-5` (fast), `claude-opus-5-5` (deep) | §4.6; swappable |
| Memory | Gyrfalcon Lite tier | Embedded crate |

## 6. Activation

Milestone 1 uses **push-to-talk** (hold a hotkey, plus an optional "listening" hand pose
once one is chosen with the user) to avoid always-on wake-word false triggers.
Wake word ("Hey SOPHIE") is a later milestone.
The listening pose must not collide with Standard mappings: index = cursor,
index+middle = scroll, index+middle+ring = right click, pinch = click/drag.

## 7. Milestones

**M1 — "Point and ask" vertical slice**
- Push-to-talk, VAD, streaming STT, fast-tier LLM, TTS, minimal HUD (listening /
  thinking / answer card near the pointed spot).
- UIA working context; no tools except reading context.
- Latency timeline logging (§8).
- Done when: pointing at a paragraph and asking "what does this mean?" answers aloud,
  with logged p50 speech-end → first audio under 1 s on the user's PC.

**M2 — Reflex + desktop tools**
- Reflex grammar, `sophie-desktop` tools, thumbs-up confirmation.
- Done when: "move this to the left screen" while pointing at a window works under
  300 ms p50, and destructive actions always ask first.

**M3 — Memory + Hirara tools**
- Gyrfalcon long-term memory ("remember that…", recall), Hirara allowlisted tools,
  deep-agent background tasks with HUD progress.

**M4 — Product**
- Wake word, onboarding, licensing, code signing, updater, demo video, waitlist.

## 8. Instrumentation

Per request, log monotonic timestamps: `ptt_down`, `speech_start`, `speech_end_detected`,
`stt_final`, `route_decided`, `context_ready`, `llm_first_token`, `tts_first_audio`,
`action_done`. Show p50/p95 in the preview diagnostics panel. No latency claim in
marketing without these numbers.

## 9. Open questions

1. ~~LLM hosting~~ — decided 2026-11-13: cloud, pluggable (§4.6).
2. Listening hand pose (needs user testing, see §6).
3. Hirara packaging route (§4.3).
4. Pricing model: one-time base app + AI subscription vs. bring-your-own-key.
