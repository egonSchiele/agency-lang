# Make the `destructive` marker authoritative for removal-on-failure, via destructive regions

Date: 2026-07-12
Status: Design (approved, pre-plan)

## Problem

When an LLM-callable tool marked `destructive` fails, it should be removed from
the tool set so the model cannot call it again — a failure may have left the
world in an unclean state. Today that does not reliably happen, and *whether* it
happens depends on an accident of the function body.

Removal is gated on a runtime flag, `destructiveRan`. `failureTier`
(`lib/runtime/prompt.ts`) returns the `destructive` tier (→ remove the tool)
only when a failure carries `destructiveRan === true`. Inside a
`destructive`-marked function, `DestructiveTracking.statementFlips`
(`lib/backends/typescriptBuilder/destructiveTracking.ts`) sets the flag before
any statement for which `NameClassifier.containsImpureCall(stmt)` is true —
i.e. the statement calls an **imported** symbol (`BUILTIN_FUNCTIONS` is empty,
`lib/config.ts`). So the flag flips based on whether the body happened to call
an import (e.g. `print`) versus a same-file `def`, not on the `destructive`
declaration. Verified by compiling probes: a call to a local `def` emits no
flip; the flip appears only before an imported call. `print("hello")` before an
interrupt flips it; a local helper does not.

The interrupt-guard idea does not rescue this in practice. Every real
`destructive` function in stdlib validates/preps **before** its interrupt gate:

```
export destructive def write(...) {
  if (useAgentCwd) { dir = applyAgentCwd(dir) }          // prep
  return interrupt std::write("Are you sure?", {...})     // gate
  return try _write(...)                                  // the destructive work
}
```

Any rule that keys "committed" on "a non-interrupt statement ran" would treat
the `if (useAgentCwd)` prep as committing, so rejecting the confirmation would
remove `write` for the rest of the session. Rejecting one write should not
disable writes forever. The gate needs to sit *outside* the destructive region,
which a whole-function marker cannot express.

## Goal

Make the `destructive` declaration authoritative and let the user say exactly
which code is destructive:

- A function marked `destructive def` — its **entire body** is destructive.
  Entering the body commits; any failure removes the tool. (No interrupt
  special-case: the whole body is destructive by declaration.)
- A new `destructive { ... }` **block** — only the code inside is destructive.
  Entering the block commits; failing inside removes the tool. Code before the
  block (prep, an interrupt gate) is not destructive, so failing there — or
  rejecting the gate — is retryable.
- Success stays re-callable (unchanged). Argument-binding failures (body never
  runs) stay retryable (`neverStarted`).

No compiler heuristic. The user declares the boundary; the compiler marks it.

### Retryable vs. removed

A destructive tool's failure removes the tool iff execution **entered a
destructive region** (a `destructive def` body, or a `destructive { }` block)
before failing. Otherwise it is retryable.

| Failure point | Entered a destructive region? | Outcome |
|---|---|---|
| Bad arguments — binding fails, body never runs | no | retryable (`neverStarted`) |
| Rejected at an interrupt gate placed before the region | no | retryable (`neutral`) |
| Inside a `destructive def` body (any statement) | yes | removed |
| Inside a `destructive { }` block | yes | removed |
| Success | — | stays callable |

## Design

### Two notions, deliberately separated

1. **Is a function destructive?** (metadata) — true if it is marked
   `destructive def` **OR** its body contains a `destructive { }` block. This
   drives the tool descriptor `markers.destructive` (`typescriptBuilder.ts`
   ~2340), the MCP `destructiveHint` and HTTP `/list` boolean
   (`lib/serve/*/adapter.ts`, both read `markers?.destructive`), and the
   `compilationUnit.destructiveFunctions` registry used by Rule 2. A migrated
   `def gitAdd(...) { … destructive { … } }` therefore still reports as
   destructive to clients and to callers.
2. **When does `destructiveRan` flip?** (runtime removal) — at **function
   entry** for `destructive def`, or at **block entry** for `destructive { }`.
   Only entering a region commits.

### Runtime commit points (codegen)

- `destructive def`: `DestructiveTracking.init()` currently emits
  `__self.__destructiveRan = __self.__destructiveRan ?? false`. For a
  destructive-marked function, emit `__self.__destructiveRan = true` instead.
  `init()` runs after argument binding and before the body, so an
  argument-binding failure (`neverStarted`) still carries `destructiveRan =
  false` and stays retryable; once the body begins, the tool is committed.
