# Spec review: partials ergonomics (2026-07-17)

**Reviewing:** `docs/superpowers/specs/2026-07-17-partials-ergonomics-design.md`
**Verdict:** Part 3 (`finalize as draft`) is ready — I traced the mechanics and
they hold, the `as`-binder decision is well-grounded, and the typing reuses an
existing rule cleanly. Part 2 (`saveDraft` as a tool) has the right idea and one
concrete error: **the frame it names to file the draft on is off by one**, and
it is off by one in exactly the direction the whole saveDraft history kept
getting wrong. One substantive ordering question follows from it. Fix those two
and this is a plan.

All line references are `packages/agency-lang/`, verified today.

---

# Blocking

## 1. `setSavedDraft` files the draft on the wrong frame in the tool-loop path

Part 2 says interception "files the draft on the loop's own scope:
`stateStack.setSavedDraft(value)` … the same branch-local stack the owner's
drafts already use." That method does not file on the loop's own scope. It files
on that scope's **parent**.

`setSavedDraft` writes `this.callerFrame().savedDraft` (`stateStack.ts:982`), and
`callerFrame()` is `stack[length - 2]` — one below the top. That is correct for
the path it was written for: `saveDraft(x)` in Agency code calls the `saveDraft`
**def** (`stdlib/index.agency:155` → `_saveDraft` → `setSavedDraft`), and a def
call pushes a frame, so the top of the stack is the `saveDraft` def frame and
`callerFrame()` is the scope that called it. The extra frame is what makes
`length - 2` land on the owner.

The tool-loop path has no such frame. `llm()` compiles to a **direct
`runPrompt()` call** (`typescriptBuilder.ts:3567`) with no `State` push — I
checked `prompt.ts`, it never pushes a frame. So while `runPrompt`'s tool loop is
executing, the top of the stack **is** the scope that owns the `llm()` call.
Interception runs inline (the spec is explicit it does not invoke the
AgencyFunction, so no tool frame is pushed either). So:

- **def path:** `[…, owner, saveDraft-def]` → `callerFrame()` = owner ✓
- **tool path:** `[…, owner]` → `callerFrame()` = owner's **parent** ✗

