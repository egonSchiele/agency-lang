# Wiring Agency's speech support to smoltalk's new audio API

## What this is

smoltalk PR #36 (`audio-stt-tts`) adds three audio capabilities to smoltalk: speech-to-text
(`transcribe`), text-to-speech (`speak`), and audio parts inside chat messages (`audioPart`).
This document plans the Agency-side changes needed to leverage them, so Agency gets cloud
speech through the same machinery that already gives `std::image` its cost accounting, spend
guards, and statelog tracing — instead of Agency hand-rolling anything new.

The guiding principle, decided earlier: **smoltalk owns the capability, Agency is a thin
wrapper.** This mirrors exactly how `std::image.generateImage` wraps `smoltalk.image()` today
(see `lib/stdlib/image.ts`).

## Background: what smoltalk PR #36 gives us

Three new public exports from smoltalk (`packages/smoltalk/lib/index.ts` on the branch):

1. **`transcribe(source, opts): Promise<Result<TranscriptionResult>>`** — speech-to-text.
   - `source` is a `BlobRef` (a `{kind}` union: `bytes` / `base64` / `path` / `url`).
   - `opts`: `{ model, provider?, apiKey?, language?, prompt?, timestampGranularity?, maxBytes?, filename? }`.
   - Returns `{ text, language?, durationSeconds?, segments?, words?, usage?, cost?, raw? }`.
   - v1 supports only OpenAI `whisper-1`. Priced **per minute**.
   - Never throws — always resolves to a `Result` with the secret redacted from any error.

2. **`speak(text, opts): Promise<Result<SpeechResult>>`** — text-to-speech.
   - `opts`: `{ model, voice, provider?, apiKey?, format?, speed? }`. `voice` is required.
   - Returns `{ audio: Uint8Array, mimeType, pcm?, cost?, raw? }`.
   - v1 supports only OpenAI `tts-1` / `tts-1-hd`. Formats mp3/opus/aac/flac/wav/pcm (default mp3),
     speed 0.25–4.0, 4096 code-point input cap. Priced **per character**.
   - Never throws — same redacting boundary as `transcribe`.

3. **`audioPart(source, {filename?}): AudioPart`** — audio inside a user message.
   - Rendered as an OpenAI Chat Completions `input_audio` part.
   - Gated to `provider: "openai"` **and** a model that positively declares audio input — in v1
     only `gpt-audio-1.5`. Every other provider/model is rejected before serialization.

Supporting changes in smoltalk that we inherit for free: `TokenUsage` gained
`inputAudioTokens` / `outputAudioTokens`, and `Model.calculateCost` now prices audio-token
buckets and is provider-aware. Agency's cost types (`smoltalk.CostEstimate`, `smoltalk.TokenUsage`,
which we already re-export) pick these up automatically.

## Where Agency stands today

`std::speech` (`stdlib/speech.agency` + `lib/stdlib/speech.ts`) has three functions:

- **`speak(text, ...)`** — plays audio through the speakers using the macOS `say` command.
  This is **local playback**, macOS-only. It is NOT cloud TTS. Name collision incoming (see below).
- **`transcribe(filepath, ...)`** — speech-to-text via a **direct `fetch`** to OpenAI's
  `/v1/audio/transcriptions` endpoint (`lib/stdlib/speech.ts:218`). Hardcoded to `whisper-1`,
  needs `OPENAI_API_KEY`. This bypasses all of Agency's cost/guard/statelog machinery — it is
  exactly the "hitting an API outside smoltalk, so no cost accounting" gap we discussed.
- **`record(...)`** — captures microphone audio with SoX (`rec`). Local device I/O; no smoltalk
  equivalent exists or should. **Unchanged by this work.**

The reference pattern to copy is `std::image`:

- `stdlib/image.agency` declares `generateImage(...)` which calls `_generateImage(...)`.
- `lib/stdlib/image.ts:34` routes through `ctx.llmClient.image!(...)` via `meteredDispatch`,
  then on success calls `recordUsage(...)` (cost + tokens), `addTokens(...)`, emits a
  `statelogClient.imageGeneration(...)` event, and calls `stack.enforceGuards()` **last**.
