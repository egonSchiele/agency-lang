# Review round 2: destructive marker authoritative — the `destructive { }` region design

Reviewer: Claude
Date: 2026-07-12
Target: `docs/superpowers/specs/2026-07-12-destructive-marker-authoritative-design.md`
Prior round: `docs/superpowers/plans/2026-07-12-destructive-marker-authoritative-review.md`
Branch/worktree: `feat/destructive-marker-authoritative`

## Verdict

**Close to executable; no blockers, but one caution must become the headline of
the codegen task.** The spec was rewritten around a new `destructive { }` block
construct — a genuine improvement that resolves both round-1 findings at the
root:

- Round-1 Finding 1 (comment/blank-line flips): gone. The per-statement
  `containsImpureCall` scan is removed entirely; commit is now a single
  region-entry flip. No incidental-body-content sensitivity remains.
- Round-1 Finding 2 (guard-before-interrupt): gone, and now the *motivating*
  case. The Problem section correctly shows every real stdlib `destructive def`
  preps before its gate, so no whole-function rule can work — the gate must sit
  *outside* the destructive region, which the block expresses and a marker
  cannot.

The two-notions separation (metadata `isDestructive` vs runtime `destructiveRan`)
is well thought through and the blast-radius section already anticipates the
descriptor-vs-entry-flip split. Findings below are one must-emphasize caution and
several precision/test items.

## Verified against code

- **`neverStarted` survives `init() = true`.** `init()` is pushed at
  `typescriptBuilder.ts:2132`, *after* the param-binding assignments
  (`:2112–2129`). So a `destructive def` whose arg binding fails halts before
  `init()` runs → `destructiveRan` stays false → `neverStarted`/retryable. §Design
  "Runtime commit points" is correct.
- **Entry flip keys on the raw marker alone.** `inDestructiveFunction` is set from
  `node.markers?.destructive` at `:2266`. The spec's instruction to keep the
  entry flip on the raw marker (not the derived `isDestructive`) matches how the
  code already reads it.
- **Rule 2 trusts the callee's runtime flag.** The outcome-flip
  (`isFailure(r) ? r.destructiveRan : true`) means a callee whose `destructive {}`
  block was never reached returns `destructiveRan = false` and does not taint its
  caller. §Design point 4 holds.
- **`containsImpureCall` is dead after removing Rule 1** — sole consumer was the
  Rule-1 scan (confirmed round 1).
- **`destructive` is a modifier-table keyword** (`parsers.ts:4704`,
  `str("destructive")` + spaces), so the new block parser must coexist with it
  (Finding E).

## Finding A (must be the headline of the codegen task) — a conventional block would evaporate the flip, failing OPEN

