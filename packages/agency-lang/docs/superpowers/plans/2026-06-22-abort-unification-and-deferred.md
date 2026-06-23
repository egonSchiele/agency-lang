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

Independent of Phases B/C. No fixture regeneration. Small and low-risk.

## Task A1: Tag race-loser / fork branch aborts with `raceLoser`

**Files:**
- Modify: `lib/runtime/runBatch.ts` (the two `branch.abortController?.abort()` sites at ~`594`, ~`607`)
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
  Add the import: `import { AgencyCancelledError } from "./errors.js"; import { makeAbortCause } from "./errors.js";` (merge into the existing errors import if present).

- [ ] **Step 4: Run, verify pass**; then `pnpm test:run lib/runtime/runBatch.test.ts` (all existing race/abort cases still green).

- [ ] **Step 5: Regression** — `pnpm run a test` on each `tests/agency/fork/race/*.agency` and a couple of `tests/agency/fork/*` (race-loser path). `readCause` now returns `raceLoser` where it returned `undefined`; `shouldSkip` still silent-halts (raceLoser is neither a delivered guardTrip nor handled specially), so behavior is unchanged.

- [ ] **Step 6: Commit.**

## Task A2: Cause-driven thread repair + dispatch normalization in `prompt.ts`

**Files:**
- Modify: `lib/runtime/prompt.ts` (the outer catch ~`1097-1108` calling `markThreadCancelled`, and the dispatch catch ~`242`)
- Test: `tests/agency/` — covered by existing guard/race fixtures + a new agency-js test if feasible (see Step 5)

**Interfaces:**
- Consumes: `readCause` from `./errors.js` (already imported alongside `isAbortError`? add if not).

- [ ] **Step 1: Gate `markThreadCancelled` by cause.** At `prompt.ts:1105`, change:
  ```ts
  if (isAbortError(error)) {
    markThreadCancelled(messages);
    throw error;
  }
  ```
  to:
  ```ts
  if (isAbortError(error)) {
    // Thread repair (dropping a dangling assistant tool-call turn) is only
    // needed for a user-initiated cancel mid-LLM-turn. A guard trip or a
    // race-loser abort doesn't leave the thread mid-tool-call in a way the
    // next user turn would choke on, and repairing then would discard a
    // turn the guard's Failure path still wants intact.
    const kind = readCause(error)?.kind;
    if (kind === undefined || kind === "userInterrupt" || kind === "userKill") {
      markThreadCancelled(messages);
    }
    throw error;
  }
  ```