- The `image?()` method is an **optional** member of the `LLMClient` interface
  (`lib/runtime/llmClient.ts:137`); clients that don't support it omit it and the wrapper
  surfaces a failure `Result`.

Everything below applies that same shape to transcribe and speak.

---

## The six pieces of work

### 1. The two new capabilities: where they live and what they're called

**Speech-to-text (transcribe).** Re-back the existing `std::speech.transcribe` onto
smoltalk's `transcribe()` instead of the direct `fetch`. Same OpenAI/whisper-1 behavior as
today (no capability regression), but now it flows through the LLM client and gains cost,
guards, and statelog. The public Agency signature stays; we add optional `model` / `provider`
params so it isn't permanently pinned to whisper-1 once smoltalk grows more providers.

The one behavioral note: today's `transcribe` reads the file itself and needs
`OPENAI_API_KEY` in the environment. smoltalk's `transcribe` takes a `BlobRef` and does the
I/O + key resolution. We pass `{ kind: "path", path: resolvedPath }` (after the existing
`resolveDir` allow-list check, which we keep — that is Agency's safety layer, not smoltalk's).

**Text-to-speech (speak) — DECIDED (breaking rename).** smoltalk calls its cloud TTS `speak`,
and we want Agency to use that same name for the cloud capability. Agency's current `speak`
means "play through the macOS speakers" — a different capability. Agency has **no users yet**,
so we take the clean breaking change:

- **Rename the current local-playback `speak` → `say`.** Same macOS `say` implementation
  (`lib/stdlib/speech.ts:22` `speakImpl`), just exposed under the name `say`. Its interrupt
  effect becomes **`std::say`**.
