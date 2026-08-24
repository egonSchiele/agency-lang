# saveDraft: how salvage-on-abort is implemented

`saveDraft(v)` records a best-so-far value for the current scope. When an
enclosing `guard(...)` trips before that scope returns, the guard yields
the saved draft instead of a failure. This doc explains how that works
under the hood, the trade-offs behind the design, and the nuances that
are easy to miss. User-facing docs live in the guide; this is for people
changing the implementation.

This doc covers the salvage mechanism and the `finalize` keyword.

## The core idea: an aborted function returns its draft

When an abort stops a function, the function does not throw past its own
frame. The frame catches the abort and returns an `AbortedResult`
instead. That is a marker saying "my run was aborted", plus the cause,
plus the frame's saved draft as its partial. Callers receive it like any
other return value. The generated check that runs after every call, the
same place interrupts are checked, spots the marker, so the caller stops
too and returns its OWN `AbortedResult`. So an abort travels up the stack
as a plain value, the same way interrupts do.

Exceptions still exist, but only in two places:

- **Inside a single frame.** A cancelled in-flight leaf op (`llm()`,
  `sleep()`) rejects, and the frame that was running converts that
  rejection into the value at its own catch. A `GuardExceededError`
  thrown by the runner's `shouldSkip` converts at the same catch.
- **Above node level.** A node that receives an aborted value rebuilds
  the exception (`toError()`), so the graph engine, the CLI entry, the
  REPL, and root budgets (`--max-cost`/`--max-time`) see aborts exactly
  as they did before this feature.

## The salvage rules, and why each one is structural

Each rule is a consequence of "an aborted function returns its draft"
plus where the returned value lands. There is no case enumeration in the
compiler, and that is deliberate (see the trade-offs section).

1. **The frame where the abort strikes** returns its saved draft, or
   nothing (`AbortedResult.fromError`, called in the generated catch).
2. **A caller receiving an aborted result at a statement**, meaning an
   assignment or a bare call, stops and returns its own saved draft
   (`carryThrough`). The callee's partial is dropped, because salvage is
   opt-in per level.
3. **Return position passes a partial through** because returning a
   value is what return statements do. `return verify()` returns
   verify's result, aborted or not. No code runs, so there is nothing
   to get wrong.
4. **Argument position drops at the call boundary.** In `f(g())` with g
   aborted, `__call` refuses to run f and forwards the abort with the
   partial dropped, because g's partial is g-typed and f's return is
   not. This lives at the one runtime chokepoint every call shape goes
   through — nested arguments, method chains, named arguments.
5. **The guard that owns the trip converts**: `success(partial)` when
   one arrived, exactly the pre-saveDraft failure when none did.

Type safety holds by induction: a partial is always the saved draft of
the frame that returned it, which the checker verified against that
frame's return type. Return position only forwards a value whose type
the checker already matched to the scope. Argument position is the one
place a wrongly-typed value could sneak through, and it is dropped at the
boundary. So a guard only ever sees a value typed for its own block.

## finalize: translating a partial instead of replacing it

`finalize { ... }` lets a scope compute its partial result when an abort
stops it, instead of only returning a pre-saved draft. The body reads the
scope's locals — including the aborted callee's partial, bound into the
local its call was assigning — and its `return` becomes the scope's
forced return value.

Mechanically, finalize plugs into the three stop sites:

- **The frame catch** calls
  `AbortedResult.fromError(...).withFinalize(__finalize, name)`.
- **The post-call check** first binds the callee's partial into the
  assigned local (`partialValueOrNull()`), then stops through
  `carryThrough(...).withFinalize(...)` — which is why the finalize can
  just read the local.
- **Direct-call returns get a checked temp** (finalize scopes only):
  plain halt-through pass-through would silently skip the finalize.
  This lowering is exhaustive because AG6036 rejects any other
  call-bearing return shape in a finalize scope.

`withFinalize` owns the failure rule. A finalize never masks the trip,
whether it throws, resolves to interrupts, or resolves to an aborted
result of its own. The abort continues with the saved draft, or with
nothing, and the failure is logged as a `finalizeError`.

The `__finalize` closure runs a fresh Runner on the SAME frame as its
container, so locals resolve without any passing. Two non-obvious
consequences:

- **Step ids live in a disjoint range** (`FinalizeCodegen.STEP_BASE` in
  `lib/backends/typescriptBuilder/finalizeCodegen.ts`). Runner
  step counters are frame-keyed (`frame.step` at the top level, path-only
  keys nested), so small ids would collide with the main body's counters
  and silently skip finalize steps.
- **`fromError` marks a guard trip's cause `delivered`.** Converting the
  exception into a value IS the delivery; without the mark, a
  leaf-delivered time trip (the signal still aborted, the cause not yet
  consumed) makes `Runner.shouldSkip` re-throw inside the finalize's
  first step and kill pure computation. In-flight leaf ops inside a
  finalize still cancel via the signal itself — that is the
  "computational-only" rule: write finalize bodies as pure computation
  over locals.

The checker enforces six rules (AG6032-AG6036, AG3016): one finalize per
scope, top level only, defs and guard blocks only (a node finalize would
compute a partial nothing above a node consumes), no `saveDraft` inside,
no interrupts (transitive for same-file callees; an imported
interrupting callee is caught by the runtime backstop instead), and the
return-shape rule above. Inside a finalize body every local reads as
`T | null` — the flow graph seeds the body as a side branch off the
scope START with every local widened, since any statement might not have
run — and the side branch never touches the main flow, so a finalize
`return` cannot satisfy definite-returns.

## Important files

| File | Role |
| --- | --- |
| `stdlib/index.agency` | The `saveDraft` def (prelude — auto-imported everywhere) |
| `lib/stdlib/thread.ts` | `_saveDraft`, a one-liner delegating to the stack |
| `lib/runtime/state/stateStack.ts` | `State.savedDraft` (serialized in `toJSON`/`fromJSON`) and `StateStack.setSavedDraft` (caller-frame targeting, deep clone, global-scope rejection) |
| `lib/runtime/abortedResult.ts` | `AbortedResult` — the whole value-transport vocabulary, plus its statelog trail |
| `lib/runtime/abortBoundary.ts` | `throwIfNodeResultAborted` / `throwIfValueAborted`: the four boundaries that turn an abort back into an exception |
| `lib/runtime/errors.ts` | `describeAbortCause`: the single owner of an abort's user-facing message |
| `lib/backends/typescriptBuilder/finalizeCodegen.ts` | The `finalize` lowering, including `STEP_BASE` and the `withFinalize` wiring |
| `lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache` | Def catch: abort exception → `AbortedResult.fromError` |
| `lib/templates/backends/typescriptGenerator/blockSetup.mustache` | Block catch: same conversion for `as { }` blocks (this is how a draft saved directly in a guard block reaches the guard) |
| `lib/backends/typescriptBuilder.ts` | `assignmentInterruptGuard` / `assignmentAbortedGuard`: the post-call checks; handler bodies and node scope emit the throw form |
| `lib/runtime/call.ts` | `findAbortedArg`: the argument-position drop in `__call`/`__callMethod` |
| `lib/runtime/result.ts` | `__tryCall`: the guard-boundary conversion (value path) plus a thin exception backstop |
| `lib/runtime/runBatch.ts` | `startInvoke`'s `.then`: aborted branch value → rejection, partial dropped |
| `lib/runtime/interrupts.ts` | Handler chain rethrows an aborted handler verdict as the abort it is |
| `lib/typeChecker/checker.ts` | `checkSaveDraftCall`: draft type vs enclosing return type |
| `lib/typeChecker/finalizeChecks.ts` | The finalize-specific checker rules |
| `lib/typeChecker/flowBuilder.ts` | The finalize flow rule: side branch, nullable locals, definite-returns exemption |
| `lib/parsers/parsers.ts` + `lib/types/finalizeBlock.ts` | The `finalize { }` grammar and AST node |
| `lib/statelogClient.ts` | The `abortUnwind` span type and `abortSalvage` event |

## Trade-offs made, and the designs we rejected

**Side-map storage (shipped briefly as PR #551, deleted).** Drafts keyed
by frame depth in a stack-wide map, with region markers per guard, a
search at the boundary, a sweep, and clearing paths in generated code.
Rejected because the guard ended up owning a ledger for its whole call
tree: the machinery existed to answer "whose draft should the guard
return?", and every answer needed another rule (stale-sibling clearing,
resume-stable regions). A draft belongs to the scope that saved it.