- [ ] **Step 2: Prefer the cause in dispatch normalization.** At `prompt.ts:242`:
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
  const cause = readCause(err) ?? readCause(ctx.getAbortSignal(stateStack));
  if (cause || ctx.isCancelled(stateStack) || isAbortError(err)) {
    throw new AgencyCancelledError(undefined, cause);
  }
  ```

- [ ] **Step 3: Build** — `make` clean.

- [ ] **Step 4: Run guard + race fixtures** — `pnpm run a test tests/agency/guards` (21) and each `tests/agency/fork/race/*.agency`; all green (a guard trip during an LLM call now skips thread repair; a user cancel still repairs).

- [ ] **Step 5: Add coverage** — add an `agency-js` test under `tests/agency-js/` that runs a node which trips a `guard(time:)` around an `llm()` (deterministic mock) and asserts the returned `timeoutFailure` Result plus that the thread still contains the pre-guard turns (not repaired). If the deterministic-mock harness can't time-trip reliably, assert the simpler invariant (guard returns a `timeoutFailure`) and note the thread-state assertion as fixture-covered. Save output to a file.

- [ ] **Step 6: Commit.**

---

# Phase B — Unification: one `AgencyAbort`, one catch rung

The big mechanical change. Land each task as its own commit; B3 (fixture regen) lands in isolation so the churn is reviewable.

## Task B1: Introduce `AgencyAbort`; make the two error types subclasses

**Files:**
- Modify: `lib/runtime/errors.ts`, `lib/runtime/guard.ts` (`GuardExceededError`)
- Modify: `lib/runtime/index.ts` (exports)
- Test: `lib/runtime/errors.test.ts`, `lib/runtime/guard.test.ts`

**Interfaces:**
- Produces: `class AgencyAbort extends Error { readonly agencyCause: AbortCause }`. `AgencyCancelledError extends AgencyAbort`. `GuardExceededError extends AgencyAbort` (keeps `.type`/`.limit`/`.spent` getters that read from `agencyCause`). `isAbortError(e)` = `e instanceof AgencyAbort` (+ DOMException/name fallback). `isGuardExceededError(e)` = `e instanceof AgencyAbort && e.agencyCause.kind === "guardTrip"`.

- [ ] **Step 1: Write failing tests** in `errors.test.ts`: `new AgencyAbort("m", makeAbortCause({kind:"userKill"}))` → `isAbortError` true, `readCause` returns the cause; an `AgencyCancelledError` is `instanceof AgencyAbort`; a `GuardExceededError("time",20,21)` is `instanceof AgencyAbort`, `isGuardExceededError` true, `.type==="time"`, `.limit===20`, `.spent===21`, and `readCause(it)?.kind==="guardTrip"`.

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
  Update `readCause` to read `agencyCause` off any `AgencyAbort` (replace the `instanceof AgencyCancelledError` branch with `instanceof AgencyAbort`). Update `isAbortError` to `error instanceof AgencyAbort || (DOMException name==="AbortError") || (error.name==="AgencyAbort"||"AgencyCancelledError"||"AbortError")`.

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

- [ ] **Step 5: Run, verify pass**; `pnpm test:run lib/runtime/errors.test.ts lib/runtime/guard.test.ts lib/runtime/result.test.ts lib/runtime/runner.test.ts`. The Increment-1 tests still pass because `AgencyCancelledError`/`GuardExceededError` identities are preserved.

- [ ] **Step 6: Export `AgencyAbort`** from `lib/runtime/index.ts` (next to `AgencyCancelledError`). Commit.

## Task B2: Collapse the codegen catch ladder to one rung

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/functionCatchFailure.ts` → edit the `.mustache` source (`functionCatchFailure.mustache`), then `pnpm run templates`
- Modify: `lib/templates/backends/typescriptGenerator/imports.ts` → edit `imports.mustache`, then `pnpm run templates`
- Modify: `lib/backends/typescriptBuilder.ts` (node catch ~`2544-2556`)

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

- [ ] **Step 3: Edit `typescriptBuilder.ts`** node catch — replace the two `ts.if(... GuardExceededError ...)` and `ts.if(... __isAbortError ...)` blocks (lines ~2548, ~2554) with a single `ts.if(ts.raw("__error instanceof AgencyAbort"), ts.statements([ts.throw("__error")]))`. Keep the `RestoreSignal` block above it.

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

- [ ] **Step 5: Commit** the fixture churn as ONE commit with a message stating it's a mechanical regen from B2.

## Task B4: Migrate stdlib leaf throws + unify predicates across the runtime

**Files:**
- Modify: the remaining non-test files still constructing the old types directly or sniffing them: `lib/stdlib/http.ts`, `lib/stdlib/builtins.ts`, `lib/stdlib/ui.ts`, `lib/stdlib/oauth.ts`, `lib/stdlib/speech.ts`, `lib/stdlib/shell.ts`, `lib/runtime/result.ts`, `lib/runtime/streaming.ts`, `lib/runtime/memory/manager.ts`, `lib/runtime/hooks.ts`, `lib/runtime/node.ts`, `lib/runtime/interrupts.ts`, `lib/runtime/agency.ts`, `lib/runtime/state/stateStack.ts`
- Test: existing unit suites for each

**Interfaces:**
- After this task, `__tryCall`'s separate `isGuardExceededError` branch is DELETED — a `GuardExceededError` is now an `AgencyAbort` with a `guardTrip` cause, so `readCause(error)?.kind === "guardTrip"` (the existing branch from Increment 1) already converts it. This is the simplification unification buys.

- [ ] **Step 1: `result.ts`** — delete the `isGuardExceededError(error)` branch in `__tryCall` (the `guardCause?.kind === "guardTrip"` branch above it now handles both the leaf-rejection AND the thrown-`GuardExceededError` shapes, since the latter is an `AgencyAbort` carrying the same cause). Remove the now-unused `isGuardExceededError` import. Keep `guardFailureData`.

- [ ] **Step 2: Run** `pnpm test:run lib/runtime/result.test.ts` and the guard fixtures — a thrown `GuardExceededError` (cost-guard pre/post-call gate in `prompt.ts`) still converts to a `guardFailure`. If a cost-guard fixture fails, the cause must carry the cost guard's `guardId`/numbers — verify `CostGuard.check` builds the `GuardExceededError` with its real numbers (it does today).

- [ ] **Step 3: stdlib leaves** — `http.ts`, `builtins.ts`, `ui.ts`, `oauth.ts`, `speech.ts`, `shell.ts`: each still throws `new AgencyCancelledError("…")`. These keep working (it's now an `AgencyAbort` subclass). Where a signal is in scope, prefer carrying the cause via the `leafCancel` pattern (import from `abortable.ts` or inline `new AgencyCancelledError(msg, readCause(signal))`). This is additive — do it only where a `signal`/`abortSignal` is already in scope; leave the rest as bare cancels.

- [ ] **Step 4: predicate audit** — `grep -rn "instanceof GuardExceededError\|instanceof AgencyCancelledError" lib/ --include=*.ts | grep -v .test.ts`. Each such site still works (subclasses), but where the intent is "any abort", prefer `isAbortError`/`instanceof AgencyAbort`. Change only where it improves clarity; do not churn working checks gratuitously.

- [ ] **Step 5: Build + full unit suite** — `make`; `pnpm test:run` → all green.

- [ ] **Step 6: Full fixture regression** — `pnpm run a test tests/agency/guards` + `tests/agency/fork/race/*` + a sweep of handler/substep/interrupt fixtures. Save output to a file. Commit.

---

# Phase C — `guardId` matching (fix nested mis-attribution)

Depends on Phase B (cost guards carry guardId; `AgencyAbort` carries the cause). Makes a guard's `try` convert ONLY its own trip; an outer guard's trip re-throws past an inner guard.

## Task C1: Give every guard a `guardId`; `_pushGuard` returns the ids

**Files:**
- Modify: `lib/runtime/guard.ts` (`CostGuard` gains `guardId`; `CostGuard.check`/`TimeGuard.check` pass it into `GuardExceededError`), `lib/stdlib/thread.ts` (`pushGuardImpl`/`_pushGuard`/`__internal_pushGuard` return `string[]` ids)
- Test: `lib/runtime/guard.test.ts`, `lib/stdlib/thread` unit if present

**Interfaces:**
- Produces: `CostGuard.guardId: string` (via `nextGuardId()`); `pushGuardImpl(...)` and `_pushGuard(...)` return `string[]` (the pushed guards' ids, innermost-last) instead of a `number` count; `_popGuard(idsOrCount)` accepts the array length.

- [ ] **Step 1: Write failing test** (`guard.test.ts`): a `CostGuard` exposes a `guardId`, and its `check()`-produced `GuardExceededError`'s `agencyCause.guardId` equals it.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — add `readonly guardId = nextGuardId()` to `CostGuard`; pass `this.guardId` as the 4th arg to `new GuardExceededError(...)` in both `CostGuard.check` and `TimeGuard.check`. Change `pushGuardImpl` to collect and return the pushed guards' ids (`const ids: string[] = []; ... ids.push(g.guardId); return ids;`); update `_pushGuard`/`__internal_pushGuard` return types to `string[]`. `_popGuard` takes the array (use `.length`).

- [ ] **Step 4: Update `stdlib/thread.agency`** `guard()`:
  ```
  const ids = _pushGuard(cost, time)
  const result = _runGuarded(ids, block)
  _popGuard(ids)
  return result
  ```
  (`_runGuarded` is added in C2; until then keep `try block()` and `_popGuard(ids.length)` so the build stays green — split the agency change into C2.)

- [ ] **Step 5: `make`; run, verify pass**; cost + time guard fixtures green. Commit.

## Task C2: `ownedGuardIds` filter so a guard converts only its own trip

**Files:**
- Modify: `lib/runtime/result.ts` (`__tryCall` gains `ownedGuardIds`), `lib/stdlib/thread.ts` (`_runGuarded` helper), `stdlib/thread.agency` (`guard()` uses `_runGuarded`)
- Test: `lib/runtime/result.test.ts`; flip `tests/agency/guards/guard-time-nested-outer-tighter.test.json`

**Interfaces:**
- Produces: `__tryCall(fn, opts?)` where `opts.ownedGuardIds?: string[]`. A `guardTrip` cause is converted to a `Failure` ONLY if `ownedGuardIds` includes `cause.guardId`; otherwise it is re-thrown (propagates to the owning guard). `_runGuarded(ids: string[], block): Promise<Result>` calls `__tryCall(() => block(), { ownedGuardIds: ids })`.

- [ ] **Step 1: Write failing tests** (`result.test.ts`):
  - `__tryCall(throw guardTrip{guardId:"g1"}, { ownedGuardIds:["g1"] })` → converts to `timeoutFailure` (owned).
  - `__tryCall(throw guardTrip{guardId:"gOUTER"}, { ownedGuardIds:["gINNER"] })` → **re-throws** (not owned).
  - `__tryCall(throw guardTrip{guardId:"g1"})` (no `ownedGuardIds`, e.g. a plain `try`) → **re-throws** (a plain `try` inside a guarded block must not swallow the guard's trip).

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
  Add `ownedGuardIds?: string[]` to `FailureOpts`. Add `_runGuarded` to `thread.ts`:
  ```ts
  export async function _runGuarded(ids: string[], block: () => any): Promise<ResultValue> {
    return __tryCall(() => block(), { ownedGuardIds: ids });
  }
  ```
  Switch `guard()` in `thread.agency` to `const result = _runGuarded(ids, block)`.

- [ ] **Step 4: `make`.** Run the nested fixtures: `guard-time-nested` (inner tighter — still `"inner tripped"`) and `guard-time-nested-outer-tighter` (outer tighter). The outer-tighter case now routes to the OUTER guard.

- [ ] **Step 5: Flip the pinned fixture** — observe the new output (expected: the outer guard now trips → `"outer:timeoutFailure"`), update `guard-time-nested-outer-tighter.test.json`'s `expectedOutput` and rewrite its description to state the limitation is now FIXED (guardId matching). Re-run → green.

- [ ] **Step 6: Guard against the plain-`try`-in-guard regression** — add a fixture `tests/agency/guards/guard-trip-not-swallowed-by-inner-try` where a plain `try someAbortableLeaf()` sits inside a `guard(time:)`; assert the guard trips (its `Failure` surfaces) rather than the inner `try` swallowing it. (This behavior is newly-correct as of Step 3.)

- [ ] **Step 7: Full regression** — `make`; `pnpm test:run` (full unit suite); `pnpm run a test tests/agency/guards`; race fixtures; `pnpm run lint:structure`. Save output. Commit.

---

## Final verification (whole plan)

- [ ] `make` clean; `pnpm test:run` full unit suite green.
- [ ] `tests/agency/guards` (all, incl. the flipped + new fixtures), `tests/agency/fork/race/*`, and a handler/substep/interrupt sweep green.
- [ ] `pnpm run lint:structure` clean.
- [ ] Codegen: a freshly compiled fixture shows the single `instanceof AgencyAbort` catch rung.
- [ ] Open the PR to `main`; mention the ~126-file mechanical fixture regen lands in its own commit (B3) for reviewability.

## Spec sync

- [ ] After landing, update the spec's §4 "what shipped vs deferred" note and §5 to reflect that unification + guardId matching + the deferred Increment-1 bits have shipped, and mark the `connectionLost` / `callTimeout` UX as the remaining future work.
