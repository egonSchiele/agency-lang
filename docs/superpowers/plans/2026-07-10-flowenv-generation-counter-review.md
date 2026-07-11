# Review: FlowEnvironment Generation Counter Plan

**Plan:** `docs/superpowers/plans/2026-07-10-flowenv-generation-counter.md`
**Reviewer basis:** every "Verified fact" re-checked against main (2026-07-10); bench script actually executed; all `declare`/`declareLocal`/`child()` call sites re-enumerated.

**Verdict:** Sound design at the right altitude, with one sequencing blocker (Task 2 cannot go green as written) and one missed contract site (handlerParamTyping.ts) that contradicts the PR's own story if left untouched. Fix those two and the smaller items below; no structural rework needed.

---

## Blocker

### 1. Task 2 cannot compile: the manual reset is a fifth `memo` write site

Task 2 Step 3 says to fix four construction sites and claims "there should be none beyond these four." Wrong: `matchExprTypes.ts:127` does

```ts
ctx.flowEnv.memo = new WeakMap();
```

The moment `FlowEnvironment.memo` becomes `FlowMemo`, this line is a type error. Task 2 Step 3's `tsc --noEmit` and Step 7's "PASS across the typeChecker suite" both fail, but the plan defers touching this line to Task 3.

**Fix:** in Task 2 Step 3, convert the reset to an in-place interim flush that respects the new box contract:

```ts
ctx.flowEnv.memo.map = new WeakMap();
```

(Belt-and-braces during the transition; Task 3 then deletes it exactly as planned. Do NOT use `ctx.flowEnv.memo = freshMemo()` — replacing the box is the pattern the FlowMemo comment forbids, and the first commit that models it would undermine the comment.)

---

## Should fix

### 2. Task 5 bench instructions are broken as written (verified by running them)

"Write this script to the scratchpad as `bench-typecheck.mjs` and run it from the worktree package dir" does not work: Node resolves the `./dist/...` imports relative to the **script file's location**, not the cwd. Ran it verbatim from the package dir with the script in the scratchpad → `ERR_MODULE_NOT_FOUND`.

**Fix:** either hardcode absolute import paths per checkout (two script copies, or a `ROOT` const edited per run), or place the script inside each `packages/agency-lang` dir and delete it before committing. Note `readFileSync("stdlib/ui.agency")` is cwd-relative, so the run-from-package-dir instruction must stay either way.

With absolute imports the script body works: **main median = 23.2 ms** (parse succeeds with `applyTemplate: false`, `typeCheck(parsed.result)` signature is correct — `config` and `info` are optional).

### 3. The perf gate is inside measurement noise

5% of a 23 ms median is ~1 ms. Seven iterations with no warmup means the gate can flap on JIT/GC noise alone and "fail" a perfectly good branch (or pass a bad one).

**Fix:** discard 3 warmup iterations, then time ~25; or run the whole script 3× and compare best-of medians. Cheap change, makes the gate meaningful.

### 4. Task 3's comment sweep misses handlerParamTyping.ts — the third home of the contract being deleted

The plan updates the ordering story in `index.ts` and the narrowing README, but `handlerParamTyping.ts:92-100` contains a **load-bearing runtime assertion**:

```ts
// ORDERING ASSERTION (load-bearing — see TypeChecker.check()): this pass
// MUTATES scope types, so it must run BEFORE buildFlowGraphs seeds the
// typeAt memo. Running after would require the memo-reset contract this
// ordering exists to avoid; a reorder would silently produce stale types.
if (ctx.flowEnv) { throw new Error("refineInlineHandlerParams must run before buildFlowGraphs ..."); }
```

plus a trailing "No flow-env memo reset needed: this pass runs BEFORE `buildFlowGraphs`..." comment at the end of the function. After this PR, "a reorder would silently produce stale types" is **false** — the pass's `declare()` at line 121 would bump the generation and the memo would self-invalidate. Leaving the assertion's rationale untouched ships a PR whose index.ts comment says "ordering is a clarity choice now" while another file still throws with a comment saying ordering is a soundness cliff.

**Fix (add to Task 3):** keep the throw if you want the ordering preserved for oracle-seeding quality (reasonable), but rewrite its justification to match the new world; update the trailing comment likewise. Deleting the assertion is also defensible — make it an explicit decision either way.

### 5. Add the two missed call sites to Verified Facts (conclusions survive, the executor shouldn't rediscover them)

The plan's inventory of `declare` sites omits:

- `handlerParamTyping.ts:121` — `info.scope.declare(...)` on the **main** tree, but it runs before `buildFlowGraphs` (enforced by the assertion in item 4), so it bumps before the memo exists. Harmless; should be listed.
- `narrowing.ts:431` — `childScope.declareLocal(...)` inside `applyNarrowing`, on the `walkWithNarrowing` detached child. Covered by the detached carve-out; should be listed since it's the second production `declareLocal` caller.

Confirmed the load-bearing facts the plan does state: all `ScopeInfo` scopes chain to one `topLevelScope` (`scopes.ts:32`/`scopes.ts:67`), so the tree-wide counter read from `env.scope` is consistent with the `at.scope` reads in `computeTypeAt`; `checkScopes` (`checker.ts`) never calls `declare`/`declareLocal`/`child()`; lazy `inferReturnTypeFor` declares only into its standalone tree (`inference.ts:56`); the spread-copy sites are `synthesizer.ts:284-287` and `:832` as claimed.

---

## Minor

6. **`root()` doc comment "depth <= 3" is wrong.** `walkWithNarrowing` creates a child scope per narrowed branch and nested ifs chain them (`child.child()...`), so parent chains are arbitrarily deep. The cost is still fine — `functionScope()` already walks the same chain on every `declare` today, and the hot `typeAt` path reads generation through `ctx.flowEnv.scope`, which is the parent-less top-level scope (O(1)). Just fix the comment, e.g. "O(parent-chain depth); the flow env's scope is the root, so the hot path is O(1)."

7. **`flowBuilder.ts:394` fallback root.** With an empty `scopes` list, `ctx.flowEnv.scope = new Scope("global")` is an orphan root whose generation never moves. No flow nodes exist in that case, so it's harmless — worth a one-line note so nobody "fixes" it later.

8. **The FlowMemo comment slightly overpromises.** "Invalidation is AUTOMATIC" is true for Scope mutations only. In-place FlowNode patches (`assignFlow.type = ...`) remain invisible to the counter and still require the paired consumer re-declare — the plan knows this (the second pin exists precisely to pin it) but the FlowMemo/typeAt comments should say it in one sentence: "Automatic for Scope mutations; a FlowNode patched in place still needs a paired declare() bump (see matchConsumerAssignFlows)." Otherwise the next person who patches a flow node without a declare reads "automatic" and ships a stale-memo bug.

9. **Task 2 Step 3 wording** — after fixing item 1, update "none beyond these four" to five sites (four constructions + the interim in-place reset).

---

## Verified with no findings

