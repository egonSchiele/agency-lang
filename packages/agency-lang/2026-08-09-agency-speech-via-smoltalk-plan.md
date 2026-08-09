# Wiring Agency's speech support to smoltalk's new audio API

> **Revision 4 (2026-08-09) — implementation supersedes the ABI-freeze decision.**
> During PR review the owner decided there is NO backwards compatibility to keep
> (Agency has no users), so the old `_speak` / `__internal_speak` /
> `__internal_record` runtime exports were **removed**, not preserved as aliases,
> and the frozen-ABI compatibility fixture was **not** built. Wherever this plan
> below still says to keep those aliases or add a frozen fixture (§11a, §12i, §15
> steps 2/7, §16), read it as REVERSED: `say()`→`_say`, cloud `speak()`→
> `_synthesizeSpeech`, `transcribe()`→`_transcribe`, and nothing is kept for
> old artifacts. Everything else in the plan stands.
>
> **Revision 3 (2026-08-09).** Rewritten after two plan reviews, an anti-pattern
> audit, and a mutation-sensitivity review of the test plan. The direction (thin
> wrapper over smoltalk) is unchanged. This revision closes the remaining
> decisions: request defaults have one owner, failure accounting follows one
> conservative rule, statelog kind changes are unconditional, TTS publishes
> atomically through an owned staging file, and every test names the seam and
> exact state transition it must prove.

## What this is

smoltalk PR #36 (`audio-stt-tts`) adds three audio capabilities to smoltalk: speech-to-text
(`transcribe`), text-to-speech (`speak`), and audio parts inside chat messages (`audioPart`).
This document plans the Agency-side changes needed to leverage them, so Agency gets cloud
speech through the same machinery that already gives `std::image` its cost accounting, spend
guards, and statelog tracing — instead of Agency hand-rolling anything new.

Guiding principle: **smoltalk owns the capability, Agency is a thin wrapper**, mirroring how
`std::image.generateImage` wraps `smoltalk.image()` (`lib/stdlib/image.ts`). Agency keeps only
what is genuinely Agency's job: the path allow-list, the approval interrupts, cost/guard
accounting, and statelog.

---

## 0. Coding and rollout gates *(R3)*

smoltalk PR #36 is still open and took architectural-rework requests on 2026-08-09. Aliasing
its option/result types into Agency's *public* `LLMClient` interface would freeze an unstable
contract. Audio coding may begin only after the **coding gate** is met and re-audited against
the *released* smoltalk declarations (not the current branch):

1. smoltalk #36 is merged and cut in a released version. Pinning that version is the first
   Agency implementation change, not a prerequisite that makes the gate circular.
2. The released `transcribe`/`speak` accept a **caller-supplied `AbortSignal`** (see §5 —
   cancellation is a hard requirement, and the current API has none).
3. Result **field names** (`cost`, `usage`, and any `model`/effective-model field), credential
   configuration (`apiKey` map shape), audio-token semantics, and cancellation distinguishability
   and abort-reason preservation are verified against the release. Failure provenance is useful
   when the release exposes it, but is not a gate: §6's conservative rule is correct without it.

The separate **emission/deployment gate** is: deploy the statelog migration/server before an
Agency release emits `transcription` or `speech`, and deploy Agency's strict spend parser before
it consumes responses containing those kinds. This rollout can be built and tested after the
coding gate; it does not block starting the implementation.

Until then this stays a plan. Nothing in Agency's public surface should reference the branch.

---

## 1. Background: what smoltalk PR #36 gives us (subject to the gate above)

Three new public exports (`packages/smoltalk/lib/index.ts` on the branch):

- **`transcribe(source, opts): Promise<Result<TranscriptionResult>>`** — STT. `source` is a
  `BlobRef` (`bytes`/`base64`/`path`/`url`). `opts`:
  `{ model, provider?, apiKey?, language?, prompt?, timestampGranularity?, maxBytes?, filename? }`.
  Returns `{ text, language?, durationSeconds?, segments?, words?, usage?, cost?, raw? }`.
  v1: OpenAI `whisper-1` only, priced **per minute**. **Never throws** — resolves to a failure
  `Result`, secret redacted.
- **`speak(text, opts): Promise<Result<SpeechResult>>`** — TTS. `opts`:
  `{ model, voice, provider?, apiKey?, format?, speed? }`, `voice` required. Returns
  `{ audio: Uint8Array, mimeType, pcm?, cost?, raw? }`. v1: OpenAI `tts-1`/`tts-1-hd`, formats
  mp3/opus/aac/flac/wav/pcm (default mp3), speed 0.25–4.0, 4096-code-point cap, priced **per
  character**. **Never throws.**
- **`audioPart(source, {filename?}): AudioPart`** — audio in a user message, rendered as OpenAI
  `input_audio`. Gated to `provider: "openai"` + a model that positively declares audio input
  (v1: only `gpt-audio-1.5`). Everything else rejected before serialization. `source` is a
  `BlobRef` (deliberately no `providerFile`).

Two facts that shape the plan:

- **Neither `transcribe` nor `speak` ever rejects** — both wrap the provider call in try/catch
  and resolve to a failure `Result`. This is the crux of §6.
- **`TranscriptionResult` / `SpeechResult` carry no `model` field** today — only `cost`/`usage`.
  This is the crux of §7.

---

## 2. Where Agency stands today

`std::speech` (`stdlib/speech.agency` + `lib/stdlib/speech.ts`):

- **`speak(text, …)`** — macOS `say` **local playback** (`lib/stdlib/speech.ts:22`). Effect
  `std::speak`. Not cloud TTS.
- **`transcribe(filepath, …): string`** — STT via a **direct `fetch`** to OpenAI
  (`lib/stdlib/speech.ts:218`), hardcoded `whisper-1`, needs `OPENAI_API_KEY`. Declared to
  return `string` and **throws** on failure (`stdlib/speech.agency:76`). Crucially, it threads
  `ctx.getAbortSignal(stack)` into `fetch`, so **Ctrl-C / race-loss / time-guard aborts the
  in-flight upload** (`:244-263`). Bypasses all cost/guard/statelog machinery.
