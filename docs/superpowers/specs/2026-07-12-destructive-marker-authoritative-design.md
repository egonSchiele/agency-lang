# Make the `destructive` marker authoritative for tool removal-on-failure

Date: 2026-07-12
Status: Design (approved, pre-plan)

## Problem

When an LLM-callable tool marked `destructive` fails, it should be removed from
the tool set so the model cannot call it again — a failure may have left the
world in an unclean state. Today that does not reliably happen. Removal is gated
on a runtime flag, `destructiveRan`, and the flag is set by a compiler heuristic
that has nothing to do with the `destructive` declaration.

Inside a `destructive`-marked function, `DestructiveTracking.statementFlips`
(in `lib/backends/typescriptBuilder/destructiveTracking.ts`) emits
`__self.__destructiveRan = true` before any statement for which
`NameClassifier.containsImpureCall(stmt)` is true. `containsImpureCall` returns
true only when the statement calls an **imported** name or a member of
`BUILTIN_FUNCTIONS`. `BUILTIN_FUNCTIONS` is `{}` (empty, `lib/config.ts`), so in
practice the flag flips only before a statement that calls an imported symbol.

Consequences, all verified by compiling probes and running the real LLM:

- A `destructive` function whose interrupt is its first statement, rejected,
  keeps `destructiveRan = false` → the tool-loop classifies the failure as the
  `neutral` tier ("you may call this tool again") → the model retries it up to
  `MAX_TOOL_FAILURES` (5). Removal never happens after a single failure.
- Adding `print("hello")` before the interrupt *does* cause removal — only
  because `print` is a prelude **import**, so `containsImpureCall` fires. The
  effect turns on an unrelated accident (import vs. local `def`), not on the
  `destructive` declaration.
- A call to a same-file `def` (which could do arbitrary destructive I/O) does
  **not** flip the flag, because a local `def` is not an import.

So whether a failed destructive tool is removed depends on whether its body
happened to call an imported symbol before failing. That is incoherent: the
`destructive` marker is a user declaration and should be authoritative.

## Goal

A tool declared `destructive` that **fails** is removed and cannot be called
again by the LLM, regardless of the body — with one narrow, principled
exception: failures where **no non-interrupt statement of the body executed**.
Success stays re-callable (unchanged).

### Retryable vs. removed (agreed)

A destructive tool's failure is **retryable** iff *no non-interrupt statement of
its body executed before the failure*; otherwise the tool is **removed**.

| Failure point | non-interrupt stmt ran? | Outcome |
|---|---|---|
| Bad arguments — argument binding fails, body never starts | no | retryable (`neverStarted` tier) |
| Rejected at an interrupt that is the first/only statement executed | no | retryable (`neutral` tier) |
| Any statement other than a leading interrupt runs, then fails | **yes** | **removed** (`destructive` tier) |
| Success | — | stays callable (unchanged) |

Accepted trade-off: pure validation-refusals in destructive tools become
non-retryable. A guard like `if (x < 0) { return failure(...) }` is a
non-interrupt statement, so reaching it commits the tool. The model can no
longer "fix the arguments and retry" *once the body has started*; it can still
retry a call that failed **argument binding** (see the bad-args row), because
there the body never ran.

## Approach (chosen: redefine the flip predicate)

Change the single predicate that decides when `destructiveRan` flips inside a
destructive function, from "the statement calls an import" to "the statement is
anything other than raising an interrupt." This makes one concept mean one thing
across all three consumers of `destructiveRan` (the observable `r.destructiveRan`
Result field, decision-8 caller propagation, and statelog), and deletes the
import heuristic from this path.

Rejected alternative — *tool-loop only*: leave `destructiveRan`'s import
heuristic in place for the field/decision-8, and make `failureTier` key on
`handler.markers.destructive` plus a new parallel signal for "a non-interrupt
statement ran." Rejected because it adds a second flag and leaves the incoherent
import-heuristic meaning of `destructiveRan` in place — the exact thing this
change is meant to remove.

## Design

### 1. Codegen: the flip predicate

In `DestructiveTracking.statementFlips`, the `inDestructiveFunction` branch
currently returns a pre-flip when `containsImpureCall(stmt)`. Replace that
condition with `!isInterruptOnlyStatement(stmt)`:

```
if (inDestructiveFunction) {
  return isInterruptOnlyStatement(stmt) ? {} : { pre: markTrue() };
}
```

Emitting `markTrue()` before every non-interrupt statement is redundant after
the first (the flag is sticky `= true`) but harmless and needs no "first
statement" bookkeeping. The `init()` (`__destructiveRan = __destructiveRan ?? false`)
and `exitStamp()` (`stampFailureBoundary(runner.haltResult, __self.__destructiveRan)`)
are unchanged. The non-destructive branch (Rule 2, `containsDestructiveCall`
before calls to `destructive` functions) is unchanged.

`containsImpureCall` in `NameClassifier` is no longer used by this rule. Confirm
during implementation that it has no remaining consumer; if dead, remove it.