- **Introduce a new cloud-TTS `speak(text, ...) -> string`** backed by `smoltalk.speak()`, which
  writes the audio to a file and returns the path (symmetric with `record`/`transcribe(path)`).
  It **reuses the existing `std::speak` effect** with an approval prompt ("send this text to a
  cloud TTS API?").

No backwards compatibility, no deprecation shims — the old `__internal_speak` migration wrapper
can be renamed/updated in place too.

After this, the `std::speech` module has: `say` (local playback), `record` (unchanged, local
mic capture), `transcribe` (re-backed onto smoltalk), `speak` (new, cloud TTS), and `audio()`
lives in `std::thread` (see piece 4).

**Interrupts stay.** `transcribe` keeps its `std::transcribe` effect; local `say` gets the
renamed `std::say` effect; cloud `speak` reuses `std::speak`. Interrupts are safety
infrastructure and must not be dropped when we rename or re-back
(CLAUDE.md, `critical_handlers`). Each interrupt fires **before** the underlying call, unchanged.

**Runtime helpers** (`lib/stdlib/speech.ts`), mirroring `_generateImage`:

- `_transcribe(...)` is rewritten to call `ctx.llmClient.transcribe!(...)` via `meteredDispatch`,
  then `recordUsage` / `addTokens` / statelog / `enforceGuards` on success. The old
  `transcribeImpl` direct-fetch body is deleted.
- `_synthesize(...)` is new, same structure, calling `ctx.llmClient.speak!(...)`, then writing
  `result.audio` to the resolved output path.
- Both surface a clear failure `Result` when the active client lacks the method (exactly like
  `lib/stdlib/image.ts:45`).

### 2. Getting the cost into the running total

This falls out of the wrapper for free, because smoltalk's `TranscriptionResult` and
`SpeechResult` both carry `cost?: CostEstimate` (and transcribe carries `usage?: TokenUsage`).
Each helper does what `_generateImage` does at `lib/stdlib/image.ts:91`:

```
recordUsage(ctx, stack, {
  type: "provider",
  kind: <"transcription" | "speech">,
  reportedModel: result.model-ish,
  configuredModel: model,
  cost: result.cost,
  tokens: result.usage,   // undefined for TTS; that's fine
});
addTokens(result.usage?.totalTokens ?? 0);
stack.enforceGuards();     // LAST, so a spend-guard trip still leaves spend accounted
```

**The one structural change this needs:** `ProviderUsageKind` in
`lib/runtime/invocationUsage.ts:24` is currently `"completion" | "embedding" | "image"`. Add
`"transcription"` and `"speech"`. `meteredDispatch` and `recordUnresolvedAttempt` take a
`kind`, so the new kinds flow through unchanged. **To verify during implementation:** the
invocation-usage accounting seam (`docs/dev/invocation-usage-accounting.md`) has
"kind-specific-token rules" — confirm adding kinds with per-minute (STT) and per-character
(TTS) pricing and possibly-absent tokens doesn't trip an assertion there, and that
`agency remote spend`'s schema/rendering tolerates the new kinds. TTS has no tokens at all
(per-character price only), so `addTokens(0)` and a cost-only observation must be a valid shape.

Cost is only recorded **on success**, never on a failed call — same rule as image
(`lib/stdlib/image.ts:75`).

### 3. Observability / statelog

`std::image` emits a dedicated `imageGeneration` statelog event
(`lib/statelogClient.ts:660`). Add two siblings:

- **`transcription`** — fields: model, `durationSeconds`, `timeTaken`, `usage`, `cost`, and a
  short **preview of the transcript text** (mirroring `imageGeneration`'s `promptPreview`
  slice, capped at `PROMPT_PREVIEW_MAX`). Never log the audio bytes.
- **`speechSynthesis`** — fields: model, voice, format, `timeTaken`, `cost`, and a short
  **preview of the input text**. Never log the audio bytes.

Two notes:

- **Transcript preview — DECIDED: capped text preview.** Both events log a `PROMPT_PREVIEW_MAX`
  slice of the text (transcript for STT, input text for TTS), consistent with
  `imageGeneration`'s `promptPreview`. Audio bytes are never logged.
- **Logs viewer.** The viewer infers span labels from event `type`
  (`lib/logsViewer/tree.ts#inferSpanLabel`, called out in `lib/statelogClient.ts` comments). New
  event types need a label there or they render as a generic span. Small addition, but must not
  be forgotten.

### 4. Audio parts in chat messages

This is smaller than it first sounds, because smoltalk does all the rendering and gating.
Agency already builds image/file message parts declaratively: `std::thread` exposes `image()`
and `file()`, backed by `_imageAttachment` / `_fileAttachment` in `lib/stdlib/thread.ts:216`,
which just return plain `{type, source}` objects that flow straight into
`smoltalk.userMessage([...])`. smoltalk does the I/O and, now, the audio rendering + model
gating.

So the audio path is a parallel addition:

- Add `_audioAttachment(source, filename, mimeType, base64)` in `lib/stdlib/thread.ts`,
  returning `{ type: "audio", source: classifySource(...), filename? }`. `classifySource`
  already produces `path` / `url` / `base64` sources, all of which are valid `BlobRef` arms —
  and smoltalk's `AudioPart.source` is deliberately a `BlobRef` (no `providerFile`), so there's
  nothing to exclude.
- Expose `audio()` in `stdlib/thread.agency` next to `image()` / `file()`, and add an `audio`
  arm to the `Attachment` union that `llm()`'s typechecker signature references (the comment at
  `lib/stdlib/thread.ts:163` flags this contract; the `tests/agency-js/multimodal-attachments`
  fixture guards it).

**Scoping — DECIDED: include now.** Audio-in-chat ships in this first cut as a parallel to the
image path. It is gated to `gpt-audio-1.5` in smoltalk v1, so reach is narrow today, but the
addition is cheap (a near-copy of `_imageAttachment`) and keeps the multimodal surface complete.

### 5. Changes to the `LLMClient` interface

`lib/runtime/llmClient.ts` is the pluggable transport Agency exposes so people can bring their
own LLM backend instead of smoltalk. We extend it the same way `image?()` was added
(`lib/runtime/llmClient.ts:137`):

- **Re-export smoltalk's audio types** as the single Agency-side surface (mirroring the
  `ImageConfig` / `ImageGenResult` / `ImageInput` re-exports at `lib/runtime/llmClient.ts:72`):
  `TranscribeConfig` (= `smoltalk.TranscribeOptions`), `TranscriptionResult`, `SpeakConfig`
  (= `smoltalk.SpeakOptions`), `SpeechResult`, and an `AudioInput` alias for `BlobRef`. Wrapper
  code and custom-client authors import these from `llmClient.ts`, never from smoltalk directly.
