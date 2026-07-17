# Spec: partials ergonomics — `saveDraft` as a tool, and `finalize as draft`

**Status:** brainstormed with the owner 2026-07-17; decisions settled.
Review round 1 folded same day (findings in
`2026-07-17-partials-ergonomics-design-REVIEW.md`); the interception
point is pinned to the ordered tool-call iteration and the
schema-vs-slot type gap is stated. **Planning correction, same day:**
the review's finding 1 (interception must write the TOP frame, not
`callerFrame()`) was checked against the runtime and is factually
wrong — `runPrompt` pushes its own frame on entry, so the existing
`setSavedDraft` already targets the owning scope. Part 2 below carries
the corrected analysis. Builds on the partial-results machinery (saveDraft #553,
finalize #556, resumable guards #558–#566) and the guard construct
(#574). Examples use the construct syntax, so this ships after #574.

**Scope:** two independent features, one theme — partials become
first-class citizens of the agent loop. The model can save them, and
the finalize can read them.

---

## Part 1: Background

### What exists today

`saveDraft(value)` records a best-so-far value on the calling scope's
frame. When a guard trip is rejected, the guard returns the last saved
draft as a success instead of a failure. A `finalize` block computes
the salvage value instead: it runs when the scope aborts, sees the
scope's locals, and its return wins over the saved draft, with the
draft as fallback if the finalize throws (`AbortedResult.withFinalize`,
`lib/runtime/abortedResult.ts:141`).

Two gaps motivated this spec:

1. **The model cannot save drafts.** In an agent loop, the model is
   the one doing the work, but only the surrounding Agency code can
   call `saveDraft`. Passing `saveDraft` in `tools:` today would
   register it as an ordinary tool — and file the draft on the tool
   invocation's own frame, which dies when the tool call ends.
   Parallel tool calls run in branch stacks that are collected at the
   end of the round, so the draft would never reach the scope whose
   return value it approximates.
2. **The finalize cannot see the draft.** The saved draft lives in a
   frame slot, not a local, so a finalize that wants to return "the
   draft, plus a note" has no way to read it. In hindsight this is a
   strange gap: the two salvage tools cannot compose.

### Decisions from the brainstorm (owner, 2026-07-17)

1. **Tool-loop interception**, not frame-walking, for the saveDraft
   tool. The loop knows which scope owns it; a walk from the tool's
   branch stack back to the owner is fragile under every future
   concurrency change.
2. **Concurrency is a non-issue by state isolation.** Each `llm()`
   call runs on its own branch stack, so each call's drafts file on
   its own branch. Within one round, parallel saveDraft tool calls
   apply in tool-call order, the same order tool results append.
3. **The tool's JSON schema must say what the contract is**: exactly
   one parameter, whose type is the return type of the enclosing
   function or scope.
4. **The finalize binder uses `as`, not parameter syntax.**
   `finalize (draft) { }` looks like a call. The draft is a value
   YIELDED to the block, and Agency already has syntax for that:
   `fork([1, 2]) as n { }`. So: `finalize as draft { }` and
   `finalize() as draft { }` are both accepted, with a user-chosen
   binder name. This is also consistent with AG4006's rule that block
   keywords take no `as` when there is nothing to bind — a finalize
   with a yielded draft HAS something to bind.

---

## Part 2: `saveDraft` as a tool

### Surface

```ts
def researchAgent(topic: string): string {
  const r = guard(cost: $0.50) {
    return llm("Research " + topic + ". Save a draft as you complete each section.", {
      tools: [search, saveDraft]
    })
  }
  if (isSuccess(r)) { return r.value }
  return "no result"
}
```

The model sees a `saveDraft` tool. Each call replaces the draft, last
save wins. If the guard trips mid-request and the trip is rejected,
the salvage pipeline runs as always — and now the draft is whatever
the model most recently saved. The trip question's `draftValue`
preview shows it too, so a handler judging "more budget or keep what
we have?" sees the model's own best-so-far.

### Recognition: identity, not name

The tool loop intercepts when an entry in the tools array IS the
stdlib `saveDraft` function. Recognition checks the AgencyFunction's
`name` and `module` fields (`"saveDraft"` from
`"stdlib/index.agency"`) — the runtime cannot import the stdlib
singleton directly without a dependency cycle, and no user module can
carry that module id, so the field pair is identity in practice.
Aliasing works for free: `const s = saveDraft; tools: [s]` still
intercepts, and a user's own function named `saveDraft` is an
ordinary tool.

### What interception does

When the model calls the intercepted tool, the loop does NOT invoke
the AgencyFunction. It:

1. Files the draft on the scope that owns the `llm()` call, via the
   EXISTING `stateStack.setSavedDraft(value)`. This corrects review
   finding 1, which claimed `runPrompt` pushes no frame and therefore
   `setSavedDraft`'s one-below-top write would land one scope too
   high. The claim is wrong: `runPrompt` pushes its own frame on entry
   (`setupFunction()` at `lib/runtime/prompt.ts:870` calls
   `stateStack.getNewState()`, which pushes — the comment there reads
   "runPrompt participates like any other function"). `llm()` does
   compile to a direct `runPrompt()` call with no wrapper, but
   runPrompt itself supplies the frame. So during the tool loop the
   stack is `[…, owner, runPrompt]` — the same shape as the def path's
   `[…, owner, saveDraft-def]` — and `callerFrame()` lands on the
   owner in both. Often that owner is a guard block's closure frame,
   exactly the slot `_runGuarded` salvages. No new StateStack method
   is needed, and `setSavedDraft`'s global-context guard comes along
   for free. The saveDraft series was a string of off-by-one-frame
   bugs, so the plan must pin the frame math with a fixture: a draft
   saved through the TOOL inside a guard block is salvaged by that
   guard.
2. Returns an acknowledgment as the tool result, e.g.
   `Draft saved (214 characters).` The model gets confirmation; the
   result rides the normal tool-result machinery, so resume
   idempotency comes for free (a completed round's draft is already
   serialized in the restored frame — drafts survive checkpoints).
   **Malformed calls get helpful feedback (owner review round 2):**
   the interception validates the argument against the synthesized
   schema. A value that violates the schema is SAVED ANYWAY, and the
   ack carries a specific warning ("Draft saved (N characters).
   Warning: the value does not match this function's declared return
   type (…). The draft was kept…") — the schema is a best-effort hint
   (see "The schema" below), and refusing a save on a possibly-wrong
   hint would throw away real work; the warning teaches the model
   instead. Only a call with NO `value` argument refuses:
   `Error: saveDraft requires a "value" argument. Nothing was saved.`
3. Emits the standard toolCall statelog events, so the trace shows
   when and what the model saved.

**Architecture (owner review round 2): the "intrinsic tool" pattern.**
saveDraft is the first tool the loop handles itself instead of
dispatching, and it will not be the last (attachment
listing/viewing and future run-control tools fit the same shape).
The implementation names the pattern: an `IntrinsicTool` is one
object declaring `matches` (identity), `buildDefinition` (what the
provider sees), and `handle` (what a call does; returns the
tool-result text). A closed, in-runtime registry lists them; the
loop owns all generic bookkeeping (ordered pass, resume idempotency,
statelog span + events, callbacks, the result message), so a new
intrinsic is one self-contained module. Deliberately NOT a
user-facing extension point: intrinsics manipulate run state, which
is exactly what user tools must never do.

**Where in the loop, and why the ordering guarantee holds (finding
2):** interception happens during the loop's ORDERED iteration over
the round's tool calls, before anything dispatches into the concurrent
tool pool. A recognized `saveDraft` call is handled inline at its
position — write, ack, record — and never becomes a concurrent
branch. Ordering therefore holds by construction: two saves in one
round apply in call-list order because the writes happen in call-list
order, not in scheduler-completion order. Real tools in the same round
dispatch exactly as today.

### The schema

The tool definition sent to the provider declares exactly one
required parameter:

- **Name:** `value`.
- **Type:** the JSON schema of the enclosing function or node's
  DECLARED return type, built with the same type-to-schema bridge
  `schema(Type)` uses. `def researchAgent(...): string` produces
  `{ "type": "string" }`; a structured return type produces its
  object schema.
- **Fallback:** when the enclosing scope has no declared return type,
  or the type is `any`, the schema falls back to `string`. Inferred
  types are not available to codegen (the typechecker and the builder
  are separate passes), and a string draft is the honest default for
  agent loops.
- **Honesty about the schema's key (finding 3):** the schema is keyed
  to the enclosing FUNCTION's declared type, while the draft files on
  the scope that owns the `llm()` call — often a guard block whose
  inferred type can differ. When they disagree, the schema is a
  best-effort hint, not a contract; v1 has no runtime validation
  either way. Tighten this when inferred types reach codegen.
- **A plan obligation, not a given:** "the builder statically knows
  the enclosing def" must be verified against the builder's
  current-scope tracking at `llm()` call sites before the schema
  threading is designed. The whole schema feature hangs on it.
- **Description:** states the contract the type system cannot check
  here: "Save your best-so-far answer as a draft. If the budget runs
  out, the last saved draft is returned instead of a failure. The
  value must match this function's return type."

Codegen threads the enclosing scope's return-type schema into the
`llm()` call site (the builder statically knows the enclosing def).
The loop only builds the saveDraft tool definition when the tools
array actually contains the intercepted function.

### Interactions worth pinning

- **Feedback channel:** `approve({message: "save a draft before each
  new topic"})` teaches the model to checkpoint. No new machinery —
  the message lands as a user message before the next request.
- **Mid-request trips:** a time trip that cancels the in-flight
  request keeps every draft saved in completed rounds. The cancelled
  generation is gone; its unsaved progress is gone with it. That is
  the feature's pitch in one line: teach the model to save, and
  cancellation stops being total loss.
- **The level rule is unchanged.** The draft files on the scope that
  owns the `llm()` call. Where that scope's partial travels — call
  boundaries, forks, joins — follows the existing rules.

### What this does NOT do

- No automatic injection. `saveDraft` is a tool only when the user
  passes it. Guards do not silently add tools to model calls.
- No SALVAGE-TIME type validation of the draft against the return
  type — an ill-typed draft still salvages, the same trust level as
  every other tool argument. (Refined in owner review round 2: the
  TOOL boundary does validate, as feedback rather than enforcement —
  a mismatched save is kept and warned about in the ack; only a
  missing `value` refuses. See "What interception does".) Documented
  in the guide.

---

## Part 3: `finalize as draft`

### Surface

```ts
def research(topic: string): string {
  const outline = draftOutline(topic)
  const full = expand(outline)
  return full

  finalize as draft {
    if (draft != null) {
      return draft + "\n\n[Stopped early: may be incomplete]"
    }
    if (outline != null) {
      return "OUTLINE ONLY: " + outline
    }
    return "nothing yet"
  }
}
```

All four head forms parse: `finalize { }`, `finalize() { }`,
`finalize as draft { }`, `finalize() as draft { }`. The binder name is
the user's choice. The formatter prints the canonical form without
parens: `finalize { }` or `finalize as draft { }`.

### Semantics

- The binder is the SCOPE'S OWN saved draft at the moment the abort
  reaches the finalize, or null when nothing was saved. It is not some
  callee's draft: the finalize belongs to the scope, so it sees the
  scope's slot. A callee's salvage arrives through ordinary locals,
  as today.
- Everything else is unchanged. The finalize still runs only on
  abort, still wins over the draft, and the draft is still the
  fallback when the finalize throws. The binder makes the choice
  explicit instead of implicit: a finalize that wants the draft
  returns it.

### Typing

The binder declares in the finalize's scope with type `T | null`,
where `T` is the scope's declared or inferred return type. This fits
the existing finalize rule that every captured local reads as
possibly-null, so the checker treatment is uniform: one more
possibly-null name, with a real type instead of a repurposed local.

### Mechanics (pointers, not code)

- **Parser (owner review round 1: reuse, not hand-rolling):** the
  binder clause is the EXISTING `asParser` /`blockParamsParser`
  (`lib/parsers/parsers.ts:3148`) — the same grammar that gives
  `fork([1, 2]) as item { }` its binder. `finalizeBlockParser` gains
  an optional empty-parens group and then delegates the `as` clause
  to `asParser`, keeping the word-boundary care the keyword already
  has. Inherited edge cases from the shared grammar, ruled on by the
  checker rather than re-parsed: `finalize as { }` parses as the
  binder-less form (the documented no-param shape; the formatter
  canonicalizes the stray `as` away, like guard's legacy-as
  migration); `as (a, b)` parses and is rejected (one draft, one
  binder — AG6038); `as draft: Report` parses with the annotation
  winning over the scope's return type (the handler-param rule).
- **AST:** `FinalizeBlock` gains `params: FunctionParameter[]` — the
  same field shape `BlockArgument` uses; the binder is `params[0]`,
  `[]` is binder-less. The formatter prints it through the shared
  param renderer; `bodySlots` is unchanged (the binder is not a
  body). NOT reused: the whole-node `functionCall`+`BlockArgument`
  pipeline — a finalize is a declaration, not a call (codegen strips
  it from the statement stream; nothing invokes it), so wrapping the
  body in a `BlockArgument` would add indirection without behavior.
- **Checker:** declare the binder in the finalize scope as
  `T | null`. The existing finalize checks (no interrupts, one per
  scope, return-position call restriction) are untouched.
- **Codegen:** the finalize closure gains one parameter; the abort
  path passes the frame's saved draft. `AbortedResult.withFinalize`'s
  `finalize` argument becomes `(draft: unknown) => Promise<unknown>`,
  and its caller reads the slot off the frame it already holds. The
  salvage order does not move: the draft is read BEFORE the finalize
  runs and passed in; if the finalize throws, the same value is the
  fallback.

---

## Part 4: Testing

**saveDraft tool:**

- Fixture: a mocked llm call whose mock issues a `saveDraft` tool
  call, then trips the guard on the next round; reject; the guard
  returns the model's draft as a success. The mock's second entry
  never runs.
- Fixture: alias (`const s = saveDraft`) intercepts identically; a
  user-defined function named `saveDraft` in `tools:` runs as an
  ordinary tool and files nothing.
- Fixture: two parallel tool calls saving in one round apply in
  tool-call order; the later one wins.
- Unit: the synthesized tool definition — one required `value` param,
  schema from a declared string return, schema from a declared object
  return, string fallback for an undeclared return, and the
  description text.
- Unit + fixture: the validation acks — missing `value` refuses and
  saves nothing; a schema-mismatched value saves anyway with the
  warning ack, and the guard salvages it.
- Runtime: a recording-client test pins the schema-threading seam —
  the tool definition the PROVIDER receives uses the threaded
  draftSchema, not the string fallback (the fixtures alone cannot
  catch a silent fallback).
- Resume: a checkpoint after a draft-saving round restores the draft
  (existing serialization; pin it from the tool path).

**finalize binder:**

- Parser: all four head forms; binder name freedom; formatter
  round-trip prints canonically.
- Checker: binder typed `T | null` (assigning it to `T` unguarded is
  the existing possibly-null error); binder name shadows nothing
  outside the finalize.
- Fixtures: finalize returns the bound draft (salvage equals the
  draft plus a suffix); binder is null when nothing was saved;
  finalize-throws falls back to the same draft that was bound.

---

## Part 5: Out of scope, recorded so they stay decisions

- Runtime validation of model-saved drafts against the return type.
- Auto-adding `saveDraft` to guarded llm calls.
- Return-type schemas from INFERRED types (needs a typechecker-to-
  codegen handoff that does not exist; declared types only).
- A binder for the trip handler's `draftValue` (it already exists in
  `i.data`).
- Sizing: the finalize binder is roughly a day. The saveDraft tool is
  one to two days, mostly the schema threading. They make one tidy PR
  or two small ones, after #574 lands.
