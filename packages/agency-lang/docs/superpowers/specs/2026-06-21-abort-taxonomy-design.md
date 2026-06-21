# Abort Taxonomy & Disposition Architecture

**Status:** Design approved; ready for implementation planning.
**Scope of this spec:** Describes the full target architecture, but splits delivery into two increments. **Increment 1 (Core)** is the implementable-now plan that turns CI green and lays the carrier foundation. **Increment 2 (Full unification)** is described in detail here but is explicitly deferred to a *separate* implementation plan.

---

## 1. The concrete problem

Three Agency fixture tests fail on CI ([run 27907963302](https://github.com/egonSchiele/agency-lang/actions/runs/27907963302/job/82579909174)), all time-guard tests:

- `tests/agency/guards/guard-time-trip.test.json`
- `tests/agency/guards/guard-time-nested.test.json`
- `tests/agency/guards/guard-time-and-cost.test.json`

Cost-guard fixtures and the 27-case `lib/runtime/guard.test.ts` unit suite all pass. The regression appeared when we added **"press Esc to cancel the in-flight request"** to the agency agent (`docs/superpowers/plans/2026-06-02-tui-pr6-ws3a-esc-cancel.md`, and the REPL-side `installCancelKey` in `lib/stdlib/cli.ts`).

### Root cause

The failure is a process crash, not an assertion miss:

```
file:///.../dist/lib/stdlib/abortable.js:170
            reject(new AgencyCancelledError("sleep cancelled"));
                   ^
AgencyCancelledError: sleep cancelled
    at AbortSignal.onAbort (.../abortable.js:170:20)
    ...
    at Timeout._onTimeout (.../runtime/guard.js:259:62)   // TimeGuard timer → controller.abort()
```

The chain:

1. A `TimeGuard` timer fires and calls `this.controller?.abort()` **with no reason** (`lib/runtime/guard.ts:364`, inside `startWindow`).
2. That abort is composed into `stack.abortSignal`, which an in-flight `sleep()` is listening on. Sleep's abort handler rejects with a **bare** `AgencyCancelledError("sleep cancelled")` (`lib/stdlib/abortable.ts:170`) — an error that carries *no information about why it aborted*.
3. **Before** Esc-cancel: the generated per-function/per-node catch ladders converted `AgencyCancelledError` into a `Failure`, so the guard's `try` still observed a budget failure and the time guard surfaced a `timeoutFailure`.
4. **After** Esc-cancel: those ladders now *re-throw* `isAbortError` so user cancellations propagate cleanly (`lib/templates/backends/typescriptGenerator/functionCatchFailure.ts:23`, `lib/backends/typescriptBuilder.ts:2554`). The bare cancel from `sleep` now escapes the guard boundary as an **unhandled async rejection** and crashes the process.
5. The runner's `shouldSkip` guard-sniff added to mitigate this (`lib/runtime/runner.ts:241`, commit `99e92199`) only catches the *synchronous step-boundary* case. The `sleep` rejection fires from the timer's microtask and never passes through a step boundary, so the sniff misses it.

The deeper issue: **the leaf abort cannot tell the guard boundary "I am a guard trip — convert me to a Failure" because intent is not carried.** Every abort is the same `AgencyCancelledError`, discriminated only by re-derivation at catch time. The Esc-cancel change made the default disposition "propagate," and there's no carried signal to override it back to "convert" for guard-owned aborts.

---

## 2. Background: the current architecture and its surface area

A full survey of every abort throw/catch/derive site (file:line references below) reveals **one transport carrying many intents**.

### 2.1 The "must-propagate, never-convert-to-Failure" family

Every generated function catch (`functionCatchFailure.ts`), every generated node catch (`typescriptBuilder.ts:2543`), and `__tryCall` (`result.ts:62`) check these *in priority order* and re-throw them so they are not swallowed into a `Failure`:

1. `RestoreSignal` — checkpoint restore (not an abort; a separate control signal).
2. `GuardExceededError` — so the stdlib `guard`'s own `try` can catch and structure it.
3. `AgencyCancelledError` / `AbortError` — cancellation.
4. `PromptBailout` — interrupt batching (handled in `prompt.ts`).

### 2.2 Where aborts originate (5 transports, all funneling to one error)

- `ctx.cancel(reason)` → global `abortController` (`context.ts:517`). Fired by: **TS-interop `cancel()`** callback (`node.ts:228`), **external `abortSignal`** passed to `runNode` (`node.ts:229`), **Esc in the REPL** (`cli.ts:778`), and **`ctx.cleanup()`** GC (`context.ts:542`).
- **Time guard** → composes an abort into branch-local `stack.abortSignal` (`guard.ts:349` `installAbortPlumbing`, `:364` the `abort()` call).
- **Race-loser / fork** → fires branch-local `stack.abortSignal`.
- **Cost guard** → throws `GuardExceededError` *directly*, no signal (`guard.ts:151`).
- **stdlib leaf ops** → translate their own abort to `AgencyCancelledError`: `http.ts:87`, `abortable.ts` (spawn/exec/sleep — `:55/:105/:115/:141/:168/:182/:202/:211`), `builtins.ts:55/:64` (input), `ui.ts:864`, `oauth.ts:177`, `speech.ts:169`.
- **prompt.ts** normalizes provider abort errors → `AgencyCancelledError` when `ctx.isCancelled` (`prompt.ts:242`).

### 2.3 The re-derivation smells (intent reconstructed at catch time)

- `runner.shouldSkip` (`runner.ts:241`) walks `stack.guards` innermost-first to decide a three-way: **guard trip** (throw `GuardExceededError`) vs **guard-already-consumed** (fall through for cleanup) vs **external/race-loser** (halt silently). This is the exact debt; it's what broke under Esc-cancel.
- `prompt.ts:242` uses `ctx.isCancelled` *state* as the authority to reclassify an unrecognizable provider error as a cancel.
- `__tryCall` (`result.ts:84`) reclassifies `GuardExceededError` into `{guardFailure}` / `{timeoutFailure}` Result shapes by sniffing `.type`.

### 2.4 Cleanup is scattered and origin-coupled, not cause-driven

- `markThreadCancelled` (thread repair for dangling tool calls) fires in `prompt.ts:1106` on **any** abort — including guard trips and race-losers, which don't need thread repair.
- `resetCancel` — REPL only (`cli.ts:812`).
- `deleteBranch` — tool-branch cleanup (`prompt.ts:699`).
- `popGuard` timer teardown — guard `finally`.

### 2.5 Disposition is decided by *where* an abort is caught, not *what* it is

A guard trip becomes a `Result` only because the stdlib `guard`'s `try` happens to wrap it; everything else propagates to the top. There is **no representation at all** for environmental/recoverable aborts (network drop, laptop closed) or per-call timeouts — exactly the cases we lack UX for.

---

## 3. Design: carry intent, convert at boundaries

The architecture rests on three ideas.

### 3.1 `AbortCause` — a tagged value carried on every abort

`signal.reason` is **always** an `AbortCause` (never a bare string); directly-thrown aborts carry the same value. The taxonomy:

```ts
type AbortCause =
  | { kind: "userInterrupt" }                     // Esc — stop work, hand control back, session lives
  | { kind: "userKill"; reason?: string }         // TS cancel() — terminal, propagate to caller
  | { kind: "guardTrip"; dimension: "cost" | "time"; limit: number; spent: number; guardId: string }
  | { kind: "raceLoser" }                          // internal — a fork/race sibling won
  | { kind: "cleanup" }                            // internal — ctx.cleanup() GC
  // ---- future (Increment 2+ / separate plans) ----
  | { kind: "callTimeout"; limitMs: number }       // one LLM call exceeded its own timeout; retryable
  | { kind: "connectionLost"; detail: string }     // environmental; recoverable
```

The cause is **read, never re-derived**. Every catch site that currently sniffs switches on `cause.kind`.

### 3.2 Boundaries convert; everything else propagates

Disposition is currently an accident of which catch fires. Make it explicit: each cause has an **owning boundary** that recognizes it (by `kind`, plus identity such as `guardId`) and converts it. Any abort that reaches a frame which is *not* its owning boundary simply keeps unwinding.

| cause | owning boundary | becomes at the boundary | cleanup at boundary |
| --- | --- | --- | --- |
| `guardTrip` | the matching `guard` block (by `guardId`) | `Result` (`GuardFailureData`) | `popGuard` timers |
| `userInterrupt` | the REPL turn | propagates; REPL prints "cancelled", reprompts | `markThreadCancelled` + `resetCancel` |
| `userKill` | the TS run boundary (`runNode`) | propagates to the caller | `markThreadCancelled` |
| `raceLoser` / `cleanup` | branch / run | halt silently | `popBranches` |
| `connectionLost` / `callTimeout` | (future) the call or an enclosing recover-scope | recoverable `Failure` / retry | thread repair if needed |

This is ordinary typed-exception handling, except the discrimination data rides on the cause instead of being reconstructed.

### 3.3 Cleanup becomes cause-driven

Thread repair (`markThreadCancelled`) runs only for `user*` causes — not for `guardTrip` or `raceLoser`, which don't leave dangling tool calls the way a mid-LLM user cancel does. This removes the `prompt.ts:1106` "repair on any abort" coupling.

---

## 4. Increment 1 — Core (this plan): green CI + carrier foundation

**Goal:** Turn CI green by fixing the three time-guard fixtures, and lay the `AbortCause` carrier so Increment 2 is purely a type-unification refactor. **No codegen template change. No fixture regeneration.** `AgencyCancelledError` and `GuardExceededError` remain as distinct types.

### 4.1 What changes

1. **Define `AbortCause`** (in `lib/runtime/errors.ts` or a new `lib/runtime/abortCause.ts`) plus helpers:
   - `abortWith(controller, cause)` — `controller.abort(cause)`.
   - `readCause(signal | error): AbortCause | undefined` — reads `signal.reason` if it's an `AbortCause`, else `undefined`; also reads a `cause` field off an abort error (see step 3).
   - `isGuardTrip(cause)`, etc., as needed.

2. **Producers attach a structured cause** instead of `undefined`/string:
   - `TimeGuard.startWindow` (`guard.ts:364`): `this.controller.abort(guardTripCause(...))` carrying `{ kind: "guardTrip", dimension: "time", limit, spent, guardId }`. *(`spent` may be approximate at abort time; `check()` still computes the exact value — the cause's role is discrimination, not the authoritative number.)*
   - `context.cancel(reason)` (`context.ts:517`): abort with `{ kind: "userKill", reason }` for the TS/external path and `{ kind: "userInterrupt" }` for the Esc path. Distinguish via an argument to `cancel` (the REPL's `installCancelKey` passes the interrupt variant; `node.ts`/TS-interop passes kill).
   - Race/fork abort site: abort with `{ kind: "raceLoser" }`.
   - `ctx.cleanup()` (`context.ts:542`): `{ kind: "cleanup" }`.

3. **Leaf ops propagate the cause** instead of minting a bare cancel. The crashing site `abortable.ts:170` (and its siblings, plus `http.ts:87`, `builtins.ts`, `ui.ts:864`, `oauth.ts`, `speech.ts`) read `signal.reason` and reject with an `AgencyCancelledError` **that carries `cause`** (add a `cause?: AbortCause` field to `AgencyCancelledError` for Increment 1 — small, additive, no type unification yet). If `signal.reason` is a `guardTrip`, the rejection carries it; the guard boundary converts it.

4. **Boundaries read the cause:**
   - `runner.shouldSkip` (`runner.ts:241`): replace the innermost-first `guards` walk with `switch (readCause(stack.abortSignal)?.kind)`. `guardTrip` → return the matching guard's `check()` error (or build the `GuardExceededError` from the cause). `raceLoser`/`cleanup` → silent halt. `userInterrupt`/`userKill` → propagate (no silent halt). This is the direct regression fix.
   - The **guard `try` boundary** (`result.ts` `__tryCall` / stdlib `guard`): when catching an abort error whose `cause.kind === "guardTrip"` and whose `guardId` matches this guard, convert to the structured `Failure`; otherwise re-throw so it keeps unwinding to its real owner. **This is the fix for the async-leaf-rejection crash**: the `sleep` rejection now carries `guardTrip`, so the enclosing guard converts it instead of letting it escape.
   - `prompt.ts:242` normalization: prefer `readCause(...)` over the `isCancelled`-state heuristic where a cause is present; keep the existing heuristic as a fallback for provider errors that arrive with no cause.

5. **Cause-driven thread repair:** `prompt.ts:1106` runs `markThreadCancelled` only when `readCause(error)?.kind` is `userInterrupt`/`userKill` (or cause is absent — conservative default), not for `guardTrip`/`raceLoser`.

### 4.2 What does NOT change in Increment 1

- The generated catch ladders (`functionCatchFailure.ts`, `typescriptBuilder.ts:2543`) stay as-is — they still `instanceof GuardExceededError` / `isAbortError` and re-throw. Because they only *propagate* (never inspect cause), they need no change. **→ zero fixture regeneration.**
- `GuardExceededError` and `AgencyCancelledError` remain separate classes.
- `isAbortError` / `isGuardExceededError` keep their current name-based cross-module checks.

### 4.3 Acceptance for Increment 1

- The 3 time-guard fixtures pass; CI is green.
- `lib/runtime/guard.test.ts` (27) and all cost-guard fixtures stay green.
- Esc-cancel still aborts the in-flight LLM call and reprompts (manual + `lib/stdlib/ui.test.ts` / `ui-smoke.test.ts`).
- Race/fork tests (`tests/agency/fork/race/*`) stay green.
- New unit test: a time guard wrapping an in-flight `sleep` trips and produces a `timeoutFailure` Result, with **no unhandled rejection** (the exact CI crash, locked down).
- New unit test: `readCause` round-trips each `AbortCause` variant through both `signal.reason` and an `AgencyCancelledError.cause`.

---

## 5. Increment 2 — Full unification (SEPARATE implementation plan)

> This section documents the target end-state in detail. **It is not part of the Increment 1 plan.** It should become its own spec→plan→implementation cycle once Increment 1 has landed and CI is green.

### 5.1 Goal

Collapse the two abort error types and the multi-rung catch ladder into a single carrier, so the taxonomy is the *only* representation of an abort anywhere in the system.

### 5.2 Changes

1. **One error type:** `AgencyAbort extends Error { readonly cause: AbortCause }`. `GuardExceededError` becomes `AgencyAbort` with `cause.kind === "guardTrip"`; `AgencyCancelledError` becomes `AgencyAbort` with a `user*`/`raceLoser`/`cleanup` cause. Keep thin compatibility shims (or codemod call sites) across the ~27 non-test `lib/` files that currently reference the old classes.
2. **Collapse the codegen ladder:** the per-function and per-node catches reduce to:
   ```
   if (__error instanceof RestoreSignal) throw __error;   // still a separate control signal
   if (__error instanceof AgencyAbort)   throw __error;   // all aborts: one check
   // ...else log + convert to Failure
   ```
   Update `functionCatchFailure.mustache` + `imports.ts` + `typescriptBuilder.ts:2543`, run `pnpm run templates`, then `make fixtures`.
3. **Regenerate ~95 fixtures** (`grep -rl __isAbortError tests | wc -l` ≈ 95). Large but mechanical diff; spot-check a couple of regenerated catches, trust the rest. Land this in its own commit so the churn is reviewable in isolation.
4. **Migrate stdlib leaves** (`http`, `abortable`, `builtins`, `ui`, `oauth`, `speech`) to throw `AgencyAbort` carrying the read cause.
5. **Unify the predicates:** `isAbortError` becomes `instanceof AgencyAbort` (plus the existing `DOMException("AbortError")` / name-based cross-module fallback). `isGuardExceededError` becomes `cause.kind === "guardTrip"`. `__tryCall` converts by reading `cause` directly.

### 5.3 Why staged this way

Increment 1's semantic core (the regression fix) is reviewable on its own with no fixture churn. Increment 2's ~95-fixture diff lands in isolation where it's obviously mechanical, and the "handlers are safety infrastructure" propagate-never-swallow contract can be re-verified site-by-site without being tangled in behavior changes. Same end-state; lower risk per PR.

---

## 6. Future extensions (beyond both increments)

The taxonomy is designed so these are *additions*, not redesigns:

- **`callTimeout`** — a per-LLM-call timeout (sibling of a time guard but scoped to one call, with a retry disposition). New cause variant + a boundary that retries N times before surfacing a `Failure`. See `docs/superpowers/plans/2026-05-24-timeout-guards.md` for prior thinking.
- **`connectionLost`** — environmental aborts (network drop, laptop closed). Today these surface either as a non-abort fetch error converted to a useless string `Failure`, or as a misclassified cancel. A new cause + a recoverable-failure disposition gives the agency agent a real "lost connection — retry?" UX.
- **Notification callbacks** (cheapest near-term UX, layerable on Increment 1): add side-effect-only hooks such as `onAbort(cause)` / `onConnectionLost(detail)` to the callbacks system (`docs/site/appendix/callbacks.md`). These can *notify* (print a message) but, per the decision record in §7, **cannot** decide disposition.
- **A language surface** for authors to declare custom abort handling. Deferred deliberately (see §7). Whatever shape it takes, the backend already speaks `cause → boundary → disposition`, so the surface is sugar over registering a boundary/policy — not a new mechanism.

---

## 7. Decision record: why not handlers or callbacks (for the *handling* mechanism)

This came up before and was rejected; the rationale, recovered from `docs/superpowers/plans/2026-05-23-remove-callback-interrupts.md` and `docs/site/appendix/callbacks.md:39`:

- **Handlers (`handle` blocks)** intercept *interrupts* — cooperative, checkpointed, **resumable** pauses. An aborted LLM call is the opposite: the socket is dead, there is nothing to resume. Routing aborts through handlers would force aborts to become interrupt-shaped (resumable), which they are not.
- **Callbacks** were *deliberately stripped of control-flow power*: the typechecker rejects `interrupt(...)` inside any callback body. They run as side effects, may throw a logged-and-dropped JS error, and that is it. They can *notify* about an abort but cannot *decide* its disposition (convert to `Result`, retry, hand control back).

Therefore abort handling lives in the **backend boundary/disposition layer** (§3.2). Callbacks remain available as a complementary *notification* layer only (§6). A first-class author-facing language surface is intentionally **out of scope** for both increments and will be designed separately if/when needed.

---

## 8. Testing strategy

- **Increment 1 regression lock:** a deterministic unit test reproducing the CI crash — a `guard(time: …)` around an in-flight `sleep`, asserting a `timeoutFailure` Result and asserting **no unhandled rejection** is emitted.
- **Carrier round-trip:** `readCause` over every variant via both `signal.reason` and `AgencyCancelledError.cause`.
- **Boundary matrix:** for each `{ guardTrip, userInterrupt, userKill, raceLoser }`, assert the correct boundary converts/propagates and the correct cleanup runs (e.g. `markThreadCancelled` runs for `userInterrupt` but not `guardTrip`).
- **Existing suites that must stay green:** `lib/runtime/guard.test.ts`, all `tests/agency/guards/*`, `tests/agency/fork/race/*`, `lib/stdlib/ui*.test.ts`. Per CLAUDE.md, do not run the full agency suite locally — let CI run it; run the specific guard/race fixtures locally while iterating, saving output to a file.

---

## 9. Risks

- **Handlers-are-safety-infrastructure (CLAUDE.md).** Every migrated catch must preserve the propagate-never-swallow contract. Increment 1 keeps the codegen ladder untouched specifically to avoid touching this in the regression fix; Increment 2 re-verifies it site-by-site.
- **`spent` accuracy in the `guardTrip` cause.** The cause carries an approximate `spent` at abort time; `TimeGuard.check()` remains the authority for the number surfaced in `GuardFailureData`. Keep `check()` as the source of truth; the cause is for discrimination.
- **Provider errors with no cause.** Some provider SDK abort errors arrive without our `AbortCause`. Keep `prompt.ts`'s `isCancelled`-state fallback so these are still classified as cancellations when a cause is absent.
- **Cross-module identity.** `readCause`/`isAbortError` must keep the name-based fallback for errors that cross module instances (e.g. the subprocess resolver shim), per `errors.ts:80`.