- **Add two optional methods:**
  ```
  transcribe?(source: AudioInput, config?: Partial<TranscribeConfig>): Promise<Result<TranscriptionResult>>;
  speak?(text: string, config?: Partial<SpeakConfig>): Promise<Result<SpeechResult>>;
  ```
  Optional, so any client that doesn't do audio simply omits them and the `std::speech` wrapper
  returns a failure `Result` (same contract as `image`).
- **`SmoltalkClient` implements both** by delegating to `smoltalk.transcribe` / `smoltalk.speak`
  with a sensible default model filled in (mirroring `image()` at `lib/runtime/llmClient.ts:169`,
  which injects `DEFAULT_IMAGE_MODEL`). We'll add `DEFAULT_TRANSCRIBE_MODEL = "whisper-1"` and
  `DEFAULT_SPEECH_MODEL = "tts-1"` to `lib/constants.ts`. `speak` needs a default `voice` too,
  since smoltalk requires it.

`normalizeError` needs no change — it already handles arbitrary thrown errors, and smoltalk's
`transcribe`/`speak` don't throw anyway (they return failure `Result`s).

### 6. The other `LLMClient` implementations

There are two besides `SmoltalkClient`:

- **`DeterministicClient`** (`lib/runtime/deterministicClient.ts:102`) — the test client. It
  already implements `image()` returning fixed PNG bytes + a fixed cost so tests can exercise
  the image path offline (`:267`). We add analogous fixed `transcribe()` (returns a fixed
  transcript string + fixed per-minute cost) and `speak()` (returns fixed audio bytes + fixed
  per-character cost), so Agency execution tests can exercise STT/TTS cost, guards, and statelog
  **without any network call**. This is required for testing the wrapper.
- **`SimpleOpenAIClient`** (`lib/runtime/simpleOpenAIClient.ts:12`) — the minimal client used for
  local models by the Agency agent. It already omits `image()` (the method is optional). Local
  models don't do cloud audio, so it **omits `transcribe`/`speak` too** — no change required,
  and `std::speech` will surface a clean "this client doesn't support transcription" failure if
  someone tries. (If you later want local-model transcription via a Whisper endpoint, that's a
  separate opt-in.)

---

## What is explicitly out of scope

- `record` (SoX mic capture) — untouched. Local playback (macOS `say`) is unchanged in behavior,
  only renamed from `speak` to `say`.
- Any non-OpenAI speech provider — smoltalk v1 is OpenAI-only; Agency inherits that limit and
  adds nothing.
- Streaming STT/TTS, translation, assistant audio *output* in chat — all deferred in smoltalk v1.

## Rough sequencing

1. `LLMClient` interface: re-export types, add optional `transcribe`/`speak`, implement in
   `SmoltalkClient`, add default-model constants. (No behavior change yet.)
2. `ProviderUsageKind` += `transcription`/`speech`; verify the accounting/spend seam.
3. Statelog: `transcription` + `speechSynthesis` events + viewer labels.
4. Runtime helpers: rewrite `_transcribe` onto the client; add cloud-TTS `_speak`; rename the
   old local-playback helper to `_say`. Delete the direct-fetch transcribe body.
5. `stdlib/speech.agency`: rename local `speak` → `say` (effect `std::say`), re-back
   `transcribe`, add cloud `speak` (reusing effect `std::speak`).
6. `DeterministicClient`: fixed `transcribe`/`speak` for tests.
7. Audio-in-chat: `_audioAttachment` + `std::thread.audio()` + typechecker union arm +
   multimodal fixture.
8. Tests: Agency execution tests (`tests/agency/`) for cost/guard/statelog on transcribe +
   speak, using the deterministic client (no LLM calls needed).
9. Dev note under `docs/dev/` for the re-backed speech path + CLAUDE.md pointer.

## Resolved decisions

1. **Naming:** local playback renamed `speak` → `say` (effect `std::say`); cloud TTS takes the
   `speak` name (reuses effect `std::speak`) and returns a file path. Breaking change accepted —
   no users yet, no backwards compatibility.
2. **Audio-in-chat:** included in this first cut.
3. **Statelog:** capped text preview (`PROMPT_PREVIEW_MAX`), consistent with `imageGeneration`;
   audio bytes never logged.