- **`record(…): string`** — SoX mic capture. Local device I/O. **Unchanged by this work.**

Reference pattern (`std::image`): the `.agency` `generateImage(...)` is **declared to return a
`Result`** (`stdlib/image.agency:21`); `lib/stdlib/image.ts:34` routes through
`ctx.llmClient.image!(...)` via `meteredDispatch`, then on success `recordUsage` (cost+tokens),
`addTokens`, `statelogClient.imageGeneration(...)`, and `stack.enforceGuards()` **last**. The
method is **optional** on `LLMClient` (`lib/runtime/llmClient.ts:137`).

---

## 3. The `std::speech` surface after this change (naming + effects)

Decided earlier: cloud TTS should take the `speak` name. Agency has no users, so a breaking
rename is fine. But the effect must be handled carefully *(R1)*.

- **Rename local playback `speak` → `say`** (same macOS `say` impl). Its effect is renamed
  **`std::say`** with the same local-playback meaning.
- **New cloud TTS `speak(text, …)`** backed by `smoltalk.speak()`.
- **`transcribe`** re-backed onto `smoltalk.transcribe()`.
- **`record`** unchanged. **Audio-in-chat** lives in `std::thread` (see §9).

### 3a. Cloud effects must be NEW, never a repurposed local effect *(R1)*

The original plan reused the *identifier* `std::speak` for cloud TTS. That is a safety hole: a
non-interactive handler or a command-line policy that already approves `std::speak` (today:
local playback) would **silently begin authorizing text transmission to an external provider**.
Handlers match the effect contract, not the prompt string, so rewording the prompt protects
nobody. This is safety infrastructure (CLAUDE.md, `critical_handlers`), and "no users yet" does
not make it safe to change what an existing approval *means*.

Therefore:

- Local playback: **`std::say`** (payload `{ textLength }`), local only.
- Cloud TTS: a **brand-new** effect, e.g. **`std::synthesizeSpeech`**, payload
  `{ requestedProvider, configuredModel, textLength }`. It is a distinct capability an
  approver opts into separately.
- Cloud STT: keep **`std::transcribe`** but its payload/prompt must stop asserting the
  destination is necessarily OpenAI once `provider`/custom clients exist. Payload becomes
  `{ requestedProvider, configuredModel, filepath }`.

The interrupt fires **before** dispatch, as today. At that point Agency knows the requested
provider, which may be `""` (automatic), but a custom `LLMClient` still owns actual routing.
The prompt therefore says "the active cloud speech provider" rather than claiming a resolved
destination Agency does not know. If actual-destination approval becomes necessary later, add
a client target-resolution preflight and dispatch that immutable approved target; do not guess
with smoltalk-only rules. The interrupt is *not* the cancellation mechanism — see §5.

---

## 4. One public failure contract *(R4)*

The three claims in revision 1 (keep `transcribe`'s `string` signature; return a file-path
`string` from `speak`; surface failures as a `Result` like `std::image`) are mutually
incompatible: a `string`-declared function cannot return a `Result` object.

**Decision: both speech functions return their natural value and throw on failure**, matching
the rest of `std::speech` and the `std::fs` idiom. Their complete public Agency interfaces are:

```ts
effect std::transcribe {
  requestedProvider: string,
  configuredModel: string,
  filepath: string,
}
effect std::synthesizeSpeech {
  requestedProvider: string,
  configuredModel: string,
  textLength: number,
}

effect std::say { textLength: number }

export def say(
  text: string,
  voice: string = "",
  rate: number = 0,
  outputFile: string = "",
  allowedPaths: string[] = [],
) {
  return interrupt std::say("Allow local text-to-speech playback?", {
    textLength: text.length,
  })

  _say(text, voice, rate, outputFile, allowedPaths)
}

export def transcribe(
  filepath: string,
  language: string = "",
  allowedPaths: string[] = [],
  model: string = "whisper-1",
  provider: string = "",
  prompt: string = "",
  timestampGranularity: "" | "segment" | "word" = "",
  apiKey: string = "",
): string {
  if (model == "") {
    throw("transcribe model cannot be empty")
  }

  return interrupt std::transcribe("Send this audio to the active cloud speech provider?", {
    requestedProvider: provider,
    configuredModel: model,
    filepath: filepath,
  })

  return _transcribe(
    filepath,
    language,
    allowedPaths,
    model,
    provider,
    prompt,
    timestampGranularity,
    apiKey,
  )
}

export def speak(
  text: string,
  outputFile: string = "",
  voice: string = "alloy",
  model: string = "tts-1",
  provider: string = "",
  format: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm" = "mp3",
  speed: number = 1,
  allowedPaths: string[] = [],
  apiKey: string = "",
): string {
  if (model == "") {
    throw("speak model cannot be empty")
  }
  if (voice == "") {
    throw("speak voice cannot be empty")
  }

  return interrupt std::synthesizeSpeech("Send this text to the active cloud speech provider?", {
    requestedProvider: provider,
    configuredModel: model,
    textLength: text.length,
  })

  return _synthesizeSpeech(
    text,
    outputFile,
    voice,
    model,
    provider,
    format,
    speed,
    allowedPaths,
    apiKey,
  )
}
```

`say` is the exact renamed local-playback API. `transcribe` keeps its existing first three
positional parameters. Both cloud functions' defaults and non-empty required-value checks run
**once, before the interrupt**, so the effect payload and dispatch see identical values. The
runtime helpers receive complete required values; they do not apply another set of defaults.
When constructing released options, omit empty optional sentinels (`provider`, `language`,
`prompt`, timestamp granularity, and key) rather than forwarding empty strings. For v1, a
non-empty public `apiKey` maps exactly to `{ openAi: apiKey }`; smoltalk v1 is OpenAI-only.
A smoltalk failure `Result` becomes a thrown `Error` with its already-redacted message. We do
not adopt `std::image`'s `Result`-returning shape here.

