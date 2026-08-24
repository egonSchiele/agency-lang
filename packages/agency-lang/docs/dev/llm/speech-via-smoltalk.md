# Cloud speech (STT / TTS) via smoltalk

`std::speech` used to hand-roll its cloud calls. Now the two cloud capabilities
route through the active `LLMClient` exactly like `std::image` routes through
`ctx.llmClient.image`, so they inherit Agency's cost accounting, spend guards,
and statelog for free. Agency keeps only what is genuinely its job: the path
allow-list, the approval interrupts, and the accounting/tracing.

Design doc: `2026-08-09-agency-speech-via-smoltalk-plan.md` (repo root of this
package). Read it for the full rationale; this note is the code map.

## The `std::speech` surface

| Function | What it is | Effect | Runtime helper |
| --- | --- | --- | --- |
| `say(text, …)` | LOCAL macOS playback (`say`) | `std::say` | `_say` (shares `speakImpl`) |
| `record(…)` | LOCAL mic capture (SoX) | `std::record` | `_record` |
| `transcribe(filepath, …)` | CLOUD speech-to-text | `std::transcribe` | `_transcribe` |
| `speak(text, …)` | CLOUD text-to-speech → file path | `std::synthesizeSpeech` | `_synthesizeSpeech` |

Breaking rename (Agency has no users): the old local-playback `speak` is now
`say`, and `speak` is the new CLOUD TTS. Because there are no users, there is no
back-compat shim. The old `_speak` and `__internal_*` runtime exports were
removed, not kept as aliases. This rename matters for approval safety, so read
the effect note below.

## Effects are capability boundaries, not just prompts

- Local playback and cloud TTS are DISTINCT effects (`std::say` vs
  `std::synthesizeSpeech`). We did NOT reuse the old `std::speak` identifier for
  the cloud path: a non-interactive handler or CLI policy that already approves a
  local effect must never silently begin authorizing text transmission to an
  external provider. Handlers match the effect contract, not the prompt string.
- `std::transcribe` / `std::synthesizeSpeech` payloads carry `requestedProvider`
  + `configuredModel` (STT also `filepath`). They state the REQUESTED provider
  (may be `""` = automatic); a custom `LLMClient` still owns actual routing, so
  the prompt says "the active cloud speech provider", not a resolved destination.

## Runtime helpers (`lib/stdlib/speech.ts`)

Local `say()` calls `_say`; cloud `speak()` calls `_synthesizeSpeech`; cloud
`transcribe()` calls `_transcribe`. No runtime symbol means both local and cloud.
There is no back-compat alias: with no users, the old `_speak` / `__internal_*`
exports were deleted rather than frozen.