**Carrying the draft on the abort exception (this PR's first
iteration, reworked in review).** Each generated catch mutated a shared
field on the exception. It worked, but the return-position rule needed
compiler analysis to decide which calls to mark — and that analysis had
a soundness hole within hours of review (a call chained off a
non-identifier base was invisible to it). Manual case enumeration was
the smell; the value transport removes the cases instead of patching
them. It also removes the shared mutable object: every `AbortedResult`
hop is a new immutable instance.

**Per-level opt-in, no deep fallback.** A draft saved three calls deep,
consumed via assignments, does NOT reach the guard. #551 salvaged it
(outermost-wins with deep fallback); we removed that on purpose. The
deep value is typed for the deep function, not for the guard block, and
silently promoting it breaks the type story. Levels opt in by saving
their own draft or by declaring `return callee()`.

**Return position: the callee's partial wins**, even when the caller
also saved a draft. This mirrors the success path — a successful
`return verify()` also ignores the caller's draft — and it is what the
transport does naturally. (An earlier revision ranked the caller's own
draft higher; that ordering was an artifact of exception thinking.)

**Plain errors never salvage.** A thrown exception converts to a
failure, draft untouched. An abort interrupts healthy code from outside,
so its work is presumptively good; a thrown error means the code itself
broke, and a draft saved by code that then proved broken is not a value
to hand out as a success. If error-path salvage is ever wanted, the
additive design is a draft on the failure's DATA — never a success.

**Fork boundary: aborted branch values become rejections again**
(partial dropped) at `startInvoke`, the single point every branch result
passes through. Isolation is one reason — which branch fails first is a
race, and one branch's value has the wrong shape for the fork. The
other is protocol: runBatch's join machinery represents branch failure
as rejection everywhere (allSettled, race seal, sequential try/catch,
result caching). Converting at the entry keeps the joins on one
representation and makes caching an aborted value impossible.

**Deep clone at save time.** `setSavedDraft` clones so later mutation
cannot change the salvage — and so a live-trip salvage is identical to
a post-resume one, where the draft went through serialization anyway.
Same program, same answer, regardless of whether an interrupt happened.

## Nuances people miss

- **The node boundary is where an abort becomes an exception again, and
  there are four of them.** Inside compiled code an abort travels as a
  value. Everything above compiled code expects an exception.
  `lib/runtime/abortBoundary.ts` does the conversion, at four boundaries,
  not one. Three hand back a node result and call
  `throwIfNodeResultAborted`: `runNodeCore` and `runResumeLoop`
  (`lib/runtime/interrupts.ts`) and `rewindFrom`
  (`lib/runtime/rewind.ts`). The fourth, `runExportedFunctionCore` in
  `lib/runtime/node.ts`, hands
  back a bare value from `invoke()` and calls `throwIfValueAborted`;
  without it an exported function that aborts returns a
  `{ __type: "abortedResult" }` object to its caller — an HTTP 200 with a
  nonsense body over `./serve`. Fixing only one of the four leaves the
  same bug one interrupt, or one export, later.

  Three things are easy to get wrong. First, codegen's
  per-call guards only cover calls whose result is bound to a local — a
  bare `return foo()` in tail position binds nothing, gets no guard, and
  reaches the boundary intact, which is why the check exists at all
  rather than being redundant (issue #243: the CLI reported runaway
  recursion as a successful run with no output). Second,
  `createReturnObject` JSON round-trips the value, and `isAborted` is an
  `instanceof` test, so a check placed after it silently never fires —
  this is also why the conversion cannot live inside
  `createReturnObject`. Third, the partial has to be dropped through
  `atNodeBoundary()` rather than by calling `toError()` raw, exactly as
  the fork boundary uses `atForkBoundary()`: that is what emits the
  closing `abortSalvage` event and ends the `abortUnwind` span. A raw
  throw leaves that span open forever and the draft vanishes with no
  record of where it went.
- **Only a TERMINAL drop may end the unwind span.** An "erased" hop opens
  the span while carrying no partial forward, so a span can outlive the
  partial that started it. The two terminal drops (`atForkBoundary`,
  `atNodeBoundary`) must still close it — nothing above them will.
  `droppedAtArgPosition` must not: the abort travels on as that call's
  result, and a later frame with a draft of its own would find no span id
  and open a second one, splitting a single abort's salvage trail across
  two spans. That is what the `terminal` flag on `dropped()` selects.