This is also the declarative/imperative boundary. The `.agency` signatures declare defaults,
types, and approval effects; `LLMClient` declares two exact optional capabilities; each runtime
wrapper is a linear policy orchestration — **resolve → dispatch → account/trace → guards →
publish**. Smoltalk owns provider mechanics, while the focused `publishSpeechOutput` helper owns
imperative file staging and commit. Callers do not reproduce those steps. Do not introduce a
generic speech service, provider switch, or universal metered-capability framework around these
small interfaces.

---

## 5. Cancellation is a prerequisite, not an afterthought *(R2)*

Today's `transcribe` cancels the actual upload (§2). Routing through smoltalk's current API
would **lose that guarantee**: `TranscribeOptions`/`SpeakOptions` carry no abort signal, so a
cancelled race-loser or a time-guard trip could keep uploading/synthesizing, incur cost, and —
for TTS — later write a file. The pre-dispatch interrupt and mid-dispatch cancellation solve
different problems; we need both.

Requirements:

- The `LLMClient.transcribe`/`speak` methods must accept the **branch abort signal**
  (`ctx.getAbortSignal(stack)`), and smoltalk's released API must thread it into the underlying
  `fetch`. This is part of the coding gate (§0.2). Racing the provider promise against an
  abort promise **without cancelling the request is not acceptable** — it stops Agency waiting
  but leaves the paid request running.
- `SmoltalkClient` passes the signal through. `DeterministicClient` honors it too (§10).
- Before entering `meteredDispatch`, the wrapper checks an already-aborted signal and propagates
  its original reason. That is a local preflight: no provider call and no unresolved attempt.
- STT resolves the allow-listed path and verifies it is a readable regular file before entering
  `meteredDispatch`. Smoltalk still owns loading/size/MIME handling; the Agency preflight only
  preserves today's local missing-file failure and avoids classifying it as paid dispatch.
- Once dispatch starts, the `LLMClient` contract is exact: cancellation rejects promptly with
  `signal.reason`; resolved failure Results mean non-cancellation failures. `SmoltalkClient`
  adapts the released API to this rule, including when upstream reports cancellation as a
  failure Result. `meteredDispatch` therefore records exactly one unresolved attempt.
- Tests prove the provider observes the same signal and stops its delayed continuation; merely
  proving the wrapper stopped waiting is insufficient. TTS checks cancellation again immediately
  before atomic publication. Publication is the commit point: cancellation observed before it
  writes nothing; an abort racing after the atomic commit does not undo a completed publication.

---

## 6. Cost accounting: honest provenance, not "complete for free" *(R5)*

Revision 1 claimed routing through smoltalk gives complete cost accounting. It does not.
`meteredDispatch` records an *unresolved paid attempt* **only when the dispatch promise rejects**
(`lib/runtime/recordPaidUsage.ts:109-127`). But smoltalk's audio APIs **never reject** — they
catch provider exceptions and resolve to a failure `Result`. So a provider failure *after*
dispatch (real spend, no price metadata) would leave Agency's `pricingComplete` **true** — the
exact #809 boundary that image generation already lives with.

The success path is unchanged and correct: on a success `Result`, do the `_generateImage` dance
(`lib/stdlib/image.ts:91`): `recordUsage({ type:"provider", kind, configuredModel, cost, tokens })`,
`addTokens(...)`, statelog, then `stack.enforceGuards()` **last**. Cost is recorded **only on
success**.

**Decision: conservatively count every resolved failure Result returned after entering the
client boundary as one unresolved attempt.** This closes the #809 under-reporting direction at
the cost of marking some provider preflight failures incomplete. Trustworthy provenance in a
future released result may suppress that record only when it explicitly proves no dispatch.
Never invent a numeric cost when only an unresolved attempt is known.

The complete rule is:

| Outcome | Provider boundary entered? | Accounting |
| --- | --- | --- |
| Unsupported method, invalid/unauthorized path, or already-aborted signal | No | no entry, no unresolved attempt |
| Promise rejects after dispatch, including cancellation | Yes | `meteredDispatch` records exactly one unresolved attempt |
| Client resolves a failure Result | Yes | wrapper records exactly one unresolved attempt |
| Client resolves success | Yes | wrapper records reported cost/usage, no unresolved attempt |
| Success followed by guard trip or output failure | Yes | successful provider usage remains recorded exactly once |

The wrapper records failure Results only after `meteredDispatch` resolves, so rejected promises
cannot take both failure paths. Tests assert exact counts and guard against double accounting.

---

## 7. The full accounting + wire-schema surface *(R6)*

"Add two members to `ProviderUsageKind`" is necessary but **not sufficient**, and "audio token
fields are inherited automatically" is **false** for Agency-owned normalized/wire types. The
following are closed contracts that a new usage kind and/or new token fields touch:

- `SmoltalkCost`, `SmoltalkTokens`, `ProviderUsageKind`, and `USAGE_KINDS` in
  `lib/runtime/invocationUsage.ts` — add `"transcription"` and `"speech"` to the kind union and
  the kinds array.
- Kind validation and entry recovery across the **subprocess IPC** boundary.
- `TokenBreakdown`, its normalizers, checked accumulation, snapshots, and IPC recovery.
- The strict `usageKindSchema` and `tokenBreakdownSchema` in `lib/cli/statelog/spendTypes.ts`.
- The companion statelog API type, `USAGE_KINDS` allow-list, Kysely table type, and a **new
  forward migration** replacing the PostgreSQL `usage_events.kind` check constraint
  (`docs/dev/invocation-usage-accounting.md`). These kind changes are unconditional.
- statelog's separate closed `TokenUsage` shape remains unchanged in v1; project raw smoltalk
  usage into it rather than leaking extra fields. Update only affected renderers/tests.

### 7a. Decide audio-token attribution *(R6)*

