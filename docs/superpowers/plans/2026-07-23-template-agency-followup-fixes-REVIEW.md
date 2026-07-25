# Review: Template Agency Follow-up Fixes plan

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-23-template-agency-followup-fixes.md`.

Overall: the plan is aimed at the right three things and the background section is honest about why each one matters. Task 2 is the strongest of the three — the design notes about the `__destructured` sentinel and shorthand expansion are exactly the two things an implementer would otherwise get wrong. Task 3 is well-scoped but has two factual errors that will stop an implementer cold. Task 1 is the riskiest: its cost and noise are underestimated, and its central invariant is weaker than the plan claims.

Findings are ordered by how much damage they do if left as written.

---

## Blockers — the plan says something that is not true of the code

### 1. Task 3 Step 7: `loadTemplateFromString` is not an Agency-side export

The execution fixture imports `loadTemplateFromString` from `std::agency`. That name does not exist there. The exports in `stdlib/agency.agency` are `loadTemplate(dir, filename)` (line 496), `parseExpr` (538), `parseStatements` (547), `fill` (519), `holesOf` (510), `toSource` (529). `_loadTemplateFromString` exists only as a TypeScript helper (`lib/stdlib/template.ts:42`) and is not surfaced to Agency.

The plan says "verify this name," which reads as a small check; it is actually a rewrite of the fixture. The fixture has to follow `tests/agency/templates/composeGuarded.agency`: sibling `.agency` template files loaded with `loadTemplate(__dirname, "…")`. While you are there, that fixture also uses `isFailure(x)` rather than the `x is failure(e)` spelling in the plan's snippet — match the existing file.

Suggested replacement shape (two new sibling files: an inner template holding `const x: number = #minutes`, and an outer holding `#helpers`):

```
import { loadTemplate, fill, holesOf } from "std::agency"

node main(): string {
  const inner = loadTemplate(__dirname, "holesOfOriginInner.agency")
  if (isFailure(inner)) { return "inner load failed" }
  const outer = loadTemplate(__dirname, "holesOfOriginOuter.agency")
  if (isFailure(outer)) { return "outer load failed" }
  const program = fill(outer.value, { helpers: inner.value })
  if (isFailure(program)) { return "fill failed" }
  const holes = holesOf(program.value)
  ...
}
```

### 2. Task 3 Step 1, first test: the type error it asserts will never fire

The test builds a guard template with a bare `#minutes` in a named-argument position, then expects `fill(program, { minutes: "two" })` to throw the expects-`number` error. It will not throw at all.

`fillOne` computes the expected type from `hole.typeAnnotation` first, falling back to `expected[hole.name]` (`lib/runtime/template/fill.ts:130-140`), and `expected` comes from `positionInferredTypes`, which only infers from an **annotated assignment** parent (`lib/utils/holes.ts:54-69`). A named argument supplies nothing. With no expected type, `assertFillerType` is never called and the fill succeeds silently.

Fix: annotate the hole — `guard(time: #minutes: number)` if that parses, otherwise put the hole in an annotated assignment inside the guard template body. Inline hole annotations are real (`#count: number`, `docs/site/guide/templates.md:61,65`), so the annotated form is the cheap fix. Worth verifying with `pnpm run ast` before writing the test, since the named-argument-plus-annotation spelling is unusual.

The same check applies to the third test in that block and to the `holesOf` test — those two do use an annotated assignment, so they are fine.

### 3. `docs/dev/template-agency.md` does not exist

Tasks 2 and 3 both list it as a file to modify, and Task 3 Step 8 tells the implementer to find "the origin-attribution section" in it. There is no such file under `docs/dev/` — nothing template-related is there. Either the dev doc was never written (in which case say so and decide whether this plan creates it) or it lives somewhere else and the path is wrong. As written, an implementer will either waste time hunting or invent a file the plan never designed.

The user-facing doc reference is correct: `docs/site/guide/templates.md:150` is exactly the destructuring-limit paragraph Task 2 removes.

