# Plan review: partials ergonomics (2026-07-17)

**Reviewing:** `docs/superpowers/plans/2026-07-17-partials-ergonomics.md`
**Verdict:** Executable. The plan is unusually well-grounded — every claim I spot-
checked against the code held, the TDD structure is real (failing test first,
byte-stability gates on the invisible-to-existing-programs tasks), and the
Background section does the load-bearing work up front. One substantive gap: the
schema-threading **seam** is untested — both halves are covered, the wire between
them isn't, and the fixtures only exercise the fallback. That plus a few minor
notes. No blockers.

**First, a correction I owe you.** My spec review's finding 1 — "`setSavedDraft`
files on the wrong frame because `llm()` is a direct `runPrompt` with no frame
push" — was **wrong**, and the plan is right to say so. I re-verified:
`runPrompt` calls `setupFunction()` → `getNewState()` → `this.stack.push(newState)`
(`stateStack.ts:918`). "Direct `runPrompt`" means no wrapper function, not no
frame. So the tool-loop stack is `[…, owner, runPrompt]`, frame-isomorphic to the
def path's `[…, owner, saveDraft-def]`, and the existing `setSavedDraft`
(`callerFrame()`) lands on the owner in both. Good verification-over-analysis
call, and pinning it with `savedraft-tool-basic` rather than trusting either of us
is exactly right.

All line references are `packages/agency-lang/`, verified today.

---

# Substantive

## 1. The schema-threading seam is untested, and the fixtures only hit the string fallback

The feature has three parts and the plan tests two of them in isolation:

- **Codegen emits** `draftSchema: z.object(...)` (Task 5 unit tests — string-match
  on generated output). ✓
- **`buildSaveDraftToolDefinition(schema)` consumes** a schema (Task 6 Step 1 —
  called directly with `z.number()`). ✓
- **The wire between them** — that `runPrompt`'s `args.draftSchema` actually
  receives the codegen's emitted value and the tool-list substitution uses it —
  is tested nowhere.

And it can't be caught by the fixtures as written, because **every Task 7 fixture
uses a node with no declared return type** (`node main()`, `node aliased()`), so
`enclosingDeclaredReturnType()` returns undefined, no `draftSchema` is emitted,
and `buildSaveDraftToolDefinition` takes the `z.string()` fallback. Not one
fixture drives a non-string schema end to end.

