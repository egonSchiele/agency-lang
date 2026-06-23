# Abort Taxonomy — Deferred Increment 1 + Increment 2 (Unification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the abort-taxonomy work: complete the deferred Increment 1 carrier pieces (Phase A), collapse `AgencyCancelledError` + `GuardExceededError` into one `AgencyAbort { agencyCause }` with a single-rung codegen catch ladder (Phase B), and add `guardId` matching so a guard's `try` converts only its OWN trip (Phase C, fixing the nested mis-attribution).

**Architecture:** `AgencyAbort extends Error` carries an `AbortCause` and becomes the single thing the generated catches propagate (`RestoreSignal` stays separate). `GuardExceededError`/`AgencyCancelledError` become thin subclasses during migration. The guard boundary (`__tryCall`) gains an `ownedGuardIds` filter so an inner guard's `try` re-throws an outer guard's trip instead of mis-attributing it.

**Tech Stack:** TypeScript runtime (`lib/runtime/*`), codegen (`lib/templates/...`, `lib/backends/typescriptBuilder.ts`), stdlib (`lib/stdlib/*`, `stdlib/thread.agency`). Touches ~26 non-test files + regenerates ~126 fixtures.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-21-abort-taxonomy-design.md` — §4.1 (deferred steps 5–6, raceLoser) for Phase A; §5 (full unification) for Phase B; §4.1.1 + the §4 "what shipped vs deferred" note for the guardId rationale (Phase C).
- **Preserve the propagate-never-swallow contract** (CLAUDE.md: handlers are safety infrastructure). Aborts must never be silently converted to a `Failure` except a guard trip at its OWNING guard boundary.
- **`signal.reason` must stay an `Error`** (`runBatch.ts` does `throw signal.reason`). Producers abort with an `AgencyAbort` carrying the cause.
- **`AbortSignal.any` identity dependency** (spec §3.4): the same cause object is visible to both the leaf-op and runner paths; the `delivered` flag relies on it.
- **Build:** `make` (not `pnpm run build`) before running fixtures — only `make` copies `lib/agents` into `dist`. Phase B regenerates fixtures with `make fixtures` (wraps `dist/scripts/regenerate-fixtures.js`).
- **Test runner:** agency fixtures via `pnpm run a test <file.agency>`; unit tests via `pnpm test:run <file>`; full unit suite `pnpm test:run`; structural lint `pnpm run lint:structure`.
- **Baseline (already merged, Increment 1):** `errors.ts` already has `AbortCause`/`makeAbortCause`/`readCause` and `AgencyCancelledError.agencyCause`; `TimeGuard` emits a `guardTrip` cause + `guardId`; `__tryCall` converts a `guardTrip` cause before `isAbortError`, setting `cause.delivered`; `runner.shouldSkip` honors `delivered`; leaf ops use `leafCancel`; `ctx.cancel`/`cleanup`/REPL-Esc carry causes.

---

# Phase A — Deferred Increment 1 carrier pieces

Independent of Phases B/C. No fixture regeneration. Small and low-risk — EXCEPT Task A2 Step 0, which rewrites live `MessageThread` state the next LLM turn consumes (see the scope note on that step). Land Task A2 Step 0 as its own commit so a thread-repair regression can be reverted without unwinding the cause-gating work.

## Task A1: Tag race-loser / fork branch aborts with `raceLoser`

**Files:**
- Modify: `lib/runtime/runBatch.ts` — the two `branch.abortController?.abort()` sites (locate with `grep -n "abortController?.abort" lib/runtime/runBatch.ts`; line numbers drift between sessions)
- Test: `lib/runtime/runBatch.test.ts`

**Interfaces:**
- Consumes: `makeAbortCause` + `AgencyCancelledError` from `./errors.js`.

- [ ] **Step 1: Write the failing test** in `runBatch.test.ts`: after a race resolves and losers are aborted, assert the loser branch's `abortController.signal.reason` is an `Error` whose `readCause(...)` is `{ kind: "raceLoser" }`. (Model construction on the existing runBatch tests — they already build branches with `abortController`.)

- [ ] **Step 2: Run, verify fail** — `pnpm test:run lib/runtime/runBatch.test.ts` (reason is currently `undefined`).

- [ ] **Step 3: Implement** — at both abort sites, replace `t.branch.abortController?.abort();` with:
  ```ts
  t.branch.abortController?.abort(
    new AgencyCancelledError("race loser", makeAbortCause({ kind: "raceLoser" })),
  );
  ```
  Add `AgencyCancelledError` and `makeAbortCause` to the existing `./errors.js` import (a single merged `import { AgencyCancelledError, makeAbortCause, ... } from "./errors.js";`, not two separate import lines).

- [ ] **Step 4: Run, verify pass**; then `pnpm test:run lib/runtime/runBatch.test.ts` (all existing race/abort cases still green).

- [ ] **Step 5: Regression** — `pnpm run a test` on each `tests/agency/fork/race/*.agency` and a couple of `tests/agency/fork/*` (race-loser path). `readCause` now returns `raceLoser` where it returned `undefined`; `shouldSkip` still silent-halts (raceLoser is neither a delivered guardTrip nor handled specially), so behavior is unchanged.

- [ ] **Step 6: Commit.**

## Task A2: Cause-driven, non-destructive thread repair + dispatch normalization in `prompt.ts`

**Files:**
- Modify: `lib/runtime/prompt.ts` — `markThreadCancelled` itself (`grep -n "function markThreadCancelled" lib/runtime/prompt.ts`), the outer catch that calls it (`grep -n "markThreadCancelled(messages)" lib/runtime/prompt.ts` — one call site), and the dispatch catch (`grep -n "isCancelled(stateStack) || isAbortError" lib/runtime/prompt.ts`).
- Test: `lib/runtime/prompt.test.ts` for the new repair shape; existing guard/race fixtures + a new agency-js test (see Step 6) for the gating.

**Interfaces:**
- Consumes: `readCause` from `./errors.js` (already imported alongside `isAbortError`? add if not).
- Produces:
  - A `needsThreadRepair(cause: AbortCause | undefined): boolean` helper colocated with `markThreadCancelled` — the single source of truth for which causes warrant thread repair. New cause variants (`connectionLost`/`callTimeout`) only need to be added here when they land.
  - A rewritten `markThreadCancelled` that **stubs missing tool responses** instead of truncating to the last user message — preserves earlier complete rounds and the dangling assistant's text body; only synthesizes the specific `tool` messages that providers require to make the thread structurally valid.

- [ ] **Step 0: Rewrite `markThreadCancelled` to be non-destructive.**

  > **SCOPE NOTE:** This is the riskiest single change in Phase A — it rewrites live `MessageThread` state the next LLM turn reads. It is a thread-repair *correctness* improvement that rides along with abort unification but is logically separable. Commit it ALONE (Steps 0 + 0a only) so a regression here can be reverted independently. Do not bundle it with the gating changes (Steps 1–7).

  Today's implementation walks back to the last `user` message and drops everything after it, throwing away earlier complete tool round-trips, the dangling assistant's text body, and any tool responses that *did* return in a partial batch. The provider's actual requirement is narrower: the last assistant message's `tool_calls` must each have a matching `tool` response. Replace the implementation with:
  ```ts
  function markThreadCancelled(messages: MessageThread): void {
    const all = messages.getMessages();
    // The ONLY structurally invalid state a mid-turn cancel can leave is
    // "trailing assistant with unanswered tool_calls". Earlier assistants
    // already have their tool responses (otherwise the runPrompt loop
    // would not have advanced past them), so we only repair the gap.
    let lastAssistant = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].role === "assistant") { lastAssistant = i; break; }
    }
    if (lastAssistant === -1) return;   // no assistant turn — thread is already valid

    const calls = all[lastAssistant].tool_calls ?? [];
    const answered = new Set(
      all.slice(lastAssistant + 1)
        .filter((m) => m.role === "tool")
        .map((m) => m.tool_call_id),
    );

    const repaired = [...all];
    for (const call of calls) {
      if (!answered.has(call.id)) {
        // Synthetic response — preserves provenance (the model sees WHICH
        // tool was cancelled, not a mysterious gap) AND makes the thread
        // structurally valid for the next provider call.
        repaired.push(smoltalk.toolMessage(call.id, "[Tool call cancelled before completion.]"));
      }
    }
    // Breadcrumb so the model knows the turn was interrupted.
    repaired.push(smoltalk.assistantMessage("[Response cancelled.]"));
    messages.setMessages(repaired);
  }
  ```
  `smoltalk.toolMessage(toolCallId, content)` and `smoltalk.assistantMessage(content)` already exist (both are used many times elsewhere in `prompt.ts`). Match the exact `tool_call_id` field name the rest of this file uses when reading tool responses (confirm against the `answered` set construction above and the existing `toolMessage` call sites).

- [ ] **Step 0a: Unit tests for the new repair shape** (`lib/runtime/prompt.test.ts` — create if it does not yet expose `markThreadCancelled`; export it for test or wrap a test seam). Cover four shapes; the *first three* must fail with the OLD truncating implementation:
  1. **Complete trailing turn (no tool_calls):** `[user, assistant{text:"hi"}]` → repair appends `[Response cancelled.]` and **preserves the assistant text turn** (old code would truncate it).
  2. **Partial tool batch:** `[user, assistant{tool_calls:[a,b,c]}, tool{a}]` → repair appends synthetic `tool{b}`, `tool{c}`, then the cancelled marker; preserves `tool{a}` and the original assistant.
  3. **Earlier complete round + new dangling assistant:** `[user, assistant{tool_calls:[x]}, tool{x}, assistant{text:"thinking", tool_calls:[y]}]` → repair preserves the entire first round AND the dangling assistant's text body, and adds the `tool{y}` stub.
  4. **No assistant yet:** `[user]` → repair is a no-op (return without mutating).
  Run; verify the first three fail against the current implementation, then implement Step 0, then verify all pass. **Commit Steps 0 + 0a here, alone** (per the scope note).

- [ ] **Step 1: Extract the repair predicate.** Add next to `markThreadCancelled`:
  ```ts
  /** Thread repair (dropping a dangling assistant tool-call turn) is only
   *  needed for a user-initiated cancel mid-LLM-turn. A guard trip or a
   *  race-loser abort doesn't leave the thread mid-tool-call in a way the
   *  next user turn would choke on, and repairing then would discard a
   *  turn the guard's Failure path still wants intact. Unknown / absent
   *  causes default to repair (conservative: matches pre-cause behavior).
   *  Future cause variants (connectionLost, callTimeout) decide their
   *  repair policy here, not at the catch site. */
  function needsThreadRepair(cause: AbortCause | undefined): boolean {
    if (cause === undefined) return true;
    return cause.kind === "userInterrupt" || cause.kind === "userKill";
  }
  ```
  Then gate the existing call site:
  ```ts
  if (isAbortError(error)) {
    if (needsThreadRepair(readCause(error))) markThreadCancelled(messages);
    throw error;
  }
  ```

- [ ] **Step 2: Prefer the cause in dispatch normalization.** At the `isCancelled(stateStack) || isAbortError(err)` site:
  ```ts
  if (ctx.isCancelled(stateStack) || isAbortError(err)) {
    throw new AgencyCancelledError();
  }
  ```
  becomes:
  ```ts
  // Prefer the structured cause when present so the normalized error keeps
  // its intent (guardTrip / userInterrupt / …); fall back to the
  // isCancelled heuristic for provider errors that arrive with no cause.
  // The cause object preserves identity (readCause off the error or the
  // signal returns the SAME branded object the producer set), so the
  // `delivered` de-dup flag still works across the two trip paths.
  const cause = readCause(err) ?? readCause(ctx.getAbortSignal(stateStack));
  if (cause || ctx.isCancelled(stateStack) || isAbortError(err)) {
    throw new AgencyCancelledError(undefined, cause);
  }
  ```

- [ ] **Step 3: Unit-test the predicate.** In `lib/runtime/prompt.test.ts` (export `needsThreadRepair` for test, or inline a test seam), assert all branches deterministically — trivial but locks the policy so future cause variants don't silently inherit the wrong default:
  - `needsThreadRepair(undefined) === true` (conservative default for absent/unknown causes)
  - `needsThreadRepair({kind:"userInterrupt"}) === true`
  - `needsThreadRepair({kind:"userKill"}) === true`
  - `needsThreadRepair({kind:"guardTrip", ...}) === false`
  - `needsThreadRepair({kind:"raceLoser"}) === false`
  - `needsThreadRepair({kind:"cleanup"}) === false`
  Use makeAbortCause-built fixtures so the test exercises the production cause shape.

- [ ] **Step 4: Build** — `make` clean.

- [ ] **Step 5: Run guard + race fixtures** — `pnpm run a test tests/agency/guards` (21) and each `tests/agency/fork/race/*.agency`; all green. (Note: these fixtures inspect *return values*, not thread state, so they do not actually verify the gating — the next step does. Their value here is ensuring no behavioral regression on the non-gating dimensions.)

- [ ] **Step 6: Add an agency-js test that verifies the gating via CONTRAST.** Under `tests/agency-js/`, add a test with two scenarios that share a deterministic-mock `llm()` setup but differ only in *which* abort fires; without the contrast you cannot distinguish "gating works" from "gating is a no-op." Both scenarios assert post-run thread state directly by reading the `MessageThread` the test harness already exposes (`lib/runtime/threads.ts` / `ThreadStore`):

  **Scenario A — guard trip (repair should NOT fire):** run a node with `guard(time: …)` around an LLM call that resolves after the guard window. Assert (a) the node returns a `timeoutFailure`, and (b) the post-run thread has the pre-guard turns AND the in-flight assistant turn intact — **no synthetic `[Response cancelled.]` marker**, **no stubbed tool responses**. If gating regressed to "always repair", this assertion fails.

  **Scenario B — user cancel (repair SHOULD fire):** run a node that issues an LLM call producing a `tool_calls` assistant message, then fire a `userInterrupt`-cause abort via `ctx.cancel({ kind: "userInterrupt" })` (or `installCancelKey` simulating Esc) before any tool response is appended. Assert (a) the abort propagates, and (b) the post-run thread shows the repair fingerprint — synthetic `tool` stubs for every unanswered `tool_call`, then the `[Response cancelled.]` assistant marker. If gating regressed to "never repair", this assertion fails.

  The contrast is what makes the test discriminative. If the deterministic-mock harness genuinely cannot drive *both* scenarios, **do not ship the test** (say so in the commit message and rely on `needsThreadRepair`'s unit test from Step 3 + the new repair-shape unit tests from Step 0a) rather than a half-test that passes regardless of the gating change. Save the test output to a file.

- [ ] **Step 7: Commit** (Steps 1–7 — the gating changes — as a separate commit from Steps 0 + 0a).

---

# Phase B — Unification: one `AgencyAbort`, one catch rung

The big mechanical change. Land each task as its own commit; B3 (fixture regen) lands in isolation so the churn is reviewable.

> **Push B2 and B3 together.** Between B2 (templates import `AgencyAbort`) and B3 (fixtures regenerate to match), the ~126 generated `tests/**/*.js` files still import `GuardExceededError`/`__isAbortError` while the runtime no longer exports those for codegen — the agency-fixture suite (`pnpm run a test ...`) will fail tree-wide. Keep B2 and B3 as separate commits for reviewability, but **do not push or run the agency suite between them**. Unit tests (`pnpm test:run`) still pass at B2 because they don't go through generated fixtures.

## Task B1: Introduce `AgencyAbort`; make the two error types subclasses

**Files:**
- Modify: `lib/runtime/errors.ts`, `lib/runtime/guard.ts` (`GuardExceededError`)
- Modify: `lib/runtime/index.ts` (exports)
- Test: `lib/runtime/errors.test.ts`, `lib/runtime/guard.test.ts`

**Interfaces:**
- Produces: `class AgencyAbort extends Error { readonly agencyCause: AbortCause }`. `AgencyCancelledError extends AgencyAbort`. `GuardExceededError extends AgencyAbort` (keeps `.type`/`.limit`/`.spent` getters that read from `agencyCause`). `isAbortError(e)` = `e instanceof AgencyAbort` (+ DOMException/name fallback). `isGuardExceededError(e)` = `e instanceof AgencyAbort && e.agencyCause.kind === "guardTrip"`.

> **BEHAVIOR-SHIFT WARNING (read before implementing):** The moment `GuardExceededError extends AgencyAbort` and carries a `guardTrip` cause (this task), a *thrown* `GuardExceededError` (the cost-guard pre/post-call gate in `prompt.ts`) starts being caught by `__tryCall`'s **`guardCause?.kind === "guardTrip"`** branch (`result.ts:~120`) BEFORE it reaches the separate `isGuardExceededError` branch (`result.ts:~139`). That earlier branch produces the same `guardFailureData(dimension, limit, spent)` from the cause — functionally identical numbers — and additionally writes `guardCause.delivered = true` on the cause (harmless here: the cost trip's cause is freshly constructed in the `GuardExceededError` ctor and not shared with any signal). Net: the `isGuardExceededError` branch is already DEAD as of B1; B4 only deletes the corpse. **Make sure the B1 guard fixtures (Step 5) actually exercise a thrown COST-guard trip** so this shift is caught here, not as a surprise at B4.

- [ ] **Step 1: Write failing tests** in `errors.test.ts` covering both the new types and two regression-prone invariants:
  - **Basic AgencyAbort identity:** `new AgencyAbort("m", makeAbortCause({kind:"userKill"}))` → `isAbortError` returns true and `readCause` returns the supplied cause.
  - **Subclass inheritance:** an `AgencyCancelledError` is `instanceof AgencyAbort`; a `GuardExceededError("time",20,21)` is `instanceof AgencyAbort`, `isGuardExceededError` true, `.type==="time"`, `.limit===20`, `.spent===21`, and `readCause(it)?.kind==="guardTrip"`.
  - **Branded default-cause round-trip** (locks the `cause ?? makeAbortCause(...)` invariant; a future "simplify" could drop the brand and silently break `readCause`): `readCause(new AgencyCancelledError()) !== undefined` and its `.kind === "userKill"`; same for `new AgencyCancelledError("custom reason")`.
  - **Cross-module / subprocess name-fallback** (locks the §9 caveat as a test): construct a raw `Error` with `Object.assign(new Error("simulated cross-realm abort"), { name: "AgencyAbort" })` — no prototype chain to `AgencyAbort` — and assert `isAbortError(it) === true` AND `readCause(it) === undefined`. This documents that abort *identity* survives the subprocess shim but the cause *payload* does not; if someone later adds cross-boundary cause preservation, this test fails informatively (flip the second assertion).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement in `errors.ts`:**
  ```ts
  export class AgencyAbort extends Error {
    readonly agencyCause: AbortCause;
    constructor(message: string, cause: AbortCause) {
      super(message);
      this.name = "AgencyAbort";
      this.agencyCause = cause;
    }
  }

  export class AgencyCancelledError extends AgencyAbort {
    constructor(reason?: string, cause?: AbortCause) {
      // The default cause MUST be branded via makeAbortCause — readCause
      // only recognizes branded causes. (A bare {kind:...} would read back
      // as undefined.) Matches what ctx.cancel() does today.
      super(reason ?? "Agent execution was cancelled",
        cause ?? makeAbortCause({ kind: "userKill", reason }));
      this.name = "AgencyCancelledError";
    }
  }
  ```
  Note: `AgencyAbort`'s constructor takes whatever cause it's handed — callers that pass an already-branded cause (every Increment-1 producer) are unaffected; only this default path needs the brand.

  **Remove the existing `agencyCause` field from `AgencyCancelledError`** — it now lives only on `AgencyAbort` (`readonly`), and the subclass inherits it through `super(...)`. Leaving the old field declaration on the subclass would shadow the parent's readonly field and silently land `undefined`.

  Update `readCause` to read `agencyCause` off any `AgencyAbort` (replace the `instanceof AgencyCancelledError` branch with `instanceof AgencyAbort`). Update `isAbortError` to recognize the new class **and** the new name in the cross-module name-fallback (the fallback is what keeps subprocess-shim errors classifying as aborts after their prototype chain is lost — see spec §9 for the documented payload-loss caveat):
  ```ts
  export function isAbortError(error: unknown): boolean {
    if (error instanceof AgencyAbort) return true;
    if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") return true;
    // Cross-module / cross-realm fallback: the prototype check above misses
    // an error reconstructed from a different module instance (subprocess
    // resolver shim, etc.). Match by `name` so identity is preserved even
    // though `agencyCause` may not survive serialization (spec §9).
    if (error instanceof Error) {
      return error.name === "AgencyAbort"
          || error.name === "AgencyCancelledError"
          || error.name === "AbortError";
    }
    return false;
  }
  ```
  (Note the `error.name === X || error.name === Y` form — a chained `X || "Y" || "Z"` would always be truthy.)

- [ ] **Step 4: Implement in `guard.ts`:** make `GuardExceededError extends AgencyAbort`:
  ```ts
  export class GuardExceededError extends AgencyAbort {
    constructor(
      public readonly type: "cost" | "time",
      public readonly limit: number,
      public readonly spent: number,
      guardId: string = "",
    ) {
      super(`guard exceeded: ${type} limit ${limit}, spent ${spent}`,
        makeAbortCause({ kind: "guardTrip", dimension: type, limit, spent, guardId }));
      this.name = "GuardExceededError";
    }
  }
  ```
  `isGuardExceededError(e)` stays `e instanceof GuardExceededError` (still valid) — leave it. Pass `guardId` from `CostGuard.check`/`TimeGuard.check` (both now have a `guardId`; CostGuard gains one in Task C1 — until then pass `""`).

  > **C2 DEPENDENCY NOTE:** the `guardId: string = ""` default is a *temporary scaffold*. It is load-bearing for C2: once `__tryCall` filters on `ownedGuardIds`, any `GuardExceededError` constructed WITHOUT a real `guardId` carries `guardId === ""`, fails the `ownedGuardIds.includes("")` check, and re-throws past its own guard — escaping as an uncaught error. C1 wires the real `guardId` into BOTH `CostGuard.check` and `TimeGuard.check`. Do not ship C2 until C1's tests prove BOTH `check()` paths carry the id (see C1 Step 1).

- [ ] **Step 5: Run, verify pass**; `pnpm test:run lib/runtime/errors.test.ts lib/runtime/guard.test.ts lib/runtime/result.test.ts lib/runtime/runner.test.ts`. The Increment-1 tests still pass because `AgencyCancelledError`/`GuardExceededError` identities are preserved. **Confirm at least one guard test/fixture throws a COST-guard trip and still converts to a `guardFailure`** (per the behavior-shift warning above).

- [ ] **Step 6: Export `AgencyAbort`** from `lib/runtime/index.ts` (next to `AgencyCancelledError`). Commit.

## Task B2: Collapse the codegen catch ladder to one rung

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/functionCatchFailure.ts` → edit the `.mustache` source (`functionCatchFailure.mustache`), then `pnpm run templates`
- Modify: `lib/templates/backends/typescriptGenerator/imports.ts` → edit `imports.mustache`, then `pnpm run templates`
- Modify: `lib/backends/typescriptBuilder.ts` — the node catch ladder (locate with `grep -n "instanceof GuardExceededError\|__isAbortError" lib/backends/typescriptBuilder.ts`; line numbers drift between sessions)

