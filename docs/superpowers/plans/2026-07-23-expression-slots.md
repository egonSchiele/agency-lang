# Expression Slots — Implementation Plan (rev 2, review incorporated)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in the main session (this project does not use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One authoritative enumeration answers "where can expressions live inside each kind of node, and when do those positions execute" — the expression twin of `bodySlots` — with completeness enforced against `EXPRESSION_NODE_TYPES` rather than assumed, so the hoisting pass (and any future expression rewriter) cannot silently miss a position.

**Architecture:** A new `lib/utils/expressionSlots.ts` mirrors `lib/utils/bodySlots.ts`: per node kind, each expression position as `{ expr, mode, write }`, operator-keyed for binops, in evaluation order. `expressionChildren` becomes a derived view that preserves its historical child order (one documented shim). `hoistCalls` consumes the slots; unlisted node kinds fail loudly instead of falling into a silent generic walk. Behavior must come out identical — the frozen hoistCalls unit tests, a zero-diff fixture regeneration, and identical type-checker suite results are the proof, with each proof attributed to what it actually covers.

**Review incorporated:** `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-23-expression-slots-REVIEW.md` — the completeness check against `EXPRESSION_NODE_TYPES` replaces parity-as-coverage; the loud-throw-first migration replaces the unprovable fallback-deletion gate; the assignment order divergence is decided (historical order preserved via shim); the write-fold round-trip and mode-liveness invariants are added; the scope of which enumerations this consolidates is stated honestly.

**Tech Stack:** TypeScript compiler internals, vitest.

## Global Constraints

- NEVER commit on main. All work on branch `adit/expression-slots` in a worktree inside the agency-lang directory. Re-check `git branch --show-current` before every commit.
- Save every test run's output to a file.
- Do not run the full agency test suite locally; run only the tests named here. CI runs the rest.
- After compiler changes, `make` before any agency execution test (`pnpm run build` skips `lib/agents`).
- No dynamic imports; objects not maps; arrays not sets; types not interfaces. No narrating comments.
- Commit messages contain no apostrophes on the command line. Do not touch CHANGELOG.md.
- Paths relative to `packages/agency-lang/` unless absolute.

## Background: the problem, the fix, and the honest scope (read first)