---

## Substantive design concerns

### 4. Task 1 invariant A is weaker than the plan claims, and the plan should say so plainly

Invariant A checks slot exprs of nodes **already walked**. If `walkNodes` never yields a node at all, none of that node's slots are checked. So invariant A cannot catch the failure mode it is described as catching in the general case — it catches it only when the parent was reached by some other path. The plan half-acknowledges this by leaning on invariant B, but the prose ("catches a missing descent case for a registered position") oversells it. Say directly: invariant A is a consistency check between two tables that both start from a walked node; invariant B is the one doing the real reachability work.

### 5. Task 1's exclusion list keys on bare field names, which is global across all node kinds

`WALKER_EXCLUDED_FIELDS` keys on `pattern` and `itemVar` as plain strings. `pattern` is a field on `assignment` (`lib/types.ts:245`) but also on `isExpression` and `typePattern` (`lib/types/pattern.ts:41,57`). One exclusion silently covers all of them, forever. The list is described as "recorded rulings," and a ruling that applies to node kinds nobody considered is not a ruling.

Key exclusions by owner type and field — `"assignment.pattern"`, `"forLoop.itemVar"` — and have `structuralNodes` pass the owner's `type` down. Small change, and it keeps the honesty the plan is going for.

### 6. Task 1 parses the corpus about seven times

`corpusPrograms` is called once per mode inside the describe loop (2), again twice inside the liveness test (2), and `corpusNodes()` parses again (1) — plus the file already asserts >50 corpus files. The existing suite parsed it once. Memoize per mode (`const cache: Record<string, …>` keyed on `lower`) and have `corpusNodes()` reuse the lowered programs. Otherwise this test file becomes one of the slowest in the repo for no benefit.

Also verify early that `parseAgency(src, {}, true, false)` — template applied, lowering off — actually succeeds across the whole corpus. The only in-repo caller of `lower: false` uses `applyTemplate: false` too (`lib/stdlib/agency.ts:195`). If the unlowered corpus parse throws on some stdlib file, half of Task 1 evaporates and the implementer should learn that in ten minutes, not after writing four tests. Make that a Step 1 smoke check.

### 7. Task 1 Step 4 rule 2 (walking parameter defaults) is a compiler change hiding inside a test task

The plan's own known candidate — descending into `functionParameter.defaultValue` — is not a test change. `walkNodes` is what the symbol-table resolver rides on to populate `scope` on variable references (`lib/utils/node.ts:380-388` explains exactly this for `messageThread`). Adding a descent means default-value expressions start getting scope-resolved and may start emitting `__stack.locals.foo` where they previously emitted bare identifiers. That could be a fix or a regression, and "the full unit suite is the referee" is a thin guardrail for a codegen change.

Recommend: make the walker change its own commit, and state in the plan that if it lands, the PR description must call out the codegen surface it touches. If the suite is ambiguous, taking rule 3 (record the exclusion, file an issue) is the right call — the plan already allows this, but it should say that rule 3 is the *preferred* outcome for parameter defaults, not the fallback.

### 8. Task 2 leaves three binder families in the same failure class it is fixing

`bindersOfNode` after this change still handles only `assignment`, `function`/`graphNode` parameters, and `forLoop`. Names bound by these are still invisible to hygiene:

- **Comprehension binders.** `comprehension` survives `lower: false`, and `walkNodes` deliberately does not descend into the binder (`lib/utils/node.ts:361-374`). A template comprehension binding `x` is not in `bindersByScope`, so a filler that uses `x` triggers no case-1 rename — capture, the exact bug Task 2 is fixing, one node kind over.
- **Result-pattern bindings.** `is success(v)` binds `v` (`lib/types/pattern.ts:45-49`).
- **Match-arm pattern binders.** `matchBlock` case values are walked as expressions, but their binding names are not collected as binders.