**Interfaces:**
- Generated code imports `AgencyAbort` (replacing `GuardExceededError` + `isAbortError as __isAbortError` in the catch path; keep `RestoreSignal`).

- [ ] **Step 1: Edit `functionCatchFailure.mustache`** — replace the `GuardExceededError` + `__isAbortError` rungs with one:
  ```
  if (__error instanceof RestoreSignal) {
    throw __error;
  }
  // All aborts — cancellations AND guard trips — carry an AbortCause and
  // must propagate untouched (the owning guard's try converts a guardTrip;
  // everything else unwinds). One check replaces the old 2-rung ladder.
  if (__error instanceof AgencyAbort) {
    throw __error;
  }
  ```

- [ ] **Step 2: Edit `imports.mustache`** — replace `GuardExceededError,` and `isAbortError as __isAbortError,` with `AgencyAbort,` (keep `RestoreSignal,`). Grep the templates for any other generated use of `__isAbortError`/`GuardExceededError`; if none remain in generated bodies, the imports are safe to drop.

- [ ] **Step 3: Edit `typescriptBuilder.ts`** node catch — replace the two `ts.if(... GuardExceededError ...)` and `ts.if(... __isAbortError ...)` blocks with a single `ts.if(ts.raw("__error instanceof AgencyAbort"), ts.statements([ts.throw("__error")]))`. Keep the `RestoreSignal` block above it. (Locate the blocks with the grep in Files; line numbers above the imports change between sessions.)