- `destructive { }` block: emit `__self.__destructiveRan = true` at block entry,
  as a non-step-consuming preamble (the same way the current pre-flip is pushed
  into the active "part" without its own substep id), then compile the block
  body.
- A function that only **contains** a block (not itself marked `destructive
  def`) does **not** flip at entry — it keeps the `?? false` init and commits
  only when the block is entered. The entry flip is tied to the `destructive
  def` marker alone; "contains a block" affects only the metadata notion below.
- The per-statement Rule 1 scan (`containsImpureCall`) is **removed**.
- Rule 2 (a non-destructive function calling a destructive function: the
  outcome-flip that ORs the callee's `destructiveRan` into the caller, plus the
  conservative pre-flip) is **unchanged**. It already trusts the callee's
  runtime flag, so a function whose `destructive { }` block was not reached
  returns `destructiveRan = false` and does not taint its caller.

### The `destructive { }` block is a transparent, stepped region

The block introduces **no new lexical scope** — it is purely a
destructive-region marker; declarations inside it are visible after it, like a
plain statement group. Its body statements are compiled through the **same
step-aware statement machinery as the enclosing function body**, spliced INLINE
into that stream. Concretely, `destructive { s1; s2 }` compiles as
`[flip, s1, s2]` inside the enclosing function's stepped statements, so
`s1`/`s2` get substep ids continuous with the rest of the body.

**HEADLINE CONSTRAINT for the codegen task — a conventional block flips the flag
into the wrong frame and fails OPEN.** Inside a normal Agency block,
`__self = __bstack.locals` (the block's own frame, `typescriptBuilder.ts`
~3118). If `destructive { }` were compiled as a conventional block, the entry
flip `__self.__destructiveRan = true` would write the **block's** locals and
**evaporate at block exit**. The failure leaving the function would then carry
`destructiveRan = false` → the tool is **NOT removed**. That is the dangerous
(fail-open) direction, and it is the same pre-existing hole where writeAgency's
guard-block flips already evaporate. The flip must land on the **enclosing
function's** activation `__self` — which is exactly why the block must be
inlined (transparent), not compiled as a frame-bearing block.

