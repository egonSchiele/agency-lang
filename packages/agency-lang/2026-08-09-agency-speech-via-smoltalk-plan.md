# Wiring Agency's speech support to smoltalk's new audio API

> **Revision 2 (2026-08-09).** Rewritten to address review round 1
> (`2026-08-09-agency-speech-via-smoltalk-plan-review.md`). The direction (thin
> wrapper over smoltalk) is unchanged. What changed: a hard upstream landing
> gate, a dedicated cloud effect instead of reusing `std::speak`, cancellation
> made a prerequisite at the client boundary, one explicit failure contract, an
> honest cost-provenance section, the full accounting/wire-schema surface
> enumerated, explicit effective-model resolution, a TTS output-path outcome
> matrix, `attachToReply` narrowing, and a corrected statelog/viewer plan. All
> ten review findings are folded in below and cross-referenced as *(R1)*…*(R10)*.

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

## 0. Landing gate — do not start implementation until these hold *(R3)*

smoltalk PR #36 is still open and took architectural-rework requests on 2026-08-09. Aliasing
its option/result types into Agency's *public* `LLMClient` interface would freeze an unstable
contract. Implementation may begin **only after all of the following are true**, re-audited
against the *released* smoltalk declarations (not the current branch):

1. smoltalk #36 is merged and cut in a released version; Agency's `package.json` pins/requires
   that version.
2. The released `transcribe`/`speak` accept a **caller-supplied `AbortSignal`** (see §5 —
   cancellation is a hard requirement, and the current API has none).
3. Failure **provenance** is expressible: the caller can tell a proven pre-dispatch failure
   from a dispatched-but-unpriced failure (see §6), OR we consciously accept the #809 gap.
4. Result **field names** (`cost`, `usage`, and any `model`/effective-model field), credential
   configuration (`apiKey` map shape), and the audio token fields (`inputAudioTokens` /
   `outputAudioTokens`) are verified against the release.

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
  `{ provider, model, textLength }`. It is a distinct capability an approver opts into
  separately.
- Cloud STT: keep **`std::transcribe`** but its payload/prompt must stop asserting the
  destination is necessarily OpenAI once `provider`/custom clients exist. Payload becomes
  `{ provider, model, filepath }`; the prompt names the resolved provider, not a hardcoded
  "OpenAI Whisper".

The interrupt fires **before** dispatch, as today. The interrupt is *not* the cancellation
mechanism — see §5.

---

## 4. One public failure contract *(R4)*

The three claims in revision 1 (keep `transcribe`'s `string` signature; return a file-path
`string` from `speak`; surface failures as a `Result` like `std::image`) are mutually
incompatible: a `string`-declared function cannot return a `Result` object.

**Decision (recommended): both speech functions return their natural value and *throw* on
failure**, matching the rest of `std::speech` and the `std::fs` idiom (`read()` returns a
`string` and throws). Concretely:

- `transcribe(...) : string` — returns transcript text; throws on failure.
- `speak(...) : string` — returns the output file path; throws on failure.

The runtime helpers (`_transcribe` / `_speak`) receive smoltalk's failure `Result` and
**translate it into a thrown `Error`** (with the already-redacted message). We do *not* adopt
`std::image`'s `Result`-returning shape here; that would be a second, inconsistent convention
in the same module.

> Owner check: if you'd rather speech return a `Result` (recoverable failures without
> `try`/`catch`), say so and both public signatures change to `Result` — a deliberate,
> documented choice. The plan assumes throw-on-failure unless you flip it.

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
  `fetch`. This is part of the landing gate (§0.2). Racing the provider promise against an
  abort promise **without cancelling the request is not acceptable** — it stops Agency waiting
  but leaves the paid request running.
- `SmoltalkClient` passes the signal through. `DeterministicClient` honors it too (§10).
- Tests must prove: cancellation stops the underlying request, and a cancelled TTS call
  **never writes its output file** (§11).

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

The failure path needs a decision:

