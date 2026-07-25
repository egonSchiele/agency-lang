# Review: Hoist Calls for Resume Safety — implementation plan

Reviewer: Claude, 2026-07-22
Plan under review: `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-22-hoist-calls-resume-safety.md`
Spec: `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-22-hoist-calls-resume-safety-design.md` (revised; Part 4a and the method-call ruling are new since my spec review)

Everything below that describes code was read at the file:line given, or probed by running the tool.

## Verdict

The task breakdown, the ordering (tripwire first as a live detector), the two-commit fixture split, and
the probe-don't-guess discipline are all right. The spec's revisions landed cleanly into it.

Five things will bite an implementer who follows the plan literally. Issue 1 makes correct programs
throw. Issue 2 is a silent wrong-value bug that the plan's own architecture creates. Issue 3 is a
sequencing hole between Task 2 and Task 4 that ships a broken intermediate commit. Issues 4 and 5 are
verification steps that cannot work as written.

## Altitude

Right altitude, and it matches existing house patterns. A new AST-to-AST preprocessor pass alongside
`guardDesugar` / `parallelDesugar` is exactly where this belongs, and the tripwire has direct precedent:
`lib/runtime/state/stateStack.ts:250-262` already throws "Parent's guard stack drifted between snapshot
and resume — state corruption" for the analogous guard-count invariant. Cite that in Task 1; it is the
house style for this kind of check and it argues the throw-don't-warn decision for you.

One overlap to resolve rather than leave implicit: Task 2 rule 5 seeds the temp counter above any
user-declared `__hoist_N`, and Task 6 adds a lint rule forbidding those names. Say which is
authoritative. My read: the seeding is the real protection (lint is advisory and not run at compile
time), the lint rule is the good error message. Worth one sentence so a later reader does not delete one
as redundant.

## Blocking issues

### 1. The Runner constructor is not the frame-claim site, and Task 1 will throw on correct programs

Task 1 puts `claimFrameForScope(this.frame, this.scopeName, ...)` at the end of the Runner constructor.
Not every Runner claims a fresh frame. `finalize { }` blocks construct a **second Runner on the container's
own frame**:

```
lib/backends/typescriptBuilder/finalizeCodegen.ts:185
scopeName: JSON.stringify(scopeName + "#finalize"),
```

and the closure template reuses the container's frame variable:

```
lib/templates/backends/typescriptGenerator/finalizeClosure.mustache:2
const runner = new Runner(__ctx, {{frameVar}}, { state: {{frameVar}}, ..., scopeName: {{scopeName}} });
```

`finalizeCodegen.ts:44-50` states the intent plainly: "The closure runs on the container's own frame:
locals live there, so the finalize body reads them with zero passing."

So any function or block with a `finalize` block, on the abort path, constructs a Runner named
`foo#finalize` against a frame stamped `foo`. Under Task 1 as written that throws

> Resume desync: function "foo#finalize" tried to claim the saved state of "foo"

on a correct program, on the salvage path that `saveDraft` depends on. That is the worst possible place
to plant a false positive.

Task 1 Step 6 will not catch it either: it runs `npx vitest run lib/runtime`, and the finalize path is
exercised by codegen and agency tests, not by the runtime unit suite.

The underlying problem is conceptual, and worth fixing rather than patching: **claiming a frame and
running on a frame are different events, and only the first should stamp.** Options, best first:

- Emit the claim in codegen at the four real claim sites, right after `setupFunction()` — the function
  preamble (`typescriptBuilder.ts:2247` neighborhood), the node preamble (`:3067`), `blockSetup.mustache`,
  and `forkBlockSetup.mustache` — plus `runPrompt` and `resumableScope.ts:122-138` (which does call
  `setupFunction` first, so it is a genuine claim). Slightly more surface than the plan assumes, but the
  distinction is then structural and cannot rot.
- Add an explicit `claimsFrame: true` opt passed only at those sites, and check inside the Runner
  constructor. Less codegen churn, same guarantee.

Do not special-case the `#finalize` suffix in `claimFrameForScope`. That hides the category rather than
naming it, and the next reused-frame Runner reintroduces the bug.

Also note the default: `this.scopeName = opts?.scopeName ?? ""` (`lib/runtime/runner.ts:159`). Any Runner
built without a scope name would stamp the empty string and then collide with the real owner. Whichever
option you take, refuse to stamp an empty name.

