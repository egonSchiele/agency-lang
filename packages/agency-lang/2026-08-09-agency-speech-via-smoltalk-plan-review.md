# Review: Wiring Agency speech support to smoltalk

## Verdict

**Revise before implementation.** The thin-wrapper direction is sound, but the plan is not yet safe or complete enough to execute. It changes an approval effect from local playback to cloud data transfer, drops the current transcription cancellation guarantee, and understates the accounting and wire-schema work. The upstream smoltalk API is also still under active review, so Agency should not publish aliases for it yet.

## Blocking findings

### 1. Do not reuse `std::speak` for a cloud operation

The plan assigns `std::say` to local playback and reuses `std::speak` for cloud TTS (plan lines 85–108). Today, `std::speak` authorizes the local macOS `say` subprocess (`stdlib/speech.agency:28-48`). A handler or command-line policy that already approves `std::speak` would silently begin authorizing transmission of text to an external provider. Changing the human-readable prompt does not protect non-interactive handlers, which match the effect contract.

Cloud synthesis needs a new cloud-specific effect. Its payload should identify at least the requested provider, model, and text length. Keep `std::say` for local playback. The transcription effect and prompt must likewise stop claiming that the destination is necessarily OpenAI once `provider` and custom clients are supported.

This is safety infrastructure, not ordinary backwards compatibility. The claim that there are no users does not make it safe to change what an existing approval means.

### 2. Preserve real cancellation, not just the pre-call interrupt

Current transcription passes `ctx.getAbortSignal(stack)` into `fetch`, so Ctrl-C, a race loss, or a time guard aborts the upload (`lib/stdlib/speech.ts:212-264`). The proposed methods only receive `Partial<TranscribeOptions>` and `Partial<SpeakOptions>`. In the current smoltalk PR, neither options type has an abort signal.

The interrupt before dispatch and cancellation during dispatch solve different problems. As written, a cancelled race loser can continue uploading or synthesizing, incur cost, and later write a file.

Make cancellation support a prerequisite at the `LLMClient` boundary and in smoltalk. Both the real and deterministic clients must honor the branch abort signal. Add tests proving that cancellation stops the underlying request and prevents a later TTS write. Racing the provider promise against an abort promise without cancelling the request is not sufficient.

### 3. Wait for a stable smoltalk release before exposing its types