- [ ] **Step 4: Recompile templates** — `pnpm run templates`; then `make` (build). Expect TS to compile clean.

- [ ] **Step 5: Sanity** — compile ONE fixture by hand and eyeball the catch: `pnpm run compile tests/agency/guards/guard-time-trip.agency` and confirm the generated `.ts` has the single `instanceof AgencyAbort` rung and imports `AgencyAbort`. Do NOT regenerate all fixtures yet.

- [ ] **Step 6: Commit** (templates + builder only; fixtures regenerate in B3).

## Task B3: Regenerate the ~126 fixtures (isolated churn)

**Files:**
- Modify: ~126 `tests/**/*.js` (generated) via `make fixtures`

- [ ] **Step 1: Regenerate** — `make fixtures 2>&1 | tee /tmp/regen.log`.

- [ ] **Step 2: Spot-check** — `git diff tests/agency/guards/guard-time-trip.js` shows the ladder collapsed to one `instanceof AgencyAbort` rung + the import swap, and nothing else of substance. Spot-check 2–3 more (`tests/agency/fork/race/*.js`, a handler fixture).

- [ ] **Step 3: Confirm scope** — `git diff --stat tests/ | tail -1` ≈ 126 files, all generated `.js`, all the same mechanical change. `git diff tests/ | grep -E '^\+' | grep -v 'AgencyAbort\|RestoreSignal\|^\+\+\+' | grep -iE 'abort|guard|catch'` should surface nothing unexpected.