- **(A, recommended) Conservatively record a resolved failure `Result` as an unresolved
  attempt** — call the equivalent of `recordUnresolvedAttempt(ctx, stack, kind)` so
  `pricingComplete` goes false whenever a dispatched audio call fails. This is *safer* than
  image's current behavior and cheap. It slightly over-reports incompleteness (a proven
  pre-dispatch failure — e.g. bad model name — also flips it), which §0.3 mitigates if smoltalk
  can distinguish the two.
- **(B) Accept #809 parity with image** and document that a post-dispatch audio failure may
  under-report spend. Simplest; matches existing behavior.

Recommend (A) unless the owner wants strict image parity. Either way: **never invent a numeric
cost when only an unresolved attempt is known.** Tests cover a rejected promise, a pre-dispatch
failure Result, a post-dispatch failure Result, and cancellation (§11).

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
- The companion statelog **server/database** schema (`docs/dev/invocation-usage-accounting.md`).
- statelog's local `TokenUsage` shape and the affected renderers/tests.

### 7a. Decide audio-token attribution *(R6)*

The new `inputAudioTokens` / `outputAudioTokens` matter mainly for **audio-in-chat completions**
(`gpt-audio-1.5` reports them; STT is per-minute and TTS is per-character, so `transcribe`/`speak`
themselves usually don't). Two options:

- **(A, recommended for v1) Collapse into `totalTokens`/cost.** Audio tokens still count toward
  spend and the total, but are not separately attributed. Requires **no** statelog server/db
  change. Document the loss of per-modality attribution and test that the total is still correct.
- **(B) Preserve end-to-end.** Thread the two fields through every normalized/wire type above
  and update **client and server as a pinned pair**. More faithful, materially more work and a
  cross-repo release coupling.

Recommend (A) for v1; revisit if per-modality audio-token reporting becomes valuable. Whichever
we pick, **every new usage kind still needs** runtime-normalization, IPC round-trip,
process-version-skew, spend-schema, and rendering tests. Cost-only TTS (a priced observation
with zero tokens) is conceptually valid but must be proven valid through all these layers.

---

## 8. Resolve the effective model before dispatch *(R7)*

The revision-1 sketch wrote `result.model-ish`, but `TranscriptionResult`/`SpeechResult` have
no `model` field, and if the stdlib passes an empty model while `SmoltalkClient` fills the
default internally, the wrapper can't attribute spend/statelog and falls back to
`"unknown model"`.

Fix: the stdlib helper **resolves a non-empty effective model before dispatch** (the caller's
model, else the Agency default constant), and uses that *same* string for (a) the client config,
(b) `recordUsage.configuredModel`, and (c) the statelog event. `reportedModel` stays `undefined`
(smoltalk returns none) — `recordUsage` already tolerates that. The **default TTS voice** is
likewise named **explicitly** in the public contract (a real voice string, e.g. `"alloy"`), not
"a sensible default." `DeterministicClient` must **not** invent a `model` field that real
results lack — the wrapper owns the effective-model string, the client does not report one.

New constants in `lib/constants.ts`: `DEFAULT_TRANSCRIBE_MODEL`, `DEFAULT_SPEECH_MODEL`,
`DEFAULT_SPEECH_VOICE`.

---

## 9. Audio in messages: `std::thread.audio()` without widening `attachToReply` *(R9)*

Audio-in-chat is a parallel to the existing `image()`/`file()` builders
(`lib/stdlib/thread.ts:216`), which return plain `{type, source}` objects that flow into
`smoltalk.userMessage([...])`. The runtime helper `_audioAttachment(source, filename, mimeType,
base64)` returns `{ type: "audio", source: classifySource(...), filename? }` — `classifySource`
already yields `path`/`url`/`base64`, all valid `BlobRef` arms.

**The trap:** `attachToReply(attachment: Attachment)` shares the exact `Attachment` union that
`image()`/`file()`/`userMessage` use (`stdlib/thread.agency:60-62,142`). Adding an `audio` arm to
`Attachment` **auto-widens `attachToReply`**, but the reply pipeline only supports image/file
parts — `ReplyAttachmentPart = ImagePart | FilePart` (`lib/runtime/replyAttachments.ts:33`) and
its gate treats every non-image part as a **PDF** (`:76`). The `_attachToReply` cast bypasses
runtime validation (`lib/stdlib/thread.ts:253`). So a naive widening would let `audio()` reach
`attachToReply` and be mis-handled as a PDF.

**Decision (recommended): keep `attachToReply` image/file-only; allow audio only in ordinary
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

Add event-schema/method tests (that the methods post the right shape and never carry bytes).
Cost roll-ups: these are leaf events, so no span lifecycle to design; if we later want a
dedicated span with aggregation, that is a separate, explicit piece.

---

## 11. `LLMClient` interface + the other implementations

**Interface** (`lib/runtime/llmClient.ts`), after the landing gate:

- Re-export the released smoltalk audio types as Agency's single surface (mirroring the
  `ImageConfig`/`ImageGenResult`/`ImageInput` re-exports at `:72`): `TranscribeConfig`,
  `TranscriptionResult`, `SpeakConfig`, `SpeechResult`, `AudioInput` (= `BlobRef`).