[smoltalk PR #36](https://github.com/egonSchiele/smoltalk/pull/36) is still open and received architectural rework requests on 2026-08-09. Cancellation, error provenance, and effective-model identity are also absent from the current API. Directly aliasing those unreleased option and result types in Agency's public `LLMClient` would freeze an unstable contract.

Add an explicit landing gate: the smoltalk PR must merge and be released, Agency must pin or require that released version, and the final API must be re-audited before implementation. In particular, verify abort support, failure provenance, result field names, credential configuration, and token fields against the released declarations rather than the current branch.

### 4. Choose one public failure contract

The plan simultaneously says that:

- `transcribe` keeps its current public signature;
- cloud `speak` returns a file-path `string`; and
- unsupported clients and provider failures return a failure `Result` like `std::image`.

Those contracts are incompatible. Current `transcribe` is declared as `string` and throws on failure (`stdlib/speech.agency:76-88`), while `generateImage` is explicitly declared as `Result` (`stdlib/image.agency:21-45`). Returning an Agency failure object through a `string` declaration is a type-contract violation.

Decide this before implementation. The smallest compatibility-preserving choice is for both speech functions to return `string` and translate smoltalk failure Results into thrown errors. If recoverable failures are preferred, explicitly change both public APIs to return `Result` and document the breaking change.

### 5. Define failure provenance for cost accounting

`meteredDispatch` records an unresolved paid attempt only when a promise rejects (`lib/runtime/recordPaidUsage.ts:109-127`). The current smoltalk audio APIs catch provider exceptions and resolve to failure Results. Therefore a provider failure after dispatch can incur unknown spend while Agency leaves `pricingComplete` true.

This is the existing #809 boundary for image generation, but the plan currently promises that routing through smoltalk supplies complete cost accounting. It does not. The revised plan must either:

1. require smoltalk to distinguish a proven pre-dispatch failure from a dispatched-but-unpriced failure;
2. conservatively record audio failure Results as unresolved attempts; or
3. explicitly accept and document the #809 gap for this feature.

Add tests for a rejected promise, a pre-dispatch failure Result, a post-dispatch failure Result, and cancellation. Do not invent a numeric cost when only an unresolved attempt is known.

## Required design corrections

### 6. Expand the full accounting and spend contracts

Adding two members to `ProviderUsageKind` is not the only structural change. The following are closed contracts today:

- `SmoltalkCost`, `SmoltalkTokens`, `ProviderUsageKind`, and `USAGE_KINDS` in `lib/runtime/invocationUsage.ts`;
- kind validation and entry recovery across the subprocess IPC boundary;
- `TokenBreakdown`, its normalizers, checked accumulation, snapshots, and IPC recovery;
- the strict `usageKindSchema` and `tokenBreakdownSchema` in `lib/cli/statelog/spendTypes.ts`;
- the companion statelog server/database schema described in `docs/dev/invocation-usage-accounting.md`;
- statelog's local `TokenUsage` shape and relevant renderers/tests.

The plan's statement that new audio token fields are inherited automatically is false for these Agency-owned normalized and wire types. Decide whether `inputAudioTokens` and `outputAudioTokens` are preserved end to end or intentionally represented only in `totalTokens`. If they are preserved, update the client and server as a pinned pair. If they are collapsed, document the loss of attribution and test it.

Cost-only TTS is already conceptually valid, but every new usage kind still needs runtime normalization, IPC round-trip, process-version-skew, spend-schema, and rendering tests.

### 7. Make model attribution explicit

The accounting sketch refers to `result.model-ish`, but the current `TranscriptionResult` and `SpeechResult` have no `model` field. If the stdlib passes an empty model and `SmoltalkClient` inserts the default internally, the wrapper cannot attribute spend or statelog data to the effective model and will fall back to `"unknown model"`.

Resolve a non-empty effective model before dispatch and use that same value for client config, accounting, and statelog, or define an Agency-owned result contract that reports the effective model. Do not make deterministic results claim a field that real client results do not provide. The default TTS voice must also be named explicitly in the public contract rather than left as “sensible.”

### 8. Specify TTS output-path and ordering semantics

The new file-producing operation needs an outcome matrix, not just “write the audio to a file.” Define:

- the generated path and extension when `outputFile` is empty;
- the relationship between `format`, returned MIME type, and an explicit filename extension;
- allow-list validation before paid dispatch;
- accounting when the provider succeeds but the local write fails;
- whether a paid artifact is written when a cost guard trips;
- cleanup behavior for partial writes and cancellation;
- which error wins if guard enforcement and file I/O both fail.

A safe default sequence is: resolve and authorize an explicit path, dispatch, record provider usage and statelog, enforce guards, then write and return the artifact. If the desired semantics instead retain the artifact after a guard trip, state that deliberately. In all cases, provider success must be accounted even when the subsequent write fails, and cancellation must not permit a late write.

### 9. Do not accidentally add audio to `attachToReply`

`attachToReply` accepts the shared `Attachment` union (`stdlib/thread.agency:142-153`). Adding an audio arm therefore widens that API automatically. The runtime reply pipeline only supports image and file parts (`lib/runtime/replyAttachments.ts:31-39`); it treats every non-image attachment as a PDF/file for modality checks, labels, and fallback MIME types (`lib/runtime/replyAttachments.ts:71-83,162-196`). The cast in `_attachToReply` bypasses runtime validation (`lib/stdlib/thread.ts:246-268`).

Either give `attachToReply` a narrower image/file-only alias while allowing audio in ordinary messages, or include complete audio reply support in scope. Add a test proving that `audio()` passed to `attachToReply` is rejected by the typechecker or handled correctly end to end.

### 10. Correct the statelog/viewer plan

Unknown event types do not render as a generic span: `inferSpanLabel` returns `evt.data.type` by default (`lib/logsViewer/tree.ts:247-290`). Explicit label cases are unnecessary if the event type is already the desired label.

Decide whether transcription and synthesis are leaf events in the current span or dedicated spans. If they are leaf events, remove the viewer-label task and add only event schema/method tests. If they are dedicated spans with cost roll-ups, plan the span lifecycle and viewer aggregation explicitly; adding a statelog method alone does not create a span.

## Test and sequencing changes

The implementation sequence should begin only after the upstream release gate and the decisions above. The test section should include focused runtime tests modeled on `lib/stdlib/image.test.ts`, not only Agency execution fixtures:

- unsupported optional client method;
- success with cost and no token usage for TTS;
- successful STT usage including audio-token policy;
- accounting before guard enforcement;
- rejected dispatch and each failure-Result provenance case;
- cancellation of both capabilities;
- output allow-list validation, write failure, partial-file cleanup, and guard-trip behavior;
- statelog previews without audio bytes;
- IPC and remote-spend parsing for both new kinds;
- ordinary audio messages plus the chosen `attachToReply` behavior.

The deterministic client should support configurable delay/cancellation for these tests. Fixed happy-path values alone are insufficient.

## What can remain

The following parts of the plan are sound once the blockers are resolved:

- keeping recording and local playback outside smoltalk;
- retaining Agency's path allow-list as an Agency-owned safety layer;
- using optional `LLMClient` capabilities for custom-client compatibility;
- keeping audio bytes out of statelog;
- representing ordinary chat audio as a smoltalk `AudioPart`/compatible declarative value;
- accounting successful provider work before enforcing spend guards.

After revising the plan, request another review before implementation.