The new `inputAudioTokens` / `outputAudioTokens` matter mainly for **audio-in-chat completions**
(`gpt-audio-1.5` reports them; STT is per-minute and TTS is per-character, so `transcribe`/`speak`
themselves usually don't). Two options:

- **(A, chosen for v1) Collapse into `totalTokens`/cost.** Audio tokens still count toward spend
  and the total, but are not separately attributed. This avoids new audio-token fields/columns;
  it does **not** avoid the unconditional server/database usage-kind changes above. Project
  smoltalk usage into Agency's existing token shape before statelog/IPC serialization so strict
  consumers never receive undeclared `inputAudioTokens`/`outputAudioTokens` fields.
- **(B) Preserve end-to-end.** Thread the two fields through every normalized/wire type above
  and update **client and server as a pinned pair**. More faithful, materially more work and a
  cross-repo release coupling.

Option (A) is the v1 decision; option (B) is future work. When `totalTokens` is valid, preserve it
as authoritative. If audio counters are present but `totalTokens` is absent/malformed, use the
conservative lower bound
`max(inputTokens + outputTokens, inputAudioTokens + outputAudioTokens)` (invalid/absent component
counters contribute zero) and set `attributionLost: true`, which makes `usageComplete` false.
The max avoids double-counting whether the released text counters include or exclude audio;
the coding-gate audit documents their semantics but does not change this v1 rule.

Implement this once as a focused `projectProviderTokenUsage(raw)` normalization at the provider
result boundary. It returns the existing closed `TokenUsage` projection plus `attributionLost`;
the projected `totalTokens` feeds invocation accounting, `addTokens`/`stack.localTokens`, global
`updateTokenStats`, STT/TTS accounting, and every statelog payload (including nested
`promptCompletion.usage`). No downstream consumer reads raw smoltalk usage. Preserve checked-add
saturation behavior and mark saturation incomplete rather than wrapping. This helper is shared
policy normalization, not a generic service abstraction.

Both new usage kinds still need runtime normalization, IPC
round-trip, process-version-skew, spend-schema, statelog persistence, migration, aggregation,
and rendering tests. Deploy the statelog migration/server before Agency emits the new kinds;
deploy Agency's strict spend parser before it consumes responses containing them.

---

## 8. Resolve the effective model before dispatch *(R7)*

The revision-1 sketch wrote `result.model-ish`, but `TranscriptionResult`/`SpeechResult` have
no `model` field, and if the stdlib passes an empty model while `SmoltalkClient` fills the
default internally, the wrapper can't attribute spend/statelog and falls back to
`"unknown model"`.

Fix: the public `.agency` defaults and checks in §4 resolve non-empty model, voice, and format
values before the interrupt. Those exact required values flow unchanged through the runtime helper into a complete
`TranscribeConfig`/`SpeakConfig`, `recordUsage.configuredModel`, and statelog. `reportedModel`
stays `undefined` when smoltalk reports none. `LLMClient` methods accept complete configs, not
`Partial` configs, and `SmoltalkClient` only adapts/delegates; it must not inject a second set of
defaults. Empty optional sentinels are omitted during this one request-construction step; they
are not defaults. This gives required fields one owner and prevents custom clients from choosing
different defaults. `DeterministicClient` must not invent a result `model` field that real
results lack. Tests pin defaulted required values, explicit unique values, empty required-value
rejection, empty optional omission, and the OpenAI API-key projection.

Do not add TS default constants: the public `.agency` signature is the single owner, and every
TS layer receives complete values. A direct `LLMClient` caller must likewise provide the full
config. This avoids two default sources that tests would merely have to keep synchronized.

---

## 9. Audio in messages: `std::thread.audio()` without widening `attachToReply` *(R9)*

Audio-in-chat is a parallel to the existing `image()`/`file()` builders
(`lib/stdlib/thread.ts:216`), which return plain `{type, source}` objects that flow into
`smoltalk.userMessage([...])`. The runtime helper `_audioAttachment(source, filename, mimeType,
base64)` returns `{ type: "audio", source: classifySource(...), filename? }` — `classifySource`
already yields `path`/`url`/`base64`, all valid `BlobRef` arms. Update `classifySource`'s
`image()/file()`-specific errors to say "attachment source" so the shared helper never lies to
an `audio()` caller. Keep `_audioAttachment` as a trivial constructor; do not add a generic
attachment factory.

**The trap:** `attachToReply(attachment: Attachment)` shares the exact `Attachment` union that
`image()`/`file()`/`userMessage` use (`stdlib/thread.agency:60-62,142`). Adding an `audio` arm to
`Attachment` **auto-widens `attachToReply`**, but the reply pipeline only supports image/file
parts — `ReplyAttachmentPart = ImagePart | FilePart` (`lib/runtime/replyAttachments.ts:33`) and
its gate treats every non-image part as a **PDF** (`:76`). The `_attachToReply` cast bypasses
runtime validation (`lib/stdlib/thread.ts:253`). So a naive widening would let `audio()` reach
`attachToReply` and be mis-handled as a PDF.

**Decision: keep `attachToReply` image/file-only; allow audio only in ordinary
messages.** Split the type:

- Keep `Attachment = image | file` as the narrow union `attachToReply` accepts.
- Introduce `MessageAttachment = Attachment | { type: "audio", source, filename? }` used by
  `audio()`, `userMessage`, and `llm()`'s first-param typechecker signature
  (`lib/typeChecker/builtins.ts`).

Add a test proving `audio()` passed to `attachToReply` is **rejected by the typechecker**. (The
alternative — full audio reply support in `replyAttachments.ts` — is more work for the narrow
`gpt-audio-1.5`-only payoff; defer it.)

The `tests/agency-js/multimodal-attachments` fixture (guards the `Attachment` contract) is
extended for the audio message path.

---

## 10. Statelog: leaf events, corrected *(R10)*

Revision 1 was factually wrong that unknown event types render as a generic span:
`inferSpanLabel` **defaults to `evt.data.type`** (`lib/logsViewer/tree.ts:289`), which is exactly
why the memory umbrella events need no per-case mapping. `imageGeneration` is a **leaf event**,
not a span.

Plan: `transcription` and `speechSynthesis` are **leaf events** mirroring `imageGeneration`
(`lib/statelogClient.ts:660`). **No viewer-label task** — the default returns the type as the
label. Fields:

- `transcription`: model, `durationSeconds`, `timeTaken`, `usage`, `cost`, and a
  `PROMPT_PREVIEW_MAX`-capped **transcript preview** (owner-approved). Never the audio bytes.
- `speechSynthesis`: model, voice, format, `timeTaken`, `cost`, and a capped **input-text
  preview**. Never the audio bytes.

Construct explicit projected cost/usage event objects; never spread or pass raw smoltalk results
to statelog. Add event-schema/method tests (that the methods post the right shape and never carry
bytes).
Cost roll-ups: these are leaf events, so no span lifecycle to design; if we later want a
dedicated span with aggregation, that is a separate, explicit piece.

---

## 11. `LLMClient` interface + the other implementations

**Interface** (`lib/runtime/llmClient.ts`), after the coding gate:

- Re-export the released smoltalk audio types as Agency's single surface (mirroring the
  `ImageConfig`/`ImageGenResult`/`ImageInput` re-exports at `:72`) for results/input. Define
  derived Agency request aliases rather than re-exporting optional upstream options unchanged:
  ```ts
  type TranscribeConfig = Omit<SmoltalkTranscribeOptions, "signal" | "model"> & {
    model: string;
  };
  type SpeakConfig = Omit<SmoltalkSpeakOptions, "signal" | "model" | "voice" | "format"> & {
    model: string;
    voice: string;
    format: NonNullable<SmoltalkSpeakOptions["format"]>;
  };
  ```
  Thus Agency-owned `model`/`voice`/`format` are required, optional provider/language/prompt/key
  fields stay optional, and config cannot contain a signal. The separate argument below is the
  one authoritative cancellation channel; the adapter reconstructs the upstream call with it.
