# Review: Recursive Type Aliases Fix Plan (#470 + #473)

Reviewed against the code at main (12213f22). Every claim below was checked by reading the
named file, not from memory.

## Verdict

The architecture is right: coinductive pair stack for `isAssignable`, `z.lazy` for
not-yet-emitted consts, one canonical `typeKey`. All three mirror idioms the codebase
already owns (`resolveTypeWithGuard`'s `inProgress` set, per-module builder state). The
plan's "verified facts" all check out — I re-verified each one (details at the bottom).

But there are two must-fix correctness gaps, one plan-code bug that won't compile as
written, and a test that doesn't pin the behavior it claims to pin. Fix these before
executing.

---

## Must fix

### 1. Task 3 does not cover the validation-descriptor path — validated recursive/forward aliases stay broken

Task 3 threads `pendingAliases` only through `zodSchemaFor` → `mapTypeToValidationSchema`.
But a validated alias (`@validate` anywhere in its body) emits a SECOND module-load-time
structure: `(Alias as any).__agency_descriptor = <descriptor>` (`typescriptBuilder.ts:802-807`),
and the descriptor builder has two eager reference sites of its own:

- `validationDescriptor.ts:296-302` — a nested alias ref with validators emits
  `(Alias as any).__agency_descriptor`, read eagerly at module load. For a forward ref
  this is a TDZ crash the z.lazy fix does not touch. For a SELF-ref it does not crash
  (the const is initialized one statement earlier) but reads `undefined` — the nested
  validation silently disappears. Silent validator loss is worse than the crash.
- `validationDescriptor.ts:173-179` (`schemaNode`) — descriptors embed schema strings via
  a direct `mapTypeToValidationSchema` call that Task 3's threading never reaches, so
  bare forward alias names still appear inside descriptors at module load.

So after Task 3 ships, `type Tree = { @validate(positive) value: number, children: Tree[] }`
either crashes at load (forward/mutual case) or silently drops nested validation
(self-recursive case). The plan's Task 3 tests only use unvalidated aliases, so nothing
catches this.

Options, in order of preference:
1. Make the descriptor references lazy too (a thunk or getter for the
   `__agency_descriptor` read, and thread `pendingAliases` into `schemaNode`). Check what
   the runtime walker in `validateChain.ts` needs before choosing the shape.
2. If that grows too large, detect a validated alias whose body reaches a pending alias
   and fail compilation with a clear "validated recursive aliases are not yet supported"
   error, plus a pinning test and a named follow-up issue.

Either way, add a validated-recursive-alias case to the Task 3 test matrix. Validation is
a safety surface in this codebase; shipping it silently broken is not acceptable.

### 2. `canonical()` ignores `valueArgs` — distinct instantiations of a value-param alias key equal

`TypeAliasVariable.valueArgs` and `GenericType.valueArgs` (`lib/types/typeHints.ts:254,49`)
never appear in the canonical string. And value-arg substitution only rewrites *tags*
(`applyValueArgs` per `assignability.ts:78-80`), which `canonical()` strips. Net effect:

- `typeKey(Age(18)) === typeKey(Age(21))`, nested or top-level.
- At dedup sites, `NumberInRange(0, 10) | NumberInRange(0, 100)` collapses to one member,
  dropping whichever validation range loses.
- As a coinduction pair key, two genuinely different pairs share a key, so the guard can
  return a premature `true` for a pair that was never actually in flight.

Fix: include `valueArgs` in the canonical form (e.g. via `tagArgToTs`, which already
stringifies the tag-argument expression subset; do not `JSON.stringify` the expression
node — it carries `loc`). Also state explicitly in the typeKey doc comment that stripping
`tags` is a deliberate identity decision and why it is safe at the flow/synth dedup sites
(they feed diagnostics, not codegen schemas) — today the plan strips them without arguing
it.

### 3. Plan's `widenAtLoopBackEdge` replacement doesn't type-check — `before`/`after` are `ScopeType`, which includes `"any"`

`typeAt` returns `ScopeType` (`VariableType | "any"`), and `widenAtLoopBackEdge`
(`flow.ts:328`) compares `before`/`after` where either can be `"any"`. The plan's
replacement `typeKey(before, env.typeAliases) === typeKey(after, env.typeAliases)` passes
`"any"` into a `VariableType`-typed parameter — tsc rejects it, and if forced through,
`canonical("any")` falls off the switch and returns `undefined` (accidentally "working"
via `undefined === undefined`). Short-circuit first:

```ts
const unchanged =
  before === "any" || after === "any"
    ? before === after
    : typeKey(before, env.typeAliases) === typeKey(after, env.typeAliases);
```

Also give `canonical()` a `never`-typed default branch (the file-level convention per
`typeHints.ts:8-13` is exhaustive switches enforced by a never default) rather than
relying on the plan's "if tsc reports a missed variant" note — without a default branch
tsc reports nothing; it just returns `undefined`.

### 4. Task 2 test 4 does not pin removal-on-exit

The "sibling repeats" test passes two bad arguments to `two(a, b)`. But each argument
check is a separate top-level `isAssignable` call, and each call creates a fresh
`Set` (the default parameter). A buggy implementation that never removes pairs still
passes this test — the stale entry dies with the set at call exit.

To pin removal you need the stale `true` to flip an outcome *within one comparison tree*.
Union member order does it:

```
type Tree = { value: number, children: Tree[] }
type NamedTree = { name: string, children: NamedTree[] }
type Target = {
  a: NamedTree | Tree,   // checks Tree~>NamedTree (false, pair added+removed), then Tree~>Tree (true)
  b: NamedTree,          // re-checks Tree~>NamedTree — a leaked entry makes this wrongly true
}
```

Pass `{ a: t, b: t }` where `t: Tree`. Correct implementation rejects (prop `b` fails);
a no-removal memo accepts. Assert the error is reported. Keep the existing test too if
you like, but don't label it as the removal pin.

---

## Should fix

### 5. `pendingAliasNames()` over-includes imported aliases — guaranteed fixture churn, contradicting Step 6's zero-churn gate

`visibleTypeAliasesFull()` returns the compilation unit's visible registry
(`scopeManager.ts:106-108`), which includes imported aliases — that is how cross-module
alias refs resolve. Imported aliases are never pushed onto `emittedAliasNames` (their
consts live in another module), so every imported alias ref classifies as pending and
gets wrapped in `z.lazy`. Harmless at runtime (imports initialize first), but every
cross-module-alias fixture churns, and Step 6's own instruction then says "stop and fix."

Compute pending from aliases *declared in the current module* (walk the program's
`typeAlias` nodes) minus emitted, not from the visible registry. The plan already
gestures at this fallback in the Step 4 NOTE — make it the primary design, not the
fallback.

Related lifecycle points to make explicit in Task 3:
- Builder is per-module (`typescriptGenerator.ts:77`), so the instance field is fine.
- Only the module-level emission path should push onto `emittedAliasNames`.
  `processTypeAlias` is also called from `hoistBodyTypeAliases` (`typescriptBuilder.ts:686-697`)
  for function-body aliases, whose consts initialize at function-call time, not module
  load. A body alias sharing a name with a later module-level alias would otherwise mark
  the module alias "emitted" early → bare name → real TDZ. Obscure, but it is exactly the
  under-inclusion direction the plan itself calls unsafe.
- Generic and value-param aliases return early from `processTypeAlias` (stub / factory /
  nothing) and never reach the const path. Refs to them are inlined or emitted as factory
  *calls* (function declarations hoist, so no TDZ). Fine — but say so, since they will sit
  in the pending set forever.

### 6. Two `JSON.stringify` dedup sites are missing from Task 1

The plan claims typeKey is "THE replacement for raw JSON.stringify at the dedup sites"
and #473 presumably wants all of them. Two are not in the task list:

- `lib/typeChecker/inference.ts:162` — `unionTypes()`. Harder: its signature has no alias
  table, so migrating ripples to callers. If you scope it out, say so in the PR and note
  it on #473 rather than letting "the dedup sites" overclaim.
- `lib/typeChecker/synthesizer.ts:1215` — block return-type dedup. Same shape as the
  three sites the plan does migrate; `ctx` is in scope there. Just add it.

### 7. Module-load tool definitions can still TDZ on def-before-type — verify and scope

Function/tool registrations emit at module load with eager schemas
(`toolDefinition: { ..., schema: z.object(...) }` — see
`tests/typescriptGenerator/asyncAssigned.mjs:322-325`), and the shared mapper emits bare
alias names (`typeToZodSchema.ts:226`). So `def f(x: Tree)` written *before*
`type Tree = ...` should crash at load today, and Task 3 does not touch this path.

This may be acceptable scope (the PR fixes alias-to-alias references), but the PR title
says "forward-referencing type aliases work," and a user will read that as covering
def-before-type. Probe it (two-line .agency file). If it crashes: either thread pending
through this path too, or state the limitation in the docs paragraph and file a follow-up.
Don't leave it undiscovered until a bug report.

---

## Minor

- **zod version confirmed**: `package.json` has `zod: ^4.3.5`, so Task 4's probe should go
  straight to `z.toJSONSchema` (zod 4 handles cycles with `$ref` by default via the `cycles`
  option; the throwing branch is unlikely but the plan's two-branch handling is fine).
- **`z.infer` circularity (Task 3 Step 5)**: generated output keeps TS annotations but runs
  as `.mjs` (see `asyncAssigned.mjs:330` — `__state: GraphState` in a .mjs file), i.e. it is
  transpiled, not type-checked. `type Tree = z.infer<typeof Tree>` degrading is therefore
  likely invisible at runtime. The plan's "observe and decide" hedge is fine; this note
  just predicts the observation.
- **`uniteTypes` param rename**: switching to `typeKey(t, _aliases)` makes `_aliases` used;
  rename to `aliases` (the underscore convention marks it unused today).
- **`canonical()` silently ignores `blockType.raises` and `ObjectProperty.description`**.
  `raises` is fine (compatibility unchecked today, per the field's own doc comment) and
  description-stripping means union dedup keeps the first member's description — both are
  reasonable, but list them in the doc comment as deliberate, next to `tags`.
- **Recursive value-param alias = compile-time infinite loop**: `mapTypeToSchemaInner`
  inlines value-param instantiations by recursion (`typeToZodSchema.ts:208-225`) with no
  `seen` guard. `type Weird(n: number) = { next: Weird(n) }` would hang codegen. Out of
  scope, but a one-line mention in the PR (or a follow-up issue) beats rediscovering it.
- **Task 2 Step 5 perf gate is sound** — worth one comment in the code when you add it:
  internal recursive calls pass *resolved* nodes, but any cycle must pass through a named
  reference (`typeAliasVariable`/`genericType`), so gating the pair-key on named nodes
  cannot miss a cycle.

---

## Verified facts — re-checked, all hold

- `isAssignable` at `assignability.ts:363`, signature `(source, target, typeAliases)`, the
  `"any"` sentinel check first, fresh `safeResolveType` per call; internal recursive call
  sites at lines 419–698, count ≈ 17. ✓
- `safeResolveType` → `resolveTypeWithGuard` resolves only the top-level alias chain
  (non-alias nodes return at `assignability.ts:150` without descending), so typeKey on an
  alias is cheap and inner refs stay nominal. ✓
- `deepResolveNode` (`assignability.ts:245-261`) leaves non-generic alias refs intact —
  the codegen bug is purely const ordering. ✓
- Alias consts emit at `typescriptBuilder.ts:782` in source order; bare-name emission at
  `typeToZodSchema.ts:226`. ✓
- `uniteTypes` has an unused `_aliases` param and the exact KNOWN-LIMITATION comment the
  plan says to delete (`flow.ts:128-143`); `widenAtLoopBackEdge` stringify-compare at
  `flow.ts:328`; synthesizer sites at 460/462, 639, 711; `ctx.getTypeAliases()` exists. ✓
- `typecheckSource` exists in `lib/typeChecker/testUtils.ts:20`. ✓
- The Task 3 agency test mirrors `tests/agency/utility-partial.agency` exactly (same
  `isSuccess(r)` + `r.value` narrowing pattern, same test.json shape and output
  serialization), so the syntax and harness expectations are right. ✓
- Builder is instantiated per module, so per-instance emitted-alias state is safe. ✓
- The canonical() switch covers all 13 `VariableType` variants. ✓

## Suggested execution order change

None structurally — the task order is right (typeKey → coinduction → codegen). Fold
must-fix items 2–4 into Tasks 1–2 before starting, and decide item 1's option (lazy
descriptors vs. clear error) before Task 3, since it changes Task 3's file list.

---

## Anti-pattern audit (docs/dev/anti-patterns.md)

Checked every code block the plan proposes against the catalog. Overall: Tasks 1 and 2
genuinely encapsulate imperative complexity behind declarative interfaces. Task 3 is the
exception — its emitted-alias tracking is the catalog's "order-dependent mutable state"
anti-pattern, and it has a cleaner stateless formulation.

### Where the plan does it right

- **`typeKey` (Task 1)** is the catalog's good pattern in its purest form: callers state
  *what* they want ("the canonical identity of this type") and the recursive `canonical()`
  walk is the hidden *how*. It also fixes an existing duplication (five hand-rolled
  `JSON.stringify` idioms collapse into one function), which is the catalog's first entry.
- **Coinduction (Task 2)** mirrors the file's own established encapsulation
  (`resolveType` public / `resolveTypeWithGuard` private with an explicit `inProgress`
  set). Consistency with the existing pattern is itself a catalog requirement.
- **`z.lazy` choice (Task 3)** is declarative at the emission site: "this reference is
  pending, so defer it" — no reordering pass, no SCC computation. The right altitude.

### Findings

**A. (Real hit) Task 3's `emittedAliasNames` is order-dependent mutable state.**
The catalog's third entry, exactly: a private mutable field that is correct only if
every emission site remembers to push after emitting, and `pendingAliasNames()` silently
returns wrong answers if any call is reordered, skipped, or added on a new emission path
(the hoisted-body-alias path in must-fix item 5 is precisely such a silent break, already
latent in the plan). The catalog's only exemption is parsers.

The state is unnecessary. Module-level alias consts emit in source order, so "pending at
the time alias #i emits" is a pure function of the program: collect the module's
`typeAlias` declarations once, in order; when emitting the alias at index `i`, the pending
set is `names[i..end]` (self included). No field, no push-after-emit invariant, nothing to
keep in sync — and it fixes the imported-alias over-inclusion (item 5) for free, since the
list is built from declarations, not scope visibility. Recommend replacing the
`emittedAliasNames` field + `pendingAliasNames()` helper with this derived computation.

(An even simpler stateless design — always emit `z.lazy` for any same-module alias
reference — was presumably rejected for fixture churn. That trade is defensible, but the
plan should say so; the zero-churn constraint is what bought this machinery.)

**B. (Mild leak) The coinduction set appears on the exported `isAssignable` signature.**
`inProgress?: Set<string>` on the public function is an internal detail leaking into the
interface — the "leaky abstraction" entry, in miniature. The file's own precedent avoids
it: `resolveType(vt, aliases)` stays two-arg and the guarded recursion lives in a private
helper. Same shape works here:

```ts
export function isAssignable(source, target, typeAliases): boolean {
  return isAssignableGuarded(source, target, typeAliases, new Set());
}
function isAssignableGuarded(source, target, typeAliases, inProgress): boolean {
  // "any" check, pair-key guard, try/finally, then the existing body;
  // all ~17 internal recursive sites call isAssignableGuarded.
}
```

Public API unchanged (three args, no optional tail), guard still applied at every
recursion level, and it matches `resolveTypeWithGuard` exactly instead of half-matching.

**C. (Catalog hit) Nested ternary in `canonical()`'s sort comparator.**
`.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))` is the "nested ternaries"
entry verbatim. Simplest fix is also more internally consistent: render each property to
its string first, then `.sort()` the strings — which is exactly what the plan's own
`unionType` case does one line below. Two cases, one pattern.

**D. (Watch, not fix) Parameter threading in the zod mapper is nearing sprawl.**
`mapTypeToSchemaInner` grows to six positional parameters, three of them optional
(`resultHandler`, `typeAliasesFull`, `optionalKeyMode`, now `pendingAliases`). The plan
correctly mirrors the existing `optionalKeyMode` threading (consistency beats a drive-by
refactor), so this is not a blocker — but it is the trajectory toward the "leaky
abstraction" entry, where every new emission concern touches four signatures. Worth one
line in the PR noting that the next parameter should trigger consolidating these into an
options/context object.

**E. (Checked, clean) The rest of the catalog.**
No silent catch blocks (Task 2 uses try/finally, no catch). No dynamic imports (the plan
explicitly designs around the cycle instead). No magic numbers, no nested type-definition
objects, no `...(x ? { x } : {})`. Guard-clause one-line ifs in the plan's snippets match
the pervasive style of the exact file being edited (`assignability.ts:51,63,71,...`), so
matching them is consistency, not a violation. Single-letter `t` for types likewise
matches the file's own convention. The `Set` for `inProgress` is the plan's explicitly
justified exception (mirrors `resolveTypeWithGuard`); if finding A is adopted, the
`pendingAliases` set becomes a small derived value and can be an array lookup per the
objects-not-maps/arrays-not-sets rule, or keep `Set` for the O(1) `has` — either is
defensible, just pick consciously.

---

## Test-plan review

Question asked of every test: if the code it guards breaks or gets reverted, does this
test go red? Findings below; the reversion matrix at the end summarizes.

### What the plan gets right

- **Every task has an explicit red step with a named failure mode** (module-not-found,
  `RangeError`, `ReferenceError`) — the tests are proven to detect the bug before the fix
  exists. This is the strongest part of the test plan.
- **Task 2 test 3 (incompatible recursive types still REJECT)** is the essential
  anti-vacuity test: a coinduction guard that returns `true` too eagerly fails it. Present
  and correctly constructed. (Note it differs at recursion level 1 — `name` vs `value` —
  which is sufficient for the mechanism, since any structural difference is reachable at
  finite depth.)
- **Task 3's `rejects` node validates at nesting depth 2**, proving the lazy schema
  actually validates recursively instead of degrading to `z.any()`. Without this test,
  `z.lazy(() => z.any())`-style bugs would pass `accepts` and ship.
- **Step 6's zero-churn gate** (`git status --short tests/`) turns the entire existing
  fixture corpus into a regression net for over-wrapping. Cheap and effective.
- Plan test code compiles as written: `Tag` needs only `type`/`name`/`arguments` (`loc`
  is optional on `BaseNode`), `TypeAliasEntry` accepts `{ body }`, `typecheckSource`
  errors carry `.message`.

### Tests that do NOT test what they claim

**T1. Task 2 test 4 ("sibling repeats") cannot fail on the bug it names.** Covered as
must-fix item 4 above: each argument check is a separate top-level `isAssignable` call
with a fresh `Set`, so a leaked (never-removed) entry dies with the set before the
sibling runs. A memoizing implementation — the exact bug the try/finally exists to
prevent — passes this test. Replace with the single-comparison union-order construction
from item 4, where a leaked `false`-pair entry flips the overall verdict to a wrong
accept.

**T2. Task 1 test 4's `k1 === k2` assertion is vacuous.** `typeKey` is a pure function;
calling it twice on the same input and comparing proves determinism, which nothing
threatens. The test's real value is termination (an unguarded implementation
stack-overflows, failing the test by crashing) — keep that, but replace the vacuous
assertion with something semantic: two same-shaped recursive aliases with different
names (`Tree` / `Tree2`) must key DIFFERENTLY (inner refs are nominal). That pins the
design decision the whole recursion story rests on, and today no test does.

**T3. Task 1 test 2 claims to test trivia but constructs none.** The test name says
"ignores tags, trivia, and effect-set flags"; the bodies cover tags and `isEffectSet`
only. Because `canonical()` is an allowlist (it rebuilds from known fields), trivia and
`loc` are stripped by construction — but then the test should either include an
`objectType` with a `trivia` entry or drop "trivia" from the name. As written, someone
adding trivia leakage later gets a green suite and a lying test name.

### Silent-revert holes (code breaks, suite stays green)

**T4. Nothing pins the Task 1 call-site wiring.** If someone reverts the
`flow.ts`/`synthesizer.ts` edits back to `JSON.stringify`, the typeKey unit tests still
pass — they test the function, not its adoption. Step 5's "expect dedup diffs in existing
tests" may leave churned assertions that pin it incidentally, but that's indeterminate
until executed. Add at least one behavior-level test that only passes through typeKey:
e.g. a `typecheckSource` case where an if/else join unites `{ a: 1, b: 2 }` with
`{ b: 2, a: 1 }` (property order flipped) and the resulting diagnostic or synthesized
type shows a single object type, not a two-member union.

**T5. Nothing pins the union-member sort.** `canonical()` sorts union members so
`A | B` keys equal `B | A` — highlighted in the plan's own doc comment, tested nowhere.
One two-line unit test. Same for the nested-nominal rule: `typeKey({a: AgeRef})` must
DIFFER from `typeKey({a: number})` (nested refs deliberately stay nominal; only the top
resolves). Both are design decisions someone could "fix" while refactoring, greenly.

**T6. Task 4's good branch commits no test.** If the zod probe shows `$ref`/`$defs`
works, the plan commits documentation and nothing else — the probe is scratch. Zod is
pinned with a caret (`^4.3.5`); a minor zod upgrade that changes cycle handling in
`toJSONSchema` regresses recursive structured output with a fully green suite. Commit a
unit-level test that runs the same conversion smoltalk uses on the generated `Tree`
schema shape and asserts a `$ref` appears (no LLM call needed). The throwing branch
already commits a pinning test; the working branch deserves one too.

### Missing test cases

Ordered by importance:

1. **Validated recursive/forward alias** (ties to must-fix item 1). Whichever way item 1
   is resolved — lazy descriptors or a clear compile error — there is currently no test
   exercising `@validate` + recursion, and the self-recursive case fails *silently*
   (descriptor reads `undefined`, validation vanishes). This is the most dangerous
   untested path in the plan.
2. **Recursive alias as a function parameter, executed** (ties to item 7). Task 2's
   `def id(x: Tree)` tests typecheck only; no execution test compiles-and-loads a module
   where a function's tool-registration schema (module-load-time `z.object`, see
   `asyncAssigned.mjs:322-325`) references a recursive alias. Add `def f(x: Tree)` to
   `recursive-type.agency` (declared after the type) and call it; separately probe
   def-before-type to settle item 7's scope question.