- [ ] **Step 4: Run the regenerated fixtures** — `pnpm run a test tests/agency/guards` (21) + each `tests/agency/fork/race/*.agency` + a handful of handler/substep fixtures. All green.

- [ ] **Step 4a: New fixture — guard trip propagates across a function-call boundary.** Add `tests/agency/guards/guard-trip-crosses-function-boundary.agency`:
  ```
  import { guard } from "std::thread"

  def inner(): string {
    sleep(150ms)
    return "inner returned"
  }

  node main() {
    const result = guard(time: 20ms) as {
      return inner()
    }
    if (isFailure(result)) {
      return "outer:${result.error.type}"
    }
    return result.value
  }
  ```
  Expected: `"outer:timeoutFailure"`. This exercises the new `instanceof AgencyAbort` rung in the *function-level* catch ladder (`inner`'s generated function-body try/catch) — the outer guard's trip aborts the sleep, the rejection unwinds through `inner`'s catch (which must re-throw, not convert), and lands at the outer guard's `try`. The existing nested-guard fixtures all live in one function and only exercise the *node-level* ladder; this one is the first cross-function regression backstop for B2's collapsed rung.

- [ ] **Step 5: Commit** the fixture churn (Steps 1–4) + the new cross-function fixture (Step 4a) as ONE commit with a message stating it's a mechanical regen from B2 plus one new fixture.

## Task B4: Migrate stdlib leaf throws + unify predicates across the runtime

**Files:**
- Modify: the remaining non-test files still constructing the old types directly or sniffing them: `lib/stdlib/http.ts`, `lib/stdlib/builtins.ts`, `lib/stdlib/ui.ts`, `lib/stdlib/oauth.ts`, `lib/stdlib/speech.ts`, `lib/stdlib/shell.ts`, `lib/runtime/result.ts`, `lib/runtime/streaming.ts`, `lib/runtime/memory/manager.ts`, `lib/runtime/hooks.ts`, `lib/runtime/node.ts`, `lib/runtime/interrupts.ts`, `lib/runtime/agency.ts`, `lib/runtime/state/stateStack.ts`
- Test: existing unit suites for each

**Interfaces:**
- After this task, `__tryCall`'s separate `isGuardExceededError` branch is DELETED — a `GuardExceededError` is now an `AgencyAbort` with a `guardTrip` cause, so `readCause(error)?.kind === "guardTrip"` (the existing branch from Increment 1) already converts it. This is the simplification unification buys. (As the B1 behavior-shift warning notes, that branch was already dead after B1; this is the cleanup.)

- [ ] **Step 1: `result.ts`** — delete the `isGuardExceededError(error)` branch in `__tryCall` (the `guardCause?.kind === "guardTrip"` branch above it now handles both the leaf-rejection AND the thrown-`GuardExceededError` shapes, since the latter is an `AgencyAbort` carrying the same cause). Remove the now-unused `isGuardExceededError` import. Keep `guardFailureData`.

- [ ] **Step 2: Run** `pnpm test:run lib/runtime/result.test.ts` and the guard fixtures — a thrown `GuardExceededError` (cost-guard pre/post-call gate in `prompt.ts`) still converts to a `guardFailure`. If a cost-guard fixture fails, the cause must carry the cost guard's `guardId`/numbers — verify `CostGuard.check` builds the `GuardExceededError` with its real numbers (it does today).

- [ ] **Step 3: stdlib leaves** — `http.ts`, `builtins.ts`, `ui.ts`, `oauth.ts`, `speech.ts`, `shell.ts`: each still throws `new AgencyCancelledError("…")`. These keep working (it's now an `AgencyAbort` subclass). Where a signal is in scope, prefer carrying the cause via the `leafCancel` pattern (import from `abortable.ts` or inline `new AgencyCancelledError(msg, readCause(signal))`). This is additive — do it only where a `signal`/`abortSignal` is already in scope; leave the rest as bare cancels.

- [ ] **Step 4: predicate audit** — `grep -rn "instanceof GuardExceededError\|instanceof AgencyCancelledError" lib/ --include=*.ts | grep -v .test.ts`. Each such site still works (subclasses), but where the intent is "any abort", prefer `isAbortError`/`instanceof AgencyAbort`. Change only where it improves clarity; do not churn working checks gratuitously.

- [ ] **Step 5: Propagate-never-swallow lock-in test** (`lib/runtime/result.test.ts`). The CLAUDE.md safety invariant — "an `AgencyAbort` must propagate untouched, never be converted to `Failure`" — is concentrated in the abort rungs of `__tryCall`. At THIS point in the plan (`__tryCall` has NO `ownedGuardIds` yet — that lands in C2), the behavior is: a `guardTrip` cause **converts** to a `Failure` (the current Increment-1 behavior), while every non-guard abort cause **re-throws**. Add a unit test that throws each `AbortCause` variant wrapped in an `AgencyAbort` through `__tryCall` (no `ownedGuardIds`) and asserts:
  - `userInterrupt` cause → **re-thrown**
  - `userKill` cause → **re-thrown**
  - `raceLoser` cause → **re-thrown**
  - `cleanup` cause → **re-thrown**
  - `guardTrip` cause → **converted to a `guardFailure`** (the no-`ownedGuardIds` behavior at B4; C2 Step 1 FLIPS this assertion to "re-thrown" once the filter exists)
  - A non-`AgencyAbort` `Error` → converted to `Failure` (negative control, ensures the test is actually exercising the abort path)
  This is the smallest fully-deterministic test that catches a regression where a non-guard abort rung is accidentally inverted, removed, or moved below the `Failure`-conversion path. **NOTE:** the `guardTrip`→convert assertion is deliberately the B4-era behavior; the C2 task re-points it (see C2 Step 1) rather than adding a second contradictory test.

- [ ] **Step 6: Build + full unit suite** — `make`; `pnpm test:run` → all green.

- [ ] **Step 7: Full fixture regression** — `pnpm run a test tests/agency/guards` + `tests/agency/fork/race/*` + a sweep of handler/substep/interrupt fixtures. Save output to a file. Commit.

---

# Phase C — `guardId` matching (fix nested mis-attribution)

Depends on Phase B (cost guards carry guardId; `AgencyAbort` carries the cause). Makes a guard's `try` convert ONLY its own trip; an outer guard's trip re-throws past an inner guard. This now applies to BOTH time and cost nesting (cost guards gain a `guardId` in C1), not just the time case the original spec called out.

## Task C1: Give every guard a `guardId`; `_pushGuard` returns the ids

**Files:**
- Modify: `lib/runtime/guard.ts` (`CostGuard` gains `guardId`; `CostGuard.check`/`TimeGuard.check` pass it into `GuardExceededError`), `lib/stdlib/thread.ts` (`pushGuardImpl`/`_pushGuard`/`__internal_pushGuard` return `string[]` ids)
- Test: `lib/runtime/guard.test.ts`, `lib/stdlib/thread` unit if present

**Interfaces:**
- Produces: `CostGuard.guardId: string` (via `nextGuardId()`); `pushGuardImpl(...)` and `_pushGuard(...)` return `string[]` (the pushed guards' ids, innermost-last) instead of a `number` count; `_popGuard(idsOrCount)` accepts the array length.

- [ ] **Step 0: Caller audit** — before changing the return shape, list every caller:
  ```sh
  grep -rn "_pushGuard\|__internal_pushGuard\|_popGuard\|__internal_popGuard" lib/ stdlib/ tests/ --include="*.ts" --include="*.agency" --include="*.js"
  ```
  Expected hits: `lib/stdlib/thread.ts` (definitions + the `pushGuardImpl` call), `stdlib/thread.agency`'s `guard()` (the one consumer documented below). Note: the compiled `guard()` lives in built stdlib, NOT inlined into the per-fixture `tests/**/*.js`, so changing `thread.agency` does NOT require a fixture regen — only `make` (rebuilds stdlib). Confirm this by checking the grep returns no `_pushGuard`/`_popGuard` hits under `tests/**/*.js`; if it does, that fixture inlines the call and the return-shape change WILL break it — migrate or surface as a blocker. Save the grep output to a file so the audit is reviewable.

- [ ] **Step 1: Write failing tests** (`guard.test.ts`) — cover BOTH `check()` paths, because C2's `ownedGuardIds` matching is load-bearing on both:
  - A `CostGuard` exposes a `guardId`, and its `check()`-produced `GuardExceededError`'s `agencyCause.guardId` equals it.
  - **A `TimeGuard`'s `check()`-produced `GuardExceededError` carries the TimeGuard's `guardId` in `agencyCause.guardId`.** This is the path the runner's `shouldSkip` throws through; today `TimeGuard.check` constructs the error WITHOUT a guardId. If this regresses, after C2 a runner-path time trip carries `guardId === ""`, fails `ownedGuardIds.includes`, and ESCAPES its own guard as an uncaught error. This test is the guard against that silent abort-escape — do not skip it.

- [ ] **Step 2: Run, verify fail** (TimeGuard test fails today: `check()` passes no guardId).

- [ ] **Step 3: Implement** — add `readonly guardId = nextGuardId()` to `CostGuard`; pass `this.guardId` as the 4th arg to `new GuardExceededError(...)` in BOTH `CostGuard.check` and `TimeGuard.check`. Change `pushGuardImpl` to collect and return the pushed guards' ids (`const ids: string[] = []; ... ids.push(g.guardId); return ids;`); update `_pushGuard`/`__internal_pushGuard` return types to `string[]`. `_popGuard`/`__internal_popGuard` take the array (use `.length`).

  > Note: `TimeGuard` already has a `readonly guardId` field (Increment 1) and already threads it into the cause it puts on `signal.reason` (the leaf-abort path). The gap C1 closes is the SECOND time-trip path: the `GuardExceededError` that `TimeGuard.check()` returns for the runner's `shouldSkip`. Both paths must carry the same id.

- [ ] **Step 4: Update `stdlib/thread.agency`** `guard()`:
  ```
  const ids = _pushGuard(cost, time)
  const result = try block()
  _popGuard(ids)
  return result
  ```
  Keep `try block()` here (the `_runGuarded` switch lands in C2). `_popGuard(ids)` now takes the array (its impl uses `.length`). The build must stay green at C1.

- [ ] **Step 5: `make`; run, verify pass**; cost + time guard fixtures green. Commit.

## Task C2: `ownedGuardIds` filter so a guard converts only its own trip

**Files:**
- Modify: `lib/runtime/result.ts` (`__tryCall` gains `ownedGuardIds`), `lib/stdlib/thread.ts` (`_runGuarded` helper), `stdlib/thread.agency` (`guard()` uses `_runGuarded`)
- Test: `lib/runtime/result.test.ts`; flip `tests/agency/guards/guard-time-nested-outer-tighter.test.json`

**Interfaces:**
- Produces: `__tryCall(fn, opts?)` where `opts.ownedGuardIds?: string[]`. A `guardTrip` cause is converted to a `Failure` ONLY if `ownedGuardIds` includes `cause.guardId`; otherwise it is re-thrown (propagates to the owning guard). `_runGuarded(ids: string[], block): Promise<Result>` calls `__tryCall(() => block(), { ownedGuardIds: ids, ... })`.

> **CRITICAL — `_runGuarded` MUST preserve the `FailureOpts` the agency `try` injects.** The Agency `try block()` expression does NOT lower to a bare `__tryCall(() => block())`. Inside a function scope (`guard()` is a `def`), `processTryExpression` (`lib/backends/typescriptBuilder.ts:~1100`) lowers it to:
> ```ts
> __tryCall(() => block(), {
>   checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
>   functionName: "guard",
>   args: __stack.args,
> })
> ```
> A naive `_runGuarded` that passes only `{ ownedGuardIds: ids }` DROPS `checkpoint`/`functionName`/`args` from every guard-failure `Failure` — a silent metadata regression that breaks retry/checkpoint behavior and error reporting on guard failures. `_runGuarded` has ALS access (like `_pushGuard`), so it MUST rebuild those opts. See Step 3.

- [ ] **Step 1: Write/repoint failing tests** (`result.test.ts`):
  - **Repoint the B4 lock-in test:** the B4 Step 5 test asserted `guardTrip` (no `ownedGuardIds`) → converts. Now that `ownedGuardIds` exists, flip that single assertion to: `guardTrip` cause with **no** `ownedGuardIds` → **re-throws** (a plain `try` inside a guarded block must not swallow the guard's trip). Keep the other five assertions (the non-guard aborts still re-throw; the negative control still converts) unchanged.
  - `__tryCall(throw guardTrip{guardId:"g1"}, { ownedGuardIds:["g1"] })` → converts to `timeoutFailure` (owned).
  - `__tryCall(throw guardTrip{guardId:"gOUTER"}, { ownedGuardIds:["gINNER"] })` → **re-throws** (not owned).
  - `__tryCall(throw guardTrip{guardId:"g1"})` (no `ownedGuardIds`, e.g. a plain `try`) → **re-throws**.

- [ ] **Step 2: Run, verify fail** (current `__tryCall` converts any guardTrip regardless).

- [ ] **Step 3: Implement** in `result.ts` — change the guardTrip branch:
  ```ts
  const guardCause = readCause(error);
  if (guardCause?.kind === "guardTrip") {
    if (opts?.ownedGuardIds?.includes(guardCause.guardId)) {
      guardCause.delivered = true;
      return failure(guardFailureData(guardCause.dimension, guardCause.limit, guardCause.spent), opts);
    }
    throw error; // belongs to an outer guard (or a plain try) — let it propagate
  }
  ```
  Add `ownedGuardIds?: string[]` to `FailureOpts`. Add `_runGuarded` to `thread.ts` — it MUST forward the same opts the agency `try` injects (see the critical note above), rebuilt from the runtime context:
  ```ts
  export async function _runGuarded(ids: string[], block: () => any): Promise<ResultValue> {
    const { ctx, stack } = getRuntimeContext();
    return __tryCall(() => block(), {
      ownedGuardIds: ids,
      checkpoint: ctx.getResultCheckpoint(),
      functionName: "guard",
      args: stack.args,
    });
  }
  ```
  Confirm the exact accessor names against `processTryExpression`'s emitted code and `getRuntimeContext()`'s returned shape (`ctx.getResultCheckpoint()`, `stack.args`) — match them precisely so the `Failure` metadata is byte-identical to what `try block()` produced before. Then switch `guard()` in `thread.agency` to `const result = _runGuarded(ids, block)`.

- [ ] **Step 3a: Verify the metadata parity.** Add/extend a unit or agency test asserting that a guard-failure `Failure` still carries `functionName === "guard"` (and a non-null `checkpoint` when one exists). This pins the regression the critical note warns about — without it, dropping the opts is invisible until a downstream retry/checkpoint test fails far away.

- [ ] **Step 4: `make`.** Run the nested fixtures: `guard-time-nested` (inner tighter — still `"inner tripped"`) and `guard-time-nested-outer-tighter` (outer tighter). The outer-tighter case now routes to the OUTER guard.

- [ ] **Step 5: Flip the pinned fixture** — observe the new output (expected: the outer guard now trips → `"outer:timeoutFailure"`), update `guard-time-nested-outer-tighter.test.json`'s `expectedOutput` and rewrite its description to state the limitation is now FIXED (guardId matching). Re-run → green.

- [ ] **Step 6: Guard against the plain-`try`-in-guard regression** — add a fixture `tests/agency/guards/guard-trip-not-swallowed-by-inner-try` where a plain `try someAbortableLeaf()` sits inside a `guard(time:)`; assert the guard trips (its `Failure` surfaces) rather than the inner `try` swallowing it. (This behavior is newly-correct as of Step 3.)

- [ ] **Step 6a: Nested COST guard, outer tighter** — add a fixture `tests/agency/guards/guard-cost-nested-outer-tighter.agency` mirroring the time case but for cost (an outer `guard(cost:)` with a tighter budget than an inner `guard(cost:)`, with charges that trip the outer first). Assert the OUTER guard converts the trip (`"outer:guardFailure"`-style), not the inner. C1 gave cost guards a `guardId`, so cost nesting is now id-matched exactly like time — this fixture is the regression backstop for the cost half of the fix, which the original spec didn't cover.

- [ ] **Step 6b: Concurrent guards in parallel branches** — add a fixture `tests/agency/guards/guard-concurrent-branches.agency` that runs two `runBatch` branches in parallel, each wrapping its own `guard(time: …)` around a `sleep` long enough that branch A's guard trips while branch B is still running. Assert: branch A returns a `timeoutFailure` (its own guard converts), branch B returns its normal result (its guard does NOT convert branch A's trip — different `guardId`), and the parent receives both results. Without `guardId` matching, branch B's `try` might mis-attribute branch A's trip; with it, the test pins the correct separation. Exercises `guardTrip` × `raceLoser`-style branch separation in one fixture — the existing fork/race fixtures don't combine the two.

- [ ] **Step 7: Full regression** — `make`; `pnpm test:run` (full unit suite); `pnpm run a test tests/agency/guards`; race fixtures; `pnpm run lint:structure`. Save output. Commit.

---

## Final verification (whole plan)

- [ ] `make` clean; `pnpm test:run` full unit suite green.
- [ ] `tests/agency/guards` (all, incl. the flipped + new fixtures), `tests/agency/fork/race/*`, and a handler/substep/interrupt sweep green.
- [ ] `pnpm run lint:structure` clean.
- [ ] Codegen: a freshly compiled fixture shows the single `instanceof AgencyAbort` catch rung.
- [ ] Guard-failure `Failure` metadata parity confirmed (`functionName`/`checkpoint`/`args` preserved through `_runGuarded`).
- [ ] Open the PR to `main`; mention the ~126-file mechanical fixture regen lands in its own commit (B3) for reviewability.

## Spec sync

- [ ] After landing, update the spec's §4 "what shipped vs deferred" note and §5 to reflect that unification + guardId matching (time AND cost) + the deferred Increment-1 bits have shipped, and mark the `connectionLost` / `callTimeout` UX as the remaining future work.