- Add two **optional** methods, each taking the branch abort signal (§5):
  ```
  transcribe?(source: AudioInput, config: TranscribeConfig, signal: AbortSignal): Promise<Result<TranscriptionResult>>;
  speak?(text: string, config: SpeakConfig, signal: AbortSignal): Promise<Result<SpeechResult>>;
  ```
  Optional → a client without audio omits them and the wrapper throws a clear
  "this client does not support transcription/speech" error (§4).
- `SmoltalkClient` implements both as a thin adapter: pass the complete config and exact signal
  through to released smoltalk, with no defaults or routing policy of its own (§8). It does own
  the boundary adaptation that turns upstream cancellation into prompt rejection with the exact
  `signal.reason` required by §5.
- No new provider-error normalization is needed unless the released API introduces a new typed
  error. Rejected dispatches remain possible and flow through `meteredDispatch`.

### 11a. ~~Preserve the old local `_speak` ABI~~ — REVERSED (revision 4)

This section originally proposed keeping `_speak` / `__internal_speak` as
local-playback aliases (and a frozen fixture to pin them) so already-compiled
artifacts couldn't reach a cloud call. **The owner reversed this in PR review:**
Agency has no users, so there are no compiled artifacts to protect and no reason
to carry dead code. `_speak`, `__internal_speak`, and `__internal_record` were
DELETED. Local `say()` calls `_say`; cloud `speak()` calls `_synthesizeSpeech`;
`transcribe()` calls `_transcribe`. No runtime symbol means both local and cloud,
and there is no frozen fixture.

**Other implementations:**

- `DeterministicClient` (`lib/runtime/deterministicClient.ts:102`, the test client) — add
  `transcribe()`/`speak()` returning fixed transcript / fixed audio bytes + fixed cost, honoring
  the abort signal. An optional second constructor argument
  `DeterministicClientOptions = { transcriptionDelayMs?: number; speechDelayMs?: number }`
  drives mid-operation cancellation tests without changing existing mock queues. The methods
  must not report a `model` field real results lack. Unit tests pin exact bytes, costs, result
  shape, delay, and abort behavior; wrapper tests still use purpose-built capturing clients for
  exact call and state-transition assertions.
- `SimpleOpenAIClient` (`lib/runtime/simpleOpenAIClient.ts:12`, local models) — already omits
  `image()`. It **omits `transcribe`/`speak`** too; local models don't do cloud audio, and the
  wrapper surfaces a clean unsupported-client error. No change required.

---

## 12. Mutation-sensitive test plan *(R2,R5,R6,R9)*

Tests are split by boundary. Every test uses unique values and exact counts; "nonzero",
`toMatchObject`, broad snapshots, and "some diagnostic exists" are insufficient. A test must
fail when its intended seam is bypassed.

### 12a. Adapter and deterministic-client tests

**Files:** `lib/runtime/llmClient.test.ts`, `lib/runtime/deterministicClient.test.ts`.

- `SmoltalkClient.transcribe` delegates exactly once with the exact `BlobRef`, complete config,
  credentials, and the same `AbortSignal` object. The upstream result is returned unchanged.
- `SmoltalkClient.speak` delegates exactly once with unique text/model/provider/voice/format/
  speed/key values and the same signal. No field is omitted or replaced by an adapter default.
- The released smoltalk function seam also observes the signal; a wrapper-to-client assertion
  alone does not prove client-to-smoltalk forwarding.
- For each method, an upstream cancellation failure is recognized using the audited released
  discriminator and becomes a rejection with the identical `signal.reason`; an ordinary failure
  Result remains unchanged. These tests fail if the adapter treats every failure as cancellation
  or merely forwards cancellation as a resolved Result.
- Compile-time `@ts-expect-error` tests reject configs missing each required field and reject a
  config-level `signal`; positive tests accept all optional fields.
- `DeterministicClient` returns exact transcript/audio bytes and exact fixed costs, has no
  invented result `model`, obeys each configured delay under fake timers, and rejects promptly
  with the exact `signal.reason` when its signal aborts.

### 12b. Runtime wrapper success and preflight tests

