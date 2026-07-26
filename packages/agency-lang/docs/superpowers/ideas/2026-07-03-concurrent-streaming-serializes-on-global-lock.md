# Concurrent streaming serializes on a global boolean lock (and degrades to interleaving after 60s)

## Status (2026-07-03)

Idea. Not yet scheduled. Surfaced while reviewing PR #416 (fix streaming
`onStream` to honor `callback()` registrations). egonSchiele's PR review
independently flagged the same `ctx.onStreamLock` concern inline. The
`onStream`-scoped-callback fix is what makes concurrent per-branch
streaming actually *reachable*, so this limitation is now worth fixing.

## The Problem

`handleStreamingResponse` guards streaming with a single process-wide
boolean, `ctx.onStreamLock` (`lib/runtime/state/context.ts:79`). Because
`runBatch` hands the **same `ctx`** to every fork/race/parallel branch
(`runBatch.ts:296,738`), that boolean is shared across all branches in a
run. The acquire block (`lib/runtime/streaming.ts:82-92`):

```ts
let count = 0;
while (ctx.onStreamLock && count < 10 * 60) {   // poll every 0.1s, up to 60s
  await builtinSleep(0.1);
  count++;
}
if (ctx.onStreamLock) {
  console.log(`Couldn't acquire lock, ${count}`);
}
ctx.onStreamLock = true;                          // ← unconditional
// ... stream all chunks ...
finally { ctx.onStreamLock = false; }
```

Three distinct problems:

1. **Needless serialization.** Two branches that each stream to their own
   independent `onStream` consumer still take turns: branch A holds the
   lock for its entire stream, branch B busy-waits, then streams. You
   cannot stream multiple concurrent responses live — e.g. a dashboard
   showing N sub-agents streaming at once delivers them one after
   another. The lock is keyed on the *run*, not on the consumer.

2. **No mutual exclusion after 60s.** The wait caps at `600 × 0.1s`.
   If the holder streams longer than 60s, the waiter falls out of the
   loop and line 92 sets `onStreamLock = true` **unconditionally** even
   though A never released it. B streams concurrently with A, and B's
   `finally` later clears the lock while A is still mid-stream. So the
   "no interleaving" guarantee silently breaks under long streams —
   chunks from A and B interleave into whatever consumers each resolves.

3. **Reentrancy now that emits are awaited (PR #416).** `emit` is now
   `await`ed and runs arbitrary Agency callback bodies inline while the
   lock is held. A `callback("onStream")` body that issues another
   `llm(..., stream: true)` — directly or transitively — re-enters
   `handleStreamingResponse`, hits the held lock, busy-waits 60s,
   force-acquires, and on completion clears the *outer* stream's lock.
   (Open question: is a streaming `llm()` even permitted inside a
   callback body? Callback bodies are barred from raising interrupts by
   the typechecker, but a plain streaming `llm()` may still be allowed —
   needs confirming. If it is reachable, this is a real footgun.)

The busy-wait boolean predates PR #416 and was harmless while the only
consumer was a single host-passed `onStream` (the TS-passed path). The
scoped/top-level callback fix is what makes multiple branches actually
funnel through this `else` branch at once.

## Why the boolean exists at all

The lock's legitimate purpose: stop two concurrent streams from
interleaving their chunks into the *same* sink (one host `onStream`
callback), which would produce garbled output. That intent is sound; the
implementation (one global boolean, busy-wait, force-acquire) is not, and
it over-applies the constraint to streams that don't share a sink.

## Proposed Fix

Replace the single global boolean with a **per-consumer serialization
key**, so streams that target different consumers run concurrently and
only streams that would collide on the same sink serialize — and do it
with a real async mutex, not a busy-wait boolean.

Design sketch:

- **Serialize per consumer, not per run.** Derive a key from the
  resolved consumer set (e.g. the identity of the gathered `onStream`
  callbacks, or the branch's active-thread id as a proxy for "which sink
  this stream feeds"). Two streams with disjoint keys never block each
  other. The natural key is probably the branch/thread the stream
  belongs to, since that's what maps to a UI sink.
- **Use `agency.withLock(name, fn)`** — the runtime already has a proper
  named async mutex (`lib/runtime/agency.ts` `withLock`, backed by
  `stack.locks`/`lockOwners`, IPC-aware for subprocesses). Wrapping the
  stream loop in `withLock("std::onStream:<key>", ...)` gives real mutual
  exclusion (queued, not busy-waited; released in `finally`; no 60s
  force-acquire) and reuses tested machinery instead of a bespoke
  boolean. This likely subsumes the whole hand-rolled block.
- **Reentrancy:** `withLock` is non-reentrant per `ownerId`; decide
  whether a nested streaming `llm()` in a callback should (a) be
  statically disallowed (simplest — extend the callback-body checker),
  or (b) use a distinct key so it doesn't self-deadlock. Prefer (a)
  unless there's a real use case.
- **Drop the 60s force-acquire entirely.** With a real mutex there's no
  need for a timeout escape hatch; if a stream genuinely hangs, that's a
  cancellation/timeout concern handled by the abort signal, not by
  silently letting a second writer in.

## Touch Points

- `lib/runtime/streaming.ts` — replace the `onStreamLock` acquire/finally
  block (`~82-124`) with a `withLock`-wrapped stream loop keyed per
  consumer/branch.
- `lib/runtime/state/context.ts` — remove `onStreamLock` (`:79`, `:217`,
  `:300`, `:630`) once nothing references it.
- `lib/runtime/agency.ts` — reuse `withLock`; no change unless a
  streaming-specific key helper is warranted.
- Callback-body checker (wherever `checkCallbackBodyInterrupts` lives) —
  if we disallow streaming `llm()` inside callback bodies (reentrancy
  option (a)), add that rule.

## Tests

- **Two `parallel` branches, different consumers, stream concurrently** —
  assert their chunk deliveries overlap in time (or at least that neither
  blocks the other), rather than strict A-then-B serialization.
- **Two branches, same host consumer** — assert chunks are NOT interleaved
  (the one case that must still serialize).
- **Long stream + sibling** — a >60s holder must not let a sibling
  force-acquire and corrupt delivery (the current bug); with a real mutex
  the sibling simply waits.
- **Reentrancy** — a streaming `llm()` inside an `onStream` callback body
  either fails the typecheck (option a) or completes without deadlock
  (option b) — pin whichever behavior we choose.
- **Subprocess streaming** — subprocesses get a fresh exec context today
  (`context.ts:300`); confirm the new keying keeps them independent.

## Related

- PR #416 — the `onStream` scoped/top-level callback fix that makes
  concurrent per-branch streaming reachable; egonSchiele's inline review
  on `streaming.ts:98` and `:80` raised problems (2) and (3) above.
- `lib/runtime/agency.ts` `withLock` — the existing async mutex to reuse.
- `docs/dev/runBatch.md` — fork/race/parallel branch model and shared-ctx
  semantics.
- `docs/site/guide/streaming.md` — user-facing streaming docs; should
  eventually document concurrent-streaming semantics once fixed.