Add a regression test for this specific shape: a function with a `finalize` block that aborts, asserting
no tripwire throw.

### 2. Per-body temp numbering collides, because frame locals are flat

Task 2 rule 5 says "seed the temp counter per body," and Task 3's while rewrite calls
`hoistCallsInBody(node.body)` recursively — so a nested statement list restarts numbering at
`__hoist_0`. But locals are flat per frame: generated code writes `__stack.locals.<name>`
(`tests/typescriptGenerator/assignment.mjs:210`), and a loop body shares its enclosing function's frame
and runner. Two different temps then share one slot.

This is not theoretical. Take `for (x in getItems()) { ... }` where the body also hoists something:

```
const __hoist_0 = getItems()          // function-level temp
for (x in __hoist_0) {
  const __hoist_0 = weigh(x)          // body-level temp, same slot
  ...
}
```

`runner.loop` receives the iterable as an evaluated argument, so on resume the generated code
re-evaluates `__stack.locals.__hoist_0` before re-entering the loop — and by then the loop body has
overwritten it with a `weigh(...)` result. The loop resumes iterating over the wrong value, silently.

Fix: **one counter per frame-owning scope** (function, node, block, fork branch), shared across every
nested statement list inside it, reset only when the pass enters a new scope that calls
`setupFunction()`. Blocks and fork branches get their own frame (`blockSetup.mustache:2-4`,
`forkBlockSetup.mustache`), so restarting there is correct and desirable.

This changes the Task 2 interface: `hoistCallsInBody` cannot own the counter if it is also the recursion
entry point. Thread a counter object through, or split into a scope-level entry (`hoistCallsInScope`)
and an internal recursive helper. Worth fixing in the interface now rather than discovering it in Task 3.

Add a test: nested hoists in a loop body produce distinct names from the enclosing body's temps.

### 3. Task 2 must state the "never cross a statement-list boundary" rule, not defer it to Task 4

Task 2 rule 1 says walk children generically, `mapChildren`-style. Task 2 rule 4 mentions recursing into
nested statement bodies. The prohibition that actually matters — a temp emitted from inside a block body
must never land in the enclosing body — appears only in Task 4 Step 2.

A generic child walk that has not been told to stop will happily descend from a statement into a
`blockArgument`'s body and hoist a per-item call out to the enclosing statement list. For a comprehension
that means evaluating a per-item call once, outside the block, which is wrong output — not a missing
optimization. Task 2 ends in a commit, so the plan as sequenced commits a pass that does this.

Move the rule into Task 2 rule 1: the walker stops at any node that owns a statement list
(`blockArgument`, `ifElse` bodies, loop bodies, handler bodies) and hands off to the statement-level
entry point, which owns its own `out` array. Add the negative test in Task 2, not Task 4.

While there: the walker must also skip `comment` and `newLine` nodes, which really do appear in parsed
bodies (probed — see issue 6).

### 4. Task 7 Step 1's red-direction check cannot work

```bash
git stash push lib/preprocessors/typescriptPreprocessor.ts    # temporarily unwire the pass
```

By Task 7 the wiring is committed (Task 5 Step 4). `git stash push <path>` on a file with no working-tree
changes stashes nothing and the pass stays wired, so the "expect >= 1 Resume desync" grep fails and the
implementer has no idea why.

Replace with an explicit unwire: comment out the `hoistCallsInProgram(this.program);` line, run, then
`git checkout -- lib/preprocessors/typescriptPreprocessor.ts`. Same reversibility, and it actually does
something.

Also state what the red run is expected to prove. With Task 1 landed, the old silent desync surfaces as
the tripwire error — but only if the impostor reaches a stamped claim site. If issue 1 is fixed by moving
the claim into codegen, that still holds (`__searchTools_impl` claims via its own preamble). Say so, so a
grep miss is diagnosed as "the tripwire did not fire" rather than "the test is wrong."

### 5. Missing `make` before the agency execution tests

Task 0 runs `make`, then Tasks 2-5 change the compiler. Task 7 then runs `pnpm run agency test` against
fixtures that use stdlib agents. Per the project's own build note, `pnpm run build` skips `lib/agents` and
`make` is what builds everything — so the stdlib compiled with the *old* compiler is what those tests
would exercise, and the pass's effect on stdlib call sites goes untested.