The single load-bearing constraint is buried in prose. Inside a normal Agency
block, `__self = __bstack.locals` (the block's own frame) — verified at
`typescriptBuilder.ts:3118–3119`:

> Scope must be "block" so processLlmCall assigns into `__bstack.locals.__prompt`,
> which is what `ts.self(...)` resolves to inside a block (where
> `__self = __bstack.locals`).

So if `destructive { }` were compiled as a conventional block, the entry flip
`__self.__destructiveRan = true` would write the **block's** locals and evaporate
at block exit. The failure leaving the function would then carry
`destructiveRan = false` → the tool is **not** removed. That is the dangerous
direction (fail-open), and it is the exact pre-existing hole where writeAgency's
guard-block flips already evaporate.

The spec's "no new lexical scope / use `processBodyAsParts` / NOT
`processBlockPlain`" is the correct fix, but states the *what* without the *why*.
Make the failure mode explicit so no one reuses block infrastructure as a
shortcut, and pin it with a test that asserts `destructiveRan` is **true on a
failure that escapes the whole function after the block** (i.e. reaches the
function's exit stamp / activation `__self`), not merely observable at block
entry. Testing at block entry alone would pass even in the broken frame-local
implementation.

## Finding B (moderate) — specify the inline-splice mechanism, not just "use processBodyAsParts"

For (1) substep ids continuous with the enclosing body (so an interrupt inside
the block resumes at the correct step relative to statements *after* the block)
and (2) declarations inside the block visible after it, the block body must be
**spliced into the enclosing statement stream**, not returned as one compound
node from `processStatement`.

The existing precedent is the pipe-chain expansion inside `processBodyAsParts`
(`:3956–3972`): detect the special node, `flushPart()`, emit the pre-formed runner
nodes inline with continuing ids, `continue`. Direct the implementer to mirror
that shape for `destructiveBlock`: in `processBodyAsParts`, special-case it —
flush, push the entry flip into the active part, then process its body inline with
continuing ids. Without this pin, a naive `processStatement` case returns one
compound node and silently breaks both interrupt-resume and declaration
visibility. Add a test: a `let` declared inside `destructive { }` is used after
the block, and an interrupt inside the block resumes correctly with a statement
following the block.

## Finding C (moderate) — success-path coarseness is now reachable in normal control flow; state it, don't imply parity

On the SUCCESS path, `toolDidDestructiveWork` reads the coarse descriptor marker,
not the runtime flag — confirmed at `prompt.ts:1156–1158`:

```
const toolDidDestructiveWork = isFailure(toolResult)
  ? toolResult.destructiveRan
  : !!handler.markers?.destructive;
```

For a contains-block function this is true whenever the tool succeeds, even if
execution never entered the block — e.g. an early `return success()` before the
block, or a block behind a condition. That over-taints the caller via decision-8.
Under the old whole-function model, success ⇒ did-work was defensible (the whole
body was destructive). Under the block model it is now reachable in ordinary
control flow. The spec's "consistent with today's `destructive def` success
handling" undersells this.

It is the **safe** direction (over-taint, never under-taint), so acceptable — but
say so precisely so the owner signs off knowing the new reachability. If precision
is wanted, name as a possible non-goal: the success path could also consult the
runtime `destructiveRan` (which the transparent-block flip already maintains on
`__self`), collapsing the failure and success paths onto one signal.

## Finding D (minor) — migration: `return` inside the block, and per-function boundary is real work

- The `write` example wraps `return try _write(...)` in `destructive { }`. A
  `return` inside the transparent block must halt the **function** and trigger the
  function exit stamp that folds `destructiveRan` — which works only because the
  block is inline (Finding A), not a frame with its own halt. Add to the
  transparency test: a `return` inside `destructive { }` exits the function and
  the escaping failure carries `destructiveRan = true`.
- The uniform three-line pattern (prep / gate / `destructive { work }`) will not
  hold for every function — some split effectful work across statements or
  interleave post-processing. The spec acknowledges "the exact gate/work boundary
  must be identified"; the plan should **enumerate each function's split**
  explicitly rather than assume the pattern, since a mis-drawn boundary either
  leaves committed work outside the region (fail-open) or pulls the gate inside
  it (removes on legitimate rejection).

## Finding E (minor / confirm) — parser disambiguation cases to pin

`destructive` is parsed by the function-modifier table (`parsers.ts:4704`). The
new block statement parser must be positioned so that `destructive {` cleanly
fails the function-def path (no `def` follows) and backtracks to the block parser,
and so `destructive` as an ordinary identifier/expression still parses. Feasible
with tarsec `or` backtracking; pin with tests for: `destructive { }` as a
statement, `destructive def` unchanged, and a nested `destructive { }` inside a
`destructive def` (spec says harmless no-op — assert it compiles and the flag is
already true).

## Altitude

Right call. Introducing a language construct is heavier than the round-1 predicate
tweak, but the Problem section earns it: no whole-function marker can express
"gate outside, committed work inside," and my round-1 review already showed the
lighter interrupt-heuristic breaks on real stdlib code. A block is the clean,
composable primitive. One optional addition: a one-line rejected-alternatives note
(e.g. why a block beats marking the interrupt itself, or a `gate { }` inverse)
would round out the design the way round 1 had one.
