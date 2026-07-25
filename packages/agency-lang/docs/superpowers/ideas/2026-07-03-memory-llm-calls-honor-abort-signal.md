# Memory-layer LLM calls should honor the abort signal (time-guard / race / cancel)

## Status (2026-07-03)

Idea. Not yet scheduled. Found while verifying the guard limitations
documented in `docs/site/guide/guards.md`. A sibling fact was fixed
already: memory LLM/embed calls now *charge* cost guards (see below).
This ticket is about the remaining half — memory calls are not
*cancelled* mid-flight when the abort signal fires.

## Background: two independent guard dimensions

A guard interacts with an LLM call in two separate ways:

1. **Cost accounting** — the call's dollar spend is billed to the
   active branch's guards so a `withCostGuard($X)` trips when exceeded.
2. **Cancellation** — when a time guard trips (or a `race` loses, or
   the run is cancelled via `cancel()` / REPL Esc), an `AbortSignal`
   fires and the in-flight HTTP request is aborted so you don't wait
   for (or pay for) a response you'd throw away.

These are wired through different code. The memory layer now
participates in (1) but not (2).

### (1) Cost accounting — already fixed

All memory LLM text prompts route through `MemoryManager._text()` and
all embeds through `_embed()`
(`lib/runtime/memory/manager.ts`). Both charge:

- `_text()` → `chargeCostIfInFrame(result.value.cost?.totalCost ?? 0)`
  (`manager.ts:293`).
- `_embed()` → same at `manager.ts:372`.
- `chargeCostIfInFrame` → `agency.addCost(amount)` (`manager.ts:42-45`),
  which bills every active guard.
- `rethrowIfGuard` (`manager.ts:57-59`) ensures a `GuardExceededError`
  raised while charging inside memory's best-effort catches bubbles out
  instead of being swallowed (e.g. the tier-3 recall catch at
  `manager.ts:782`).

`manager.ts:218` documents that these are the only LLM entry points
("We always go through `llmClient.text`"), so the accounting gap is
comprehensively closed. The old "Memory layer LLM calls bypass cost
guards" limitation was removed from `guards.md` as part of this
verification.

## The Problem: (2) Cancellation — still missing

The standard `llm()` path threads the composed abort signal all the way
into smoltalk:

```
ctx.getAbortSignal(stack)            // context.ts:533 — composes run-cancel + branch guards
  → parentSignal
  → armCallTimeout(parentSignal, …)  // prompt.ts:205-230
  → promptConfig.signal
  → ctx.llmClient.text(promptConfig) // prompt.ts:127 — smoltalk honors signal
```

so an in-flight standard call aborts the instant a time guard fires.

The memory path does **not** do this. `_text()` builds its request as:

```ts
this.llmClient.text({
  ...this.smoltalkDefaults,
  messages: [smoltalk.userMessage(prompt)],
  model,
  ...(options?.responseFormat ? { responseFormat: options.responseFormat } : {}),
} as any)                            // manager.ts:239-246 — NO `signal` field
```

There is no `signal`, and `smoltalkDefaults` is a static config baked in
at construction (`manager.ts:206`), not a live per-call signal. `_embed()`
(`manager.ts:315`) has the same shape. So the abort signal never reaches
the memory HTTP request.

### Observable consequence

When a time guard (or `race` loss, or `cancel()`) fires *during* a
memory extraction / compaction / recall-filter call:

1. The in-flight memory HTTP request is **not** cancelled — it runs to
   completion. You pay for it and wait for it.
2. When it returns, `chargeCostIfInFrame` bills its cost, and the next
   runner step's `shouldSkip()` throws `GuardExceededError("time")`.

So a memory LLM call currently behaves like the non-cooperative
JS-bodied tool in the `guards.md` Limitations section: **the trip is
still enforced at the next step boundary, but the in-flight call is not
preempted.** The time budget is honored in the "fail the block" sense,
not in the "stop paying / stop waiting immediately" sense.

## Why it matters (and why it's low-severity)

- **Consistency.** The standard `llm()` path aborts in-flight on a time
  trip; memory calls don't. Two LLM calls under the same `guard(time:)`
  behave differently depending on which path issued them. That's a
  surprising inconsistency even if rarely hit.
- **Wasted spend/time on trip.** A time guard is often a hard wall
  ("kill this if it takes more than N seconds"). If the tripping moment
  lands during a memory extraction call, you wait for that call and pay
  for it — exactly the outcome the abort plumbing exists to avoid.
- **Bounded blast radius.** Memory calls are single-shot (not the
  multi-turn tool loop), and auto-extraction/compaction typically run in
  `runPrompt`'s post-turn hook. Worst case is "the time guard waits for
  one memory call to finish before failing." No correctness bug, no
  runaway — just a latency/cost overrun bounded by one call's duration.

This is why it's an idea, not a bug: enforcement is correct, only
promptness is off.

## Proposed Fix

Thread the live composed abort signal into the memory request configs so
memory joins the standard cancellation path.