**File:** new `lib/stdlib/speech.test.ts`, following `lib/stdlib/image.test.ts`'s real ALS frame
and real `InvocationUsageMeter` pattern.

For `_transcribe` success, assert:

- exact transcript and exactly one client call;
- exact resolved absolute `{ kind: "path", path }` source;
- complete config and exact branch-signal identity;
- exact cost/token totals and exactly one `(transcription, configuredModel)` entry;
- `unknownCostCallCount === 0` and `usageComplete === true`;
- one exact `transcription` event and one guard enforcement.

For `_synthesizeSpeech` success, assert:

- exact returned path and exact bytes read back from disk;
- one client call with complete config and exact signal;
- exact cost, every token counter zero, one `(speech, configuredModel)` entry, and zero unknown
  attempts;
- one exact `speechSynthesis` event, one guard enforcement, and no staging files left behind.

For each unsupported method, unauthorized/missing STT input, unauthorized TTS output, explicit
format/extension mismatch, and already-aborted signal, assert the exact thrown error, zero client
calls, zero cost/tokens/unknown attempts, zero events, zero guard calls, and no final/staging file.
Assert defaulted required config values, exact non-empty optional forwarding, empty optional
omission, and `apiKey` → `{ openAi: apiKey }` separately. This proves local preflight and request
construction occur at the intended boundary before paid dispatch.

### 12c. Accounting and side-effect outcome table

Exercise this table independently for both kinds where applicable:

| Case | Exact assertions |
| --- | --- |
| Promise rejection after dispatch | one client call; original error; exactly one unresolved attempt; zero priced entries/events/guards |
| Resolved failure Result | one client call; redacted thrown error; exactly one unresolved attempt; zero priced entries/events/guards |
| Cancellation after dispatch | one client call; original abort reason; exactly one unresolved attempt; zero success event/output |
| Success | one priced entry; zero unresolved attempts; one event; one guard call |
| Success then guard trip | priced entry and event already visible inside `enforceGuards`; thrown guard error; no staging write/publication |
| TTS success then staging/write/commit failure | priced entry/event/guard exactly once; zero unresolved attempts; write/publication error propagated |

Also spy on `sendInvocationUsageToParent`: each row emits exactly one normalized delta. This
catches double accounting between `meteredDispatch`, wrapper failure handling, and later errors.

The success ordering assertion is:

```text
dispatch resolves
→ usage billed and merged
→ statelog method invoked
→ guard enforced
→ staging write
→ atomic publication
```

A throwing guard inspects the meter and event spy from inside `enforceGuards`, then the test
asserts that no filesystem publication seam ran.

### 12d. Cancellation proves underlying work stopped

Purpose-built fake clients expose `started`, `receivedSignal`, `abortObserved`, and `completed`.
For STT and TTS:

1. start the provider operation and verify exact signal identity;
2. abort with a unique `AgencyCancelledError` reason;
3. assert the client observed abort exactly once and the same reason propagates;
4. advance fake timers beyond the original completion delay;
5. assert `completed === false` and no success event occurred;
6. for TTS, assert no final or staging file appears later;
7. assert exactly one unresolved attempt after entered dispatch;
8. in a separate commit-race test, abort immediately after successful `link()` and assert the
   committed final path is still returned and remains byte-for-byte intact.

This explicitly rejects a promise-race implementation that stops waiting but leaves work alive.

### 12e. Atomic output publication tests

Use §13's publication seam and a unique `mkdtemp` root. Assert:

- a new final path is invisible until commit and then contains the complete expected bytes;
- an existing disposable sentinel causes a preflight error and remains byte-for-byte unchanged;
- provider failure, guard trip, cancellation, staging-write failure, and commit failure all
  preserve the sentinel/final target;
- a destination created after preflight follows the no-clobber race policy and remains intact;
- only the invocation-owned staging file is removed;
- cleanup failure before commit throws
  `AggregateError([primaryError, cleanupError], "Speech output failed and staging cleanup failed")`;
  assert exact error order and object identity;
- cleanup failure after a successful link keeps the final file and returns success while
  making exactly one `console.error("Failed to remove published speech staging file '<stage>' for '<final>'", cleanupError)` call;
- success and every clean failure leave no owned staging file.

Format coverage includes matching explicit extension, accepted extensionless explicit path,
pre-dispatch extension mismatch, post-dispatch returned-MIME mismatch (usage still accounted,
no publication), auto-generated extension from requested format, unsupported MIME, PCM metadata,
and exact accepted bytes.

### 12f. Statelog privacy and shape tests

**Files:** `lib/stdlib/speech.test.ts`, `lib/statelogClient.test.ts`.

The wrapper test proves the event method is actually called. A separate real file-sink test
reads serialized JSONL. Use text longer than `PROMPT_PREVIEW_MAX`, a unique suffix beyond the
limit, and recognizable audio bytes plus their base64 string. Assert:

- preview is exactly `text.slice(0, PROMPT_PREVIEW_MAX)` and the suffix is absent;
- exact event type/model/voice/format/duration/cost/projected usage fields;
- byte and base64 canaries are absent;
- no `audio`, `pcm`, `raw`, `inputAudioTokens`, or `outputAudioTokens` field exists.

These are explicit privacy assertions, not snapshots.

### 12g. Invocation usage, IPC, spend, and statelog rollout tests

**Agency files:** `lib/runtime/invocationUsage.test.ts`, `lib/runtime/recordPaidUsage.test.ts`,
`lib/runtime/prompt.test.ts`, `lib/runtime/ipc.test.ts`, `lib/cli/statelog/spendTypes.test.ts`,
`lib/cli/remote/render.test.ts`.

- Normalize exact `transcription` and cost-only `speech` observations; assert model/kind/cost/
  token buckets and unknown counts.
- For audio-token collapse, test a valid authoritative `totalTokens`, then unique text/audio
  counters with absent and malformed totals. The latter cases assert the exact §7a max formula,
  `attributionLost === true`, and `usageComplete === false`; a sum, text-only fallback, or
  completeness-preserving mutation must fail.
