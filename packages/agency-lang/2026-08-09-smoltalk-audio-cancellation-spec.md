# What smoltalk needs to add: cancellation for `transcribe` / `speak`

## Why

Agency's `std::speech` routes cloud speech-to-text (`transcribe`) and
text-to-speech (`speak`) through smoltalk (0.10.0). Agency's design makes
cancellation a hard requirement: a Ctrl-C, a `race()` loss, or a time-guard trip
must tear down the in-flight provider request, not just stop Agency waiting for
it. The old hand-rolled `transcribe` did this by threading an `AbortSignal` into
`fetch`; routing through smoltalk 0.10.0 loses it, because the released audio API
has no way to pass a signal. This doc specifies exactly what smoltalk must add so
Agency can restore that guarantee.

The single hard requirement is: **smoltalk must pass a caller-supplied
`AbortSignal` down to the underlying OpenAI SDK call, so aborting the signal
aborts the actual HTTP request.** Everything else below is detail and a
recommended (not required) error-reporting refinement.

## Current state in smoltalk 0.10.0 (commit f3fc211)

Both audio operations use the OpenAI SDK and never accept or forward a signal:

- `TranscribeOptions` (`lib/transcription.ts`) and `SpeakOptions`
  (`lib/speech.ts`) have no `signal` field.
- `TranscriptionClientConfig` (`lib/transcription/baseTranscriptionClient.ts`)
  and `SpeechClientConfig` (`lib/speech/baseSpeechClient.ts`) have no `signal`.
- `OpenAITranscriptionClient._transcribe` calls
  `client.audio.transcriptions.create(requestBody)` with no request options
  (`lib/transcription/openai.ts`).
- `OpenAISpeechClient._speak` calls `client.audio.speech.create(params)` with no
  request options (`lib/speech/openai.ts`).

The OpenAI Node SDK's `.create(body, options)` already accepts
`options.signal: AbortSignal` and aborts the request when it fires — so the
plumbing is a pass-through, not new networking code.

## The change

### 1. Accept a `signal` on the public options

`lib/transcription.ts`:

```ts
export type TranscribeOptions = {
  model: string;
  // …existing fields…
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;   // NEW
};
```

`lib/speech.ts`:

```ts
export type SpeakOptions = {
  model: string;
  voice: string;
  // …existing fields…
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;   // NEW
};
```

### 2. Thread it into the client config

Add `signal?: AbortSignal` to `TranscriptionClientConfig`
(`lib/transcription/baseTranscriptionClient.ts`) and `SpeechClientConfig`
(`lib/speech/baseSpeechClient.ts`), and copy it through wherever the public
`transcribe()` / `speak()` wrappers build the config that the client factory
consumes (the same place `language`, `prompt`, `format`, `speed` are threaded).

### 3. Pass it to the OpenAI SDK call

`lib/transcription/openai.ts`, in `_transcribe`:

```ts
const res = (await client.audio.transcriptions.create(
  requestBody as unknown as Parameters<typeof client.audio.transcriptions.create>[0],
  { signal: this.config.signal },          // NEW second arg
)) as unknown as OpenAITranscriptionResponse;
```

`lib/speech/openai.ts`, in `_speak`:

```ts
const res = await client.audio.speech.create(params, { signal: this.config.signal }); // NEW
```

### 4. (Recommended) Short-circuit an already-aborted signal

At the top of the base `transcribe()` / `speak()` template methods, before
loading the blob / building the request, if `this.config.signal?.aborted` is
true, stop immediately (reject, or return the failure the boundary would produce
— see §5) rather than doing paid work. Not strictly required (the SDK will reject
an already-aborted request too), but it avoids the blob load and the SDK
round-trip.

## The behavioral contract Agency depends on

1. **Real cancellation.** When the signal aborts mid-flight, the underlying
   request is aborted — the work stops and stops billing where the provider
   supports it. "Agency stopped awaiting but the request kept running" does NOT
   satisfy this. (Passing the signal to the OpenAI SDK gives this for free.)

2. **Cancellation is distinguishable from an ordinary provider failure.** This is
   the one design choice for smoltalk to make. Two acceptable shapes:

   - **(A, cleanest for callers) Reject on abort.** When the failure cause is the
     caller's abort (the SDK throws `APIUserAbortError`, or `signal.aborted` is
     true in the boundary `catch`), rethrow instead of converting to a redacted
     failure `Result`. This is the only place the "audio ops never throw"
     invariant would bend, and only for caller-initiated cancellation.
   - **(B, keeps never-throws) A distinguishable failure `Result`.** Keep
     returning a `Result`, but make an aborted call's failure recognizable — e.g.
     a stable `cancelled: true` flag on the failure, or a documented error
     code/prefix — rather than an opaque redacted string.

   Agency can adapt to either: it knows its own branch signal, so on `signal.aborted`
   it maps smoltalk's outcome to a prompt rejection carrying the original abort
   reason. What Agency CANNOT do is distinguish cancellation from a coincidental
   provider error if the aborted outcome is an indistinguishable redacted failure
   string. Pick (A) or (B); (A) is less surprising.

3. **Non-abort failures are unchanged.** A real provider error (bad key, 500,
   oversize input) still resolves a redacted failure `Result` exactly as today.

4. **Secret redaction still applies** on any error that does surface (unchanged
   boundary behavior).

## How Agency consumes it once this ships

Agency is already wired for it — the `AbortSignal` is the sole cancellation
channel on `LLMClient.transcribe`/`speak`, and `SmoltalkClient` forwards it into
the smoltalk options today via a `withSignal` cast (inert until this lands). On
the smoltalk change:

1. Drop the `withSignal` cast in `lib/runtime/llmClient.ts` and set the typed
   `signal` field directly (the cast exists only because the field is absent).
2. If smoltalk chose shape (B), `SmoltalkClient` maps an aborted-and-flagged
   failure `Result` to a rejection with `signal.reason` (plan §5 already
   specifies this adapter step); if (A), the rejection already carries it.
3. Remove the "cancellation is inert" caveats from
   `docs/dev/speech-via-smoltalk.md`, the `withSignal` comment, and the CLAUDE.md
   pointer.
4. Add the two deferred tests: (a) `SmoltalkClient.transcribe`/`speak` forward the
   exact signal object to smoltalk, and (b) a real mid-flight abort rejects
   promptly with the branch reason and records exactly one unresolved attempt.
   (The DeterministicClient already honors the signal, so the wrapper-level
   cancellation paths are covered; only real-smoltalk forwarding is pending.)

## Testing smoltalk should add

- `transcribe`/`speak` forward `opts.signal` to the SDK `.create(..., { signal })`
  call (spy on the SDK method; assert the exact signal object).
- An abort fired mid-request produces the chosen outcome (A: rejects with an
  abort error; B: a distinguishable cancelled failure) and does so promptly.
- An already-aborted signal short-circuits without doing paid work (if §4 added).
- A non-abort failure is still a redacted failure `Result` (regression guard).

## Scope

Only the OpenAI clients exist in v1, so only `lib/transcription/openai.ts` and
`lib/speech/openai.ts` need the SDK-call change; the config/threading is in the
two base clients and the two public option types. No new networking, no new
dependency — the OpenAI SDK already supports `{ signal }`.