These do not have to be in scope. But the plan removes the "destructuring binders are not tracked" line from the guide (`templates.md:150`) and replaces it with a claim that pattern binders are tracked — which will be read as "hygiene sees all binders." Either extend `patternBinders` usage to the comprehension and result-pattern cases, or keep a narrower honest sentence in the guide and record the remainder as known limits. Silently narrowing a documented limitation is worse than the limitation.

### 9. Task 3: nested composition attributes to the outermost graft only

`stampOrigin` unconditionally overwrites `loc.origin` on every node it touches (`lib/runtime/template/fill.ts:275-293`). Compose three levels deep and the innermost fragment's origin is rewritten to the outermost hole name at each graft. The plan's two-level worked example is correct; a three-level one is not, and a model composing templates is precisely the caller who would hit it.

This is probably the right trade-off (the outermost graft is the one the current caller can act on), but it is a design decision the plan should state, and the docs sentence in Step 8 should say "the hole it most recently arrived through," not something that implies a full chain.

### 10. Task 3: nodes without a `loc` get no origin at all

`stampOrigin` stamps only nodes that already carry a `loc` (line 287). `nodesFor` backfills a loc on the **top** node of each graft (line 171), but not on inner ones. If a grafted fragment contains a loc-less hole node, `HoleInfo.origin` comes back `null` and the fill-path error gets no suffix — a quiet hole in the feature, not a crash. Add one sentence to the plan acknowledging it, and have the `holesOf` docstring say origin is best-effort rather than guaranteed.

---

## Smaller corrections

- **Task 2 Step 4, `expandShorthand` copies `source.loc`, which does not exist.** `ObjectPatternShorthand` is not a `BaseNode` (`lib/types/pattern.ts:13-16`) — it has only `type` and `name`. Neither is `ObjectPatternProperty` (line 5). So the constructed node gets `loc: undefined` on two fields that the types do not declare. Harmless at runtime, but drop the `loc` keys rather than writing undefined ones.

- **Task 2 Step 4's generator check is already answered.** `formatObjectPattern` prints `key: value` whenever the value's name differs from the key, and collapses back to shorthand when they match (`lib/backends/agencyGenerator.ts:901-916`). So `{ key: __hyg1_key }` prints exactly as the tests expect, and an un-renamed expansion would print back as `{ key }`. Replace the "confirm the printer handles this" instruction with this fact — it removes an unknown from the self-review list.

- **Task 3 Step 3's message-text change is safe.** Nothing in the repo asserts the current `(in the fill for \`#name\`)` tail — the string appears only at `lib/runtime/template/fill.ts:195`. The plan hedges ("update any test asserting the old exact text"); you can state it is unreferenced.

- **`patternBinders`'s signature vs. reality.** `ObjectPatternProperty.value` is `BindingPattern | Literal | ResultPattern` and `ArrayPattern.elements` also admits `Literal | WildcardPattern | ResultPattern` (`lib/types/pattern.ts:10,27`). The plan's `isBindingPattern` guard handles this correctly. Worth noting in the code comment that dropping `resultPattern` here loses a binder (`is success(v)`) — which ties back to finding 8.

- **Task 2's `directBinders` edit is correct and easy to miss.** Confirmed `directBinders` reads `stmt.variableName` today (`lib/runtime/template/hygiene.ts:340-347`) and would report the `__destructured` sentinel as a shadowing name. Good catch by the plan; keep it prominent, because the shadowing test in Step 1 is the only thing that covers it.

- **The `Set` deviation is justified.** Membership by object identity over per-file node counts; `includes` would be quadratic. The plan already flags it for the PR description. No change needed.

---

## What I would change before executing

1. Fix findings 1–3 in the plan text — they are the ones that will strand an implementer.
2. Add the early smoke check for the unlowered corpus parse (finding 6), since it gates half of Task 1.
3. Decide finding 8 explicitly: either widen Task 2 to comprehension and result-pattern binders, or narrow the doc rewrite. Do not leave it to the implementer.
4. Reword the Task 1 invariant-A claim (finding 4) and re-key the exclusion list (finding 5).

Everything else can be handled inline during execution.