In the spec's own example the owner is the guard block (`guard(cost: $0.50) {
return llm(…) }` — the block closure pushes a frame, `_runGuarded` salvages it,
`llm` runs in it). `callerFrame()` there is the `_guard` def frame. The draft
lands a level above the block, the block's slot stays empty, and the guard
returns an empty draft on reject — the exact failure the feature exists to
prevent.

The fix is small and the spec should name it: interception writes
`lastFrame().savedDraft`, not `setSavedDraft`. But "small" is why it needs to be
in the spec — the saveDraft series was a string of off-by-one-frame bugs
(`draftRegionStart`'s `length` shifting +1 on resume; the block-vs-def clearing
gate), and "just call the existing method" is precisely the shorthand that
reintroduces one. Decision 1 chose loop-interception over frame-walking *to know
which scope owns the draft* — so the spec has to state which frame that is, and
it is the top one, not `callerFrame()`.

(Worth a second method rather than raw field access, so the global-context guard
in `setSavedDraft` — which correctly throws for a top-level `saveDraft` — has a
sibling. A guarded `llm()` at node top level owns a real frame, so the guard
should not fire there, but the method should still exist rather than every caller
reaching into `lastFrame().savedDraft` by hand.)

---

# Substantive

## 2. The "last save wins, in tool-call order" guarantee needs the write to be ordered, and the spec doesn't say where it happens

Decision 2 and Part 4's third fixture assert that parallel `saveDraft` tool calls
in one round "apply in tool-call order … the later one wins." That holds only if
the interception **writes** in tool-call order. The spec grounds it in "the same
order tool results append" — but tool *results* append in call order while the
*writes* happen during tool execution, and if the round dispatches tools
concurrently, whichever interception the scheduler runs last wins, not whichever
is last in the call list.

This is recoverable and probably already true, but it depends on a mechanic the
spec doesn't pin: is the intercepted `saveDraft` handled during the loop's
**ordered iteration** over the round's tool calls, or is it dispatched into the
same concurrent pool as real tools? If the former, the ordering claim is correct
by construction — say so. If the latter, the fixture can flake and the guarantee
is false. Name the interception point in the loop, and the ordering follows or
doesn't from there.

(This also interacts with finding 1: both are questions about *when and where* the
draft write happens, and both resolve once the spec pins the interception point
to a specific frame and a specific place in the tool-call iteration.)

## 3. The schema's type and the draft's frame can disagree

Part 2 builds the tool schema from "the enclosing function or node's DECLARED
return type," while the draft files on the scope that owns the `llm()` call —
often a guard block, whose type is inferred and need not equal the function's
declared return. In the example they coincide (`string` all the way down), which
is why it reads fine. They won't always: `def f(): Report { const r = guard(…) {
return llm(…) } … }` where the block yields a `string` the function later wraps
into a `Report` tells the model to produce a `Report` for a slot that holds a
`string`.

v1 has no runtime validation, so this is advisory-only and not a correctness bug
— but it is a real "the schema lies to the model" case, and the spec's "the type
of the enclosing function or scope" (decision 3) papers over the function-vs-scope
gap that finding 1 exposes. One sentence: the schema is a best-effort hint keyed
to the declared function type, and may not match the exact slot when a guard block
of a different type owns the call. That is honest and keeps the door open for
tightening it when inferred types reach codegen.

---

# Notes

- **Recognition (identity by name+module) is sound** — I confirmed `AgencyFunction`
  carries readonly `name` and `module` (`agencyFunction.ts:88-89`), so the
  field-pair check works across modules and the alias case falls out. Good call
  using the pair rather than object identity; the prelude auto-import means each
  module may hold its own wrapper object.
- **Part 3 is solid.** `withFinalize(finalize, scopeName)` (`abortedResult.ts:141`)
  currently calls `finalize()` with no args and, on throw, returns `this` — which
  already carries the pre-finalize partial (the draft). Threading the draft in as
  a parameter surfaces the same value the throw path falls back to, so the "read
  before the finalize runs, same value is the fallback" claim is exactly right,
  no ordering change. The `T | null` binder typing reuses the existing
  every-captured-local-is-possibly-null finalize rule. And AG4006's explanation
  (`diagnosticExplanations.ts:258`, "does not support an `as` binding, because
  there is nothing to bind") genuinely supports decision 4: a finalize with a
  yielded draft *has* something to bind, so `finalize as draft` is the
  something-to-bind case, not a contradiction of the rule.
- **"The builder statically knows the enclosing def"** (schema threading) is
  asserted but not shown. It's plausible — the builder processes statements in a
  def context — but since the whole schema feature hangs on it, the plan should
  point at the builder's current-scope tracking and confirm the declared return
  type is in hand at an `llm()` call site, the way finding 1 points at the frame.

# What is right

The theme — partials become things the model saves and the finalize reads — is
the correct next step, and the two halves are genuinely independent, which makes
the "one tidy PR or two small ones" sizing real. Decision 1 (interception over
frame-walking) is the right call for the reason given; the irony is that the
mechanism it names then reintroduces a frame question, which finding 1 is just
asking the spec to finish. The out-of-scope list is disciplined — deferring
inferred-type schemas and runtime validation keeps v1 to what the pipeline can
actually deliver.

# Recommended next steps

1. Name the frame: interception writes the **top** frame's `savedDraft`, not
   `setSavedDraft`/`callerFrame` (finding 1). Add the method with the
   global-context guard.
2. Pin the interception point in the tool-call iteration, and derive the ordering
   guarantee from it (finding 2).
3. Add the one-sentence honesty about schema-vs-slot type (finding 3).