- Drive an ordinary audio-input completion through the real completion path and assert that same
  projected total in the invocation meter, `getTokens()` branch total, global token stats, and
  serialized `promptCompletion.usage`; assert raw audio fields are absent everywhere. Repeat for
  absent and malformed totals, and add a near-limit case proving checked-add saturation marks
  usage incomplete rather than wrapping.
- JSON-round-trip each delta through real `handleChildMessage`, merge into the parent meter, and
  relay a grandchild delta exactly once. Calling only `normalizeIpcUsageDelta` is insufficient.
- Strict spend schemas accept both new kinds and reject an unknown kind. `--by-kind` rendering
  prints both exact labels and totals.

**Companion statelog files:** `src/common/apiTypes/spend.ts`,
`src/backend/db/usage_event.test.ts`, `src/backend/postgres-integration/hostedInvocations.migration.test.ts`,
and `src/backend/postgres-integration/spendLedger.test.ts`.

- `toInvocationRows` keeps both details with zero invalid-detail drops;
- the new forward migration accepts both kinds and still accepts legacy kinds;
- persistence and spend aggregation return both exact `(kind, model)` groups;
- an old unsupported kind still fails the database constraint.

### 12h. Audio attachment and typechecker tests

**Files:** `lib/typeChecker/attachments.test.ts`, `lib/stdlib/thread.test.ts`, and
`tests/agency-js/multimodal-attachments/*`.

- `_audioAttachment` returns exact path, URL, data-URI, and raw-base64 shapes; generic
  `classifySource` errors name an attachment, not image/file only.
- A capturing `LLMClient.text` receives the exact audio part in final `PromptConfig.messages`
  for both `llm([...])` and `userMessage([...])`, with the selected model unchanged. The existing
  deterministic fixture alone is insufficient because it ignores message content.
- Released smoltalk's own audio serialization/model-gating tests are a coding-gate prerequisite;
  Agency does not duplicate provider renderer internals.
- Positive `llm`/`userMessage` audio cases produce zero diagnostics. `attachToReply(audio(...))`
  asserts the exact diagnostic code, severity, location/call, and message. Existing image/file
  reply cases remain diagnostic-free.

### 12i. Effects and handlers tests

Agency execution/JS harness tests assert exact effect identifiers and payloads. Rejection and
an unhandled interrupt both produce zero provider calls; approval dispatches exactly once; an
order spy proves interrupt handling precedes dispatch. `std::say` reaches only local playback,
and `std::synthesizeSpeech` gates only cloud TTS. Explicit empty model/voice throws the exact
public validation error before any interrupt or provider call; defaults produce the exact
non-empty effect payload and downstream request.

*(Revision 4: the frozen pre-change `_speak` compatibility fixture described here was DROPPED —
there are no compiled artifacts to protect, see §11a.)*

### 12j. Test safety and commands

- Filesystem tests create unique `mkdtemp` roots. Every final target, sentinel, and staging file
  stays under that root. Never use `$HOME`, the repository root, a fixed shared `/tmp` path, or a
  real user file.
- Use fake/capturing clients and signals; never call OpenAI, `say`, `rec`, or an audio device.
- A failed test can corrupt only its disposable sentinel. Cleanup removes only the exact root
  that test created. Deletion-refusal tests use dry-run.
- Run focused unit files first, saving output as required by `docs/misc/TESTING.md`:
  ```bash
  pnpm test:run -- \
    lib/runtime/llmClient.test.ts \
    lib/runtime/deterministicClient.test.ts \
    lib/stdlib/speech.test.ts \
    lib/stdlib/thread.test.ts \
    lib/statelogClient.test.ts \
    lib/runtime/invocationUsage.test.ts \
    lib/runtime/recordPaidUsage.test.ts \
    lib/runtime/prompt.test.ts \
    lib/runtime/ipc.test.ts \
    lib/cli/statelog/spendTypes.test.ts \
    lib/cli/remote/render.test.ts \
    lib/typeChecker/attachments.test.ts \
    > .tmp/speech-unit-tests.log 2>&1
  ```
- Run the focused Agency-JS fixtures only (not the full Agency suite):
  ```bash
  make > .tmp/speech-make.log 2>&1
  AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js \
    tests/agency-js/speech-effects \
    tests/agency-js/multimodal-attachments \
    > .tmp/speech-agency-tests.log 2>&1
  pnpm run lint:structure > .tmp/speech-structure-lint.log 2>&1
  ```
  Remove these temporary logs after inspection. *(Revision 4: the compat-fixture
  runner was dropped — no back-compat, §11a.)*
- In the statelog checkout, run focused mapping and PostgreSQL tests separately:
  ```bash
  pnpm exec vitest run src/backend/db/usage_event.test.ts \
    > .tmp/speech-usage-kinds-unit.log 2>&1
  pnpm run test:integration -- \
    src/backend/postgres-integration/hostedInvocations.migration.test.ts \
    src/backend/postgres-integration/spendLedger.test.ts \
    > .tmp/speech-usage-kinds-integration.log 2>&1
  ```
  Remove those logs after inspection. Do not claim the cross-repo rollout passes from Agency
  tests alone.

---

## 13. TTS output-path outcome matrix *(R8)*

`speak(...)` produces a file, so it needs a defined outcome for every branch, not just "write
the audio":

- **Empty `outputFile`:** before dispatch, generate a unique runtime-owned basename under the
  system temp directory and choose its extension from the requested `format` (mp3 → `.mp3`,
  etc.). This runtime-owned temp destination is exempt from caller `allowedPaths`, like `record`.
- **`format` vs. MIME vs. explicit extension:** map requested format to one expected MIME before
  dispatch and require the returned `mimeType` to match before writing. An explicit extension,
  when present, must be consistent with format (mismatch is a pre-dispatch error); an explicit
  extensionless path is accepted unchanged. Never silently rename caller paths.