3. **Mutual recursion, executed.** Employee/Manager exists only as a textual fixture grep
   (Step 6), which pins emission shape but never runs. Add a `schema(Employee).parseJSON`
   round-trip to the execution test — it would catch a back-edge/forward-edge direction
   bug that happens to load without crashing.
4. **Utility-type × recursion at codegen.** Task 5 pins `Partial<Tree>` in the
   typechecker only. Add `type TreePatch = Partial<Tree>` to the codegen fixture (alias
   const whose *expanded* initializer contains a pending self-reference — exercises the
   pending-set logic through the builtin-generic expansion path) and an execution
   `schema(Partial<Tree>).parseJSON("{}")` test mirroring `utility-partial.agency`.
5. **Self-reference in union position.** The fixture covers object-property and
   array-element positions. `type Json = string | number | Json[]` puts the self-ref
   under `z.union([...])` in the const initializer — a different structural path through
   `mapTypeToSchemaInner`. One fixture line plus one grep.
6. **Non-empty nested literal in Task 2 test 1.** `children: []` means the green run
   never structurally compares a nested `Tree` literal against the alias. Use
   `{ value: 3, children: [{ value: 4, children: [] }] }` — the red expectation is
   unchanged (the crash comes from the `Tree`-vs-`Tree` call-site check), and green gains
   depth.
