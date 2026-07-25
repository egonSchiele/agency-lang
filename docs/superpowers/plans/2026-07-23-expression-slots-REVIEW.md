# Review: Expression Slots — implementation plan

Reviewer: Claude, 2026-07-23
Plan under review: `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-23-expression-slots.md`
Checked against `origin/main` at `6a86a3f7f` (#657 merged).

## Verdict

The diagnosis is right and the `bodySlots` precedent is the correct model. Three holes in one week is
exactly the evidence that hand-written position lists do not survive, and the `EvalMode` idea is a real
design contribution rather than mechanical enumeration — it is the piece that lets a table serve a
rewriter instead of only a reader.

Two things need to change before this is executable. The parity test cannot prove what Task 3 uses it to
license (issue 2), and deriving `expressionChildren` from slots silently reverses child order in a way
the parity test is designed not to see (issue 3). Issue 1 is an altitude question worth settling
explicitly even if the answer is "not now."

## Altitude: the plan consolidates two of four enumerations

The plan says there are two hand-written expression-position lists — `expressionChildren` and
`hoistCalls`'s switch — and merges them. In the same file as `expressionChildren` there are two more:

- **`walkNodes`** (`lib/utils/node.ts:~410-460`) has its own expression descent, including a
  `messageThread` block whose comment explains that it exists *because* the named-arg expressions were
  missing elsewhere: "They must be walked so the symbol-table resolver populates the `scope` field on any
  variable references inside them — otherwise codegen emits bare identifiers instead of
  `__stack.locals.foo`."
- **`getAllVariablesInBody`** (`lib/utils/node.ts:~340-380`) hand-lists `returnStatement`/`matchYield`,
  `gotoStatement`, `forLoop`, `whileLoop`, `messageThread`, `withModifier`, `tryExpression` again.

So after this plan lands, a new node kind still has three places to register expression positions, and
two of them are in the very file the plan is editing. That does not make the plan wrong — halving the
surface is worth doing, and `walkNodes` carries ancestor/scope threading that a plain slot list does not
model. But the Background section claims the fix ends the drift ("nothing forces it to register its
expression positions"), and after this change something still does not.

Either bring `walkNodes`'s expression descent onto the table in this plan (it is the one with the
documented drift scar), or add a paragraph to the Background saying which enumerations are in scope,
which are not, and why — and put the same note in the `expressionSlots.ts` header so the next person does
not assume the table is already universal. I would do the latter now and the former as a follow-up: doing
`walkNodes` here would put ancestor plumbing on the critical path of a refactor whose whole value is
being provably behavior-identical.

## Substantive issues

### 1. The corpus parity test is blind to shared blind spots

Task 1 Step 3 asserts set-equality between `expressionChildren(node)` and the slot table over the stdlib
corpus. That catches positions one side has and the other lacks. It cannot catch positions **neither**
side has — and those exist today.

`expressionChildren` (`node.ts:51-126`) has no case for `isExpression` (`pattern.ts:40-43`,
`{ expression, pattern }`) or `typeTestExpression` (`pattern.ts:66-69`, `{ expression, typeHint }`).
Both are in `EXPRESSION_NODE_TYPES` (`types.ts:120-146`) and both carry a real `expression` field. The
plan's mode table does not list them either. So the corpus test will run green across both enumerations
while both are missing the same positions, and the plan will read that green as coverage.

Fix: replace set-equality-with-`expressionChildren` as the coverage argument with a direct completeness
check against `EXPRESSION_NODE_TYPES` — for every type in that list, either a slot case or an explicit
"no expression children" entry, asserted by a test that fails when a new member is added. That is the
`bodySlots` guarantee (one case per kind, exhaustive switch), and it is what makes the enumeration
authoritative rather than merely consistent with an older one.

Keep the corpus parity test too. It is good for what it does — proving the derived view does not regress
the type checker — just not for proving completeness.

### 2. Task 3 Step 2 deletes the generic fallback on a proof that does not cover it

Step 2 says: delete `walk()`'s `Object.keys` descent "ONLY if the corpus parity test proves the slot
table reaches everything the old walk reached."

The parity test compares the slot table to `expressionChildren`. The generic `Object.keys` descent
reaches strictly more than `expressionChildren` does — that is why it is there. Parity with the narrower
enumeration says nothing about parity with the wider walk, so the stated gate cannot be met by the stated
evidence. With issue 1's types (`isExpression`, `typeTestExpression`) absent from the table, deleting the
fallback silently stops hoisting inside them.

The plan's instinct — a loud dev-mode throw naming the unlisted node type rather than a silent walk — is
right, and it is also the correct migration tool: land it *first*, run the corpus and the full fixture
build with it enabled, and let it name every node kind the table misses. Then delete the fallback with
evidence. Sequencing it that way turns an untestable gate into a checklist.

Worth noting for scope: calls may be unreachable inside `is` positions today (the parser rejects a call
on the left of `is`), so the practical exposure may be nil. That is a fine reason to leave them
un-hoisted — but it should be a recorded ruling with the parser fact next to it, not a gap the test
suite happens not to see.

### 3. Deriving `expressionChildren` from slots reverses assignment child order

`expressionChildren` today returns, for an assignment:

```ts
case "assignment":
  return [node.value, ...accessChainExpressions(node.accessChain)];   // node.ts:55-56
```

Value first, target chain second. The plan's slot ordering contract is evaluation order, and Task 1 Step
1 states it explicitly: "assignment target chain slots come before the value slot." So
`expressionSlots(node).map(s => s.expr)` yields the reverse of what `expressionChildren` yields today.

Both consumers iterate that array: `attachExpressionsToFlow` (`flowBuilder.ts:97`) attaches each child to
a flow graph, and flow analysis is order-sensitive by construction; `checkConstMutations`
(`scopes.ts:372`) is order-insensitive. So this could change narrowing behavior, and the parity test —
set-equality, deliberately — is designed not to notice.

Three ways out; pick one in the plan rather than at the keyboard:

- Have `expressionChildren` preserve its historical order explicitly (sort or hand-order the derived
  list), and say in a comment that flow order and evaluation order differ here.
- Change the order and prove it safe by running `lib/typeChecker` and asserting identical results — but
  identical *pass counts* is not enough; a narrowing change can keep every test green and still be a
  behavior change.
- Assert order in the parity test (`toEqual`, not set-equality) so the question is forced at
  implementation time.

Note that assignment-target ordering is already pinned on the hoisting side by a unit test on main
("hoists calls in assignment-target index expressions, before the value temps"), so the two orders are
genuinely both load-bearing, for different consumers. The plan should name that tension.

### 4. The zero-diff fixture proof is weaker than the plan claims, for exactly the motivating shapes

Task 3 Step 3 calls the zero-diff regeneration "the strongest single assertion in this plan." It is a
good check, but its strength is bounded by what the corpus contains, and the corpus does not contain the
shapes this work exists for. `tests/typescriptGenerator/gotoWithArgs.agency` is:

```agency
node main() {
  goto greet("world")
}
```

A literal argument, no nested call. Drop `gotoStatement` from the slot table and every fixture stays
byte-identical.

The real net for those shapes is the unit suite, which on `origin/main` does cover them — there are tests
for goto arguments, thread named args, thread blocks in value position, and assignment-target index
expressions. So the conclusion is not "add more proof," it is "attribute the proof correctly": the unit
tests are the contract for the motivating shapes, the fixture diff is the corpus-wide net for everything
else. As written, the plan leans on the weaker of the two.

If you want the fixture net to actually cover these, adding a nested call to `gotoWithArgs.agency` is a
one-line change with a permanent payoff.

### 5. Nothing tests the modes or the `write` functions

The parity test compares `expr` values only. Two failure modes get no coverage:

- **A wrong mode.** Marking `whileLoop.condition` as `once` would be caught by hoistCalls tests; marking
  an `agencyObject` value `conditional` would silently stop hoisting there and break nothing visible.
- **A wrong `write`.** A slot that reads field A and writes field B round-trips wrong. `bodySlots` has
  the same risk and the same answer.

Add the cheap invariant, over the whole corpus: for every node, folding each slot's own `expr` back
through its `write` returns a structurally equal node.

```ts
const rebuilt = expressionSlots(node).reduce((owner, s) => s.write(owner, s.expr), node);
expect(rebuilt).toEqual(node);
```

That one assertion catches every mis-wired `write` across the entire stdlib, and it costs three lines.
For modes, assert that every `EvalMode` value appears somewhere in the corpus run — a mode no node ever
carries is either dead or mis-assigned.

## Smaller notes

- **Stale numbers.** The plan cites "33 hoistCalls unit tests," "15 execution fixtures," and main at
  `135de584c`. On `origin/main` (`6a86a3f7f`) it is 29 unit tests and 13 fixtures under
  `tests/agency/hoist/`. These are quoted as the contract in Task 3, so they should be re-counted at Task
  0 rather than asserted from memory — or stated as "all existing tests, unedited," which is the actual
  requirement and cannot go stale.
- **`conditional` and `opaque` are indistinguishable to every consumer that exists.** Both mean "skip" to
  the pass and "include" to the reader. Keeping both is defensible as documentation of *why*, but the
  plan should say that no code branches on the difference today, so nobody later assumes it is
  load-bearing. If you would rather not carry an untested distinction, collapse to three modes and put
  the reason in each slot's comment.
- **The comprehension row in the mode table is malformed** — `once; expression + condition | perIteration`
  breaks the markdown cell and leaves the actual assignment ambiguous. Since only the type checker ever
  sees comprehensions, spell it out: iterable `once`, expression and condition `perIteration`.
- **Task 4 Step 2's grep is a weak audit.** Grepping `hoistCalls.ts` for `case "gotoStatement"` proves one
  file stopped enumerating. The claim worth checking is repo-wide: after this change, how many places
  enumerate expression positions? Given the altitude section, the honest answer is three, and the audit
  should record that rather than confirm one.
- **The corpus test parses `stdlib/` only.** `tests/typescriptGenerator/*.agency` is the corpus the
  fixture proof runs against and contains deliberately odd shapes; including it costs one line and makes
  the two proofs cover the same ground.

## Anti-pattern audit (`docs/dev/anti-patterns.md`)

**On the headline question: yes, this plan is the declarative-interface pattern, and it is the strongest
example of it I have reviewed in this stream of work.** The catalog's "imperative code everywhere" entry
asks for the "what" and the "how" to be split so future changes touch only the "what."
`expressionSlots(node) → [{ expr, mode, write }]` does exactly that: positions and timing become data,
the traversal becomes a loop, and a rewriter's policy stays in the rewriter. The plan even draws the
dividing line explicitly in the Background ("the table answers where the expressions are and when they
run; the pass keeps everything that is hoist POLICY") and holds it consistently through Task 3.

That is the same move that fixed the hoisting pass's own rulings tables, applied one level up. No
complaints about the core design.

Four smaller places where the plan slips back toward the catalog's warnings.

### A. Leaky abstraction: `perIteration` is a general mode with a whileLoop-specific handler

Task 3 Step 1 dispatches on mode:

```
mode "perIteration" → only whileLoop.condition today: run the existing while rewrite
```

But the mode table assigns `perIteration` to comprehension expressions and conditions as well. Those
never reach the pass (parse-time desugar), so nothing breaks today — but the abstraction now promises
"re-evaluated per pass, a rewriter must restructure" while the implementation means "do the `while (true)
{ temps; if (cond) { body } else { break } }` rewrite," which is valid for exactly one node kind. A
future construct that honestly carries a `perIteration` slot gets a while-shaped restructure applied to
it.

That is the catalog's leaky-abstraction shape: understanding what `perIteration` does requires reading
the one consumer that implements it. Two clean options — key the restructure on the statement kind and
treat `perIteration` as "this slot cannot hoist to before the owner" (a prohibition, which generalizes),
or throw on a `perIteration` slot the pass does not know how to restructure. The second is better: it
matches the loud-failure instinct the plan already shows in Task 3 Step 2.

### B. The expression/statement boundary is in neither table

Task 3 Step 2 notes: "The `bodySlots(node).length > 0` statement-list check stays (thread blocks in
expression position)." So after this refactor a consumer still has to consult *both* tables and know how
they interact, because a thread block in value position is simultaneously an expression and a statement
owner — and neither `ExpressionSlot` nor `BodySlot` says so.

The knowledge that makes this work correctly lives only in the pass, which is where it lived before. The
fix need not be large: an `ownsStatements?: true` marker on the relevant expression slots, or one
paragraph in both headers stating the interaction rule and pointing at each other. Right now the plan
leaves the seam undocumented in a change whose entire purpose is that these facts live in one place.

### C. Duplicating existing code — partly addressed, and one new ambiguity

Covered in the altitude section above: `walkNodes` and `getAllVariablesInBody` keep their own hand-written
expression descents, so the same facts still live in three places after this lands. Under the catalog's
first entry that is duplication, inherited rather than introduced, but the plan currently reads as though
it ends.

One genuinely new ambiguity: the file-structure table says `accessChainExpressions` "moves or is
re-exported." Those are different outcomes, and one of them (re-export while the slot table grows its own
chain handling) is how you end up with two chain walkers. Decide it in the plan: one implementation, one
home.

### D. A corpus test that tolerates skips can degrade to proving nothing

Task 1 Step 3: "parse every `.agency` file under `stdlib/` ... skip files that fail to parse with a
logged count — none should."

If none should, assert none do. A completeness proof with a tolerated-skip path can quietly shrink to
covering half the corpus after an unrelated parser change, and the count is printed into a test log
nobody reads. This is the catalog's "try-catch without logging anything" in spirit: the failure is
technically recorded and functionally invisible. Make an unparseable stdlib file fail the test.

### Not found

No dynamic imports, no maps or sets where objects and arrays serve, no magic numbers, no nested
ternaries, no order-dependent mutable state (the `write`-fold is copied from `bodySlots`, which
documents why it composes), and nothing destructive in the verification steps. The one adjacent risk —
that a fold over overlapping slots could drop writes — is worth stating as an explicit non-overlap
invariant in the header, and the round-trip test from issue 5 above would enforce it.

## What I checked

Read `expressionChildren`, `walkNodes`, and `getAllVariablesInBody` in `lib/utils/node.ts`; `bodySlots`;
both consumers (`flowBuilder.ts:97`, `scopes.ts:372`); the `isExpression` / `typeTestExpression` /
`schemaExpression` type definitions; `EXPRESSION_NODE_TYPES`; the current `hoistCalls.test.ts` test list
and `tests/agency/hoist/` contents on `origin/main`; and `gotoWithArgs.agency`. I did not create the
worktree or run any suite, and I did not verify the mode assignments row by row against the landed
rulings in `hoistCalls.ts` — the plan says the pass wins where they disagree, which is the right rule, but
that transcription still needs doing at implementation time.