The hoisting pass (`lib/preprocessors/hoistCalls.ts`, PR #655) rewrites helper calls into their own resume-safe statements. To do that it must know, for every kind of statement, where expressions live inside it. Today that knowledge is a hand-written `switch` in the pass — and hand-written position lists drift. Three holes were found in one week, each by a different accident: thread blocks in value position (caught by CI), `goto` arguments (caught in review), indexed-assignment targets (caught by a direct "did you get everything?" question). Every hole is a place where the resume bug the pass exists to fix silently survives.

`bodySlots.ts` is the proven pattern for the sibling question (which nodes contain *statements*): one enumeration, a writer per slot, every consumer picks up new node kinds automatically. This plan builds the expression twin, with one design addition — each slot carries *when it executes*, because that is what a rewriter keys safety on:

```agency
if (score(n) > 3) { }       // condition runs once        → hoist before the if
while (check(i) < 5) { }    // condition runs per pass    → needs the loop rewrite
a() && b()                  // right side might never run → must not hoist
try parse(fetch(url))       // inside the error net       → must not touch
```

**Scope, stated plainly (review: altitude).** `lib/utils/node.ts` contains not two but FOUR expression-position enumerations: `expressionChildren` (:51-126), the `walkNodes` generator's own descent (~:410-460, including the messageThread named-args block whose comment records its own drift scar), `getAllVariablesInBody` (~:340-380), and — outside node.ts — `hoistCalls`'s switch. This plan consolidates `expressionChildren` and `hoistCalls` onto the table; `walkNodes` and `getAllVariablesInBody` keep their own descents because both thread ancestor/scope state a plain slot list does not model, and putting that plumbing on the critical path would compromise the property this refactor depends on (provable behavior-identity). After this plan, a new node kind has TWO remaining places to register expression positions besides the table; the `expressionSlots.ts` header says so and names them, and migrating `walkNodes` is the recorded follow-up. What this plan does end: the possibility of `hoistCalls` and `expressionChildren` disagreeing, and the possibility of a node kind having NO registered expression positions without a test failing (Task 1's completeness check).

**The table/policy dividing line, held throughout:** the table answers "where are the expressions and when do they run"; the pass keeps everything that is hoist POLICY — which nodes become temps (calls and call-bearing chains), the statement-tail rule, the chain unit-hoist decision, the while restructure, per-frame temp counters. A future consumer with different policy reads the same table and applies its own rules.

**The expression/statement seam (review: anti-pattern B).** A thread block in value position is simultaneously an expression (it has a value) and a statement owner (its body). Neither table alone describes it; the interaction rule is: *when a consumer walks a slot's expression and that expression node has `bodySlots`, its statement bodies are reached through `bodySlots`, not through expression slots.* That rule is written in BOTH headers (`expressionSlots.ts` and `bodySlots.ts`), each pointing at the other, so the seam is documented where both halves live.

## Verified facts this plan builds on (re-verify any that look stale at Task 0)

- `EXPRESSION_NODE_TYPES` at `lib/types.ts:120-146` — the canonical expression-kind list the completeness check runs against. It includes `isExpression` (`pattern.ts:40-43`, `{ expression, pattern }`) and `typeTestExpression` (`pattern.ts:66-69`, `{ expression, typeHint }`), which NEITHER `expressionChildren` nor rev 1's mode table covered — the shared blind spot that motivated the completeness check.
- `expressionChildren` at `node.ts:51-126` (21 case labels), `accessChainExpressions` at :129-146. Consumers: `flowBuilder.ts:97` (order-sensitive — it builds a flow graph), `scopes.ts:372` (order-insensitive).
- `expressionChildren` returns assignment children as `[value, ...targetChain]` (node.ts:55-56) — the REVERSE of evaluation order. The hoisting side pins evaluation order (target temps before value temps) in a unit test on main. Both orders are load-bearing for different consumers; the plan resolves this with a shim, not a silent change (Task 2).
- `tests/typescriptGenerator/gotoWithArgs.agency` has only a literal argument — the fixture corpus does NOT exercise the motivating nested-call shapes, so the zero-diff proof does not cover them; the frozen unit tests do (proof attribution, Task 3).

## File structure

| File | Role |
|---|---|
| `lib/utils/expressionSlots.ts` | Create: `ExpressionSlot`, `EvalMode`, `expressionSlots(node)`, `NO_EXPRESSION_SLOTS`; chain handling implemented HERE, once |
| `lib/utils/expressionSlots.test.ts` | Create: unit tests, completeness check, corpus round-trip + parity |
| `lib/utils/node.ts` | Modify: `expressionChildren` derives from slots (with the assignment order shim); `accessChainExpressions` DELETED (its only caller was `expressionChildren`; one chain implementation, one home — review item C) |
| `lib/preprocessors/hoistCalls.ts` | Modify: dispatch + walker consume slots; rulings tables retired; unlisted kinds throw |
| `tests/typescriptGenerator/gotoWithArgs.agency` (+ regenerated `.mjs`) | Modify: nested call in the goto argument so the fixture corpus permanently covers the shape |
| `docs/dev/hoist-calls.md` | Modify: point rulings at the table |

---

### Task 0: Worktree, baseline, recounts

- [ ] **Step 1:**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
git worktree add worktree-expr-slots -b adit/expression-slots origin/main
cd worktree-expr-slots/packages/agency-lang
pnpm install
make > /tmp/exprslots-make.out 2>&1; tail -3 /tmp/exprslots-make.out
```

- [ ] **Step 2: Baseline the suites this refactor must not disturb, and record the real counts** (the contract is "all existing tests, unedited" — counts are recorded here only so a drop is noticed):

```bash
npx vitest run lib/preprocessors/hoistCalls.test.ts lib/typeChecker lib/utils > /tmp/exprslots-baseline.out 2>&1; grep -E "Test Files|Tests " /tmp/exprslots-baseline.out
ls tests/agency/hoist/*.agency | wc -l
```

All pass or stop and report.

---

### Task 1: `expressionSlots.ts` — enumeration, completeness, invariants

**Files:** create `lib/utils/expressionSlots.ts`, `lib/utils/expressionSlots.test.ts`.

**Interfaces:**

```ts
export type EvalMode = "once" | "perIteration" | "conditional" | "opaque";
// NOTE recorded in the type's doc comment: no consumer today branches on
// conditional-vs-opaque — both mean "skip" to rewriters and "include" to
// readers. The distinction is kept as documentation of WHY a position is
// untouchable; do not build logic on it without adding tests that
// distinguish them.

export type ExpressionSlot = {
  /** The expression at this position. A read view — never mutate. */
  expr: AgencyNode;
  mode: EvalMode;
  /** Fresh copy of `owner` with this slot's expression replaced. Takes
   *  the CURRENT owner so a fold over several slots composes. Slots
   *  never overlap (each targets a distinct field/index), which is what
   *  makes the fold safe — the corpus round-trip test enforces it. */
  write: (owner: AgencyNode, expr: AgencyNode) => AgencyNode;
};

/** Slots in EVALUATION order. */
export function expressionSlots(node: AgencyNode): ExpressionSlot[];

/** Expression node kinds that genuinely carry no expression children
 *  (literals, identifiers, ...). The completeness test requires every
 *  member of EXPRESSION_NODE_TYPES to appear either here or in the
 *  switch — an unlisted kind is a test failure, not a silent []. */
export const NO_EXPRESSION_SLOTS: Record<string, true>;
```

**Mode table** (transcribes the landed hoistCalls rulings; where table and pass disagree, the pass wins and the table is wrong):

| Node / position | Mode |
|---|---|
| `assignment` target chain (index/slice bounds), then `assignment.value` — in that order | once |
| `returnStatement.value`, `matchYield.value` | once |
| call/interrupt arguments (positional + `namedArgument.value`), `gotoStatement.nodeCall` arguments | once |
| `ifElse.condition` | once |
| `whileLoop.condition` | perIteration |
| `forLoop.iterable`, `matchBlock.expression` | once |
| `messageThread` `label`/`summarize`/`continueExpr`/`sessionExpr`/`hidden` | once |
| ordinary binops (`+`, `<`, `==`, …): both sides | once |
| `&&`/`\|\|`/`??`: left | once |
| `&&`/`\|\|`/`??`: right | conditional |
| `catch`: left | opaque |
| `catch`: right | conditional |
| `\|>`: left | once |
| `\|>`: right (stages) | opaque |
| `tryExpression.call` | opaque |
| `withModifier.statement`, `staticStatement.statement` | opaque |
| if-expression branches (value-position `thenBody[0]`/`elseBody[0]`) | conditional |
| `valueAccess.base`; chain index/slice bounds; chain methodCall arguments | once |
| array items, splat values, object entry values, string interpolation expressions | once |
| `comprehension.iterable` | once |
| `comprehension.expression`, `comprehension.condition` | perIteration |
| `newExpression` arguments | once |
| `isExpression.expression`, `typeTestExpression.expression` | once — with the recorded ruling: the parser rejects a call on the left of `is`, so calls are unreachable here today; the slots exist so the enumeration is complete and so the ruling is visible, not because hoisting has work to do (review issue 1/2 note) |

Everything else in `EXPRESSION_NODE_TYPES` goes in `NO_EXPRESSION_SLOTS` explicitly.

- [ ] **Step 1: Failing unit tests.** Per-family slot+write round trips (fresh owner, original untouched); operator table rows; `whileLoop.condition` perIteration vs `ifElse.condition` once; assignment slots in evaluation order (target chain before value); opaque slots still readable; `isExpression`/`typeTestExpression` present.

- [ ] **Step 2: The completeness test** (review issue 1 — this, not parity, is the coverage argument):

```ts
it("every EXPRESSION_NODE_TYPES member is enumerated or explicitly empty", () => {
  for (const kind of EXPRESSION_NODE_TYPES) {
    const enumerated = HANDLED_KINDS.includes(kind); // exported from expressionSlots.ts beside the switch
    const declaredEmpty = kind in NO_EXPRESSION_SLOTS;
    expect(enumerated || declaredEmpty, `unregistered expression kind: ${kind}`).toBe(true);
    expect(enumerated && declaredEmpty, `${kind} is both enumerated and declared empty`).toBe(false);
  }
});
```

Adding a member to `EXPRESSION_NODE_TYPES` without registering it here fails this test by name. (Statement kinds have no canonical list; their completeness is enforced operationally by Task 3's loud throw plus the corpus run.)

- [ ] **Step 3: Implement.** One switch, evaluation order, chain handling implemented here once (this is the single chain walker after `accessChainExpressions` is deleted in Task 2). Header: the bodySlots-style drift history; the mode definitions; the table/policy line; the expression/statement seam paragraph (cross-referencing `bodySlots.ts`, which gets the mirror paragraph in Task 2); the scope note naming `walkNodes` and `getAllVariablesInBody` as the enumerations NOT yet on this table.

- [ ] **Step 4: The corpus invariants** — parse the corpus and enforce three properties on every node:

Corpus = every `.agency` file under `stdlib/` AND `tests/typescriptGenerator/` (the fixture corpus has deliberately odd shapes; one extra glob makes the proofs cover the same ground). **A file that fails to parse FAILS the test** — a tolerated-skip path lets the corpus quietly shrink to nothing (review item D).

1. **Write-fold round trip** (catches every mis-wired `write` and enforces slot non-overlap):

```ts
const rebuilt = expressionSlots(node).reduce((owner, s) => s.write(owner, s.expr), node);
expect(rebuilt).toEqual(node);
```

2. **Mode liveness:** every `EvalMode` value occurs somewhere in the corpus run — a mode no node carries is dead or mis-assigned.
3. **Parity with `expressionChildren`** — kept for what it actually proves (the derived view will not regress the type checker), NOT as coverage. Compare with `toEqual` (order-sensitive) against the OLD function's output; the known divergences (assignment order; messageThread named args, which old `expressionChildren` lacks) are handled via an explicit, commented exceptions list in the test. Order-sensitivity forces the issue-3 question at implementation time instead of hiding it in set-equality.

- [ ] **Step 5: Run green, commit**

```bash
npx vitest run lib/utils/expressionSlots.test.ts > /tmp/exprslots-t1.out 2>&1; grep -E "Tests " /tmp/exprslots-t1.out
git add lib/utils/expressionSlots.ts lib/utils/expressionSlots.test.ts
git branch --show-current
git commit -m "utils: expressionSlots - expression positions with eval modes, completeness-checked against EXPRESSION_NODE_TYPES"
```

---

### Task 2: `expressionChildren` derives; the order divergence is explicit

**Files:** modify `lib/utils/node.ts` (and `bodySlots.ts` for the seam paragraph).

- [ ] **Step 1: Reimplement with the order shim (review issue 3 — decided here, not at the keyboard).** `expressionChildren` preserves its historical child order: derived from slots, with assignment's children reordered to the historical `[value, ...targetChain]`, and a comment stating the tension outright — flow analysis (`attachExpressionsToFlow`) consumes flow order, hoisting consumes evaluation order, both are load-bearing, and the shim is the explicit record that they differ for assignment. messageThread named args: include them in the derived view only if the type-checker suites stay identical (they were historically reached via `walkNodes`, not `expressionChildren`); if anything shifts, exclude them via the same shim and record it. Delete `accessChainExpressions` (only caller was `expressionChildren`).

- [ ] **Step 2: Verify consumers**

```bash
npx vitest run lib/typeChecker lib/utils > /tmp/exprslots-t2.out 2>&1; grep -E "Test Files|Tests " /tmp/exprslots-t2.out
```

Expected: identical results to the Task 0 baseline. Note the review's caveat: identical pass counts are necessary, not sufficient, for narrowing behavior — which is exactly why the shim preserves order instead of changing it and hoping.

- [ ] **Step 3: Add the seam paragraph to `bodySlots.ts`'s header** (mirror of the one in `expressionSlots.ts`), commit:

```bash
git add lib/utils/node.ts lib/utils/bodySlots.ts lib/utils/expressionSlots.test.ts
git branch --show-current
git commit -m "utils: expressionChildren derives from expressionSlots, historical assignment order preserved via explicit shim"
```

---

### Task 3: hoistCalls consumes the slots — loud throw first, then delete the fallback

**Files:** modify `lib/preprocessors/hoistCalls.ts`, `tests/typescriptGenerator/gotoWithArgs.agency`.

The existing hoistCalls unit tests are the contract and MUST NOT be edited to make this task pass; if one fails, the rewrite is wrong.

- [ ] **Step 1: The loud throw lands BEFORE the fallback dies (review issue 2 — this ordering turns an unprovable gate into a checklist).** Replace the walker's generic `Object.keys` descent with: consult `expressionSlots(node)`; if the node's kind is neither handled by the slot switch nor in `NO_EXPRESSION_SLOTS` (expose a helper `isRegisteredExpressionKind(type)` from expressionSlots.ts), **throw** `hoistCalls: unregistered expression kind "<type>" — register it in expressionSlots.ts`. Not dev-mode-only: the completeness test guarantees it never fires for known kinds, so in production it can only fire for a genuinely new, unregistered kind — exactly when loud is right.

- [ ] **Step 2: Smoke the throw against the world before trusting it:**

```bash
make > /tmp/exprslots-t3-make1.out 2>&1; echo "make: $?"          # compiles every stdlib + agent .agency through the pass
make fixtures > /tmp/exprslots-t3-fixgen.out 2>&1; echo "fixtures: $?"
```

Any throw here names a table gap — fix it in Task 1's table (with a test), never by widening the pass. This is the evidence the rev-1 plan's deletion gate claimed but could not produce.

- [ ] **Step 3: Rewrite the dispatch.** Statement kinds collapse to slot iteration:

- mode `once` → extract calls (statement-tail withheld where the slot IS the tail position), temps before the statement in slot order, write back.
- mode `perIteration` → the mode means "cannot hoist to before the owner", nothing more. The while restructure is keyed on the STATEMENT KIND (`whileLoop`), not on the mode; a perIteration slot on any other statement kind **throws** (`hoistCalls: no restructure strategy for perIteration slot on "<type>"`) rather than receiving a while-shaped rewrite it never asked for (review anti-pattern A — comprehension slots never reach the pass, so today this throw is dead by construction, and it stays honest if that ever changes).
- `conditional` / `opaque` → skip.
- Statement-body recursion via `bodySlots` exactly as today, including the seam rule (a slot expression that itself owns statements is recursed via bodySlots), the handler-body skip, and own-frame block scopes.

Policy that stays in the pass, with reasons in code: the tail rule, chain unit-hoisting, the while restructure, per-frame counters.

- [ ] **Step 4: The identity proofs, each attributed to what it covers (review issue 4):**

```bash
npx vitest run lib/preprocessors/hoistCalls.test.ts > /tmp/exprslots-t3a.out 2>&1; grep -E "Tests " /tmp/exprslots-t3a.out
npx vitest run lib > /tmp/exprslots-t3b.out 2>&1; grep -E "Test Files|Tests " /tmp/exprslots-t3b.out
make fixtures > /tmp/exprslots-t3-fixtures.out 2>&1
git status --short tests/typescriptGenerator tests/typescriptBuilder | wc -l   # expect 0 at this point
```

Attribution, recorded here so nobody over-credits either net: the **frozen unit tests** are the contract for the motivating shapes (goto args, thread named args, thread-in-value-position, assignment targets — all covered on main); the **zero-diff regeneration** is the corpus-wide net for everything else, bounded by what the corpus contains.

- [ ] **Step 5: Make the fixture corpus cover the motivating shape permanently** — the review's one-line payoff. Change `tests/typescriptGenerator/gotoWithArgs.agency`'s argument to a nested call (e.g. `goto greet(decorate("world"))`, adding a `decorate` def), regenerate THIS fixture via `make fixtures`, and eyeball the `.mjs` for the `__hoist_` temp before the goto. This commit is deliberately separate from Step 4's zero-diff check so the zero-diff claim stays clean.

- [ ] **Step 6: Execution spot-checks**

```bash
for d in resume-regression-args eval-order while-rewrite while-cond-pause loop-body-pause nested-arg-interrupt-double; do
  pnpm run agency test tests/agency/hoist/$d.agency > /tmp/exprslots-$d.out 2>&1; echo "$d: $(grep -o '[0-9]*/[0-9]* tests passed' /tmp/exprslots-$d.out)"
done
pnpm run agency test tests/agency/threads/messages.agency > /tmp/exprslots-threads.out 2>&1; grep -o "[0-9]*/[0-9]* tests passed" /tmp/exprslots-threads.out
```

- [ ] **Step 7: Commits** (pass rewrite, then the fixture-shape change with its regeneration):

```bash
git add lib/preprocessors/hoistCalls.ts
git branch --show-current
git commit -m "hoistCalls: consume expressionSlots; unregistered expression kinds throw; rulings tables retired"
git add tests/typescriptGenerator/gotoWithArgs.agency tests/typescriptGenerator/gotoWithArgs.mjs
git commit -m "fixtures: gotoWithArgs carries a nested call so the corpus covers the motivating shape"
```

---

### Task 4: Docs, audit, PR

- [ ] **Step 1: Docs.** `docs/dev/hoist-calls.md`: the rulings section points at `expressionSlots` for positions and modes; the pass's remaining policy listed. Confirm both headers carry the seam paragraph and the scope note (which enumerations are on the table, which are not, and that `walkNodes` migration is the follow-up).

- [ ] **Step 2: Honest repo-wide audit (review: the grep was too weak).** Record in the PR body the answer to "how many places enumerate expression positions after this change": the table, `walkNodes`, `getAllVariablesInBody` — three, down from four, with the remaining two named in the header and the follow-up recorded. Then the anti-pattern sweep of the diff itself.

- [ ] **Step 3: Full suite, lint, PR**

```bash
npx vitest run lib > /tmp/exprslots-final.out 2>&1; grep -E "Test Files|Tests " /tmp/exprslots-final.out
pnpm run lint:structure > /tmp/exprslots-lint.out 2>&1; echo "lint: $?"
git add docs/dev/hoist-calls.md
git branch --show-current
git commit -m "docs: expressionSlots is the source of truth for hoist positions and modes"
git push -u origin adit/expression-slots
```

PR body (`/tmp/exprslots-pr.md` → `gh pr create --title "expressionSlots: one completeness-checked enumeration of expression positions" --body-file /tmp/exprslots-pr.md`): the drift story; the bodySlots precedent; the mode design with the conditional/opaque documentation note; the completeness check vs parity attribution; the loud-throw migration; the assignment-order shim and why both orders are load-bearing; the honest three-enumerations count and the walkNodes follow-up. Ends with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-review notes

- **Every review item has a home:** altitude → Background scope paragraph + header notes + Task 4 Step 2's honest count; issue 1 → Task 1 Step 2 completeness test + the isExpression/typeTestExpression rows with the parser-fact ruling; issue 2 → Task 3 Steps 1-2 (throw first, smoke the world, then the fallback is gone by construction — there is no deletion step left to gate); issue 3 → Task 2 Step 1 shim + order-sensitive parity in Task 1 Step 4; issue 4 → Task 3 Step 4 attribution + Step 5 fixture change; issue 5 → Task 1 Step 4 write-fold + mode liveness; smaller notes → counts replaced by "all existing tests, unedited" with a Task 0 recount, conditional/opaque non-branching note in the type doc, comprehension row split into two clean rows, corpus includes typescriptGenerator, corpus skip-tolerance removed (parse failure fails the test); anti-pattern A → perIteration as prohibition + statement-kind-keyed restructure + throw; B → seam paragraph in both headers; C → `accessChainExpressions` deleted, chain handling has one home; D → covered with issue 1's corpus rule.
- **The proofs and what each covers:** completeness test → no unregistered expression kind, ever; write-fold → no mis-wired writer, no overlapping slots; frozen unit tests → the motivating shapes; zero-diff fixtures → corpus-wide identity (now including one motivating shape via Step 5); type-checker suites vs baseline → the derived view; the loud throw → future kinds fail by name at compile time instead of silently keeping the resume bug.
- **Judgment calls with their decision procedure written down:** messageThread named args in the derived view (Task 2 Step 1 — suites decide, shim records), and any corpus mismatch ruling (Task 1 Step 4's commented exceptions list).