Argument validation (format, speed, timestamp granularity) lives in
`validateSpeakArgs` / `validateTranscribeGranularity` and runs at TWO points:
`speech.agency` calls the `_validateSpeakArgs` / `_validateTranscribeArgs` exports
BEFORE the approval interrupt (an invalid call never prompts), and the runtime
helpers validate again at their boundary (a direct/deterministic caller that
bypassed the `.agency` still can't publish a mislabeled artifact). `format` is
normalized for case and a leading dot against the shared `SPEAK_FORMATS` and
`SPEECH_FORMAT_TO_MIME` in `lib/runtime/audioFormats.ts`. That file is the single
source both this helper and the `DeterministicClient` use.

## Failure accounting: honest #809 provenance (`lib/stdlib/speech.ts`)

smoltalk's `transcribe`/`speak` never reject — they resolve a failure `Result`.
`meteredDispatch` only records an unresolved attempt on a REJECTED promise, so a
resolved failure would leave `pricingComplete` true. The wrapper therefore
records exactly one unresolved attempt on a resolved failure Result itself
(`recordUnresolvedAttempt`). The success path mirrors `_generateImage`: `recordUsage`,
then `addTokens` (STT only, since TTS has no tokens), then the statelog leaf
event, then `enforceGuards()` LAST. Cost is recorded only on success; a guard trip still
leaves the spend accounted and traced.

## TTS output is published atomically (`publishSpeechOutput`)

`speak()` never overwrites. The path is resolved + authorized (allow-list) and a
no-clobber preflight runs BEFORE any paid dispatch. After a successful synthesis
and the guard gate, `publishSpeechOutput` writes to an exclusive
invocation-owned sibling stage, checks cancellation (the commit point), then
`link()`s the stage onto the final path (EEXIST rather than clobbering a file
that appeared after preflight). Cleanup removes only the owned stage; a
cleanup-before-commit failure throws an `AggregateError`, a cleanup-after-commit
failure is logged and the published file is kept.

## Accounting + statelog wiring

- Usage kinds: `ProviderUsageKind` and `USAGE_KINDS`
  (`lib/runtime/invocationUsage.ts`) gained `transcription` and `speech`; the
  strict `usageKindSchema` (`lib/cli/statelog/spendTypes.ts`) matches. The
  companion statelog server/DB `usage_events.kind` migration is a SEPARATE
  cross-repo change (see the plan §7); this PR is Agency-only.
- Audio tokens (`inputAudioTokens`/`outputAudioTokens`, gpt-audio-1.5 chat) are
  COLLAPSED into `totalTokens` for v1 — they never surface as their own fields in
  the normalized `TokenBreakdown`. `buildTokens` only uses them to widen the
  FALLBACK total to a conservative `max(text-sum, audio-sum)` lower bound when the
  provider's `totalTokens` is absent/malformed, marking attribution lost.
- **One projection, every consumer.** `projectProviderTokenUsage(raw, kind)`
  (`lib/runtime/invocationUsage.ts`) wraps that same `buildTokens`, so the
  invocation meter (via `recordUsage`), the branch total (`stack.localTokens` in
  `recordCompletionUsage`; `addTokens` in `_transcribe`), the global token stats
  (`updateTokenStats`), and every statelog payload all use the identical projected
  total and never serialize an audio-token field. Before this, the completion path
  fed the meter one number and the branch, global, and statelog consumers the raw
  one for the same call. The single projection closes that skew.
- Leaf events `transcription` + `speechSynthesis` (`lib/statelogClient.ts`) mirror
  `imageGeneration`. Previews are `PROMPT_PREVIEW_MAX`-capped; audio bytes / `raw`
  / `pcm` are never logged. The wrapper hands the projected usage + a total-only
  cost to the event.

## Audio in chat messages (`std::thread`)

`audio()` builds an audio attachment (`_audioAttachment` in
`lib/stdlib/thread.ts`), parallel to `image()`/`file()`. It flows into
`smoltalk.userMessage([...])`, which does the rendering + model gating
(gpt-audio-1.5 only in smoltalk v1).

Type split (`stdlib/thread.agency`):
- `Attachment = image | file` — the NARROW union `attachToReply` accepts. Passing
  `audio()` to `attachToReply` is a type error on purpose (the reply pipeline in
  `lib/runtime/replyAttachments.ts` only handles image/file).
- `MessageAttachment = image | file | audio` — used by `userMessage`.
- `llm()`'s first-arg type (`lib/typeChecker/builtins.ts`) is a UNION of the two
  alias NAMES `Attachment | MessageAttachment`. At an `llm()`
  call site the user file usually has not imported these aliases, so the checker
  compares them as unresolved aliases by name (`assignability.ts`). A single alias
  would reject whichever builder returns the other name.

## Cancellation

Agency pins `smoltalk ^0.12.0`. `abortSignal` on the audio operations arrived in
0.10.1. The branch abort signal (`ctx.getAbortSignal(stack)`) is the SOLE
cancellation channel: it is a method argument on `LLMClient.transcribe`/`speak`,
deliberately NOT a config field (the derived `TranscribeConfig`/`SpeakConfig`
`Omit` `abortSignal`), so there is exactly one place a signal can enter.

`SmoltalkClient` passes it as smoltalk's `abortSignal`, which forwards it to the
provider SDK call — so a Ctrl-C / `race()` loss / time-guard trip aborts the
in-flight request, not just Agency's wait.

**Abort outcome adaptation.** smoltalk never throws for audio; on cancellation it
resolves a distinguishable `failure("Request was aborted")`. The `LLMClient`
contract (plan §5) is the opposite — cancellation must REJECT with the branch
reason; a resolved failure means a non-cancellation failure. So the
`SmoltalkClient` adapters call `rejectIfAborted(signal)` after the smoltalk call.
If our OWN branch signal aborted, it throws `signal.reason`, the runtime's
`AgencyCancelledError`. Detection is by our signal, not by string-matching
smoltalk's message, so it holds even if that string changes. `meteredDispatch`
then records exactly one unresolved attempt for the rejection.

The adapters do this only on a FAILURE result (`if (!result.success)`). A request
that raced to a real success before a late abort keeps its success and its real
cost, rather than being discarded as a cancellation.

Three layers, all covered by tests. The wrapper's already-aborted preflight
throws before any dispatch. The `SmoltalkClient` adapts a mid-flight abort into a
rejection. For TTS, the pre-publication abort check means a cancelled synthesis
never writes its file. The `DeterministicClient` also honors the signal (rejects with
its reason) so wrapper tests can exercise mid-request cancellation offline.

Note: for a non-OpenAI provider (Gemini), smoltalk documents its cancellation as
client-only (tears down the client request, not server-side billing). Agency's
`std::speech` defaults to OpenAI (`whisper-1`/`tts-1`), which cancels fully.