Add a `make > /tmp/hoist-make2.out 2>&1` step at the top of Task 7 (and again after any pass change), and
say why: the pass changes generated output for every `.agency` file including the stdlib.

## Corrections

### 6. The `!` probe in Task 3 fails, but the claim it checks is true

Task 3 Step 3 tells the implementer to "confirm with one probe (`pnpm run ast` on a file containing
`if (!(x < 5)) { break }`)". I ran it. It fails:

```
Failed to parse Agency program: Expected function body
```

The parser cannot parse `!(...)` over a comparison at all — this is the known bang gotcha. An implementer
following the instruction hits a wall and may conclude the rewrite is impossible.

The shape the plan asserts is nonetheless correct. `!flag` parses to exactly what the plan describes:

```json
{"type":"binOpExpression","operator":"!","left":{"type":"boolean","value":true},"right":{"type":"variableName","value":"flag"}}
```

And emission over a comparison is safe by precedence, not by luck: `PRECEDENCE["!"] = 8` and
`PRECEDENCE["<"] = 4` (`lib/types/binop.ts:43-79`), `needsParensRight` returns true when the child's
precedence is `<=` the parent's (`lib/backends/typescriptBuilder.ts:489-491`), and the printer wraps the
operand when `parenRight` is set (`lib/ir/prettyPrint.ts:225-230`). So a synthesized `!` over
`__hoist_0 < 5` prints `!(__hoist_0 < 5)`, not the silently-wrong `!__hoist_0 < 5`.

Two changes: fix the probe to use `!flag` (which does parse and yields the shape), and record the
precedence chain above as the reason emission is safe. **The plan must also require that the synthesized
node be the `binOpExpression` shape, not a hand-rolled unary node** — `ts.unaryOp` only parenthesizes when
explicitly told (`lib/ir/prettyPrint.ts:501-508`), so an implementer who "simplifies" to a unary node
gets `(!h) < 5` with no warning. That is the trap worth naming.

Separately: `while (true) { ... }` does parse cleanly, so the synthesized loop condition is fine.

Consider avoiding `!` altogether: `while (true) { <temps>; if (cond') { BODY } else { break } }` is the
same semantics with no negation, no precedence question, and no synthesized operator the parser cannot
produce. `continue` still lands on the condition check either way. I would take this and drop the whole
question.

### 7. The unit-test assertions will break on comments and blank lines

Task 2's tests use exact shape equality, e.g.
`expect(body.map(n => n.type)).toEqual(["assignment", "returnStatement"])`. Parsed bodies contain
`comment` and `newLine` entries — probed:

```
"type": "assignment"   "type": "comment"   "type": "returnStatement"
```

for a body with one comment. The builder has a `case "newLine": return ts.empty();` arm
(`typescriptBuilder.ts:668-669`) for the same reason. The test sources in the plan mostly avoid comments
and blank lines, so these may pass by accident and then break the moment someone edits a fixture.

Have `bodyOf` filter `comment` and `newLine`, and add one test with a comment between statements to prove
the pass steps over them rather than treating them as expressions.

### 8. Hoisting a `for` iterable out of the loop relaxes an existing compile error

`validateNoAsyncInLoops` (`lib/preprocessors/typescriptPreprocessor.ts:932-944`) throws when an `async`
call appears anywhere under a `forLoop` or `whileLoop` ancestor, and the plan runs the pass *before* it.
After hoisting, `for (x in async getItems())` has its async call outside the loop, so a program that is
rejected today compiles. The `while` direction is unaffected (hoisted condition calls move deeper into
the loop, which is still inside it).

Probably fine, arguably an improvement, but it is a user-visible change to what compiles and it should be
a stated decision rather than a side effect. If you want the old behavior, run the check before the pass.

## Smaller notes

- **Task 1 test API**: `State.toJSON` is at `stateStack.ts:219`, `State.fromJSON` at `:271`, and
  `StateStack.fromJSON` at `:1152` — the plan's spellings work. Add the field to the `StateJSON` type too;
  the plan mentions `toJSON` and "the revive path" but not the type.
- **`runPrompt` claim site**: `lib/runtime/prompt.ts:887` is exactly
  `const { stateStack, stack } = setupFunction();`, so the plan's placement is right. If issue 1 moves
  claiming into codegen, this one stays a hand-written call, since `runPrompt` is TypeScript — worth
  saying so explicitly rather than letting it look inconsistent.
