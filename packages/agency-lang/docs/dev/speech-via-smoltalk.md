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
`say`. The `speak` name is the new CLOUD TTS. This is a deliberate,
approval-safety-relevant change — see the effect note below.

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

## ABI freeze: `_speak` stays local (`lib/stdlib/speech.ts`)

`_speak` and `__internal_speak` are exported runtime symbols that meant LOCAL
playback. An already-compiled artifact can import them against a newer runtime,
so they are kept with their exact old local behavior. New local `say()` calls
`_say` (same private `speakImpl`); new cloud `speak()` calls the NEW
`_synthesizeSpeech`. No runtime symbol ever changes from local to cloud meaning.

## Failure accounting: honest #809 provenance (`lib/stdlib/speech.ts`)

smoltalk's `transcribe`/`speak` never reject — they resolve a failure `Result`.
`meteredDispatch` only records an unresolved attempt on a REJECTED promise, so a
resolved failure would leave `pricingComplete` true. The wrapper therefore
records exactly one unresolved attempt on a resolved failure Result itself
(`recordUnresolvedAttempt`). Success path mirrors `_generateImage`: `recordUsage`
→ `addTokens` (STT only; TTS has no tokens) → statelog leaf event →
`enforceGuards()` LAST. Cost is recorded only on success; a guard trip still
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
  COLLAPSED into `totalTokens` for v1 — they never surface as their own fields
  in the normalized `TokenBreakdown`. `buildTokens` only uses them to widen the
  FALLBACK total to a conservative `max(text-sum, audio-sum)` lower bound when
  the provider's `totalTokens` is absent/malformed, and marks attribution lost
  in that case.
- Leaf events `transcription` + `speechSynthesis` (`lib/statelogClient.ts`)
  mirror `imageGeneration`. Previews are `PROMPT_PREVIEW_MAX`-capped; audio
  bytes / `raw` / `pcm` are never logged. The wrapper projects usage/cost to the
  closed field sets before handing them to the event.

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
  alias NAMES `Attachment | MessageAttachment`. This is because at an `llm()`
  call site the user file usually has not imported these aliases, so the checker
  compares them as unresolved aliases by name (assignability.ts) — a single alias
  would reject whichever builder returns the other name.

## Branch-build caveat (remove when smoltalk #36 ships)

This work was built against the unreleased smoltalk `audio-stt-tts` branch
(PR #36), overlaid into the worktree's `node_modules`. Two things depend on the
released API and are currently forward-compatible stubs:

1. **Cancellation.** smoltalk's `TranscribeOptions`/`SpeakOptions` do not yet
   carry an `AbortSignal`. `SmoltalkClient` forwards the branch signal into the
   opts via `withSignal` (one cast), so it "just works" once upstream adds the
   field — but until then mid-flight cancellation is INERT; only the wrapper's
   already-aborted preflight applies. The `AbortSignal` is already the sole
   cancellation channel on the `LLMClient.transcribe`/`speak` methods.
2. **Version pin.** Agency still pins `smoltalk ^0.8.4`. Pinning the released
   audio version is the first step once #36 lands.

When #36 releases: pin it, drop the `withSignal` cast if the option becomes
first-class, re-audit result field names / error provenance, and add the
`SmoltalkClient` adapter forwarding + cancellation unit tests deferred here.