- Altitude is right: the codebase currently enforces one invariant ("scope mutated after memo seeded ⇒ stale typeAt") via **two different mechanisms** (manual reset in matchExprTypes, throw-on-reorder in handlerParamTyping) plus prose in three files. Centralizing it as data on `Scope` is the correct move, and `Scope` is the correct owner (the mutation site, not the cache site).
- Task 1 tests exercise the real semantics: `declare` from a detached child delegates through `functionScope()` and bumps; `declareLocal` on detached skips. Checked against `scope.ts:25-43`/`:80-89`.
- The four Task 2 pins are correct against `computeTypeAt`: the assign-node pin's `toBe("any")` matches the exact-ref early return; the identity pin's fresh-object assumption holds (`uniteTypes` builds a new union object for 2+ members) and the plan already names the limitation.
- The detached-root assertion is safely placed (first statement of the `for (const info of scopes)` loop; the test's ctx stub works because `getTypeAliases()` is called before the loop). Production `ScopeInfo` scopes are never `child()`-created, so it's purely defensive — as intended.
- Test-helper anchors check out: `flow.test.ts:65-67` (`env`), `flow.test.ts:~320` (bare env), `flowBuilder.test.ts:~28-33` (`freshEnv`).
- The box-shared-by-reference design correctly handles the spread-copied envs; mutating `memo.map`/`memo.gen` in place keeps all copies coherent, including copies taken before an invalidation.
- Interim state after Task 1 (counter exists, nothing reads it) is inert. Commit sequencing otherwise fine.
- Spec file exists; issue #471's title matches the part-1/part-2 framing; `stdlib/ui.agency` exists; `parseAgency`/`typeCheck` import paths in dist are real.

---

## Anti-pattern audit (against `docs/dev/anti-patterns.md`)

**Headline: the plan is a net anti-pattern FIX, not a violation.** Today's design is a textbook instance of the "Imperative code everywhere" + "Leaky abstractions" entries: `FlowEnvironment.memo`'s soundness contract is prose that instructs every scope-mutating pass to reach into the env and imperatively replace the memo (`ctx.flowEnv.memo = new WeakMap()`), and a second pass (handlerParamTyping) enforces the same invariant with a throw-on-reorder. The "how" of cache invalidation leaks into every "what" site. The plan moves the how behind two interfaces: producers bump implicitly inside `declare()`/`declareLocal()` (client passes just declare — the what), and the single consumer (`typeAt`) owns the check-and-flush. The `detached` flag likewise turns "callers must know whether their child scope endangers the memo" into a property fixed at construction. That is exactly the declarative encapsulation the catalog asks for.

Two places where the plan still relies on prose contracts instead of interfaces, and could go further:

- **The "never replace the box" rule is comment-enforced.** The FlowMemo doc says "Mutate the box fields in place; never replace a memo field on one env" — a human contract of exactly the species this PR exists to delete. Make it structural: declare the field `readonly memo: FlowMemo` in `FlowEnvironment`. Object-literal construction still works, spread copies still work, `memo.map`/`memo.gen` in-place mutation still works — but `env.memo = ...` (the old reset, and any future regression) becomes a compile error. Verified feasible: the only assignment site on main is `matchExprTypes.ts:127`, which this PR removes. Recommend adding to Task 2.
- **The paired patch+declare in matchExprTypes phase 2 stays imperative-and-adjacent.** `info.scope.declare(...)` and `assignFlow.type = type` must travel together (the counter only sees the first), and the plan keeps them as two statements plus a comment. Optional: a small helper (e.g. `rebindMatchConsumer(scope, node, type, flowNode)`) that owns the pairing would make the invariant an interface instead of a convention. Single caller today, so reasonable to skip — but then the FlowMemo comment must carry the warning (item 8 above).

Line-level entries, checked against every code block in the plan:

- **One-line if statements (violation, minor):** the new `declareLocal` body uses `if (!this.detached) this.bumpGeneration();` — the catalog explicitly bans one-line ifs. Brace it. (The `if (isConst) target.consts[name] = true;` line is pre-existing code the plan quotes verbatim — leave that to the file's current style.) Same nit in the bench script's `if (!parsed.success) throw ...`.
- **Magic numbers (nit, bench only):** `7` iterations and `times[3]` as the median index are paired magic numbers — if one changes the other silently breaks. `const RUNS = 7; ... times[Math.floor(RUNS / 2)]`. Folds into review item 3 (which raises RUNS anyway).
- **Single-character names:** the pins use `e` for the env — matches the existing convention in `flow.test.ts` (`const e: FlowEnvironment` at ~:320), so consistency with the file wins here. No change.
- **Duplicating existing code:** none — `root()` doesn't exist on `Scope` today (`functionScope()` is a different walk: it stops at function boundaries); `freshMemo()` centralizes what are currently four copy-pasted `new WeakMap()` literals, which also cures an "Inconsistent patterns" seed.
- **Order-dependent mutable state:** the check-then-flush-then-stamp in `typeAt` is 3 lines of ordered mutation, but it is confined inside the one function that owns the cache — this is the encapsulation the entry asks for, not a violation. The counter itself is mutable state by necessity (it is a cache-invalidation clock) and is private with a single mutation path.
- **Useless special cases / nested ternaries / silent try-catch / dynamic requires / nested type objects:** none present. `freshMemo()`'s `gen: -1` sentinel is a justified special value (documented, guarantees the first query stamps) rather than a useless branch.

---

## Test-plan review

**Verdict:** The pins are unusually well-designed — they are mutually covering for the two halves of the check-and-stamp, and the red-check procedures prove they detect the exact bug class. Two structural gaps: the box-shared-by-reference design (the plan's own headline subtlety) has **zero** test, and integration coverage of the production flush point is *recorded* but not *guaranteed*. Plus three cheap unit pins worth adding.

### Do the planned tests test what they claim? (verified by simulation against the proposed code)

**Task 1 scope tests — yes.** Traced each against the proposed `declare`/`declareLocal`/`functionScope`/`root` wiring: bump-on-declare lands on the root and is readable from any scope (catches a per-scope-storage regression: both assertions fail if `generation` is bumped or read on the wrong instance); the detached carve-out and the declare-still-delegates-and-bumps cases pin the two sides of detachment. Step 2's red is trivially real (methods don't exist).

**Task 2 pins — yes, and they complement each other correctly:**

- **Pin 1** (fresh type after mutation) and **pin 2** (patch+declare pairing) test *invalidation*. If the generation check is removed or the flush half breaks (`gen` stamped, map kept), both return stale types and fail. Step 6's comment-out red-check proves this empirically. Note: pin 2's first assertion (`toBe("any")`) is load-bearing — it seeds the memo before the patch; verified `computeTypeAt`'s exact-ref assign case returns `at.type` directly, so the setup is real.
- **Pin 3** (identity-based memo hit) tests *caching*. It catches the failure modes pins 1–2 are blind to: stamp-half broken (`map` flushed but `gen` never stamped → flushes every call → identity fails) and memoization removed entirely (pins 1–2 pass vacuously green in both cases, since recomputing always yields the fresh type). It also catches a detached-scope regression (a bump from `declareLocal` on a child would flush and break identity). The fresh-object assumption behind `toBe` is verified: `uniteTypes` builds a new union object for 2+ members.
- **Pin 4** deliberately pins whole-map lazy invalidation so granularity changes show up as a test diff. It is red on main (memo hit → `not.toBe` fails), so it also participates in the red-proof.
- **flowBuilder assertion test** — real: without the assertion, `buildFlowGraphs` on an empty body completes without throwing, so `toThrow` fails.

### Breakages NO planned test catches

1. **Box replacement / spread-copy desync — the design's central subtlety is untested.** Every pin uses a single env object, so reverting `FlowMemo` to a per-env value, or writing `env.memo = freshMemo()` on one env, passes the entire planned suite while silently desyncing the synthesizer's spread copies (`synthesizer.ts:284-287`, `:832`). Add a pin: memoize through env A, `scope.declare(...)`, query through a spread copy `{ ...A, typeAliases }` and assert the fresh type; and the converse identity-hit (no mutation → same object through the copy). Pairs with the `readonly memo` suggestion — one enforces at compile time, the other pins the runtime semantics.
2. **Wrong-root generation reads.** Every pin builds `env.scope` and the `start` node from the same `Scope`, so a bug where `typeAt` consults a scope outside the mutated tree (e.g. the `flowBuilder.ts:394` fallback root wired into `ctx.flowEnv` wrongly) never invalidates and no pin notices. Unit pins can't realistically cover this — it's what integration coverage is for → item 3.
3. **Integration coverage is conditional, not guaranteed.** Task 3 Step 4 *records* whether any match-expression integration test goes red with the check disabled — good experiment, wrong ending. A candidate exists (`matchExpression.test.ts:228`, "unannotated consumer flows the match union to downstream uses" — its `const n: number = label` diagnostic depends on the consumer's post-phase-2 type), but whether phase-1 yield synthesis memoizes the consumer's node *before* phase 2 rebinds it is exactly the open question. **Change Step 4: if no integration test fails, add one that does** (e.g. a second match whose scrutinee reads the first consumer, forcing a typeAt query during phase 1). Otherwise the only guard on the real production flush point is synthetic-graph pins.
4. **Same-type re-declare must still bump.** Phase 2 re-declares the consumer with the computed union, which can equal the already-declared type. A plausible future "optimization" — skip the bump when the type is unchanged — would break the paired assign-node-patch contract (pin 2 declares a *different* type, so it wouldn't notice... actually pin 2 declares STR over "any", so it passes under that optimization only if types differ — the same-type case is uncovered). One-line scope test: declare the same name/type twice → generation +2.
5. **Nested detached chains.** `walkWithNarrowing` nests children per nested if, so `fn.child().child()` chains are real. Cheap Task 1 additions: `declareLocal` through two detached levels doesn't bump; `declare` through two detached levels does.
6. **Standalone-tree isolation (perf claim).** "Bumps in `inferReturnTypeFor`'s standalone tree never flush the main memo" is guarded only by the noisy benchmark. Cheap identity pin: memoize via the main env, `declare` into an unrelated `new Scope(...)` tree, assert the memo hit survives.

### Accepted residuals (fine to leave untested, but say so)

- **Mid-walk mutations:** `gen` is stamped before computing, so a scope mutation occurring *during* a recursive typeAt walk goes unnoticed for entries computed earlier in that walk. The design's stated invariant ("nothing mutates scopes mid-walk") makes this moot today; it's the right call to not test it, but the typeAt comment should name it as an invariant rather than an observation.
- **The perf gate as a test** is currently inside noise (item 3 above) — until fixed, it cannot fail meaningfully in either direction.
- The red-checks (Task 2 Step 6, Task 3 Step 4) prove test power once, at execution time. That's inherent to comment-out proofs; the durable artifacts are the pins themselves, which is why items 1 and 3 matter.