**Implementation mechanism (pin this, don't paraphrase as "use
`processBodyAsParts`").** Mirror the existing pipe-chain expansion inside
`processBodyAsParts` (`typescriptBuilder.ts` ~3956–3972): special-case a
`destructiveBlock` node in that loop — `flushPart()`, push the entry flip into
the active part, then process the block's body statements **inline with
continuing substep ids**, then `continue`. Do NOT return one compound node from
`processStatement`: that silently breaks both interrupt-resume (ids no longer
continuous with statements after the block) and declaration visibility
(bindings trapped in a nested node). Use `processBlockPlain` nowhere here (it is
the interrupt-free "plain" path for expression-position match arms).

**Interrupts inside a destructive block must work correctly** (explicit
requirement). Because the region commits at entry, an interrupt inside the block
is after the commit: rejecting it removes the tool (you placed the gate inside
the destructive region). Because the block is inlined, an `interrupt(...)` or
async call inside it pauses and resumes at the correct substep relative to
statements *after* the block, and the entry `__destructiveRan = true` survives
checkpoint/resume — it re-applies idempotently on replay and is preserved across
serialization (per the #522 boundary-folding design). A `return` inside the
block halts the **function** (again, only because the block is inline) and hits
the function exit stamp that folds `destructiveRan`. All of this is mandated by
tests (below), including one that asserts `destructiveRan` is true on a failure
that **escapes the whole function after the block** (reaches the function's exit
stamp / activation `__self`) — testing only at block entry would pass even in
the broken frame-local implementation.

### `destructiveRan` meaning

"Execution entered a destructive region" — a `destructive def` body or a
`destructive { }` block. One meaning across all consumers: the `r.destructiveRan`
field on `ResultFailure` (`lib/runtime/result.ts`, typed in `resultUnion.ts` /
`synthesizer.ts`), decision-8 caller propagation
(`lib/runtime/prompt.ts` / `markDestructiveWork`), and statelog
(`lib/statelogClient.ts`).

### Removal wiring — unchanged

`failureTier` already returns the `destructive` tier (→ single-failure removal)
when `destructiveRan` is true, and `neverStarted` (retryable) when the body
never started. With commit driven by region-entry, the table above holds with
no tool-loop change.

## New construct: `destructive { }`

Following `docs/dev/adding-features.md` (adding an AST node):

- **Type** — `DestructiveBlock = BaseNode & { type: "destructiveBlock"; body:
  AgencyNode[] }` in `lib/types/`; export from `lib/types.ts`; add to the
  `AgencyNode` union.
- **Parser** — parse `destructive { … }` in `lib/parsers/parsers.ts`, wired into
  the statement parser; co-located tests. Must disambiguate `destructive {`
  (block) from the `destructive def` function marker and from `destructive` used
  as an identifier.
- **Formatter** — format `destructive { … }` (block body indented).
- **Codegen** — a case that emits the entry flip and compiles the body through
  the stepped statement path (see above).
- **Typecheck / symbol table** — the block body typechecks and resolves in the
  enclosing scope (no new bindings semantics). Confirm the generic node walkers
  (`walkNodes`) descend into `.body` so symbol resolution, effect/`raises`
  checking, and narrowing see the body; add a passthrough case where a pass
  dispatches on node type.
- **Fixtures** — `.agency`/`.mts` pairs in `tests/typescriptGenerator/`.

Nesting notes: a `destructive { }` inside a `destructive def`, or nested
`destructive { }` blocks, are harmless no-ops (the flag is already/again set).

## Stdlib migration (in scope, this change)

Migrate every stdlib `destructive def` whose interrupt gate should stay
retryable-on-rejection to `def` + `destructive { }` around only the effectful
work. Pattern:

```
export destructive def f(...) {          export def f(...) {
  prep                              →       prep
  interrupt gate                            interrupt gate
  work                                       destructive { work }
}                                         }
```

Functions to migrate (~20+): `stdlib/git.agency` (gitAdd, gitCommit,
gitCheckout, gitSwitch, gitBranchCreate, gitBranchDelete, gitStashPush,
gitStashPop, gitRestore), `stdlib/fs.agency` (edit, applyPatch, mkdir, copy,
move, remove), `stdlib/shell.agency` (exec, bash), `stdlib/index.agency`
(write, writeBinary), `stdlib/clipboard.agency` (copy), and any others surfaced
by `grep -rn "destructive def" stdlib/`.

The uniform three-line pattern will NOT hold for every function — some split
effectful work across statements, interleave post-processing, or use the
`return interrupt <effect>(...)` continuation form (where the statement after
the gate is the work performed on approval). The **plan must enumerate each
function's gate/work split explicitly** rather than assume the pattern: a
mis-drawn boundary either leaves committed work *outside* the region (fail-open:
the tool is not removed after doing damage) or pulls the gate *inside* it
(removes the tool on a legitimate rejection). Because these functions contain a
`destructive { }` block, they remain `isDestructive`-true for client hints and
the Rule 2 registry (see "Two notions"). Rebuild with `make` after editing any
stdlib `.agency`.

## Blast radius / files

- `lib/backends/typescriptBuilder/destructiveTracking.ts` — `init()` sets `true`
  for destructive functions; remove the `statementFlips` Rule-1 scan; its unit
  tests.
- `lib/backends/typescriptBuilder.ts` — `destructiveBlock` codegen case. Two
  distinct predicates: (a) the **entry flip** (`init()` → `= true`) and
  `inDestructiveFunction` (~2266) key on the raw `destructive def` marker ALONE
  (`node.markers?.destructive`); (b) the **emitted descriptor** marker (~2340),
  the MCP/HTTP hint, and the `destructiveFunctions` registry use a *derived*
  `isDestructive = node.markers?.destructive || containsDestructiveBlock(node)`.
  Do NOT mutate `node.markers.destructive` to fold in "contains a block" — that
  would wrongly turn on `inDestructiveFunction`/the entry flip for a
  contains-block-only function. Note the emitted descriptor marker is also read
  at runtime on the SUCCESS path (`handler.markers?.destructive` →
  `toolDidDestructiveWork`, `prompt.ts` ~1156–1158). For a contains-block
  function this is true whenever the tool succeeds, **even if execution never
  entered the block** — e.g. an early `return success()` before the block, or a
  block behind a condition. Under the old whole-function model success ⇒
  did-work was exact; under the block model this over-taint becomes reachable in
  ordinary control flow, propagating `destructiveRan` to the caller via
  decision-8 when the block may not have run. It is the **safe** direction
  (over-taint, never under-taint), so it is acceptable — see the non-goal option
  to unify the success path onto the runtime flag. The failure path stays
  precise (it uses the runtime `destructiveRan`).
- `lib/compilationUnit.ts` — populate `destructiveFunctions` from marked-OR-
  contains-block (~180).
- `lib/backends/typescriptBuilder/nameClassifier.ts` — remove `containsImpureCall`
  (sole consumer was Rule 1); confirm no other consumer.
- New AST node plumbing: `lib/types/`, `lib/types.ts`, `lib/parsers/parsers.ts`
  (+ tests), formatter, typecheck/symbol-table passthrough.
- `tests/agency/destructive-tracking.agency` (+ `.test.json`) — rewrite to the
  region model (see Testing).
- Stdlib `.agency` files listed above (+ their tests where behavior asserts
  removal/retryability).
- `lib/runtime/result.ts` JSDoc on `destructiveRan`; `docs/site/guide/llm-part-2.md`
  ("when a tool call fails" + document the `destructive { }` block);
  doc comments in `destructiveTracking.ts`.

## Testing

- Rewrite `destructive-tracking` agency tests to the region model:
  `destructive def` body entry → `destructiveRan` true; `destructive { }` entry
  → true; failure before a block (prep/gate) → false; bad-args → false.
- **Frame-escape test (Finding A — the anti-fail-open guard):** a failure that
  escapes the **whole function** after passing through a `destructive { }` block
  must carry `destructiveRan = true` at the function exit stamp / activation
  `__self` — NOT merely observable at block entry. A test that only checks the
  flag at block entry would pass even in the broken frame-local implementation,
  so this test must assert at function-escape.
- **Interrupts in a destructive block** (mandated): an execution test where a
  `destructive { }` block contains an interrupt — approve path resumes and
  completes; reject path removes the tool; a pause/resume across the block
  preserves `destructiveRan`. Deterministic (no real LLM; removal is
  `destructiveRan`-driven).
- **Inline-splice test (Finding B):** a `let` declared inside `destructive { }`
  is used *after* the block (declaration visibility), and an interrupt inside the
  block resumes correctly with a statement following the block (continuous
  substep ids).
- **Return-in-block test (Finding D):** a `return` inside `destructive { }` exits
  the function; an escaping failure after such a block carries
  `destructiveRan = true`.
- Tool-removal behavior test: a tool that fails inside its destructive region is
  removed after one failure; one that fails/rejects before the region is
  retryable.
- Stdlib: a representative migrated tool (e.g. `write`) — rejecting the gate is
  retryable; failing inside the block removes it; MCP/HTTP still report it
  destructive.
- **Parser disambiguation (Finding E):** `destructive { }` as a statement;
  `destructive def` unchanged; `destructive` as an ordinary identifier still
  parses; a nested `destructive { }` inside a `destructive def` compiles (no-op,
  flag already true). Plus formatter unit tests and typescriptGenerator fixtures.
- Full lib suite (8000+) green.

## Non-goals

- Whether a **non-destructive** tool's rejected interrupt should be retryable —
  separate question (the `interrupt.test.json` flake, PR #533).
- Success-path semantics — a successful destructive tool stays callable.
- Block-level lexical scoping — `destructive { }` introduces no new scope.
- **Unifying the success path onto the runtime flag (Finding C option, not
  taken):** the SUCCESS-path `toolDidDestructiveWork` could consult the runtime
  `destructiveRan` (which the transparent-block flip already maintains on
  `__self`) instead of the coarse descriptor marker, collapsing the success and
  failure paths onto one signal and removing the over-taint. Left out to keep
  this change scoped; the current over-taint is the safe direction. Revisit if
  the extra caller-taint proves noisy.

## Rejected alternatives

- **A per-statement heuristic (round-1 predicate approach).** Flip
  `destructiveRan` before the first "non-interrupt" (or "impure-call") statement.
  Rejected: every real stdlib `destructive def` preps before its gate, so the
  first statement commits and rejecting the gate removes the tool. No
  whole-function rule can express "gate outside, committed work inside."
- **Marking the interrupt itself** (e.g. a "committing interrupt"). Rejected: the
  commit boundary is the *work*, not the gate; a function may have work with no
  gate, or a gate far from the work. A region names the work directly.
- **An `idempotent { }` block, for syntactic symmetry with `destructive { }`.**
  Rejected: the two markers are not mirror concepts. `destructive` is a *commit
  point* — a function has a natural before/after boundary (clean prep/gate, then
  touching the world), which a region expresses. `idempotent` is a *global
  promise* that re-running the whole tool from the start is safe; a retry always
  restarts the tool, never resumes at a sub-region, so there is nothing for a
  region boundary to attach to and nothing consumes a per-region idempotency
  signal. An `idempotent { }` block would compile to nothing operational and
  would falsely imply a tool can be "partly idempotent." `idempotent` stays a
  function marker only.
