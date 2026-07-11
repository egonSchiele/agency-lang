# Schema Chaining (issue #480) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline execution — this owner does not use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `schema(number).parseJSON("[1]")` parse (issue #480) by letting a schema expression start an access chain, with a targeted `parseError` message once the chain is unambiguously intended.

**Architecture:** One new parser, `schemaAccessParser` = `schemaExpressionParser` + `peek(dotParser)` commit + `parseError`-wrapped `many1(chainElementParser)`, producing an ordinary `ValueAccess`. Inserted at two sites: `baseAtom` (expression position) and `_valueAccessParser` (statement position). No AST, checker, or codegen changes — those paths are already generic over the base (verified in the spec). (Review fix: the gate is `peek(dotParser)`, not `peek(char("."))`, so `?.`-led chains commit too — `dotParser` at parsers.ts:2355 is the exact set of dot-led heads `dotMethodCallParser` accepts.)

**Tech Stack:** TypeScript, tarsec parser combinators, vitest.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-11-schema-chaining-design.md`

## Global Constraints

- Commit messages: NO apostrophes; multi-line messages via file + `git commit -F`.
- Save all test output to files; never rerun suites to re-read failures.
- Do NOT run the full agency execution suite locally (CI does); running the two new agency tests individually is fine.
- Agency syntax in tests must follow `docs/site/guide/basic-syntax.md` (parens + braces, `let`/`const`, `match` yield form).
- No new benchmark gate (spec: `schema(`-anchored parser, no new backtracking level); the full parse-test suite + `make` (stdlib compile) are the guards.

## Verified facts (2026-07-11, against main)

- `peek` and `parseError` are ALREADY imported in `lib/parsers/parsers.ts` (lines 19-20 of the tarsec import). `parseError(msg, ...parsers)` runs `seqC(...parsers)` and THROWS `TarsecError` on failure (combinators.js:776) — a hard commit, no backtrack. `parseAgency` catches `TarsecError` (lib/parser.ts:313-314) and converts it to a parse failure carrying the message.
- Precedent for the commit-anchor + parseError shape: `angleBracketsArrayTypeParser` (parsers.ts:1107) commits after `array<`.
- `chainElementParser` (parsers.ts:2451) = dot-method / call / slice / index elements. `schemaExpressionParser` (parsers.ts:2643). `baseAtom` or() (parsers.ts:~2656) lists `schemaExpressionParser` BEFORE `lazy(() => valueAccessParser)` — the stranded-suffix cause. `_valueAccessParser` (parsers.ts:2483) tries `parenAccessParser` first, then bases `or(_functionCallParser, variableNameParser)`.
- Statement-position `schema(T).method()` parses TODAY as a functionCall named `schema` with the chain attached (repro-verified) — Task 2 deliberately changes that shape.
- `ValueAccess.base` is `AgencyNode` (lib/types/access.ts:13) — a schema base needs no type change. `parenAccessParser` (parsers.ts:2466) is the exact `map(seqC(capture(...), capture(many1(chainElementParser), "chain")))` idiom to mirror.
- Module-init ordering: `schemaAccessParser` must be DEFINED after `schemaExpressionParser` (module-init value dependency — the known or()/seqC TDZ class); referencing it from `_valueAccessParser`'s function BODY (call-time) is safe even though that function is defined earlier in the file.
- Existing test homes: schema parse assertions in `lib/parsers/expression.test.ts` (~line 384); checker schema tests in `lib/typeChecker/schemaType.test.ts`; formatter cases table in `lib/backends/agencyGenerator.test.ts`; execution-test convention `tests/agency/schema-param-injection.{agency,js,test.json}` (nodeName/input/expectedOutput/exact); codegen fixture convention `tests/typescriptGenerator/schemaAccess.{agency,mjs}` (regenerate via `make fixtures`, zero churn elsewhere).
- (Review-verified) `dotParser` (parsers.ts:2355) = `?.` | `.`; chain elements never allow leading whitespace (for ANY base), so the peek gate does not newly break multiline chains. `isSuccess(r)`/`isFailure(r)` narrow (lib/typeChecker/narrowing.ts:227-237), so `.value` access inside the guard typechecks. No valid program contains `schema(T).`/`schema(T)?.` followed by a non-chain — `schema` is reserved and a postfix dot demands a chain element in every context — so the parseError hard commit can only fire on genuinely invalid input.

## Worktree setup (before Task 1)

```bash
cd /Users/adityabhargava/agency-lang
git fetch origin
git worktree add .claude/worktrees/schema-chaining -b schema-chaining origin/main
cd .claude/worktrees/schema-chaining && pnpm install
cd packages/agency-lang && make > /tmp/i480-setup-make.log 2>&1
```

All paths below are inside `.claude/worktrees/schema-chaining/packages/agency-lang/` unless noted.

---

### Task 1: `schemaAccessParser` + expression position

**Files:**
- Modify: `lib/parsers/parsers.ts` (define after `schemaExpressionParser` ~2654; insert into `baseAtom` ~2656)
- Test: `lib/parsers/expression.test.ts`

**Interfaces:**
- Produces: `export const schemaAccessParser: Parser<ValueAccess>` — matches `schema(T)` followed by a `.`- or `?.`-led chain; throws `TarsecError` ("expected a method call after schema(...)…") when the dot is present but the chain is malformed; plain failure (backtracks) when there is no dot.

- [ ] **Step 1: Write the failing tests** — append to `lib/parsers/expression.test.ts` (uses `parseAgency` directly; add the import if the file lacks it):

```ts
describe("schema(...) chaining (issue #480)", () => {
  function rhsOfFirstConst(source: string): AgencyNode {
    const parsed = parseAgency(`node main() {\n  ${source}\n  return 1\n}`, {}, false);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    const node = parsed.result.nodes.find((n) => n.type === "graphNode") as GraphNodeDefinition;
    const assignment = node.body.find((n) => n.type === "assignment") as Assignment;
    return assignment.value as AgencyNode;
  }

  it("parses a chained call in expression position", () => {
    expect(rhsOfFirstConst('const r = schema(number).parseJSON("[1]")')).toMatchObject({
      type: "valueAccess",
      base: { type: "schemaExpression" },
      chain: [{ kind: "method", name: "parseJSON" }],
    });
  });

  it("accepts a type-grammar argument on the chained form", () => {
    expect(rhsOfFirstConst('const r = schema(number[]).parseJSON("[1]")')).toMatchObject({
      type: "valueAccess",
      base: { type: "schemaExpression", typeArg: { type: "arrayType" } },
    });
  });

  it("parses a two-element chain", () => {
    const v = rhsOfFirstConst('const r = schema(number).parseJSON("5").value');
    expect(v).toMatchObject({ type: "valueAccess", base: { type: "schemaExpression" } });
    expect((v as ValueAccess).chain.length).toBe(2);
  });

  it("bare schema(T) in expression position is unchanged", () => {
    expect(rhsOfFirstConst("const s = schema(number)")).toMatchObject({
      type: "schemaExpression",
    });
  });

  it("optional-chain head commits too", () => {
    expect(rhsOfFirstConst('const r = schema(number)?.parseJSON("[1]")')).toMatchObject({
      type: "valueAccess",
      base: { type: "schemaExpression" },
      chain: [{ kind: "method", name: "parseJSON", optional: true }],
    });
  });

  it("a malformed chain after the dot is a targeted parse error", () => {
    const parsed = parseAgency("node main() {\n  const r = schema(number).123\n  return r\n}", {}, false);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toContain("expected a method call after schema(...)");
  });
});
```

NOTE for the executor: the chain-element shape (`{ kind: "method", name: ... }`) is an educated guess — the real fields are `{ kind: "methodCall", functionCall: {...} }` per `AccessChainElement` (lib/types/access.ts:4-9); read one `chainElementParser` result or `pnpm run ast` the bind-first form and correct the `toMatchObject` shapes before running. The SAME applies to the whole helper skeleton (`parsed.result.nodes`, `node.body`, `type === "assignment"` for a `const` statement) and to `parsed.message` — verify each against a real parse before trusting the red run. Consider the lighter pattern used by the existing schema tests (expression.test.ts:380): call `exprParser` directly on the bare expression string for the expression-position rows; only the statement-position and error-message rows need full-program `parseAgency`. The assertion intent (targeted message reaches the user) must not be weakened.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/parsers/expression.test.ts > /tmp/i480-task1-red.log 2>&1`
Expected: the three chained-form tests FAIL (parse fails today: this is the issue); the bare-schema test PASSES; the parse-error test FAILS (today's message is the generic stranded-suffix failure, not the targeted one).

- [ ] **Step 3: Implement.** In `lib/parsers/parsers.ts`, immediately AFTER `schemaExpressionParser` (so its module-init value dependency is initialized — the or()/seqC TDZ class):

```ts
/**
 * `schema(T).method(...)...` — a schema expression as an access-chain base
 * (issue #480). The peek(dotParser) gate — `.` or `?.`, exactly the heads
 * dotMethodCallParser accepts — keeps bare `schema(T)` on its existing path
 * in every position. Once a dot is seen the user unambiguously meant a
 * chain (`schema` is reserved, and no valid program puts a postfix dot on
 * schema(T) without a chain element), so a malformed tail is a hard,
 * targeted parse error (parseError throws TarsecError; parseAgency converts
 * it to a message) instead of a backtrack into the stranded-suffix
 * "expected node body" failure. Mirrors parenAccessParser; the commit shape
 * mirrors angleBracketsArrayTypeParser. Non-dot chain heads ([i], (args))
 * stay non-committal by design and fall through to the bare atom. Chains
 * never allow whitespace before the dot (dotParser starts at the dot, for
 * every base), so the peek loses no multiline forms.
 */
export const schemaAccessParser: Parser<ValueAccess> = memo(
  "schemaAccessParser",
  map(
    seqC(
      capture(schemaExpressionParser, "base"),
      peek(dotParser),
      captureCaptures(
        parseError(
          "expected a method call after schema(...), e.g. schema(number).parseJSON(input)",
          capture(many1(chainElementParser), "chain"),
        ),
      ),
    ),
    (result) =>
      ({
        type: "valueAccess" as const,
        base: result.base as unknown as AgencyNode,
        chain: result.chain,
      }) as ValueAccess,
  ),
);
```

`dotParser` (parsers.ts:2355) is declared well above `schemaExpressionParser` (2643), so referencing it here has no module-init ordering issue.

Then insert into `baseAtom`, directly BEFORE `schemaExpressionParser`:

```ts
  schemaAccessParser,
  schemaExpressionParser,
```

If the produced node lacks a `loc` in the Step 1 assertions (compare the bind-first form), wrap the `map(...)` in `withLoc(...)` exactly as `valueAccessParser` (parsers.ts:2550) does.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/parsers/expression.test.ts > /tmp/i480-task1-green.log 2>&1`
Expected: PASS, including all pre-existing schemaExpression tests.

- [ ] **Step 5: Parser-suite sweep** (the new alternative sits in `baseAtom` — everything routes through it):

Run: `npx vitest run lib/parsers > /tmp/i480-task1-parsers.log 2>&1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/expression.test.ts
git commit -m "Parse schema(T) as an access-chain base in expression position (issue 480)"
```

---

### Task 2: Statement position (deliberate shape change)

**Files:**
- Modify: `lib/parsers/parsers.ts:2483-2495` (`_valueAccessParser`)
- Test: `lib/parsers/expression.test.ts`

**Interfaces:**
- Consumes: `schemaAccessParser` (Task 1).

- [ ] **Step 1: Write the failing test** — append inside the Task 1 describe block:

```ts
  it("statement position: chain on schema(...) is a schemaExpression-based access, not a call to schema", () => {
    // Parses TODAY as functionCall("schema") with the chain attached —
    // wrong node kind (undefined function, wrong codegen). Deliberate
    // shape change, spec section Design/site 2.
    const parsed = parseAgency('node main() {\n  schema(number).parseJSON("[1]")\n  return 1\n}', {}, false);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    const node = parsed.result.nodes.find((n) => n.type === "graphNode") as GraphNodeDefinition;
    const stmt = node.body.find((n) => n.type === "valueAccess" || n.type === "functionCall");
    expect(stmt).toMatchObject({
      type: "valueAccess",
      base: { type: "schemaExpression" },
    });
  });

  it("statement position: bare schema(T) keeps its legacy functionCall shape", () => {
    // The peek(dotParser) gate exists to preserve exactly this: a chainless
    // schema(T) statement still parses as a call to `schema` (checker flags
    // it as reserved/undefined), NOT as a schemaExpression statement.
    const parsed = parseAgency("node main() {\n  schema(number)\n  return 1\n}", {}, false);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    const node = parsed.result.nodes.find((n) => n.type === "graphNode") as GraphNodeDefinition;
    const stmt = node.body.find((n) => n.type === "functionCall");
    expect(stmt).toMatchObject({ type: "functionCall", functionName: "schema" });
  });

  it("assignment target: chained schema flips to a schemaExpression-based access", () => {
    // The assignment-target parser (parsers.ts:~3590) consumes
    // _valueAccessParser, so it sees the new shape too: the target of
    // `schema(number).foo = 5` was functionCall-based before this change.
    // Semantic nonsense either way (checker rejects); this pins the parse
    // shape so the change is deliberate, not incidental.
    const parsed = parseAgency("node main() {\n  schema(number).foo = 5\n  return 1\n}", {}, false);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    const node = parsed.result.nodes.find((n) => n.type === "graphNode") as GraphNodeDefinition;
    const assignment = node.body.find((n) => n.type === "assignment") as Assignment;
    expect(assignment.target ?? assignment.lhs).toMatchObject({
      type: "valueAccess",
      base: { type: "schemaExpression" },
    });
  });
```

NOTE for the executor: as in Task 1, verify the AST field names (`assignment.target` vs `lhs`, statement node types) against `pnpm run ast` output before running; the assertion intents must not be weakened.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/parsers/expression.test.ts > /tmp/i480-task2-red.log 2>&1`
Expected: the chained-statement test FAILS (parses today as `functionCall("schema")`, so the `toMatchObject` on `valueAccess` fails); the bare-statement pin PASSES already (it pins current behavior that must survive the change); the assignment-target pin FAILS (target is functionCall-based today).

- [ ] **Step 3: Implement.** In `_valueAccessParser`, after the `parenAccessParser` attempt and before the general `seqC`:

```ts
  // Schema-with-chain must be tried before the general base parsers:
  // `schema(number)` also matches _functionCallParser (as a call to an
  // undefined function named `schema`), which would mis-tag the base.
  // Call-time reference: schemaAccessParser is defined later in the module,
  // which is safe inside a function body (module fully initialized before
  // any parse runs) but would TDZ as a module-init value dependency.
  const schemaResult = schemaAccessParser(input);
  if (schemaResult.success) return schemaResult;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/parsers/expression.test.ts lib/parsers > /tmp/i480-task2-green.log 2>&1`
Expected: PASS across the parser suite (bare `schema(T)` statements still take the legacy functionCall path — only the chained form changed shape).

- [ ] **Step 5: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/expression.test.ts
git commit -m "Statement-position schema chains parse as schemaExpression-based access"
```

---

### Task 3: Checker pin + formatter round-trip

**Files:**
- Test: `lib/typeChecker/schemaType.test.ts`, `lib/backends/agencyGenerator.test.ts`

**Interfaces:**
- Consumes: parsing from Tasks 1-2. NO checker/formatter code changes expected — these pins prove the existing generic paths compose.

- [ ] **Step 1: Checker pin** — append to `lib/typeChecker/schemaType.test.ts`, adapting to that file's existing parse+typeCheck helper (if none, use the `check(source)` shape from `lib/typeChecker/matchExpression.test.ts:8-13`):

```ts
it("chained schema(...).parseJSON types like the bind-first form (issue #480)", () => {
  // One deliberate error pins that the chained call is Result-typed
  // (a bare `any` would silently pass the annotation).
  const errs = check(`node main() {
  const chained = schema(number).parseJSON("5")
  const s = schema(number)
  const bound = s.parseJSON("5")
  const n: number = schema(number).parseJSON("5")
  return 1
}`);
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/not assignable/);
});
```

- [ ] **Step 2: Formatter round-trip** — add to the round-trip `testCases` table in `lib/backends/agencyGenerator.test.ts` (same shape as the intersection rows):

```ts
{
  description: "schema chaining round-trips",
  input: 'def f(x: string) { const r = schema(number).parseJSON(x) }',
  expectedOutput: 'def f(x: string) {\nconst r = schema(number).parseJSON(x)\n}',
},
```

- [ ] **Step 3: Run both**

Run: `npx vitest run lib/typeChecker/schemaType.test.ts lib/backends/agencyGenerator.test.ts > /tmp/i480-task3.log 2>&1`
Expected: PASS with zero production-code changes. If either fails, STOP and diagnose — a failure here means the spec's "downstream is ready" claim is wrong and the fix needs a checker/formatter case, which is a plan deviation to record.

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/schemaType.test.ts lib/backends/agencyGenerator.test.ts
git commit -m "Pin checker typing and formatter round-trip for chained schema access"
```

---

### Task 4: Execution test + codegen fixture

**Files:**
- Create: `tests/agency/schema-chaining.agency`, `tests/agency/schema-chaining.test.json`
- Create: `tests/typescriptGenerator/schemaChaining.agency` (+ generated `.mjs`)

- [ ] **Step 1: Execution test.** Create `tests/agency/schema-chaining.agency`:

```
// Issue #480: method calls chained directly on schema(...) expressions.
// The accept node uses a type-grammar argument (number[]) that could never
// parse as a call argument, proving the chained form goes through the
// schema atom. No LLM calls.

node chainedAccept() {
  const r = schema(number[]).parseJSON("[1,2,3]")
  if (isSuccess(r)) {
    return r.value
  }
  return "failed"
}

node chainedReject() {
  const r = schema(number).parseJSON("\"not a number\"")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}
```

And `tests/agency/schema-chaining.test.json`:

```json
{
  "sourceFile": "schema-chaining.agency",
  "tests": [
    {
      "nodeName": "chainedAccept",
      "input": "",
      "expectedOutput": "[1,2,3]",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "Chained parseJSON accepts and returns the parsed value"
    },
    {
      "nodeName": "chainedReject",
      "input": "",
      "expectedOutput": "rejected",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "Chained parseJSON rejects a type mismatch"
    }
  ]
}
```

Mirror how sibling tests get their committed `.js` (schema-param-injection.js exists — check `docs/misc/TESTING.md` / `make fixtures` for whether it is generated or committed by hand) and produce it the same way.

- [ ] **Step 2: Run the execution test**

Run: `pnpm run agency test tests/agency/schema-chaining.agency > /tmp/i480-task4-exec.log 2>&1`
Expected: both nodes PASS. (Single-file agency tests are fine locally; no LLM calls involved.)

- [ ] **Step 3: Codegen fixture.** Create `tests/typescriptGenerator/schemaChaining.agency`:

```
node main() {
  const r = schema(number).parseJSON("[1]")
  print(r)
}
```

Run `make fixtures > /tmp/i480-task4-fixtures.log 2>&1`, then `git status --porcelain tests/typescriptGenerator/` — expected: ONLY `schemaChaining.agency` + its new `.mjs` appear. Any other fixture churn is a regression; STOP and diagnose. Eyeball the generated `.mjs`: the chained call must appear as a schema construction with `.parseJSON(...)` on it, not a call to a function named `schema`.

- [ ] **Step 4: Run the fixture suite**

Run: `npx vitest run lib/backends > /tmp/i480-task4-backends.log 2>&1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/schema-chaining.agency tests/agency/schema-chaining.test.json tests/agency/schema-chaining.js tests/typescriptGenerator/schemaChaining.agency tests/typescriptGenerator/schemaChaining.mjs
git commit -m "Execution test and codegen fixture for chained schema access"
```

(Adjust the `git add` list to whatever artifacts the conventions actually produce.)

---

### Task 5: Full verification + PR

- [ ] **Step 1: Build + linter + full lib suite**

```bash
make > /tmp/i480-task5-make.log 2>&1
pnpm run lint:structure > /tmp/i480-task5-lint.log 2>&1
npx vitest run lib > /tmp/i480-task5-tests.log 2>&1
```
Expected: all clean. `make` compiling the full stdlib is the strongest regression guard for the new `baseAtom` alternative. Revert any `docs/site/stdlib/data/usaspending.md` drift; delete any `a.vs.b.verdict.json`.

- [ ] **Step 2: Commit spec + plan docs to the branch** (repo-root `docs/superpowers/{specs,plans}` copies, as in prior PRs).

- [ ] **Step 3: Push and open the PR.** Body must include: `Fixes #480`; the two-site design and the `peek(".")`-commit rationale (bare schema untouched, dot = user intent, targeted `parseError` message with the exact text); the DELIBERATE statement-position shape change (functionCall("schema") → schemaExpression-based valueAccess) with its pin; the owner-requested parseError usage; scope-outs (`new Foo().bump()` sibling gap; non-dot chain heads on schema literals stay non-committal). Title: "Parse method chains on schema(...) expressions (#480)".

---

## Self-review notes

- Spec coverage: design/two sites → Tasks 1-2; parseError (owner ask) → Task 1 (message + pin); deliberate statement shape change → Task 2; downstream-ready claims → Task 3 pins (with a STOP if wrong); tests 1-5 of the spec → Tasks 1-4; non-goals need no task.
- The `peek(".")` commit is narrower than the spec's plain `many1` sketch — it is what makes the owner's parseError request safe (no hard failure on bare `schema(T)`); recorded here as the plan-level refinement of the spec, to be called out in the PR body.
- Known transcription checkpoints flagged inline (chain-element field names, parse-failure message field, `.js` artifact convention, `withLoc`) — each has a concrete resolution instruction, not a TBD.
- Type consistency: `schemaAccessParser` name and `Parser<ValueAccess>` shape consistent across Tasks 1-2; test helper names local to each file.
- Review round (2026-07-11, `2026-07-11-schema-chaining-review.md`) incorporated: gate widened from `peek(char("."))` to `peek(dotParser)` so `?.` chains commit; statement-position bare-schema pin and assignment-target shape pin added to Task 2; helper-skeleton verification extended in the Task 1 NOTE; `git fetch origin` added to worktree setup; whitespace/hard-commit safety arguments recorded in the parser doc comment.