7. **Degenerate `type Loop = Loop`.** Today's behavior after this plan: typechecker keys
   it nominally (fine), but codegen emits `const Loop = z.lazy(() => Loop)`, which
   stack-overflows at first parse. Decide the behavior (a "circularly references itself"
   compile error, like TS, is the obvious choice) and pin it — or explicitly scope it out
   in the PR. Zero-cost to detect: the alias body resolves to a bare self-reference.

### Reversion matrix (summary)

| Break | Caught by |
|---|---|
| typeKey deleted/broken | Task 1 unit tests ✓ |
| typeKey call sites reverted | **nothing** (T4) |
| Union sort / nested-nominal removed | **nothing** (T5) |
| Coinduction guard removed | Task 2 tests 1–2 (stack overflow) ✓ |
| Guard never removes pairs (memo bug) | **nothing as written** (T1); fixed test 4 ✓ |
| Guard accepts everything | Task 2 test 3 ✓ |
| z.lazy emission removed | Task 3 tests (load crash) ✓ |
| Backward refs over-wrapped | Step 6 zero-churn gate ✓ |
| Wrong lazy target | Task 3 accepts/rejects ✓ |
| Validated recursive alias breaks | **nothing** (missing case 1) |
| zod upgrade breaks $ref conversion | **nothing** (T6) |
| Recursive param in tool schema breaks | **nothing** (missing case 2) |
