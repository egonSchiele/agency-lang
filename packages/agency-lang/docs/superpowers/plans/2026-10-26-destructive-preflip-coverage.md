# Destructive pre-flip coverage implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a compound statement (a loop, an `if`, a `match`, a `handle`, a `thread`) from marking `destructiveRan: true` before it runs, when the only destructive calls inside it are already tracked precisely by their own post-flip.

**Architecture:** One decision changes, in one place. `DestructiveTracking.statementFlips` decides today "pre-flip if the statement textually contains a destructive call". After this change it decides "pre-flip if the statement contains a destructive call that no precise post-flip covers". Nothing about step numbering, the compound-statement list, or the runtime changes.

**Tech Stack:** TypeScript codegen in `lib/backends/typescriptBuilder/`, vitest unit tests, Agency execution tests under `tests/agency/`, regenerated compiler fixtures.

**Spec:** GitHub issue [#1278](https://github.com/egonSchiele/agency-lang/issues/1278). There is no separate spec doc; the issue carries the repro, the expected output, and the suggested fix, and this plan follows that suggestion.

Paths below are relative to `packages/agency-lang`.

## Background

Read `docs/dev/language/destructive-regions.md` first. The short version:

Every function activation carries one boolean, `__activation.__destructiveRan`. It starts false. When the function leaves with a failure, the exit stamp copies the flag onto the failure as `destructiveRan`. The tool loop reads that one bit: a tool whose failure says `true` is removed from the conversation for the rest of the turn, because retrying it could repeat work that cannot be undone. A tool whose failure says `false` may be retried.

For a call to a destructive function, the compiler emits one of two flips:

- **The precise post-flip.** When the call's result binds a plain local, `const saved = saveOne(item)`, the compiler emits after the call: `__activation.__destructiveRan = __activation.__destructiveRan || (isFailure(__self.saved) ? __self.saved.destructiveRan : true)`. A clean refusal from the callee leaves the flag alone. Any other outcome sets it.
- **The conservative pre-flip.** For any other statement that contains a destructive call, the compiler emits `__activation.__destructiveRan = true` before the statement. For a compound statement the flip gets a step of its own before the statement's step, so a `return` inside the statement cannot skip it. PR #1255 put the flip there; before that it landed after the statement, which was a bug.

The two rules are applied by one function, `statementFlips` in `lib/backends/typescriptBuilder/destructiveTracking.ts`, and `processBodyAsParts` in `lib/backends/typescriptBuilder.ts` calls it for every statement of every body it compiles. Bodies nest: the body of a loop is compiled by `processBodyAsParts` too, so a `const saved = saveOne(item)` inside the loop gets its own precise post-flip.

## The bug

Take the issue's repro:

```
def saveAll(items: string[]): Result<string> {
  for (item in items) {
    const saved = saveOne(item)
    if (saved is failure) {
      return failure("stopped: ${saved.error}")
    }
  }
  return success("all saved")
}
```

`statementFlips` is asked about the `for` statement. The `for` textually contains a call to `saveOne`, which is destructive, so the `for` gets a pre-flip. Then `statementFlips` is asked about `const saved = saveOne(item)` inside the body, and that gets the precise post-flip. The generated code is:

```ts
await runner.step(1, ..., async () => {
  __activation.__destructiveRan = true;                      // the loop's pre-flip
});
await runner.loop(2, ..., async (item, ...) => {
  await runner2.step(0, ..., async () => {
    __stack.locals.saved = await __call(__run4, saveOne, { args: [item] });
    __activation.__destructiveRan = __activation.__destructiveRan ||
      (isFailure(__self.saved) ? __self.saved.destructiveRan : true);   // the precise post-flip
  });
  ...
});
```

With `["bad", "ok"]`, `saveOne("bad")` refuses before its destructive region, so its failure says `destructiveRan: false`. The post-flip computes `true || false`. The flag was already true from the pre-flip, so the failure that leaves `saveAll` says `destructiveRan: true` and the tool loop drops the tool for nothing. In 0.31 this passed only because the pre-flip ran after the loop, which was the ordering bug #1255 fixed.

The same thing happens for an `if`, `while`, `match` arm, `handle` body, `thread` body, or block argument that wraps a tracked assignment, because they all go through the same `statementFlips` call.

## The fix

`statementFlips` keeps its first rule unchanged. Its fallback changes from "does the statement contain a destructive call" to "does the statement contain a destructive call that is not covered". A call is **covered** when both of these hold:

1. It is the value of a plain local assignment, with the same shape `destructiveOutcomeVar` already accepts: no destructuring pattern, no access chain, no block depth, a direct call or a `try`-wrapped call.
2. That assignment sits in a body `processBodyAsParts` compiles, so it will get its own post-flip. Every body slot from `bodySlots` qualifies **except an inline handler body** (`with (intr) { ... }`). `processHandleBlockWithSteps` compiles that body statement by statement with `processStatement`, so nothing in it gets a flip.

Any destructive call that is not covered keeps the pre-flip: a call in an `if` condition, a loop iterable, a bare call statement, a call nested in an expression, a destructured assignment, and anything inside an inline handler body. A statement that mixes a covered call and an uncovered one still gets the pre-flip. That mixed case is rare and the conservative answer is the safe one.

### How the check is written

Collect two lists of nodes under the statement and compare them by identity. `walkNodesArray` yields the same objects the tree holds, so identity works.

- `coveredCalls(body)`: for each statement in the body, add every node `trackedCallNodes(stmt)` returns. Then recurse into each `bodySlots(stmt)` entry, skipping the slot when `stmt.type === "handleBlock"` and the slot has `retargetsReturn: true` (that is the inline handler slot, `lib/utils/bodySlots.ts:142-151`).
- `containsDestructiveCall(node, except)`: the existing walk in `NameClassifier`, with a new list of call nodes to ignore.

`trackedCallNodes` is `destructiveOutcomeVar` with a different return value. Both must agree on what a tracked assignment is, so `destructiveOutcomeVar` is rewritten to call `trackedCallNodes` and read the variable name from the statement.

## Global Constraints

- Follow `docs/dev/contributing/coding-standards.md` and `docs/dev/contributing/anti-patterns.md`.
- Use arrays, not sets, for the collected call lists. Use `Object.hasOwn` for the `destructiveFunctions` lookup, as the existing code does.
- Agency execution tests must not make LLM calls.
- Run `pnpm run typecheck` after every TypeScript edit. Run `pnpm run fmt:ts` before committing.
- Save every test run's output to a file under the scratchpad directory, and read the file instead of rerunning.
- Do not edit `docs/site/`. Do not edit `CHANGELOG.md`.
- Write commit messages to a file and pass the file to `git commit -F`.

## Review Focus

Inputs the issue does not name, each pinned by a test in the task that owns it:

1. A tracked assignment inside an inline handler body must still produce the pre-flip on the `handle` statement, or the flag fails open. Task 1 unit test, and `handlerDoesWork_` in `tests/agency/destructive-in-blocks.agency` already pins the runtime result.
2. A loop whose iterable is a destructive call must keep the pre-flip. Task 1 unit test, Task 2 runtime test.
3. A compound statement with one covered call and one uncovered call must keep the pre-flip. Task 1 unit test.
4. A destructured assignment, `const [a, b] = burn()`, is not tracked and must keep the pre-flip even inside a loop body. Task 1 unit test.
5. The second iteration of a loop must still mark the function when the first iteration did destructive work and a later one fails. Task 2 runtime test. This proves the post-flip is carrying the load once the pre-flip is gone.

---

### Task 1: The coverage check in `DestructiveTracking`

**Files:**
- Modify: `lib/backends/typescriptBuilder/nameClassifier.ts:144-155` (`containsDestructiveCall`)
- Modify: `lib/backends/typescriptBuilder/destructiveTracking.ts:88-99` (`statementFlips`) and `:131-160` (`destructiveOutcomeVar`, becomes `trackedCallNodes`)
- Test: `lib/backends/typescriptBuilder/destructiveTracking.test.ts`

**Interfaces:**
- Consumes: `bodySlots(node: AgencyNode): BodySlot[]` from `lib/utils/bodySlots.ts`; `walkNodesArray` from `lib/utils/node.ts`.
- Produces: `NameClassifier.containsDestructiveCall(node: AgencyNode, except?: AgencyNode[]): boolean`. `DestructiveTracking.statementFlips` keeps its signature. Nothing outside these two files changes.

- [ ] **Step 1: Write the failing unit tests**

Add to the `describe("DestructiveTracking")` block in `destructiveTracking.test.ts`, using the existing `setup` and `flips` helpers. Each test builds a `caller` whose first body statement is the compound statement under test and asserts on `flips(tracking, body[0], false)`. The `pre` string when present is `"__activation.__destructiveRan = true;"`.

```ts
const RM = `destructive def rm(p: string): Result { return failure("x") }\n`;

it("a loop whose body binds a destructive call to a local gets NO pre-flip (#1278)", () => {
  const { tracking, body } = setup(
    RM + `def caller(xs: string[]) { for (x in xs) { const r = rm(x) } }`,
    "caller",
  );
  expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
});

it("an if whose branch binds a destructive call to a local gets NO pre-flip", () => {
  const { tracking, body } = setup(
    RM + `def caller(b: boolean) { if (b) { const r = rm("x") } }`,
    "caller",
  );
  expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
});

it("a tracked assignment nested two bodies deep is still covered", () => {
  const { tracking, body } = setup(
    RM + `def caller(xs: string[], b: boolean) { for (x in xs) { if (b) { const r = try rm(x) } } }`,
    "caller",
  );
  expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
});

it("a loop whose ITERABLE is a destructive call keeps the pre-flip", () => {
  const { tracking, body } = setup(
    `destructive def items(): string[] { return [] }\n` +
      `def caller() { for (x in items()) { const n = 1 } }`,
    "caller",
  );
  expect(flips(tracking, body[0], false).pre).toBe("__activation.__destructiveRan = true;");
});

it("a bare destructive call inside a loop body keeps the pre-flip", () => {
  const { tracking, body } = setup(
    RM + `def caller(xs: string[]) { for (x in xs) { rm(x) } }`,
    "caller",
  );
  expect(flips(tracking, body[0], false).pre).toBe("__activation.__destructiveRan = true;");
});

it("a destructured assignment inside a loop body is not tracked and keeps the pre-flip", () => {
  const { tracking, body } = setup(
    `destructive def pair(): number[] { return [1, 2] }\n` +
      `def caller(xs: string[]) { for (x in xs) { const [a, b] = pair() } }`,
    "caller",
  );
  expect(flips(tracking, body[0], false).pre).toBe("__activation.__destructiveRan = true;");
});

it("a covered call next to an uncovered one keeps the pre-flip", () => {
  const { tracking, body } = setup(
    RM + `def caller(xs: string[]) { for (x in xs) { const r = rm(x)\n  rm(x) } }`,
    "caller",
  );
  expect(flips(tracking, body[0], false).pre).toBe("__activation.__destructiveRan = true;");
});

it("a tracked assignment inside an inline handler body is NOT covered: the handle keeps the pre-flip", () => {
  const { tracking, body } = setup(
    RM +
      `def caller() { handle { return interrupt("go?") } with (intr) { const r = rm("x")\n  return reject() } }`,
    "caller",
  );
  expect(flips(tracking, body[0], false).pre).toBe("__activation.__destructiveRan = true;");
});

it("a tracked assignment in the handle BODY is covered", () => {
  const { tracking, body } = setup(
    RM + `def caller() { handle { const r = rm("x") } with approve }`,
    "caller",
  );
  expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
});
```

- [ ] **Step 2: Run the unit tests and confirm the new ones fail**

Run: `pnpm vitest run lib/backends/typescriptBuilder/destructiveTracking.test.ts > "$SCRATCH/task1-red.txt" 2>&1; tail -40 "$SCRATCH/task1-red.txt"`

Expected: the "NO pre-flip" and "covered" tests fail with `pre` equal to the flip string. The "keeps the pre-flip" tests already pass. All eleven existing tests still pass.

- [ ] **Step 3: Add the `except` list to `NameClassifier.containsDestructiveCall`**

Signature: `containsDestructiveCall(node: AgencyNode, except: AgencyNode[] = []): boolean`. Inside the walk, skip a sub-node when `except.includes(subNode)`. Update the doc comment to say what `except` is for: call nodes an enclosing body's own flips already cover.

- [ ] **Step 4: Add `trackedCallNodes` and `coveredCalls` to `DestructiveTracking`, and reroute `statementFlips`**

In `destructiveTracking.ts`:

- `private trackedCallNodes(stmt: AgencyNode): AgencyNode[]`. The body of today's `destructiveOutcomeVar`, returning the nodes the walk will present for the call instead of the variable name: `[call]` for a direct call, `[tryExpr, tryExpr.call]` for a `try`-wrapped call, `[]` when the statement is not a tracked assignment. Keep the `Object.hasOwn` lookup and its comment.
- `private destructiveOutcomeVar(stmt: AgencyNode): string | null`. Becomes: `return this.trackedCallNodes(stmt).length > 0 ? (stmt as Assignment).variableName ?? null : null;`
- `private coveredCalls(body: AgencyNode[]): AgencyNode[]`. The recursion described in "How the check is written", concatenating `trackedCallNodes(stmt)` for each statement. Import `bodySlots` from `../../utils/bodySlots.js`.
- In `statementFlips`, replace the final line with:
  `return this.names.containsDestructiveCall(stmt, this.coveredCalls([stmt])) ? { pre: this.markDestructiveRan() } : {};`

Write the doc comment on `coveredCalls` so it names the one excluded slot and why: an inline handler body is compiled by `processStatement` per statement, with no flips, so nothing inside it is covered. Point at `docs/dev/language/destructive-regions.md`.

Why a `try` call contributes two nodes: `walkNodes` yields the `tryExpression` and then descends into its `.call` (`lib/utils/node.ts:498-501`), and `callTarget` in `nameClassifier.ts` reads the function name off either one. If only one of the two is in `except`, the other still matches and the pre-flip fires. The Step 1 test "nested two bodies deep" uses `try` to pin this. The comment on `callTarget` (`nameClassifier.ts:124-127`) says the walk does not descend into `.call`; that is stale, so correct it while you are there.

- [ ] **Step 5: Typecheck and run the unit tests**

Run: `pnpm run typecheck > "$SCRATCH/task1-tc.txt" 2>&1; tail -5 "$SCRATCH/task1-tc.txt"`
Expected: no errors.

Run: `pnpm vitest run lib/backends/typescriptBuilder/destructiveTracking.test.ts > "$SCRATCH/task1-green.txt" 2>&1; tail -20 "$SCRATCH/task1-green.txt"`
Expected: all tests pass, including the eleven that were there before.

- [ ] **Step 6: Commit**

```bash
pnpm run fmt:ts
git add lib/backends/typescriptBuilder/nameClassifier.ts lib/backends/typescriptBuilder/destructiveTracking.ts lib/backends/typescriptBuilder/destructiveTracking.test.ts
git commit -F "$SCRATCH/commit1.txt"
```

Commit message in the file: `Skip the destructive pre-flip for calls a post-flip already covers (#1278)`, with a body of two or three sentences restating "The bug" above.

---

### Task 2: Runtime test for the loop, the `if`, and the shapes that keep the flip

**Files:**
- Create: `tests/agency/destructive-tracked-in-compound.agency`
- Create: `tests/agency/destructive-tracked-in-compound.test.json`

**Interfaces:**
- Consumes: the codegen from Task 1. Nothing else.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the Agency test file**

Follow the layout of `tests/agency/destructive-in-blocks.agency`: a header comment, the helper defs, then one `def` per case with a `node <case>_()` wrapper that calls it and returns `[r.destructiveRan]`. The helper is the issue's `saveOne`:

```
def saveOne(item: string): Result<string> {
  if (item == "bad") {
    return failure("refused")
  }
  destructive {
    return success("saved")
  }
}
```

Do not call `print` inside the region; the test compares node output exactly.

Cases, with the expected output in the `.test.json`:

| node | body | expected |
| --- | --- | --- |
| `loopRefusedFirst_` | the issue's `saveAll` over `["bad", "ok"]` | `[false]` |
| `loopRefusedSecond_` | the issue's `saveAll` over `["ok", "bad"]` | `[true]` |
| `ifRefused_` | `if (true) { const s = saveOne("bad"); if (s is failure) { return failure("stopped") } }` then `return failure("after")` | `[false]` |
| `whileRefused_` | a `while` with a counter that calls `saveOne("bad")` once, binds it, and returns the failure | `[false]` |
| `matchRefused_` | a `match` on a string whose arm binds `saveOne("bad")` and returns the failure | `[false]` |
| `bareInLoop_` | `for (item in ["bad"]) { saveOne(item) }` then `return failure("after")` | `[true]` |
| `destructiveIterable_` | `for (x in listDestructively()) { return failure("inside") }` where `listDestructively` is a `destructive def` returning `["a"]` | `[true]` |

The `loopRefusedSecond_` case is the one that proves the post-flip now carries the loop on its own: the first iteration's success flips the flag, and the second iteration's refusal leaves with `true`.

- [ ] **Step 2: Write the `.test.json`**

Same shape as `tests/agency/destructive-in-blocks.test.json`: one entry per node above, `"input": ""`, `expectedOutput` from the table, `evaluationCriteria` of `[{ "type": "exact" }]`, and a one-line `description` each.

- [ ] **Step 3: Build and run the test, confirm it fails before Task 1 if run against main (optional), passes now**

Run: `make > "$SCRATCH/task2-make.txt" 2>&1; tail -5 "$SCRATCH/task2-make.txt"`
Expected: build succeeds.

Run: `pnpm run agency test tests/agency/destructive-tracked-in-compound.test.json > "$SCRATCH/task2-test.txt" 2>&1; tail -30 "$SCRATCH/task2-test.txt"`
Expected: all seven cases pass.

If `loopRefusedFirst_` fails with `[true]`, Task 1's `coveredCalls` is not reaching the loop body; check that `bodySlots` returns the `forLoop` body and that the walk's `except` comparison is by identity.

- [ ] **Step 4: Run the existing destructive tests to confirm nothing moved**

Run: `for f in destructive-block destructive-tracking destructive-extern-throw destructive-in-blocks stdlib-destructive; do pnpm run agency test tests/agency/$f.test.json; done > "$SCRATCH/task2-existing.txt" 2>&1; grep -c "PASS\|FAIL" "$SCRATCH/task2-existing.txt"; grep -n "FAIL" "$SCRATCH/task2-existing.txt"`

Also: `pnpm run agency test tests/agency/decorators/destructive-region-in-body.test.json >> "$SCRATCH/task2-existing.txt" 2>&1`

Expected: no `FAIL` lines. `handlerDoesWork_` and `inCondition_` in `destructive-in-blocks` are the two that guard the fail-open direction and must still print `[true]`.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/destructive-tracked-in-compound.agency tests/agency/destructive-tracked-in-compound.test.json
git commit -F "$SCRATCH/commit2.txt"
```

Message: `Test destructiveRan for tracked calls inside loops, ifs, and matches`.

---

### Task 3: Fixtures, lint, and the dev doc

**Files:**
- Modify: `tests/typescriptGenerator/*.mjs` (regenerated; expect `destructiveNested.mjs` and `destructiveBlock.mjs` and possibly others to change)
- Modify: `docs/dev/language/destructive-regions.md:23` (the Rule 2 bullet)

**Interfaces:** none.

- [ ] **Step 1: Regenerate the compiler fixtures**

Run: `make fixtures > "$SCRATCH/task3-fixtures.txt" 2>&1; tail -5 "$SCRATCH/task3-fixtures.txt"; git status --short tests/typescriptGenerator | head -20`

Expected: a handful of `.mjs` files change. For each changed file, read the diff and confirm the only change is a removed `__activation.__destructiveRan = true;` step before a compound statement and the renumbering that follows. A diff that removes a flip before a bare call, an `if` condition, or a handler body is a regression in Task 1; stop and fix it there.

Run: `git diff tests/typescriptGenerator | grep "^[-+]" | grep -v "^[-+][-+]" | grep -c destructiveRan`
Expected: only `-` lines for `__destructiveRan = true`, no `+` lines adding one, and no removed post-flip lines (the `isFailure(` ternary form).

- [ ] **Step 2: Run the fixture test and the structural lint**

Run: `pnpm vitest run tests/typescriptGenerator > "$SCRATCH/task3-fixtures-test.txt" 2>&1; tail -10 "$SCRATCH/task3-fixtures-test.txt"`
Expected: pass.

Run: `pnpm run lint:structure > "$SCRATCH/task3-lint.txt" 2>&1; tail -5 "$SCRATCH/task3-lint.txt"`
Expected: pass.

- [ ] **Step 3: Update the Rule 2 bullet in the dev doc**

In `docs/dev/language/destructive-regions.md`, rewrite the second sentence of the Rule 2 bullet. Today it says "Any other statement containing a destructive call gets a conservative pre-flip before the statement." Replace it with text that says: any other destructive call gets a conservative pre-flip on the statement that contains it, **except** a call that a nested body's own post-flip already covers. Then say what covered means in one sentence (a plain local assignment of the call, inside a body `processBodyAsParts` compiles) and name the one body that is never covered, an inline handler body, with the reason (`processHandleBlockWithSteps` compiles it statement by statement with no flips). Keep the rest of the bullet about compound statements and `COMPOUND_STATEMENT_TYPES` as it is. Add `destructive-tracked-in-compound.agency` to the Tests line in the Files section.

Mechanism and rule only. No history, no issue narration beyond the `#1278` reference in parentheses at the end of the new sentence.

- [ ] **Step 4: Commit**

```bash
pnpm run fmt:ts
git add tests/typescriptGenerator docs/dev/language/destructive-regions.md
git commit -F "$SCRATCH/commit3.txt"
```

Message: `Regenerate fixtures and document pre-flip coverage`.

---

### Task 4: Pre-PR checks and the PR

**Files:** none new.

- [ ] **Step 1: Audit the diff against the anti-patterns doc**

Run: `git diff origin/main --stat; git diff origin/main -- lib/ | head -200`

Check against `docs/dev/contributing/anti-patterns.md`. The two likely catches: a comment that narrates the code instead of saying why, and a helper that duplicates `destructiveOutcomeVar` instead of sharing `trackedCallNodes`.

- [ ] **Step 2: Run the unit suites that touch the changed files**

Run: `pnpm vitest run lib/backends > "$SCRATCH/task4-backends.txt" 2>&1; tail -10 "$SCRATCH/task4-backends.txt"`
Expected: pass. Do not run the full agency suite locally; CI does that.

- [ ] **Step 3: Push and open the PR**

Write the PR body to `$SCRATCH/pr.md`: what the bug was (two sentences), what changed (the one-rule change), what still keeps the pre-flip (the list from "The fix"), and the generated-code before/after for the issue's `saveAll`. End with `Closes #1278` and the attribution line.

```bash
git push -u origin adit/destructive-preflip-coverage
gh pr create --title "Skip the destructive pre-flip for calls a post-flip already covers" --body-file "$SCRATCH/pr.md"
```

Then stop. The owner merges.

---

## Self-review

- **Issue coverage.** The issue asks for the pre-flip to be skipped when every destructive call inside a compound statement is a tracked plain assignment, and kept for condition, iterable, bare, and nested calls. Task 1 implements it, Task 2 pins the runtime result for the issue's exact repro and for the shapes that must keep the flip, Task 3 keeps the fixtures and the doc honest.
- **Types.** `containsDestructiveCall(node, except)` is defined in Task 1 and used only there. `trackedCallNodes` returns every node the walk will present for the call (two for a `try` call), which Task 1 Step 4 calls out because it is the one place an implementer would reasonably get wrong. Verified before writing: the walk descends into a `try`'s inner call, and the planned test source parses, `with approve` included.
- **Fail-open guard.** The inline handler body is the only known body that gets no per-statement flips. Review Focus item 1 pins it twice, once at the unit level and once at runtime.