The failure this misses is concrete and silent: if Task 5 lands the `draftSchema:`
entry in the wrong arg object (say inside `clientConfig` instead of top-level
`args`), or the key drifts, then `args.draftSchema` is `undefined` at runtime →
`buildSaveDraftToolDefinition(undefined)` → `z.string()` → the model **always**
gets a string schema, even for a `def f(): Report`. Task 5's tests stay green
(they check generated text), Task 6's stay green (they call the builder directly),
every fixture stays green (they're string anyway). The exact feature decision 3
sells — structured-draft typing — is gone, and nothing is red.

**Close it with the RecordingClient precedent already in the repo.**
`promptLabels.test.ts` (from #557) drives a real `runPrompt` with a client that
captures the `PromptConfig` it's handed — and that config carries `tools`. One
runtime test: `runPrompt({ …, draftSchema: <a zod number schema>, tools: [<the
saveDraft AgencyFunction>] })` with a recording client, assert the captured tools
list has a `saveDraft` entry whose `value` schema rejects a string. That ties
`args.draftSchema` → substitution → provider tool list, which is the untested
third of the feature. (An end-to-end `.agency` fixture can't assert it — the tool
*schema* sent to the provider isn't in statelog, only the model's *args* are — so
the runtime test is the right level.)

---

# Minor

## 2. Say why the ack survives resume; the idempotency comment only covers the write

Task 6's comment explains that the interception `pr.step` re-runs on resume and
skips completed writes. But the more fragile question is the **tool-result
message**: the interception pushes the ack to the live thread, and `pr.step` does
NOT snapshot `messagesJSON` on normal completion (`promptRunner.ts:107` — it
snapshots only on the interrupt path), and on resume a completed step returns
before its body, so the ack is never re-pushed.

I worked through it and it's safe: the ack rides the live `messages` thread, and
the next checkpoint (the sibling tool's interrupt bailout, or the guard gate —
both `pr.step` interrupt paths) calls `snapshotMessages()`, which reads the live
thread the ack is already in. So the snapshot captures it. Worth one sentence in
the plan, because an executor who notices "this step pushes a message but never
snapshots" will either add a redundant snapshot or suspect a bug — and the
`savedraft-tool-resume` fixture won't reassure them, because the deterministic
client doesn't validate tool_use/result pairing, so a lost ack wouldn't fail it.
(Real providers would reject the dangling `tool_use` — which is the actual
safety net, and worth naming.)

## 3. AG6037's collision check must be scope-local, not parent-walking

`declareFinalizeBinders` flags a collision via `info.scope.has(fin.binder)`. The
codegen hazard it's protecting against is specifically a **local in the same
frame** (a binder name that would resolve to `__stack.locals.<name>`). A name that
matches a *module global* compiles differently (not `__stack.locals`) and is not a
miscompile — so if `scope.has` walks parent scopes, a binder legitimately named
like an outer global would false-positive into an error. The plan says "copy
exactly what `handlerParamTyping` does," which is the right instinct; just make
the check explicitly scope-local and add a test: a binder named like a module-
level `const` is *allowed* (or, if `has` is unavoidably parent-walking, decide
that's acceptable and say so). Cheap to pin either way.

## 4. `draftCharCount`'s "unstringifiable" test doesn't test the throwing case

The test feeds `undefined`, where `JSON.stringify` *returns* `undefined` (handled
by the `=== undefined` guard). A genuinely unstringifiable value — a circular
object — makes `JSON.stringify` **throw**, which the function doesn't catch. In
practice a model's tool args are JSON-origin and can't be circular, so this is
safe, but the test name overclaims. Either narrow the name ("returns 0 for
undefined") or add a `try/catch` and a real circular-input test if you want the
claim. Trivial.

## 5. Gemini tool-result ordering (known, low-severity, real-provider-only)

The interception pushes ack messages before the concurrently-dispatched tools'
results, and Task 6's comment correctly flags that providers pair by
`tool_call_id` (order-independent) except Gemini (position/name). The residual
edge the comment doesn't quite cover: if the model issues tools in an order that
puts a real tool *before* saveDraft, or issues two saveDraft calls (same name),
Gemini's position/name pairing can misalign against acks pushed out of call
order. Same class as the #566 finding, deterministic tests won't catch it, and
it's not worth reordering for — but it belongs in the "known limitations" doc
follow-up alongside the renamed-saveDraft note, not just a code comment.

---

# What is right

The Background section is the model for how to write one — every downstream task
rests on a fact established and cited there (the frame isomorphism, the
handler-param bare-identifier precedent, `withFinalize` already holding the
draft), so the tasks read as consequences rather than assertions. The byte-
stability gates (Task 3 Step 5, Task 5 Step 5) are placed exactly where an
invisible-to-existing-programs change could silently churn, and they fail loud.
The AG6037-makes-codegen-sound argument is genuinely load-bearing and correctly
identified: the collision error isn't ergonomics, it's what prevents a silent
miscompile, and the plan knows that.

Part A (finalize binder) I'd execute as written — I traced `withFinalize` and the
"draft already in hand, throw-fallback returns the same value" claim holds exactly,
so the runtime change really is the one line the plan says. Part B is sound too;
it just needs the seam test before the two well-tested halves can be trusted to be
connected.

# Recommended next steps

1. Add the RecordingClient runtime test tying `args.draftSchema` → the provider
   tool list (finding 1). This is the one gap worth closing before merge.
2. One sentence in Task 6 on why the ack survives resume, naming the dangling-
   `tool_use` safety net (finding 2).
3. Make AG6037's collision check explicitly scope-local, with a test (finding 3).
4. Fold the Gemini-ordering and renamed-saveDraft limitations into the doc
   follow-up list (finding 5).

---

# Addendum: audit against `docs/dev/anti-patterns.md`

**Direct answer to "does it write declarative interfaces that encapsulate
complexity, or imperative code?": mostly the former, with one clear miss.**
Part A (finalize binder) and the *pure* helpers of Part B are well-encapsulated.
But Task 6's interception — the stateful heart of the saveDraft tool — is a
~35-line imperative block inlined in the tool loop, and it hand-rolls a divergent
second copy of the tool-lifecycle emission. Four findings, ordered by how much
they bear on the declarative-vs-imperative question the owner flagged.

## A1. The "how" of handling an intercepted call is inlined, not encapsulated (*Imperative code everywhere*)

`saveDraftTool.ts` extracts the pure *what* cleanly — `isSaveDraftTool`,
`buildSaveDraftToolDefinition`, `draftCharCount`. That's the right instinct, and
it's genuinely good. But the *behavior* — what "handle one intercepted call"
means — stays inline in `prompt.ts` (Task 6 Step 5): recognition-dispatch, the
`hasValue` branch, ack formatting, `setSavedDraft`, four lifecycle emissions, and
the `messages.push`, all in one block inside the `for`. That is exactly the split
the anti-patterns entry names: the module holds the data logic, the tool loop
holds the how.

The loop should read declaratively — `intercepted → await handleSaveDraftCall(…)`
— with the block moved into `saveDraftTool.ts` (or a sibling) as a function
taking `{ toolCall, stateStack, ctx, messages, model }` and returning the ack (or
pushing it). The plan extracted the nouns and left the verb inline; finish the
job. This is the owner's #1 review flag (`feedback-pre-pr-anti-pattern-audit`),
so it's worth doing before the PR, not after.

## A2. The lifecycle emission is a divergent second copy of the real tool path (*Duplicating existing code* + *Inconsistent patterns*)

The four-event sequence the interception hand-writes — `toolCallStart` →
`onToolCallStart` → `onToolCallEnd` → `toolCall` — is the same sequence the real
tool dispatch emits (`prompt.ts:1650-1740`). There's no shared helper today (the
real path inlines it too, woven into the `b.parallel` branch steps), so the
interception isn't duplicating a *helper* — it's writing a **second, subtly
different** copy:

- the real path wraps each emission in its own `b.step` (`.logStart`, `.start`)
  for resume-idempotency and emits `toolCallStart` **inside a `toolExecution`
  span** so consumers pair start/end by `span_id`, with real `performance.now()`
  timing;
- the interception does all four in one `pr.step`, `timeTaken: 0`, and **opens no
  span** — so saveDraft's start/end events won't span-pair like every other
  tool's, and a statelog consumer that groups by `span_id` sees them orphaned.

Two implementations of "emit a tool's lifecycle" will drift the first time a
fifth event or a span change lands — and they already differ. The proportionate
fix isn't to unify the two paths (the real one is deep in the parallel/branch
machinery — that's scope creep); it's to (a) put the interception's emission in
the same `handleSaveDraftCall` helper from A1, and (b) **flag the span/pairing
divergence in the plan as a deliberate decision** rather than emitting it
silently. Right now the plan neither reuses nor acknowledges the difference.

## A3. `dispatchCalls` is a parallel mutable variable the plan admits is a footgun (*Order-dependent mutable state* / *Leaky abstractions*)

Task 6 builds `dispatchCalls` imperatively (`push` in a loop with `continue`),
then instructs: "Audit the rest of the `while` iteration for reads of `toolCalls`
that should now read `dispatchCalls`." That instruction *is* the anti-pattern —
two live lists of tool calls where the reader must remember which one each site
wants, and a wrong choice fails silently (an intercepted call slipping back into
the dispatch pool, or a real call being skipped). The declarative form is one
partition up front:

```ts
const { intercepted, dispatched } = partitionBy(toolCalls, (tc) =>
  isInterceptedSaveDraft(tc, toolFunctions),
);
```

Then `intercepted` drives the ordered handling and `dispatched` drives
`pr.parallel`, and there's no "which variable does this line want" to audit —
the names carry the answer. (If there's no `partitionBy` in `lib/utils`, two
`.filter`s are still better than build-by-push, because each is a total
expression, not an accumulation whose correctness depends on the `continue`.)

## A4. The `z.any()` string-compare is a leaky, brittle check (*Leaky abstractions*)

Task 5 decides whether to emit a schema with
`if (draftZod !== "z.any()")` — comparing against the **rendered output string**
of `zodSchemaFor`, and the plan itself says "verify what `zodSchemaFor` renders
for an `any` declared type … adjust the comparison to the real string." That's a
semantic decision (is this type `any`?) made by sniffing a renderer's text, which
breaks the moment the renderer's output changes. Make the decision at the type
level, before rendering: `if (declaredReturn !== undefined && !isAnyType(declaredReturn))`.
`isAnyType` already exists (it's the predicate the `retire-any-sentinel` work
standardized on). Then `zodSchemaFor` is called only when you've already decided
to emit, and no output-string coupling exists.

(Minor, same task: the triple-nested `if` guarding the emit reads better as guard
clauses or a small `draftSchemaFor(scope): TsNode | null` — but that falls out of
the `isAnyType` fix, since two of the three conditions collapse into it.)

## Not anti-patterns (checked, to be fair)

No dynamic requires. No swallowed catches — `withFinalize`'s catch routes through
`logFinalizeFailure`. No nested ternaries (the `?:` in `draftCharCount` and the
tool-def fallback are single, legible). No magic numbers, no one-line ifs, no
deeply-nested type literals. The parser's ordered structure (Task 1) is the
explicitly-exempted case. And the genuine wins are worth stating: `saveDraftTool.ts`
as a home for the recognition/definition/counting logic, and Part A's one-line
`withFinalize` change, are both exactly the "encapsulate the how, expose a clean
what" the catalog asks for. The miss is narrow — the interception's stateful
verb — not pervasive.

## Where this lands

A1 and A2 are the same fix from two angles: extract `handleSaveDraftCall`, and let
it own both the effect logic and a lifecycle emission whose divergence from the
real path is a stated choice. A3 and A4 are independent local cleanups. None
change the plan's architecture; they finish the encapsulation it already started.

---

# Addendum 2: the test plan

Two questions: will each test fail if the thing it guards breaks, and what's
missing? The finalize-binder tests are mostly honest. The saveDraft-tool tests
have a structural blind spot — **they assert the salvaged draft and nothing else,
so the feature's actual output (the tool result the model sees, the schema the
provider sees) is untested** — and one finalize test is a false negative that
cannot fail.

## Tests that would not fail when the code breaks

### T1. Task 2 test 3 ("undeclared return → binder is `any`") is a false negative

```ts
def f() {            // no declared return type
  return "x"
  finalize as d { return d }
}
// filter(/binder|null|not assignable/i) → expect toHaveLength(0)
```

The assertion filters to binder/null/assignable messages and expects none. But the
bug this test exists to catch — the binder-declaration pass failing to declare `d`
— produces an **"undefined variable `d`"** error, whose message contains none of
those words. So it's filtered out, the filtered set is empty either way, and the
test passes whether or not the binder is declared. It cannot fail in the direction
it's meant to.

Fix: assert on the **unfiltered** result (`expect(typecheckSource(src)).toHaveLength(0)`),
so an undefined-variable leak surfaces — or add a positive use that only compiles
if `d` is `any` (e.g. `const s: string = d` with no null guard, which is legal for
`any` but not for `T | null`). The unfiltered version is the honest one: it proves
the binder both exists and is permissive.

### T2. The Task 5 codegen tests pass even if the runtime ignores `draftSchema`

Every Task 5 test string-matches the **generated output** (`toContain("draftSchema: z.string()")`).
None run the generated code. So the plan's own primary risk — that `args.draftSchema`
never reaches `buildSaveDraftToolDefinition`, or lands in the wrong arg object —
fails no test here: codegen emits the key, runtime drops it, model silently gets
`z.string()`, all green. This is the seam finding (plan-review finding 1) stated as
a test-failure question, and the answer is the same: only the RecordingClient
runtime test closes it.

### T3. The resume fixture pins draft survival, not thread integrity

`savedraft-tool-resume` asserts the salvaged draft is `"model-draft"` after a
checkpoint/resume. But the draft survives via **frame serialization**, entirely
independent of the ack tool-message. If the ack were lost on resume (the
message-survival concern from finding 2), the draft would still be `"model-draft"`
and the fixture would still pass — the deterministic client doesn't validate
tool_use/result pairing, so a dangling `tool_use` doesn't error in-harness. The
fixture's name promises more than it checks.

## Missing tests

### M1. Nothing asserts the feature's observable output — the tool result and the statelog events

Spec Part 2's contract is two things: "returns an acknowledgment as the tool
result" and "emits the standard toolCall statelog events." **Neither is asserted
anywhere.** Every saveDraft fixture proves the feature worked only by the salvaged
draft value — an indirect, downstream signal. If the ack message were malformed,
absent, or attached to the wrong `tool_call_id`, or if the toolCall events never
fired, no test would fail.

The message-labels e2e (#557) is the precedent: run with `--log-file`, read the
statelog, assert the events. One saveDraft fixture that reads statelog and asserts
the `toolCall` event fired with `args: { value: "model-draft" }` and
`output: "Draft saved (11 characters)."`, in order, would pin the actual
user-facing behavior instead of inferring it from salvage. This is the single
most valuable addition — it's the difference between "a draft came out" and "the
tool behaved as specified."

### M2. No test that AG6037's collision check is scope-local (plan-review finding 3)

The checker tests cover collision-with-local and collision-with-param (both must
error) and "fresh binder doesn't disturb outer variables." None cover a binder
named like a **module-level** `const`/`def`. That's the case that decides whether
`info.scope.has` is scope-local (correct) or parent-walking (false-positives on a
global-named binder, which compiles fine because a global isn't `__stack.locals`).
Add: `finalize as <name-of-a-top-level-const>` — assert it's **allowed** (or, if
the team decides parent-walking is acceptable, assert the error and document why).
Without it the scope-local requirement is unpinned.

### M3. The schema seam with a real object type, end to end

Task 6 unit-tests `buildSaveDraftToolDefinition(z.number())` directly and Task 5
tests the object-schema emit — but nothing wires a generated `draftSchema:
z.object(...)` into the tool the model sees. Same root as M1/T2: the RecordingClient
test should cover both a `z.number()` and a structured type, asserting the tool's
`value` schema rejects the wrong shape.

### M4. `draftCharCount` on a throwing input (finding 4)

The "unstringifiable" test feeds `undefined`, where `JSON.stringify` *returns*
undefined. A circular object makes it *throw*, uncaught. Safe in practice (args are
JSON-origin), but either the test name should narrow to "undefined → 0" or the
function should `try/catch` with a real circular-input test. Trivial, but the
current test's name claims coverage it doesn't have.

### M5. A `withFinalize` unit test that it passes the draft (not just the fixture)

Task 3's runtime change — `finalize(this.partialValueOrNull())` — is verified only
by the `finalize-binder-returns-draft` fixture. A direct unit test on `withFinalize`
(spy finalize, assert it received the draft value, assert the throw path still
returns `this`) would pin the runtime half in isolation, so a regression there
fails at the unit level rather than only in a full compile-and-run fixture. Cheap,
and it matches how the rest of `abortedResult` is presumably tested.

## What the tests get right

The finalize codegen test's `not.toContain("__stack.locals.draft")` is exactly the
right assertion — it pins the load-bearing "bare identifier, not frame local"
mechanic that AG6037 exists to protect, so if the binder ever compiled to a local
the test fails loudly. The three finalize fixtures map cleanly to the three spec
behaviors (yields draft, null when unsaved, throw-falls-back-to-same-draft). The
`userShadow` fixture genuinely discriminates (expected `"no-draft"` vs the
would-be `"ignored"` if recognition wrongly fired). And `savedraft-tool-basic` is a
real frame-math pin: a wrong-frame write yields an empty draft and `"no-draft"`, so
it fails in exactly the direction the (now-corrected) frame analysis was worried
about. The bones are good; the gap is that the tool-side tests stop at the
salvaged value and never look at the tool result or the wire.

## Priority

1. Fix T1 (the false-negative binder-`any` test) — it's a one-line change and the
   test currently protects nothing.
2. Add M1 (statelog assertion of the ack + toolCall events) and M3 (RecordingClient
   schema seam) — together they cover the feature's untested observable surface.
3. Add M2 (scope-local collision) and M5 (`withFinalize` unit).
4. Narrow or fix M4.