- Add two **optional** methods, each taking the branch abort signal (§5):
  ```
  transcribe?(source: AudioInput, config: Partial<TranscribeConfig>, signal: AbortSignal): Promise<Result<TranscriptionResult>>;
  speak?(text: string, config: Partial<SpeakConfig>, signal: AbortSignal): Promise<Result<SpeechResult>>;
  ```
  Optional → a client without audio omits them and the wrapper throws a clear
  "this client does not support transcription/speech" error (§4).
- `SmoltalkClient` implements both, injecting default model/voice (§8) and passing the signal.
- `normalizeError` unchanged (smoltalk audio calls don't throw).

**Other implementations:**

- `DeterministicClient` (`lib/runtime/deterministicClient.ts:102`, the test client) — already
  implements `image()` with fixed bytes+cost. Add `transcribe()`/`speak()` returning fixed
  transcript / fixed audio bytes + fixed cost, **honoring the abort signal** and supporting a
  **configurable delay** so cancellation and provenance tests are possible (§5, §6). It must
  **not** report a `model` field real results lack (§8). Fixed happy-path values alone are
  insufficient.
- `SimpleOpenAIClient` (`lib/runtime/simpleOpenAIClient.ts:12`, local models) — already omits
  `image()`. It **omits `transcribe`/`speak`** too; local models don't do cloud audio, and the
  wrapper surfaces a clean unsupported-client error. No change required.

---

## 12. Test plan (expanded) *(R2,R5,R6,R9)*

Focused runtime tests modeled on `lib/stdlib/image.test.ts`, not only Agency execution
fixtures:

- unsupported optional client method (clean thrown error);
- STT success with usage (and the chosen audio-token policy from §7a);
- TTS success with cost and **no** token usage;
- accounting recorded **before** guard enforcement;
- rejected dispatch, pre-dispatch failure Result, **post-dispatch** failure Result — each
  producing the §6 provenance outcome;
- **cancellation** of both capabilities (request actually stops; TTS writes **no** file);
- TTS output: allow-list validation before paid dispatch, write failure after provider success,
  partial-file cleanup, and guard-trip behavior (§13);
- statelog previews present, audio bytes absent;
- IPC round-trip and `agency remote spend` parsing for both new kinds;
- ordinary audio message end-to-end, plus the chosen `attachToReply` rejection (§9);
- Agency execution tests (`tests/agency/`) for the interrupt/effect wiring, using the
  deterministic client (no LLM calls).

---

## 13. TTS output-path outcome matrix *(R8)*

`speak(...)` produces a file, so it needs a defined outcome for every branch, not just "write
the audio":

- **Empty `outputFile`:** auto-generate a temp path; extension chosen from the resolved
  `format`/MIME (mp3 → `.mp3`, etc.).
- **`format` vs. MIME vs. explicit extension:** the returned `mimeType` is authoritative for the
  extension; an explicit `outputFile` extension is respected but must be consistent with
  `format` (mismatch is an error, not a silent rename).
- **Allow-list:** `resolveDir(outputFile, allowedPaths)` runs **before** paid dispatch, so an
  unauthorized path never costs money.
- **Provider success but local write fails:** provider usage is **still accounted and
  statelog'd** (money was spent); the thrown error reports the write failure.
- **Cost-guard trip:** guards are enforced **after** accounting/statelog and **before** the
  write, so a trip means **no artifact is written** (the paid bytes are discarded). If instead
  we want to keep the artifact on a trip, that must be stated deliberately — default is discard.
- **Partial write / cancellation:** clean up any partial file; a cancelled call writes nothing
  (§5).
- **Error precedence:** a guard trip wins over a subsequent write error (same ordering as
  image, where `enforceGuards()` runs before the return).

Safe sequence: **resolve+authorize path → dispatch (cancellable) → record usage + statelog →
enforce guards → write + return.**

---

## 14. Out of scope

- `record` (SoX) and local playback (macOS `say`, now named `say`) — behavior unchanged.
- Non-OpenAI speech providers — smoltalk v1 is OpenAI-only; Agency inherits that.
- Streaming STT/TTS, translation, assistant audio *output* in chat — deferred in smoltalk v1.
- Full audio support in `attachToReply` (§9) — deferred; typechecker rejects it for now.
- Per-modality audio-token attribution if §7a lands on option (A).

---

## 15. Sequencing (gated on §0)

0. **Landing gate met** (§0): smoltalk merged/released with cancellation + provenance; version
   pinned; released API re-audited.
1. `LLMClient`: re-export released types, add optional `transcribe?`/`speak?` **with abort
   signal**, implement in `SmoltalkClient`, add default model/voice constants.
2. Accounting/wire: `ProviderUsageKind`/`USAGE_KINDS` += `transcription`/`speech`; the §7a
   token-attribution decision; update `spendTypes` schemas + IPC recovery; server/db only if
   §7a option (B).
3. Statelog: `transcription` + `speechSynthesis` **leaf** events (no viewer task).
4. Runtime helpers: rewrite `_transcribe` onto the client (delete direct-fetch body); add
   `_speak` (cloud TTS + output-path matrix §13); rename local helper to `_say`. §6 provenance
   handling; §8 effective-model resolution.
5. `stdlib/speech.agency`: local `speak`→`say` (effect `std::say`); re-backed `transcribe`
   (effect `std::transcribe`, provider-honest); new cloud `speak` (effect
   `std::synthesizeSpeech`).
6. `DeterministicClient`: fixed `transcribe`/`speak` with abort + configurable delay (§10/§11).
7. Audio-in-chat: `_audioAttachment` + `std::thread.audio()`; split `MessageAttachment` vs the
   narrow `Attachment` so `attachToReply` stays image/file-only (§9); typechecker arm; extend
   the multimodal fixture.
8. Full test matrix (§11–§13).
9. Dev note under `docs/dev/` (re-backed speech path, effects, provenance) + CLAUDE.md pointer.

---

## 16. Decisions summary

Recommended (owner may override):
- **§4 failure contract:** throw-on-failure, natural return values.
- **§6 provenance:** option (A), conservatively record audio failures as unresolved attempts.
- **§7a token attribution:** option (A) for v1, collapse into `totalTokens`/cost.
- **§9 attachToReply:** keep image/file-only; audio in ordinary messages only.

Fixed by review:
- **§3a:** cloud effects are new (`std::synthesizeSpeech`), never a repurposed `std::speak`;
  local playback is `std::say`.
- **§5:** cancellation is a landing-gate prerequisite.
- **§10:** leaf events, no viewer-label task.

**Per the review's closing instruction: request another review of this revised plan before
implementation.**