- **Throwing at the boundary skips the caller's end-of-run tail.** The
  run lands in the outer `catch` instead of the branch that emits
  `agentEnd` with a result, fires `onAgentEnd`, and calls
  `closeTraceWriter()`. `finalizeExecCtx` does not touch the trace
  writer, so without help an aborted `agency run --trace` writes a trace
  that stops mid-stream with no `footer` record. The `endsRun` flag on
  `throwIfNodeResultAborted` closes it for the two call sites that own
  the end of a run; the rewind loop has no such tail and passes false.
  The `onAgentEnd` hook still does not fire for an aborted run — that
  matches every other crash path, including the aborts codegen already
  threw before this.
- **An abort's message has to survive on the cause, not the error.**
  `AbortedResult.toError()` rebuilds the exception from the `AbortCause`
  alone — the original error object is long gone. Anything a user needs
  to read (which guard tripped, what recursed) must therefore ride the
  cause and be rendered by `describeAbortCause`, which is the single
  owner of that text. `CallDepthExceededError` calls
  `describeAbortCause` for its own message too, so the thrown form and
  the rebuilt form cannot drift apart.
- **`saveDraft` writes the CALLER's frame.** saveDraft is itself an
  Agency def, so when `_saveDraft` runs, the top frame is saveDraft's
  own. `StateStack.setSavedDraft` targets `callerFrame()`. If you inline
  or move this code, that assumption moves with it.
- **A saved `null` is a real draft.** The slot is `{ value }`-wrapped
  precisely so `saveDraft(null)` salvages null rather than reading as
  "no draft".
- **Global scope throws.** There is no enclosing scope whose salvage a
  top-level draft could become, and a silent no-op hid real mistakes.
- **The draft survives interrupt/resume; the AbortedResult never
  serializes.** `savedDraft` is part of `State.toJSON`, because a pause
  can happen between saving and tripping. An `AbortedResult` propagates
  to a guard or a node within one turn and never rests in a checkpoint.
- **The trip's cause rides by identity.** `AbortedResult.cause` is the
  same object the abort signal carries, and `toError()` passes it
  through — that is what keeps the `delivered` de-dup flag working
  across the two delivery paths (converted leaf op vs `shouldSkip`).
- **`__tryCall`'s exception branch is a backstop, not the salvage
  path.** A trip thrown from runtime code between the guard and the
  block (e.g. the subprocess adapter) has no compiled frame to convert
  it; it reaches the guard as an exception and produces the plain
  failure. Partials only travel on the value path.
- **`onFunctionEnd` fires for a pass-through return.** `return f()`
  sets `__functionCompleted` before evaluating the call, so a function
  whose return VALUE is an aborted result counts as completed — it did
  return. A function stopped by its own catch does not.
- **The checker rule is name-keyed with an origin gate.** It fires only
  when `saveDraft` resolves to the stdlib prelude (or is unresolved);
  a user def, node, or import named saveDraft is left to the generic
  checks. Aliasing (`const s = saveDraft; s(v)`) escapes the check —
  documented v1 limitation.
- **Shared envelope with interrupts.** An aborted value flowing through
  a binOp operand (`g() + 1`), wrapped in a container literal in
  argument position (`f([g()])`), or through non-`__call` JS interop
  degrades the same way an `Interrupt[]` would today. Bounded: the
  abort signal keeps firing, so the callee's next leaf op re-trips, and
  the wrapped value never becomes a call's own result, so no
  wrongly-typed salvage can reach a guard. The two systems share the
  fix whenever one lands.
- **Statelog silence is meaningful.** The `abortUnwind` span opens only
  when a partial is touched; an abort through undrafted code emits
  nothing new. Return-position pass-through is silent on purpose — no
  code runs there. Events carry the span id explicitly because an abort
  can cross span contexts (out of a fork branch), where current-span
  attribution alone would split the trail.

## Design history

The original design docs are no longer in the repo. The behavior they
described is pinned by fixtures instead.

- Fixtures: `tests/agency/guards/save-draft-*.agency`. Each one pins a
  rule above. `save-draft-arg-position` pins the argument-position drop
  both ways, and `save-draft-return-chain` versus `save-draft-deep-only`
  pin pass-through versus per-level opt-in.
- The value transport is revision 3 of the design. Earlier revisions,
  the side-map storage and the draft-on-the-exception, are described in
  the trade-offs section above.