### 2. `isInterruptOnlyStatement(stmt)`

True only for a statement whose *sole* action is raising an interrupt:

- a bare `interruptStatement` (`interrupt(...)` or `raise ...`); or
- a `returnStatement` whose `value` is directly an `interruptStatement`
  (`return interrupt(...)`); or
- an assignment whose value is directly an `interruptStatement`
  (`let x = interrupt(...)`).

Everything else is non-interrupt and flips the flag: pure computation, property
access, calls (local or imported), `if`/`while`/`for` (even one that merely
wraps an interrupt in its body), and any expression that only *contains* an
interrupt as a sub-part. Deliberately conservative — only a leading, direct
interrupt gate is treated as clean. (`return interrupt(...)` parses as a
`returnStatement` whose `value.type === "interruptStatement"`; verified.)

Correctness edge: the predicate must fire only on **executable** statements.
Non-executable nodes (comments, blank lines, type-only nodes) must not flip the
flag. Today `containsImpureCall` returns false for them so they never flip;
`!isInterruptOnlyStatement` would return true for them, so the implementation
must confirm `statementFlips` is reached only for executable statements (it is
guarded by an earlier `continue`/skip in the statement loop) or exclude those
node types explicitly.

### 3. New meaning of `destructiveRan`

"At least one non-interrupt statement of a destructive function's body began
executing." This replaces "a statement was about to call an imported symbol." It
is the same value observed by:

- the `r.destructiveRan` field on `ResultFailure` (`lib/runtime/result.ts`),
  typed in the checker (`resultUnion.ts`, `synthesizer.ts`);
- decision-8 propagation, where a destructive tool inside `llm()` folds its flag
  into the caller's activation (`lib/runtime/prompt.ts`, `markDestructiveWork`);
- statelog (`lib/statelogClient.ts`).

Consequence to note: decision-8 propagation now fires on *any* non-interrupt
work in a destructive callee, not just imported calls — so an enclosing
agent-as-tool is tainted more readily. This is consistent with the model (a
destructive sub-operation that did work and then failed taints the caller).

### 4. Removal wiring — unchanged

`failureTier` (`lib/runtime/prompt.ts`) already returns the `destructive` tier
(→ `removedTools.push`) when `failure.destructiveRan` is true, and the
`neverStarted` tier (retryable) when the body never started. With the corrected
flip, no tool-loop change is needed:

- bad args → body never runs → `destructiveRan` false, `neverStarted` true →
  `neverStarted` tier (retryable);
- rejected at a leading interrupt → `destructiveRan` false, `neverStarted` false
  → `neutral` tier (retryable);
- any other statement then fail → `destructiveRan` true → `destructive` tier
  (removed);
- success → not a failure → no removal.

The `destructive` tier already removes the tool after a **single** such failure
and messages the model that the tool can no longer be called.

## Blast radius / files

- `lib/backends/typescriptBuilder/destructiveTracking.ts` — predicate change +
  `isInterruptOnlyStatement` (here or on `NameClassifier`); its unit tests
  (`destructiveTracking.test.ts`) — the "impure call flips" cases become
  "non-interrupt statement flips"; the `init()` unconditional test is unchanged.
- `NameClassifier` (`lib/backends/typescriptBuilder/nameClassifier.ts`) — remove
  `containsImpureCall` if it becomes dead.
- `tests/agency/destructive-tracking.agency` (+ `.test.json`) — rewrite the
  expectations. Under the new rule `burn(-1)` fails at `if (x < 0) return
  failure(...)`, a non-interrupt statement, so `destructiveRan` is now **true**;
  it is no longer a "clean refusal." Replace/extend with genuine clean cases
  (interrupt-first reject → false; bad-args → false) and keep a work-then-fail
  case (→ true).
- `lib/runtime/result.ts` — JSDoc on the `destructiveRan` field.
- `docs/site/guide/llm-part-2.md` — the "when a tool call fails" section:
  reword "clean refusal" to "pre-body / interrupt-gate only."
- Doc comments in `destructiveTracking.ts` referencing the old rationale.

## Testing

- Rewrite the `destructive-tracking` agency tests to encode the agreed table:
  interrupt-first reject → retryable/`destructiveRan` false; any other statement
  then fail → removed/`destructiveRan` true; bad-args → retryable.
- Add a tool-removal behavior test (agency or agency-js, deterministic LLM — no
  real model needed, since removal is driven by `destructiveRan`, which is
  deterministic): a `destructive` tool that runs a non-interrupt statement then
  fails is removed after one failure; one rejected only at its leading interrupt
  is not.
- Unit tests for `isInterruptOnlyStatement` and the flip predicate.
- Full lib suite (8000+) must stay green.

## Non-goals

- Whether a **non-destructive** tool's rejected interrupt should be retryable at
  all — that is a separate question (surfaced by the `interrupt.test.json`
  flake, PR #533) and is not addressed here.
- Success-path semantics — a successful destructive tool remains callable
  (unchanged).