- **Allow-list:** `resolveDir(outputFile, allowedPaths)` runs **before** paid dispatch, so an
  unauthorized path never costs money.
- **Existing target:** refuse before dispatch. New speech output does not overwrite files. If a
  target appears after preflight, exclusive atomic publication fails without clobbering it.
- **Provider success but local write fails:** provider usage is **still accounted and
  statelog'd** (money was spent); the thrown error reports the write failure.
- **Cost-guard trip:** guards are enforced **after** accounting/statelog and **before** the
  write, so a trip means no staging or final artifact is written; paid bytes are discarded.
- **Partial write / cancellation:** a focused `publishSpeechOutput(finalPath, audio, signal)`
  helper owns all file mechanics. It creates an exclusive unique sibling stage, writes complete
  bytes, checks cancellation, then calls `link(stage, finalPath)` as the atomic no-clobber commit.
  `EEXIST` preserves a destination created after preflight; do not fall back to replacing
  `rename`. After a successful link, unlink the stage. Publication is the commit point in §5.
- **Cleanup ownership:** cleanup deletes only the helper's direct-child generated stage after
  verifying its parent and prefix/suffix. Use `safeDeleteFile` where its project-root contract
  applies; arbitrary allowed directories require the narrow ownership-checked exception modeled
  on `cleanupOwnedTemp` in `lib/cli/remote/pullPlan.ts`. Never delete the final target. Before
  commit, throw
  `AggregateError([primaryError, cleanupError], "Speech output failed and staging cleanup failed")`
  with that exact order. After a successful link, preserve the published file and return success;
  report a failed stage unlink with exactly
  `console.error("Failed to remove published speech staging file '<stage>' for '<final>'", cleanupError)`,
  the existing stdlib diagnostic seam. Never silently swallow either case.

`_synthesizeSpeech` owns request construction, cancellable dispatch, accounting, statelog, and
guard enforcement. `publishSpeechOutput` owns staging and publication. Do not introduce a generic
speech service or generic "metered capability" framework.

Safe sequence: **resolve+authorize+no-clobber preflight → dispatch → record usage + statelog →
enforce guards → stage → final abort check → exclusive atomic publication → return.**

---

## 14. Out of scope

- `record` (SoX) and local playback (macOS `say`, now named `say`) — behavior unchanged.
- Non-OpenAI speech providers — smoltalk v1 is OpenAI-only; Agency inherits that.
- Streaming STT/TTS, translation, assistant audio *output* in chat — deferred in smoltalk v1.
- Full audio support in `attachToReply` (§9) — deferred; typechecker rejects it for now.
- Per-modality audio-token attribution — v1 deliberately collapses it (§7a).

---

## 15. Sequencing (gated on §0)

0. **Coding gate met** (§0): smoltalk merged/released with real cancellation and final
   config/result/error/token contracts re-audited.
1. Pin the released smoltalk version in Agency.
2. *(Revision 4: the frozen `_speak` compatibility artifact step was DROPPED — no back-compat, §11a.)*
3. **Statelog first:** add both usage kinds to API/server/types, ship the forward database
   migration, and prove persistence/aggregation. Deployment is the separate emission gate; it
   must complete before an Agency release emits the new kinds.
4. `LLMClient`: re-export released types, add exact-config optional `transcribe?`/`speak?` with
   abort signal, implement thin `SmoltalkClient` delegation, and add adapter tests (§12a).
5. Accounting/wire: add both provider kinds throughout normalization, fixed meter indexes, IPC,
   strict spend schemas, projected token fields, and focused tests (§7/§12g).
6. Statelog: add `transcription` + `speechSynthesis` leaf events and privacy serialization tests.
7. Runtime helpers (revision 4 — no back-compat): add `_say`, rewrite `_transcribe`, add cloud
   `_synthesizeSpeech`, add focused atomic `publishSpeechOutput`, and REMOVE the old
   `_speak`/`__internal_speak`/`__internal_record`. Implement the conservative accounting and
   output matrices with tests first (§6/§12b–f/§13).
8. `stdlib/speech.agency`: local `speak`→`say` (effect `std::say`); re-backed `transcribe`
   (effect `std::transcribe`, provider-honest); new cloud `speak` (effect
   `std::synthesizeSpeech`) using the exact signatures in §4. Add effect tests (§12i).
9. `DeterministicClient`: exact fixed audio results plus optional delays and abort tests (§11/§12a).
10. Audio-in-chat: `_audioAttachment` + `std::thread.audio()`; split `MessageAttachment` vs the
   narrow `Attachment` so `attachToReply` stays image/file-only (§9); typechecker arm; extend
   the multimodal fixture and add capturing-client handoff tests (§12h).
11. Run all focused checks in §12j, inspect saved output once, remove temporary logs, then update
   the dev note/CLAUDE.md pointer and run `make` because stdlib files changed.

---

## 16. Decisions summary

All decisions are fixed for implementation:

- **Public contract:** natural `string` values; throw on failure; complete defaults in `.agency`.
- **Effects:** `std::say` is local; new `std::synthesizeSpeech` is cloud; `std::transcribe`
  carries requested/configured values without pretending to know actual routing.
- **ABI (revision 4):** no back-compat — `_speak` / `__internal_speak` /
  `__internal_record` were removed; local is `_say`, cloud is `_synthesizeSpeech`.
- **Cancellation:** released provider cancellation is mandatory; publication is the file commit point.
- **Failure accounting:** every entered resolved failure is conservatively one unresolved attempt.
- **Tokens:** v1 preserves authoritative totals but does not expose modality-specific buckets.
- **Output:** no overwrite; exclusive sibling staging; atomic publish; owned-stage cleanup only.
- **Attachments:** audio is allowed in ordinary messages, not `attachToReply`.
- **Statelog:** leaf events; previews only; bytes/raw/PCM absent; server/database kinds updated first.
- **Abstractions:** exact `LLMClient` capability configs and one file-publication helper; no generic
  speech service or generic metered-operation framework.

**Per the review's closing instruction: request another review of this revised plan before
implementation.**
