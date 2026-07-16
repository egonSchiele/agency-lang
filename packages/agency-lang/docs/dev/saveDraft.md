# saveDraft: how salvage-on-abort is implemented

`saveDraft(v)` records a best-so-far value for the current scope. When an
enclosing `guard(...)` trips before that scope returns, the guard yields
the saved draft instead of a failure. This doc explains how that works
under the hood, the trade-offs behind the design, and the nuances that
are easy to miss. User-facing docs live in the guide; this is for people
changing the implementation.

This doc covers the first increment (the salvage mechanism). It will be
extended when `finalize` blocks land in the follow-up PR.

## The core idea: an aborted function returns its draft

When an abort stops a function, the function does not throw past its own
frame. The frame catches the abort and returns an `AbortedResult`
instead: a marker that says "my run was aborted", the cause, and the
frame's saved draft as its partial. Callers receive it like any other
return value. The generated check that runs after every call — the same
place interrupts are checked — spots the marker, and the caller stops
too, returning its OWN `AbortedResult`. So an abort travels up the stack
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
2. **A caller receiving an aborted result at a statement** — an
   assignment or a bare call — stops and returns its own saved draft
   (`carryThrough`). The callee's partial is dropped: salvage is opt-in
   per level.
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
frame's return type; return position only forwards a value whose type
the checker already matched to the scope; argument position — the one
place a wrongly-typed value could sneak through — is dropped at the
boundary. So a guard only ever sees a value typed for its own block.

## Important files

| File | Role |
| --- | --- |
| `stdlib/index.agency` | The `saveDraft` def (prelude — auto-imported everywhere) |
| `lib/stdlib/thread.ts` | `_saveDraft`, a one-liner delegating to the stack |
| `lib/runtime/state/stateStack.ts` | `State.savedDraft` (serialized in `toJSON`/`fromJSON`) and `StateStack.setSavedDraft` (caller-frame targeting, deep clone, global-scope rejection) |
| `lib/runtime/abortedResult.ts` | `AbortedResult` — the whole value-transport vocabulary, plus its statelog trail |
| `lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache` | Def catch: abort exception → `AbortedResult.fromError` |
| `lib/templates/backends/typescriptGenerator/blockSetup.mustache` | Block catch: same conversion for `as { }` blocks (this is how a draft saved directly in a guard block reaches the guard) |
| `lib/backends/typescriptBuilder.ts` | `assignmentInterruptGuard` / `assignmentAbortedGuard`: the post-call checks; handler bodies and node scope emit the throw form |
| `lib/runtime/call.ts` | `findAbortedArg`: the argument-position drop in `__call`/`__callMethod` |
| `lib/runtime/result.ts` | `__tryCall`: the guard-boundary conversion (value path) plus a thin exception backstop |
| `lib/runtime/runBatch.ts` | `startInvoke`'s `.then`: aborted branch value → rejection, partial dropped |
| `lib/runtime/interrupts.ts` | Handler chain rethrows an aborted handler verdict as the abort it is |
| `lib/typeChecker/checker.ts` | `checkSaveDraftCall`: draft type vs enclosing return type |
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

- `docs/superpowers/specs/2026-07-15-save-draft-carry-on-abort-redesign.md`
  — the full design (revision 3 = the value transport), with walked
  examples the fixtures pin value-for-value.
- Fixtures: `tests/agency/guards/save-draft-*.agency` — each one pins a
  rule above; `save-draft-arg-position` pins the argument-position drop
  both ways, and `save-draft-return-chain` vs `save-draft-deep-only`
  pin pass-through vs per-level opt-in.
- The follow-up `finalize` design (translating a callee's partial in
  the caller) and the resumable-guards design build on this; both are
  in `docs/superpowers/specs/`.