- In `_text()` and `_embed()`, read the live signal per-call the same way
  `chargeCostIfInFrame` reads the live frame:

  ```ts
  import { getRuntimeContext } from "../asyncContext.js"; // or wherever it's exported internally

  function abortSignalIfInFrame(): AbortSignal | undefined {
    const store = agencyStore.getStore();
    if (!store) return undefined;              // direct-construction unit tests
    return store.ctx.getAbortSignal(store.stack);
  }
  ```

  Then include `signal: abortSignalIfInFrame()` in the object passed to
  `this.llmClient.text({...})` (`manager.ts:239`) and
  `this.llmClient.embed(...)` (`manager.ts:315`).

- **Must read the ALS branch `stack`, not `ctx.stateStack`.** The
  composed signal includes guards installed on the *active branch* stack;
  inside a `fork`/`race` branch the two differ. This mirrors the note we
  added to `guards.md` / `ts-helpers.md` about
  `getRuntimeContext().stack`.

- **Consider a per-call deadline too (optional).** The standard path
  wraps each attempt in `armCallTimeout` (`prompt.ts:205-230`) so a
  single call can't hang past `policy.timeout`. Memory calls don't get
  this. Out of scope for the core fix (which is just "honor the parent
  abort"), but worth a follow-up decision: should memory calls also
  respect the LLM call-timeout policy? Probably yes, for the same
  consistency reason.

- **Cancellation error shape.** When the signal aborts an in-flight
  memory call, smoltalk will surface an abort/cancel error. Ensure the
  existing `_text` error handling (`manager.ts:248-270`) does not
  convert an `AgencyCancelledError` / `GuardExceededError` into a generic
  "memory llm text call failed" `Error` — those must propagate as-is so
  the surrounding `guard(time:)` boundary converts them to the
  `timeoutFailure`. `rethrowIfGuard` already covers `GuardExceededError`
  at the call sites; verify the cancel/abort case is handled analogously
  (an aborted memory call on a time trip should not be "fail open" —
  falling back to cheap-tier results — the way a transient provider
  error is at `manager.ts:782-792`; it should bubble).

## Touch Points

- `lib/runtime/memory/manager.ts`
  - `_text()` (`~230-296`): add `signal` to the `llmClient.text({...})`
    config; audit the failure branch (`248-270`) so cancel/guard errors
    propagate rather than being wrapped.
  - `_embed()` (`~307-372`): add `signal` to the `llmClient.embed(...)`
    config; same error-propagation audit.
  - Add the `abortSignalIfInFrame()` helper next to
    `chargeCostIfInFrame` (`~42-45`) so the two "read live frame if
    present" helpers sit together.
  - Recall tier-3 catch (`~782-792`) and any other best-effort catch:
    make sure an abort/cancel bubbles (do NOT fail open to cheap-tier
    results on a real cancellation).
- `docs/site/guide/guards.md` — once fixed, no limitation note needed;
  if we ship the fix in stages, add a temporary Limitations bullet
  ("memory LLM calls are enforced by time guards at the step boundary
  but not aborted mid-flight") and delete it when the fix lands.

## Tests

- **Time guard trips during a memory extraction call → the in-flight
  memory request is aborted** (not run to completion). Assert via a mock
  llmClient whose `text()` observes the passed `signal` and rejects on
  abort; assert the surrounding `guard(time:)` returns `timeoutFailure`
  promptly rather than after the mock's full delay.
- **`race` loser mid-memory-call is cancelled** — the losing branch's
  memory call sees the abort.
- **`cancel()` / Esc mid-memory-call** — the call aborts and the run
  unwinds.
- **In-frame vs no-frame** — direct-construction `MemoryManager` unit
  tests (no `agencyStore`) still work: `abortSignalIfInFrame()` returns
  `undefined`, request has no signal, behavior unchanged.
- **Fork branch-local time guard** — a memory call inside a branch honors
  the branch's guard, proving we read `getRuntimeContext().stack` not
  `ctx.stateStack`.
- **Cost accounting unchanged** — existing memory cost-charging tests
  still pass (the fix is additive; it doesn't touch `chargeCostIfInFrame`).

## Related

- `docs/site/guide/guards.md` — guard semantics; "Cooperative
  cancellation from TypeScript" section documents the same
  `getAbortSignal(stack)` hook for user TS code.
- `docs/site/guide/ts-helpers.md` — "Respecting cancellation (the abort
  signal)".
- `lib/runtime/prompt.ts:94-127, 205-230` — the standard-path signal
  wiring this fix mirrors.
- `lib/runtime/state/context.ts:533-536` — `getAbortSignal(stack)`
  composition.
- `docs/superpowers/ideas/2026-07-03-guard-trip-preserves-value.md` — the
  other guard follow-up from the same review session; this cancellation
  gap is a natural companion but independent of it.
- `docs/dev/threads.md` — memory layer runs inside `runPrompt`'s
  post-completion hook; explains why the frame is present in production.