- **Task 4 fork test is weak**: asserting zero temps in the *outer* body passes both when the pass
  correctly hoists inside the branch block and when it skips blocks entirely. Add a positive assertion
  that the temp exists inside the block body.
- **Task 7 Step 4's #653 dependency**: I could not verify that PR from here. The plan's instruction ("must
  not reach main ahead of #653") is right in spirit; add the check command (`gh pr view 653`) so the
  implementer confirms rather than assumes.
- **Task 8 docs**: `docs/dev/hoist-calls.md` should include the finalize case from issue 1 in the
  tripwire section — "which Runners claim a frame and which reuse one" is precisely the thing a future
  reader will get wrong.

## Anti-pattern audit (`docs/dev/anti-patterns.md`)

The plan tells the implementer to audit the diff before the PR (Task 8 Step 4). That is too late for
these: the anti-patterns are in the *design the plan prescribes*, so an implementer who follows it
faithfully writes them in and then audits their own instructions.

Four of the catalog's entries apply. The first two are the substantive ones.

### A. Duplicating existing code — the walker and the boundary rules already exist

This is the catalog's first entry, and its "Good" example is literally "use the existing helper from
`lib/utils/node.ts`."

Task 2 rule 1 says to write a generic `mapChildren`-style walker, reusing or extracting
`comprehensionDesugar`'s copy. Task 4 Step 2 then hand-lists which node types own statement lists and
must not be crossed. The codebase already owns both halves:

- `lib/utils/bodySlots.ts` — "the single source of truth for which fields of a node hold statements,"
  with a `write(owner, body)` immutable rewriter per slot.
- `lib/utils/mapBodies.ts` — "apply a transform to every immediate statement body of a node, returning a
  structurally-fresh copy," built on `bodySlots`, and used by `guardDesugar`, `patternLowering`, and
  `comprehensionDesugar` — the exact three passes the plan names as house style.
- `lib/utils/node.ts:51` `expressionChildren` — the read view of expression children.

`bodySlots` even carries `retargetsReturn`, flagging bodies that run in their own closure (block
arguments, inline handler bodies, finalize bodies). That is very nearly the boundary predicate Task 4
hand-writes, and it is already maintained by everyone who adds a node type.

The file's own header documents the failure mode the plan is about to repeat:

> Before this existed, each consumer hand-listed the node types and they drifted (mapBodies missed
> `messageThread`, then `withModifier`/`staticStatement` — each miss silently skipped lowering).

For this pass, "silently skipped lowering" means a statement that still desyncs on resume.

What the plan should say instead: **statement-level recursion goes through `mapBodies`; only the
expression interior needs a generic child walk.** That is what `comprehensionDesugar` actually does — it
appears in the `mapBodies` consumer list *and* has its own `mapChildren` for expressions. The plan picked
up half the pattern and re-derived the other half. It should also state explicitly whether the pass wants
`retargetsReturn` slots recursed-into-separately (yes: they own a frame, so they own a temp counter — see
blocking issue 2) or skipped (handler bodies).

### B. Imperative code everywhere — the "what" and the "how" are fused

This is the entry you asked about, and it is the plan's weakest design decision. The prescribed core is:

```ts
function extractCalls(expr: any, out: AgencyNode[], ctx: WalkContext, isTail: boolean, fresh: () => string): any
```

Every red flag from the catalog's entry is here. Results accumulate through an output parameter (`out`)
rather than being returned. A mutable counter closure (`fresh`) threads through every frame. A boolean
flag parameter (`isTail`) changes behavior mid-recursion. And each position rule from the spec becomes
another `if` branch inside the same function, so the rules ("what may be hoisted") live tangled in the
traversal ("how to walk"). Change one ruling later and you are editing traversal code.

The plan half-notices this. Task 4's preamble says: "for each, decide hoist/skip and **record the ruling
as a comment table** at the top of `hoistCalls.ts`." A comment table beside scattered `if`s is the exact
shape the catalog warns about — the declarative statement exists, but as prose, where nothing checks it
and it silently drifts from the code beneath it.

Make the table the implementation. Something like:

```ts
type Ruling =
  | "descend"        // ordinary expression: walk children, hoist calls
  | "conditional"    // may not execute: walk for structure, hoist nothing
  | "opaque"         // never descend: try operands, catch expressions
  | "statements";    // owns a statement list: hand off to the body rewriter

const RULINGS: Record<string, Ruling> = {
  tryExpression: "opaque",
  ...
};
```

with operator-keyed entries for the `binOpExpression` cases (`catch` → opaque, `|>` → input only,
`&&`/`||`/`??` → left descend, right conditional). Then one small traversal consults `RULINGS` and knows
nothing about `try` or pipes. Adding a construct becomes a table row plus a test — the "what" changes,
the "how" does not. It also makes the spec's position table and the code checkable against each other,
and it gives Task 4 something better to assert than string-searching serialized JSON.

Two smaller pieces of the same problem:

- Return `{ temps, expr }` from a pure extractor rather than mutating an `out` parameter. The plan already
  declares `hoistCallsInBody` "pure, returns a new statement list" — the interior should match.
- `isTail` is a property of the *statement*, not of the expression being walked. The statement-level
  rewriter already knows which sub-expression is the tail; let it not pass that one to the extractor,
  instead of passing a flag down the recursion.

### C. Order-dependent mutable state, plus a purity contradiction

Task 2's interface says `hoistCallsInBody` is "pure, returns a new statement list." Task 3's
implementation snippet then mutates the parsed node in place:

```ts
node.condition = { type: "boolean", value: true, loc: node.condition.loc };
node.body = [...temps, breakIf, ...hoistCallsInBody(node.body)];
```

Both conventions exist in the codebase — `guardDesugar` and `comprehensionDesugar` mutate deliberately
and say so in a header comment; `mapBodies` returns fresh copies — so either is defensible. What is not
defensible is claiming one and shipping the other in the same plan. Pick one and write the reason down.
Note that in-place AST mutation has burned this repo before through the parse cache (the clone-on-read
fix), which argues for the `mapBodies` copying route, and that route also comes free with item A.

Related: `hoistCallsInBody` returns a value while `hoistCallsInProgram` returns `void` and mutates. That
is the catalog's "inconsistent patterns" within a single new module. Make both return.

### D. A test whose failure is destructive

The catalog's last entry is about tests that do damage when they fail. Task 7 Step 1:

```bash
git stash push lib/preprocessors/typescriptPreprocessor.ts
...
git stash pop
```

Per blocking issue 4, the `push` stashes nothing, because the file is committed and unmodified. The
`pop` then applies whatever else happens to be on the stash stack — an unrelated stash from earlier work,
applied to the wrong tree. The failure mode of this "test" is silently restoring someone else's changes.
Replace it with an explicit edit and `git checkout -- <file>`, which cannot reach into unrelated state.

### Minor

- Task 2 Step 5: `git add lib/lowering/astChildren.ts 2>/dev/null || true` silently swallows the failure.
  If item A is adopted the file does not exist at all; otherwise just `git add` the paths that exist.
- The plan's Agency test fixtures use names like `f`, `g1`, `f2`, `mark`. `mark` is good — it says what it
  does. The rest are single-letter names in the catalog's sense; `outer`/`inner`/`slow`/`fast` cost
  nothing and make a failing assertion readable.
- Not an anti-pattern, a check I ran: hand-rolling `{ type: "ifElse", condition, thenBody, loc }` is fine.
  `IfElse` (`lib/types/ifElse.ts`) has `elseBody` optional, and `createKeyword` is the only node
  constructor in `lib/types/`, so there is no helper being bypassed.

## Test-plan review: will these tests fail when the code breaks?

Short answer: the unit tests for the pass are mostly sound, but the three tests carrying the most weight
— the tripwire tests, the `while`-rewrite runtime test, and the flagship resume regression — each have a
hole that lets the thing they exist to catch slip through. There are also seven missing cases, several
for behavior the spec explicitly promises.

### Tests that pass when the code is broken

**1. The tripwire tests never exercise a call site.** All four tests in Task 1 Step 2 call
`claimFrameForScope` directly. Nothing asserts that the Runner constructor calls it, that `runPrompt`
calls it, or that the stamp reaches a frame during a real execution. Delete the wiring and every test
still passes.

This is not hypothetical: blocking issue 1 (the `finalize` closure builds a second Runner named
`foo#finalize` on the container's own frame) is a call-site bug, and this suite is structurally incapable
of seeing it. Add:

- a test that constructs two Runners on the same frame with different names — which is what `finalize`
  does — and asserts the intended outcome, whatever you decide it is;
- one execution test with a `finalize { }` block that aborts, asserting no tripwire error;
- one assertion that a normal two-function agency run stamps frames at all (otherwise a no-op
  implementation passes everything).

**2. The legacy-checkpoint test simulates the wrong thing.** It sets `frame.scopeName = null` by hand.
The real legacy path is a JSON payload that has no `scopeName` key at all, revived through
`State.fromJSON` (`stateStack.ts:271`). If the revive path defaults a missing key to `""` rather than
`null`, production legacy checkpoints throw and this test still passes. Build the JSON without the key
and revive it.

**3. The `while`-rewrite runtime test cannot catch the `!` trap.** Task 7 Step 3 uses:

```agency
while (check(i)) { ... }
```

The condition is a bare boolean call, so the synthesized negation has an atomic operand and `!x` and
`!(x)` are identical. The precedence hazard I described in correction 6 only appears with a comparison —
`!(__hoist_0 < 5)` versus the silently-wrong `!__hoist_0 < 5`. As written, an implementation that emits
an unparenthesized unary node passes this test and ships a wrong loop condition.

Change the fixture to `while (count(i) < 3)` (or adopt the `else { break }` form and delete the hazard).
Either way the runtime test must contain a comparison in the condition.

**4. The flagship regression test's only validity check is the broken one.** The resume-regression
fixture is the whole point of the work, and the only evidence it exercises the desync is the red run in
Task 7 Step 1 — which cannot work as written (blocking issue 4). Fix that first, because without it a
fixture that happens to take a non-desyncing resume path passes before and after and proves nothing.

While fixing it, state which resume path the fixture drives. The known repro is
`pnpm run a bisect-a.agency -i` — an interactive approval through `respondToInterrupts`. If the agency
test harness resumes differently, say so and say why that path desyncs too.

Also: the reported bug shape is `llm(msg, llmOptions(model: model, tools: tools))` — a *call in argument
position*. The fixture uses `{ tools: [...buildTools()] }`. Both hoist, but the flagship regression
should mirror the reported shape; add an `llmOptions(...)` variant, which is one extra fixture and the
closest thing to the original bug.

**5. Two Task 4 assertions pass when the pass does nothing.** The fork test asserts zero temps in the
outer body, and the handler test string-searches serialized JSON for `"__hoist_0"` present /
`"__hoist_1"` absent. Both are satisfied by a pass that skips blocks and handlers entirely — and the
handler one is additionally coupled to the numbering scheme, which blocking issue 2 changes. Assert on
the actual nested bodies: the fork branch body *contains* a temp, the `with` body contains none.

**6. Fixture regeneration is not verification.** `typescriptGenerator.integration.test.ts:32-75` parses
each `.agency` fixture and string-compares generated output to the `.mjs` file. The fixtures are never
executed. So `make fixtures` followed by a green suite proves only that generation is deterministic —
regenerating makes the comparison true by construction. Say this in Task 8 Step 1 so nobody reads that
green as evidence, name the CI agency suite as the actual gate, and have the implementer eyeball two or
three regenerated fixtures for the expected `__hoist_` shape.

### Missing cases

Ordered by what I would add first.

1. **A pause inside a `while` condition, resumed.** Per correction 5 in the plan's own Task 3, this is the
   worst-behaved position today — the condition re-runs once per completed iteration on resume
   (`runner.ts:1058-1066`). The plan rewrites it and never tests that the rewrite fixes the resume
   behavior. An execution test with an interrupting call in a `while` condition, resumed, is the direct
   proof.
2. **A pause inside a hoisted temp's own step.** `llm(msg, needsApproval())` where the *helper* raises the
   interrupt. The temp is now an assignment step, and the spec relies on assignment steps carrying
   `hasInterrupts` handling. Nothing tests it.
3. **Failure propagation through a temp.** The spec states that a hoisted call returning a Failure leaves
   the temp holding the Failure and the consuming call's argument-propagation rules apply unchanged.
   That is a claim about behavior; there is no test.
4. **A method-chain intermediate live in a frame at pause time.** Spec Part 4a asks for exactly this, and
   the `roundtrip-tools` fixture does not deliver it: the chain intermediates are built inside
   `buildKit`, which has *returned* before the pause, so its frame is gone. Put the chain in the pausing
   function's own statement — `llm(msg, { tools: [add.partial(a: 5), gate] })` in `main` — so
   `__hoist_0` holds an `AgencyFunction` across the checkpoint.
5. **Nested-scope temp numbering.** Blocking issue 2's collision has no test. Assert that a temp inside a
   loop body gets a different name from the enclosing body's temps, and add the `for`-iterable execution
   test that would catch the corruption end to end.
6. **A pause inside a loop body, resumed.** Distinct machinery from the top-level case: `whileLoop` and
   `loop` clear `__substep_` / `__condbranch_` locals per completed iteration (`runner.ts:1075-1082`) but
   never clear `__hoist_` locals. The interaction deserves one direct test.
7. **`continue` and a user `break` inside a rewritten `while`.** The rewrite injects its own `break`, so a
   loop body containing either keyword now has two exit paths through one construct. Cheap test, real
   risk.

Two smaller ones worth having: an **idempotency** test (the house passes document idempotency explicitly
— `guardDesugar`'s header, and `typeChecker/index.ts:106`), which matters more if you keep Task 3's
in-place mutation; and **`catch` / `|>` in the runtime order test**, since those two rulings are the
newest and currently exist only as AST-level assertions.

### On the neutrality test specifically

Task 7 Step 2 asserts one expected order — `a, b, left, l1, l2, t1, t2, c` with `right` absent. That
pins the pass's behavior, but it does not demonstrate *neutrality*, because nothing compares it to the
pre-pass result. Someone could edit the pass, update the expected list, and the test would keep passing.

Make it a comparison: run the same fixture with the pass unwired, capture the order, and assert the
hoisted run produces the identical sequence. That is the claim — "observationally neutral outside
resume" — stated as a test rather than as a constant.

Two things to verify before finalizing that fixture: whether an empty `if` body (`if (...) { }`) is
legal, and the exact spelling of `is number` on a primitive type. Both are cheap probes and both would
otherwise surface as a confusing parse error mid-task.

## Simplifications

Reviewed with the owner's constraint that **no backwards compatibility is required** — no legacy
checkpoints, no old-version tolerance. Ordered by how much they delete. The first four are the
substantial ones; together they remove one whole task, one file, one type, one function parameter, and
several tests, without giving up any of the fix.

### S1. Collapse "conditional" from a walk mode into an opaque boundary

The plan threads a `WalkContext { conditional: boolean }` through every recursion frame. In a conditional
position the walker still descends but hoists nothing (Task 4 Step 2, the `&&`/`||`/`??` rule).

Walking without hoisting produces no rewrites, so it is observably identical to not descending at all.
Make conditional positions simply opaque and the following all disappear: the `WalkContext` type, the
`ctx` parameter on every recursive call, one of the walker's two modes, and the "first inline call in a
conditional position is resume-aligned by construction" reasoning that a reader currently has to hold in
their head while reading the traversal.

The ruling table from anti-pattern item B then has three values, not four:

```ts
type Ruling = "descend" | "opaque" | "statements";
```

with `try` operands, catch expressions, pipe stages, and short-circuit right sides all being `opaque` for
their own reasons — reasons that belong in a comment on the table row, not in the traversal.

### S2. Delete Task 6 (the lint rule) entirely

The rule reserves the `__hoist` prefix in user code. It costs a rule file, a registry entry, a new AL
code, a diagnostic explanation, and a test — a full task — and it protects against a collision that
Task 2 rule 5 already makes impossible by seeding the counter above any existing `__hoist_N`.

The consistency argument is stronger than the redundancy one: no other compiler-reserved prefix in this
language is linted. `__comprehensionItem` (`comprehensionDesugar.ts:47`), `__block_N`, `__forsrc_N`,
`__substep_`, `__condbranch_` — none has a rule, and the comment on `__comprehensionItem` says only
"Double underscore is compiler-reserved, so it cannot collide with a user binder." Adding a rule for
`__hoist` alone makes the codebase less consistent, not more.

If it is wanted later it is a clean #646 candidate. Keep the counter seeding, which is the part that
actually prevents the collision.

### S3. Drop every legacy-checkpoint accommodation (unlocked by no back-compat)

Three pieces of the tripwire exist only to tolerate old checkpoints:

- the `frame.scopeName === null || undefined` exemption in `claimFrameForScope`;
- "serialize it only when non-null, to keep checkpoint noise down" (Task 1 Step 4), which is what creates
  the null-versus-absent distinction in the first place;
- the fourth Task 1 test ("a legacy frame with no scopeName passes any claim"), which as written tests
  the wrong thing anyway (test-plan review item 2).

Delete all three. Always stamp, always serialize, make the field required in `StateJSON`. The claim
function keeps exactly one branch — unstamped means fresh, stamped-and-different means corruption — and
the "is it null or undefined or empty string" question that would otherwise haunt the revive path never
arises.

While there, drop the ad-hoc `statelogClient?: { error?: (e: Record<string, unknown>) => void }`
parameter. It is a hand-rolled structural duplicate of the real client type, threaded through for an
event that fires immediately before a throw that crashes the run. Either import the real type or, better,
let the throw be the signal.

### S4. Reuse `mapBodies` instead of building a walker (also anti-pattern item A)

Restating it here because it is a size reduction, not only a purity argument: routing statement-level
recursion through `mapBodies` / `bodySlots` deletes the hand-listed boundary rules in Task 4 Step 2, the
proposed `lib/lowering/astChildren.ts` extraction, its `git add ... 2>/dev/null || true` line, and the
risk that the list drifts as node types are added. What remains to be written is the expression-interior
walk, which is the part that genuinely does not exist yet.

### S5. Fold nine tasks into five

The current split (2: core, 3: control flow, 4: boundaries, 5: wiring) means each intermediate commit is
knowingly incomplete, and one is knowingly wrong (blocking issue 3: Task 2 commits a walker that hoists
out of block bodies). Task 5 is four steps for a one-line change.

With the ruling table (S1) written first, the increments become safe in any order, and the natural shape
is:

| Task | Content |
|---|---|
| 0 | Worktree and baseline |
| 1 | Tripwire (with S3 applied) |
| 2 | The pass: ruling table, walker, all positions, wiring, smoke test |
| 3 | Tests: unit + execution |
| 4 | Fixtures (own commit), docs, PR |

Same commits where commits matter — the fixture split survives — with four fewer context reloads of the
same design.

### S6. Replace the `git stash` red-run with a compiled-output assertion

Task 7 Step 1's unwire-and-rerun dance is destructive when it misfires (anti-pattern item D) and exists
to prove the fixture exercises the desync. A permanent test proves more and cannot misfire: assert that
the fixture's *compiled output* contains a `__hoist_` temp for the tool-list argument. That pins the
shape under test forever, where the stash dance proves it once, on one machine, in one direction.

Keep the red run as a one-time manual check the implementer does and reports; just take it out of the
plan as a scripted step with `git stash pop` in it.

### S7. Use `else { break }` and delete the negation question

Already noted in correction 6, repeated here as a simplification: `while (true) { <temps>; if (cond) {
BODY } else { break } }` removes the synthesized `!` node, the parser probe (which fails), the precedence
reasoning about `PRECEDENCE["!"]`, and the class of bug where someone "simplifies" to `ts.unaryOp` and
gets `(!h) < 5`. One less synthesized operator, one less test to get right.

### Considered and rejected

**Hoisting the statement's tail call too, to delete the `isTail` flag.** Tempting — it removes a boolean
parameter and a special case, and #430 already does exactly this for match arms. But a graph-node call is
control flow, not a value (`typescriptBuilder.ts:1620-1634` throws when one appears as a value), so
uniform hoisting would need a node-call exclusion. Under the current rule a node call sits at tail
position and needs no rule at all. Trading a cheap special case for a subtler one is not a win.

**Dropping the `while` rewrite to a follow-up.** It is the single largest piece of Task 3 and the only
place the pass synthesizes control flow. But it is also the position that is worst-behaved today (the
condition re-runs once per completed iteration on resume), and with S7 applied the remaining complexity
is small. Keep it.

## What I did not check

I did not run any of the plan's test fixtures, and I did not verify the `test.json` schema the plan tells
implementers to copy. I did not read `runBatch`'s restore path. I probed the parser and the emitted JS for
the `!` and `while (true)` questions, and read the finalize, Runner, preprocessor, `bodySlots`, and
`mapBodies` code paths named above.
