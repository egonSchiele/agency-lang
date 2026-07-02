# Match Expressions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2** — incorporates the review in `2026-07-01-match-expressions-feedback.md`: yield types resolved at check time via a matchId table (issues #1/#2/#12), `runner.exitMatch(matchId, value)` owns value storage (C1), try/finally clearing (#3/A1), `matchExprId` threaded into lowering instead of post-hoc mutation (A2), grammar-site enforcement of expression positions (#5 + Task 5 test review), module-level match error (#13), handler-skip design note (#4), and the expanded test matrices throughout.

**Goal:** Extend `match` to support multi-statement block arms, expression position (`const x = match(...)`, `return match(...)`), and `return`-yields-to-match semantics, per `docs/superpowers/specs/2026-07-01-match-expressions-design.md`.

**Architecture:** The parser gains block arm bodies (`MatchBlockCase.body` becomes `AgencyNode[]`) and match-expression parsing at exactly two grammar sites (assignment RHS, return value) — the v1 position restriction is structural. Pattern lowering (`lib/lowering/patternLowering.ts`, parse time) transforms expression matches into statements: arms whose `return`s become internal `matchYield` nodes, a match region tagged with `matchExprId`, and a consumer reading `__matchval_<id>`. The runtime `Runner` gains a `_matchExit` flag mirroring `_break`/`_continue`; `runner.exitMatch(matchId, value)` stores the yield and starts the skip-unwind, cleared by the owning `ifElse` in a try/finally. The TypeScript builder compiles arm bodies through `processBodyAsParts` so every arm statement gets its own interrupt-resume substep. The typechecker computes each match's type as the union of its `matchYield` value types via a per-scope pass, consulted through a matchId table (handles nesting).

**Tech Stack:** TypeScript, tarsec parser combinators, vitest, typestache mustache templates, the Agency runner runtime.

## Global Constraints

- All paths below are relative to `packages/agency-lang/`.
- Run `make` after changing stdlib files (CLAUDE.md).
- NEVER use dynamic imports; objects not maps; arrays not sets; types not interfaces (docs/dev/coding-standards.md).
- Reuse existing walkers/helpers before writing new ones (docs/dev/anti-patterns.md — check `lib/utils/node.ts` `walkNodesArray` and `grep -rn "walkNodes" lib/`).
- Do NOT run the full agency test suite locally; run only the tests named in each task, and save output to a file (`> /tmp/task-N.log 2>&1`) so failures never require a rerun.
- Write every commit message to a file and use `git commit -F <file>` (avoids the apostrophe/shell-quoting class of failures noted in CLAUDE.md).
- Agency syntax in tests must follow docs/site/guide/basic-syntax.md (`def name(): Type { }`, `if (cond) { }`, `let`/`const` declarations).
- Handlers are safety infrastructure. Design note for reviewers (spec §Semantics): handlers registered *after* the yield point in an arm are intentionally skipped during match-exit unwind, exactly as a function `return` skips subsequent registrations. Handlers registered *before* the yield must always fire. Task 8 tests both.
- Before writing any test that asserts AST node `.type` strings, verify the real strings with `pnpm run ast <sample.agency>` — do not guess (e.g. a call may be `functionCall` or `valueAccess`; confirm).

## Execution order and why

Tasks 1→8 build the feature. Task 9 migrates existing `.agency` code to `return match(...)`. Task 10 turns on the statement-position `return`-in-arm error LAST — enabling it earlier would break stdlib compilation before migration. Task 11 is docs.

---

### Task 1: Block arm bodies — AST + parser

**Files:**
- Modify: `lib/types/matchBlock.ts` (body type)
- Modify: `lib/parsers/parsers.ts:3003-3034` (`matchBlockParserCase`)
- Modify: `lib/lowering/patternLowering.ts` (foldArms:397, lowerMatchCase, buildIfChainFromGuardArms — every `arm.body` consumer)
- Modify: `lib/backends/typescriptBuilder.ts:1286-1313` (`processMatchBlockWithSteps`), `:3223+` (`processBlockPlain`)
- Modify: `lib/backends/agencyGenerator.ts:1133-1168` (`processMatchBlock`, minimal compile fix; full formatting in Task 2)
- Modify: the AST walker and any other consumers found by the inventory step
- Test: `lib/parsers/matchBlock.test.ts`

**Interfaces:**
- Produces: `MatchBlockCase.body: AgencyNode[]`. A single-expression arm parses as a one-element array. All later tasks assume this shape.

- [ ] **Step 1: Inventory every consumer of `MatchBlockCase`**

```bash
rg -n 'MatchBlockCase|matchBlockCase' lib/ > /tmp/task1-inventory.txt
rg -n 'caseItem\.body|arm\.body|caseNode\.body|c\.body' lib/ >> /tmp/task1-inventory.txt
rg -n 'walkNodes|walkNodesArray|transformNodes|mapNodes' lib/utils/ lib/typeChecker/ >> /tmp/task1-inventory.txt
```
Known consumers (the grep must find at least these): `patternLowering.ts` (foldArms:397 `this.lower([arm.body])`, `lowerMatchCase`, `buildIfChainFromGuardArms`), `typescriptBuilder.ts` (1299, 1307, `processBlockPlain` ~3240), `agencyGenerator.ts:1158`, `flowBuilder.ts:213` (arm-body flow walk), the generic AST walker (likely `walkNodesArray` in `lib/utils/node.ts`), and `matchExhaustiveness.ts` (reads `caseValue`/`guard` only — verify it never touches `body`). Every hit gets updated in this task so the package compiles. Record which walker exists — Tasks 6 and 10 reuse it.

- [ ] **Step 2: Establish real AST type strings**

Create a throwaway sample and inspect:
```bash
cat > /tmp/probe.agency <<'EOF'
node main() {
  print("hi")
  let y = 1
}
EOF
```
`pnpm run ast` requires the file inside the repo — write it to `tests/agency/.probe.agency` instead, run `pnpm run ast tests/agency/.probe.agency > /tmp/task1-ast.json`, note the exact `.type` for a call statement and a let-assignment, delete the probe file. Use those strings in the tests below (the plan writes `functionCall` and `assignment` as placeholders to correct).

- [ ] **Step 3: Write failing parser tests**

Append to `lib/parsers/matchBlock.test.ts` (uses the file's existing imports plus `toEqualWithoutLoc` conventions):

```typescript
describe("block arm bodies", () => {
  it("parses a multi-statement block arm with correct contents", () => {
    const result = matchBlockParser(`match(x) {
  "a" => {
    print("hi")
    let y = 1
  }
  _ => 0
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase");
      expect(cases[0].body.length).toBe(2);
      // exact type strings verified in Step 2; also assert CONTENT so a
      // dropped/mangled statement cannot pass on length alone:
      expect(cases[0].body[0].type).toBe("functionCall"); // ← corrected string
      expect(JSON.stringify(cases[0].body[0])).toContain("hi");
      expect(cases[0].body[1].type).toBe("assignment");
      expect(cases[0].body[1].variableName).toBe("y");
      expect(cases[1].body.length).toBe(1);
    }
  });

  it("parses single-expression arm as one-element body", () => {
    const result = matchBlockParser(`match(x) { "a" => 1; _ => 2 }`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase");
      expect(cases[0].body).toEqual([expect.objectContaining({ type: "number", value: "1" })]);
    }
  });

  it("parses a block arm ending in a return statement", () => {
    const result = matchBlockParser(`match(x) {
  "a" => {
    print("hi")
    return 1
  }
  _ => 0
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase");
      expect(cases[0].body[cases[0].body.length - 1].type).toBe("returnStatement");
    }
  });

  it("parses mixed single-expression and block arms", () => {
    const result = matchBlockParser(`match(x) {
  "a" => {
    print("a")
  }
  "b" => 2
  _ => {
    print("d")
  }
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase");
      expect(cases.map((c: any) => c.body.length)).toEqual([1, 1, 1]);
    }
  });

  it("parses semicolon-separated statements inside a block arm", () => {
    const result = matchBlockParser(`match(x) { "a" => { print("p"); let y = 1 } _ => 0 }`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase");
      expect(cases[0].body.length).toBe(2);
    }
  });

  it("parses an empty block arm as body: []", () => {
    const result = matchBlockParser(`match(x) { "a" => { } _ => 0 }`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase");
      expect(cases[0].body).toEqual([]);
    }
  });

  it("treats brace after arrow as a block: object-literal-looking content fails as statements", () => {
    const result = matchBlockParser(`match(x) {
  "a" => { label: "hi" }
  _ => 0
}`);
    expect(result.success).toBe(false);
  });

  it("positive twin: block form with an object literal return parses", () => {
    const result = matchBlockParser(`match(x) {
  "a" => { return { label: "hi" } }
  _ => 0
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase");
      expect(cases[0].body[0].type).toBe("returnStatement");
    }
  });

  it("parses a block arm with a guard, capturing both", () => {
    const result = matchBlockParser(`match(x) {
  y if (y > 2) => {
    print(y)
  }
  _ => 0
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase");
      expect(cases[0].guard).toBeDefined();
      expect(cases[0].body.length).toBe(1);
    }
  });

  it("parses a parenthesized object literal single-expression arm", () => {
    const result = matchBlockParser(`match(x) { _ => ({ label: "hi" }) }`);
    expect(result.success).toBe(true);
    if (result.success) {
      const cases = result.result.cases.filter((c: any) => c.type === "matchBlockCase");
      expect(JSON.stringify(cases[0].body[0])).toContain("label");
    }
  });
});
```
If the parenthesized-object-literal test fails because `exprParser`'s paren parser rejects object literals, decide: fix it if it is a small change to the parenParser passed to `buildExpressionParser` (parsers.ts:2602-2664); otherwise delete that test, use the block form everywhere (including Task 9 migration), and update the spec's `=> ({...})` rule to block-form-only. Record the decision in the commit message — Task 9 depends on it.

- [ ] **Step 4: Run tests to verify they fail**

```bash
pnpm test:run lib/parsers/matchBlock.test.ts > /tmp/task1-fail.log 2>&1
```
Expected: new tests FAIL; pre-existing tests PASS.

- [ ] **Step 5: Change the AST type**

`lib/types/matchBlock.ts`:
```typescript
export type MatchBlockCase = {
  type: "matchBlockCase";
  caseValue: MatchPattern | DefaultCase;
  guard?: Expression;
  body: AgencyNode[];
};
```

- [ ] **Step 6: Update `matchBlockParserCase`**

Above `matchBlockParserCase` in `parsers.ts`, following the `map(seqC(...))` house style of `_bodyParserImpl`:

```typescript
// `{ ... }` after `=>` is always a block, never an object literal (JS-arrow rule).
const matchArmBlockParser: Parser<AgencyNode[]> = map(
  seqC(
    char("{"),
    optionalSpacesOrNewline,
    capture(lazy(() => bodyParser), "body"),
    optionalSpacesOrNewline,
    char("}"),
  ),
  (result: { body: AgencyNode[] }) => result.body,
);
```
Change the body capture (line 3029) to:
```typescript
capture(
  or(
    matchArmBlockParser,
    map(
      or(returnStatementParser, lazy(() => assignmentParser), exprParser),
      (n: AgencyNode) => [n],
    ),
  ),
  "body",
),
```
`matchArmBlockParser` first, so `=> {` never reaches `exprParser`'s object-literal path. Check `bodyParser`'s tail behavior against the empty-block and semicolon tests — if `bodyParser` already consumes trailing whitespace up to `}`, the extra `optionalSpacesOrNewline` is harmless; if the empty-block test fails, `bodyParser` may require at least one node — wrap with `optional(...)` defaulting to `[]`.

- [ ] **Step 7: Update all body consumers (single-element compatible)**

- `patternLowering.ts` `foldArms` line 397: `this.lower([arm.body])` → `this.lower(arm.body)`; same one-liner in `lowerMatchCase` and `buildIfChainFromGuardArms`.
- `typescriptBuilder.ts` 1299/1307: `[this.processNode(caseItem.body)]` → `caseItem.body.map((b) => this.processNode(b))` (per-statement substeps come in Task 3). Same in `processBlockPlain` ~3240.
- `agencyGenerator.ts:1158` — direct, no sentinel:
  ```typescript
  const bodyCode =
    caseNode.body.length === 1
      ? this.processNode(caseNode.body[0]).trim()
      : `{ ${caseNode.body.map((b) => this.processNode(b).trim()).join("\n")} }`;
  ```
  (Task 2 replaces this with properly indented block printing.)
- The AST walker: descend into `matchBlockCase` body arrays.
- `flowBuilder.ts:213`: iterate the body array where it walks arm bodies.
- `pnpm run build` until clean; address every remaining `/tmp/task1-inventory.txt` hit.

- [ ] **Step 8: Run tests and sweep**

```bash
pnpm test:run lib/parsers/matchBlock.test.ts lib/typeChecker/matchExhaustiveness.test.ts lib/typeChecker/matchArmNarrowing.test.ts > /tmp/task1-pass.log 2>&1
pnpm test:run lib/ > /tmp/task1-sweep.log 2>&1
```
Expected: PASS. Generator integration fixtures must be byte-identical for single-statement arms (one-element `.map()` produces the same nodes).

- [ ] **Step 9: Commit**

```bash
printf 'feat(parser): match arms accept multi-statement block bodies\n' > /tmp/commitmsg
git add -A lib/ && git commit -F /tmp/commitmsg
```

---

### Task 2: Formatter — pretty block arms

**Files:**
- Modify: `lib/backends/agencyGenerator.ts:1133-1168` (`processMatchBlock`)
- Test: the formatter test file (locate: `ls lib/backends/*.test.ts`; create `lib/backends/agencyGenerator.matchBlock.test.ts` if match is uncovered)

**Interfaces:**
- Consumes: `MatchBlockCase.body: AgencyNode[]` (Task 1).
- Produces: `pnpm run fmt` round-trips block arms.

- [ ] **Step 1: Write failing round-trip tests**

Copy the parse-format-compare harness from an existing formatter test (format path parses with `lower: false`). Cases, each asserting BOTH `format(input) === input` (modulo harness whitespace convention) AND idempotence `format(format(input)) === format(input)`:

1. Multi-statement block arm (the Task 1 test source wrapped in `node main() { ... }`).
2. Single-expression arm stays inline (`"a" => 1` does not become a block).
3. Block arm with a guard: `y if (y > 2) => { print(y) }`.
4. Pattern arm block: `success(v) => { print(v)\n    return v }`.
5. Mixed inline and block arms in one match.
6. Parenthesized object-literal arm `_ => ({ label: "hi" })` stays parenthesized (skip if Task 1 Step 3 decided block-form-only).

- [ ] **Step 2: Verify failure** — `pnpm test:run <formatter test file> > /tmp/task2-fail.log 2>&1`.

- [ ] **Step 3: Implement block printing**

Replace the Task 1 minimal `bodyCode` with block emission copied from `processIfElse`'s body loop (line 1201+ — reuse its exact indent/newline discipline):

```typescript
// A one-statement body prints inline UNLESS the statement is itself a
// matchBlock: the single-statement arm grammar only accepts
// return/assignment/expression, so a nested match statement must print in
// block form to re-parse.
if (caseNode.body.length === 1 && caseNode.body[0].type !== "matchBlock") {
  result += this.indentStr(`${pattern}${guardCode} => ${this.processNode(caseNode.body[0]).trim()}\n`);
} else {
  result += this.indentStr(`${pattern}${guardCode} => {\n`);
  this.increaseIndent();
  // copy processIfElse's statement-emission loop here verbatim
  this.decreaseIndent();
  result += this.indentStr("}\n");
}
```

- [ ] **Step 4: Run** — `pnpm test:run <formatter test file> > /tmp/task2-pass.log 2>&1` (PASS), then `pnpm run fmt tests/typescriptGenerator/matchBlock.agency` and confirm no diff for single-statement arms.

- [ ] **Step 5: Commit** — `printf 'feat(fmt): print multi-statement match arms as blocks\n' > /tmp/commitmsg && git add -A lib/ && git commit -F /tmp/commitmsg`

---

### Task 3: Builder — per-statement substeps in arm bodies

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1286-1313` (`processMatchBlockWithSteps`)
- Test: `tests/typescriptGenerator/matchBlockBlockArms.agency` (new fixture)
- Test: `tests/agency/substeps/interrupt-in-match-arm.agency` + `.test.json` (new)

**Interfaces:**
- Produces: arm statements compile via `processBodyAsParts(body, nextStartId)` with unique substep id ranges per arm, exactly like `processIfElseWithSteps` (typescriptBuilder.ts:1169-1215). Tasks 4/8 rely on individually step-guarded arm statements.

- [ ] **Step 1: Create the generator fixture source**

`tests/typescriptGenerator/matchBlockBlockArms.agency`:
```
node main(x: string) {
  let out = ""
  match(x) {
    "a" => {
      print("first")
      out = "was a"
    }
    "b" => out = "was b"
    _ => {
      print("default")
      out = "other"
    }
  }
  return out
}
```

- [ ] **Step 2: Implement substep ranges (mirror `processIfElseWithSteps`)**

```typescript
private processMatchBlockWithSteps(node: MatchBlock): TsNode {
  const id = this.steps.currentId();
  const expression = this.processNode(node.expression);

  const filteredCases = node.cases.filter(
    (c) => c.type !== "comment",
  ) as MatchBlockCase[];

  const branches: { condition: TsNode; body: TsNode[] }[] = [];
  let elseBranch: TsNode[] | undefined;
  let nextStartId = 0;

  for (const caseItem of filteredCases) {
    const body = this.processBodyAsParts(caseItem.body, nextStartId);
    nextStartId += body.length;
    if (caseItem.caseValue === "_") {
      elseBranch = body;
    } else {
      branches.push({
        condition: ts.binOp(
          expression,
          "===",
          this.processNode(caseItem.caseValue as AgencyNode),
        ),
        body,
      });
    }
  }

  return ts.runnerIfElse({ id, branches, elseBranch });
}
```
`processBlockPlain` keeps the Task 1 `.map()` (handler bodies do not use substeps).

- [ ] **Step 3: Regenerate fixtures with a scripted assertion**

```bash
make fixtures > /tmp/task3-fixtures.log 2>&1
git diff --stat tests/typescriptGenerator/
# scripted checks (no eyeballing):
test "$(grep -c 'runner2\?\.step(' tests/typescriptGenerator/matchBlockBlockArms.mjs)" -ge 4 && echo STEPS-OK
grep -o 'step([0-9]*' tests/typescriptGenerator/matchBlockBlockArms.mjs | sort | uniq -d | tee /tmp/task3-dup-ids.txt
test ! -s /tmp/task3-dup-ids.txt && echo IDS-UNIQUE
```
Adjust the grep to the actual emitted runner variable name after looking at ONE line of the file. Expected: STEPS-OK (2+1+2 arm statements each step-wrapped, some may coalesce per `TYPES_THAT_DONT_TRIGGER_NEW_PART` — if coalescing changes the count, assert the actual count and note why) and IDS-UNIQUE. `matchBlock.mjs` will diff (step wrappers added) — verify the diff contains only step-wrapping changes.

- [ ] **Step 4: Write interrupt execution tests**

`tests/agency/substeps/interrupt-in-match-arm.agency` (verify `tests/helpers/mutableVar.js` exists — `checkpoint-in-match.agency` imports it with this path):
```
import { getMutable, setMutable } from "../../helpers/mutableVar.js"

node main(x: string) {
  setMutable("log", "start,")
  match(x) {
    "go" => {
      setMutable("log", getMutable("log", "") + "arm1,")
      interrupt("confirm")
      setMutable("log", getMutable("log", "") + "arm2,")
    }
    "first" => {
      interrupt("early")
      setMutable("log", getMutable("log", "") + "after-early,")
    }
    "last" => {
      setMutable("log", getMutable("log", "") + "pre,")
      interrupt("tail")
    }
    "twice" => {
      interrupt("one")
      setMutable("log", getMutable("log", "") + "mid,")
      interrupt("two")
      setMutable("log", getMutable("log", "") + "end,")
    }
    _ => setMutable("log", getMutable("log", "") + "other,")
  }
  return getMutable("log", "")
}
```
`tests/agency/substeps/interrupt-in-match-arm.test.json`:
```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Interrupt mid-arm resumes at the next statement; earlier statements do not re-run; other arms never fire",
      "input": "\"go\"",
      "expectedOutput": "\"start,arm1,arm2,\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve", "expectedMessage": "confirm" }]
    },
    {
      "nodeName": "main",
      "description": "Interrupt as the FIRST arm statement (substep 0) resumes into the rest of the arm",
      "input": "\"first\"",
      "expectedOutput": "\"start,after-early,\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve", "expectedMessage": "early" }]
    },
    {
      "nodeName": "main",
      "description": "Interrupt as the LAST arm statement completes the arm cleanly without re-running earlier statements",
      "input": "\"last\"",
      "expectedOutput": "\"start,pre,\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve", "expectedMessage": "tail" }]
    },
    {
      "nodeName": "main",
      "description": "Two interrupts in one arm advance substeps across both pauses",
      "input": "\"twice\"",
      "expectedOutput": "\"start,mid,end,\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [
        { "action": "approve", "expectedMessage": "one" },
        { "action": "approve", "expectedMessage": "two" }
      ]
    }
  ]
}
```

- [ ] **Step 5: Run**

```bash
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/substeps/interrupt-in-match-arm.test.json > /tmp/task3-exec.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/substeps/checkpoint-in-match.test.json >> /tmp/task3-exec.log 2>&1
pnpm test:run lib/backends > /tmp/task3-units.log 2>&1
```
Expected: all PASS.

- [ ] **Step 6: Commit** — `printf 'feat(codegen): per-statement interrupt substeps inside match arm bodies\n' > /tmp/commitmsg && git add -A lib/ tests/ && git commit -F /tmp/commitmsg`

---

### Task 4: Runner `_matchExit` + `matchYield` node + codegen

**Files:**
- Modify: `lib/runtime/runner.ts`
- Create: `lib/types/matchYield.ts`; register `MatchYield` in the `AgencyNode` union and the AST walker
- Modify: `lib/types/matchBlock.ts`, `lib/types/ifElse.ts` (`matchExprId?: number`)
- Modify: `lib/ir/tsIR.ts`, `lib/ir/builders.ts`, `lib/ir/prettyPrint.ts`
- Modify: `lib/templates/backends/typescriptGenerator/runnerIfElse.mustache` + `pnpm run templates`
- Modify: `lib/backends/typescriptBuilder.ts` (`processMatchYield` + dispatch; thread `matchId` in `processMatchBlockWithSteps`/`processIfElseWithSteps`)
- Test: the runtime Runner test file (locate: `ls lib/runtime/*.test.ts`; extend the closest, or create `lib/runtime/runner.matchExit.test.ts`)
- Test: prettyPrint snapshot test (co-located with existing `lib/ir/*.test.ts` conventions)

**Interfaces (consumed by Tasks 6/8):**
- AST: `type MatchYield = BaseNode & { type: "matchYield"; matchId: number; value?: Expression }`
- Runtime: `runner.exitMatch(matchId: number, value: unknown): void` — stores the value in the frame local `__matchval_<matchId>` (storage owned by the runner) and sets `_matchExit`. `runner.ifElse(id, branches, elseBranch?, opts?: { matchId?: number })` clears `_matchExit === opts.matchId` in a try/finally.
- Codegen: `matchYield` compiles to `runner.exitMatch(<matchId>, <value>); return;` — same halt+return shape as `processReturnStatement` (typescriptBuilder.ts:2730-2762).
- Concurrency note (spec v1 restriction #3 defense-in-depth): add a comment on `_matchExit` that it must never be set from a parallel/fork child — the Task 6 lowering error makes that unreachable; the flag is a scalar and would race.

- [ ] **Step 1: Write failing runtime unit tests**

First read the existing Runner test file found above and reuse its construction harness (a Runner needs a frame/state — copy the setup verbatim; if no Runner unit test exists, build the minimal state the constructor requires by following `setupNode` usage in any generated `tests/agency/substeps/*.js`). The required scenarios and assertions — all six must exist with these exact observable checks:

```typescript
describe("match exit propagation", () => {
  it("exitMatch stores the value and skips to the owning ifElse", async () => {
    const ran: string[] = [];
    await runner.ifElse(
      0,
      [{
        condition: async () => true,
        body: async (r) => {
          ran.push("before");
          r.exitMatch(7, "yielded");
          ran.push("unreachable"); // exitMatch does not throw; codegen adds `return;`
        },
      }],
      undefined,
      { matchId: 7 },
    );
    await runner.step(1, async () => { ran.push("after-match"); });
    expect(ran).toContain("after-match");           // flag cleared by owner
    expect(frameLocals()["__matchval_7"]).toBe("yielded"); // value stored by runner
  });

  it("a non-owning inner ifElse neither runs nor clears an outer exit", async () => {
    runner.exitMatch(1, "outer");
    const ran: string[] = [];
    await runner.ifElse(2, [{ condition: async () => true, body: async () => { ran.push("inner"); } }], undefined, { matchId: 2 });
    await runner.step(3, async () => { ran.push("after"); });
    expect(ran).toEqual([]); // inner skipped, flag still set, step skipped
  });

  it("nested matches: inner ifElse does not clear the outer id; outer does", async () => {
    const ran: string[] = [];
    await runner.ifElse(0, [{
      condition: async () => true,
      body: async (r) => {
        await r.ifElse(1, [{
          condition: async () => true,
          body: async (r2) => { r2.exitMatch(10, "from-inner-arm-of-OUTER"); },
        }], undefined, { matchId: 11 }); // inner match id 11 ≠ 10
        ran.push("outer-arm-after-inner"); // must be SKIPPED (exit 10 pending)
      },
    }], undefined, { matchId: 10 });
    await runner.step(2, async () => { ran.push("after-outer"); });
    expect(ran).toEqual(["after-outer"]);
  });

  it("exitMatch propagates through a nested non-match ifElse", async () => {
    const ran: string[] = [];
    await runner.ifElse(0, [{
      condition: async () => true,
      body: async (r) => {
        await r.ifElse(1, [{ condition: async () => true, body: async (r2) => { r2.exitMatch(5, 1); } }]); // plain if, no matchId
        ran.push("skipped");
      },
    }], undefined, { matchId: 5 });
    await runner.step(2, async () => { ran.push("after"); });
    expect(ran).toEqual(["after"]);
  });

  it("stops loop AND whileLoop iterations when a match exit is pending", async () => {
    // one test per primitive: exitMatch inside iteration 0; assert iteration 1 never runs
    // and the loop does NOT clear the flag (a following step is still skipped until
    // an owning ifElse would clear it).
  });

  it("clears the flag even when the branch body throws", async () => {
    await expect(
      runner.ifElse(0, [{
        condition: async () => true,
        body: async (r) => { r.exitMatch(9, "x"); throw new Error("boom"); },
      }], undefined, { matchId: 9 }),
    ).rejects.toThrow("boom");
    const ran: string[] = [];
    await runner.step(1, async () => { ran.push("after"); });
    expect(ran).toEqual(["after"]); // try/finally cleared the flag
  });

  it("_matchExit is not part of serialized checkpoint state", () => {
    runner.exitMatch(3, "v");
    const snapshot = JSON.stringify(serializeRunnerState()); // use the real serialization entry point (grep runner.ts / stateStack.ts for serialize)
    expect(snapshot).not.toContain("_matchExit");
    expect(snapshot).toContain("__matchval_3"); // the VALUE does serialize (it is a frame local)
  });
});
```
Replace `frameLocals()` / `serializeRunnerState()` with the harness's real accessors. If the halt-signal pattern (runner.ts:429 `HaltSignal`) means branch bodies communicate exits by throwing, adapt the "unreachable" assertion accordingly — read `halt()` usage in one generated `.js` first.

- [ ] **Step 2: Verify failure** — `pnpm test:run <runner test file> > /tmp/task4-fail.log 2>&1` (exitMatch not a function).

- [ ] **Step 3: Implement runner changes**

```typescript
// next to _break/_continue (runner.ts:239)
/** Pending match-expression exit: the matchId whose owning ifElse will clear
 *  this. Mirrors _break/_continue unwind. NEVER serialized (transient unwind
 *  state; interrupts cannot fire while skipping). Must never be set from a
 *  parallel/fork child — the lowering forbids returns across concurrency
 *  boundaries; this scalar would race. */
private _matchExit: number | null = null;

/** Yield `value` from a match arm: store it as the match result and skip
 *  everything until the owning ifElse (matchId) consumes the flag. */
exitMatch(matchId: number, value: unknown): void {
  this.frame.locals[`__matchval_${matchId}`] = value;
  this._matchExit = matchId;
}
```
- `shouldSkip()`: add `|| this._matchExit !== null` to BOTH returns (lines 280, 293).
- `ifElse(...)`: add `opts?: { matchId?: number }` as the 4th parameter and wrap the entire existing body (after the top `shouldSkip` early-return) in:
  ```typescript
  try {
    ...existing branch-selection and execution...
  } finally {
    if (opts?.matchId !== undefined && this._matchExit === opts.matchId) {
      this._matchExit = null;
    }
  }
  ```
  The top-of-method `if (this.shouldSkip()) return;` stays OUTSIDE the try — an outer construct owns the flag there.
- `loop()` (~838) and `whileLoop()` (~902): alongside `if (this._break) break;` add `if (this._matchExit !== null) break;`. Do NOT touch `_matchExit` in the flag resets at 817-818/842-843/881-882/906-907.

- [ ] **Step 4: Run runtime tests** — `pnpm test:run lib/runtime > /tmp/task4-runtime.log 2>&1`, PASS.

- [ ] **Step 5: AST node, IR, template, builder**

`lib/types/matchYield.ts`:
```typescript
import { BaseNode, Expression } from "../types.js";

/** Internal node produced by pattern lowering for `return` inside a match arm
 *  when the match is used as an expression. Never produced by the parser. */
export type MatchYield = BaseNode & {
  type: "matchYield";
  matchId: number;
  value?: Expression;
};
```
Register in the `AgencyNode` union and the AST walker (one child: `value`). Add `matchExprId?: number` to `MatchBlock` and `IfElse`.

`lib/ir/tsIR.ts` — extend `TsRunnerIfElse` (:364) with `matchId?: number`; add (follow the file's local interface convention):
```typescript
/** runner.exitMatch(matchId, value); return; */
export interface TsRunnerExitMatch {
  kind: "runnerExitMatch";
  matchId: number;
  value: TsNode;
}
```
`lib/ir/builders.ts`:
```typescript
runnerExitMatch(opts: { matchId: number; value: TsNode }): TsRunnerExitMatch {
  return { kind: "runnerExitMatch", ...opts };
},
```
`lib/ir/prettyPrint.ts` — read the `runnerHalt` case FIRST and copy its runner-variable naming and indent handling exactly:
```typescript
case "runnerExitMatch": {
  const value = printTs(node.value, 0);
  // <runnerVar> below = whatever identifier the runnerHalt case emits
  return [
    `<runnerVar>.exitMatch(${node.matchId}, ${value});`,
    `return;`,
  ].map((line) => " ".repeat(indent * 2) + line).join("\n");
}
```
`runnerIfElse` case (:386-400): pass `matchId: node.matchId`, `hasMatchId: node.matchId !== undefined` into `renderRunnerIfElse`. Template `runnerIfElse.mustache` last line becomes:
```
]{{#hasElse}}, async (runner) => {
{{{elseBranch}}}
}{{/hasElse}}{{#hasMatchId}}{{^hasElse}}, undefined{{/hasElse}}, { matchId: {{{matchId}}} }{{/hasMatchId}});
```
Run `pnpm run templates` (CLAUDE.md: never edit the generated `.ts`).

`typescriptBuilder.ts`:
```typescript
private processMatchYield(node: MatchYield): TsNode {
  const value = node.value ? this.processNode(node.value) : ts.id("undefined");
  return ts.runnerExitMatch({ matchId: node.matchId, value });
}
```
Dispatch next to the `returnStatement` case. In `processMatchBlockWithSteps` and `processIfElseWithSteps`, add `matchId: node.matchExprId` to the `ts.runnerIfElse({...})` call.

- [ ] **Step 6: PrettyPrint snapshot tests for the template arg**

In the ir test conventions (`ls lib/ir/*.test.ts`), three cases printing a `runnerIfElse` node: (a) no else, no matchId — output must be BYTE-IDENTICAL to before this task (assert no `undefined` or `matchId` appears); (b) matchId without else — `..., undefined, { matchId: 5 });`; (c) matchId with else — `...}, { matchId: 5 });`. Plus one `runnerExitMatch` case asserting the two emitted lines.

- [ ] **Step 7: Sweep and prove zero fixture drift**

```bash
pnpm run build && pnpm test:run lib/ir lib/backends lib/runtime > /tmp/task4-sweep.log 2>&1
make fixtures > /tmp/task4-fixtures.log 2>&1 && git diff --exit-code tests/typescriptGenerator/ && echo NO-DRIFT
```
Expected: PASS and NO-DRIFT (nothing sets `matchExprId` yet — proves the template change is inert for existing code).

- [ ] **Step 8: Commit** — `printf 'feat(runtime): match-exit propagation flag and matchYield codegen\n' > /tmp/commitmsg && git add -A lib/ && git commit -F /tmp/commitmsg`

---

### Task 5: Match in expression grammar — two sites only

**Files:**
- Modify: `lib/types.ts:79-92` (`Expression` union gains `MatchBlock`)
- Modify: `lib/parsers/parsers.ts` (factor `matchBlockExprParser`; wire into `assignmentParser` RHS :3353 and `returnStatementParser` :2677)
- Test: `lib/parsers/matchBlock.test.ts`

**Interfaces:**
- Produces: `const x = match(...) {...}` and `return match(...) {...}` parse with `MatchBlock` as the `value`. Any other expression position does NOT parse — the v1 restriction is structural (spec v1 restrictions #1). Task 6 consumes these shapes.

- [ ] **Step 1: Write failing parser tests**

```typescript
describe("match as expression (assignment RHS and return only)", () => {
  it("parses match as assignment RHS", () => {
    const result = assignmentParser(`const val = match(r) {
  "a" => 1
  _ => 2
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.declKind).toBe("const");
      expect((result.result.value as any).type).toBe("matchBlock");
    }
  });

  it("parses return match(...)", () => {
    const result = returnStatementParser(`return match(r) {
  "a" => 1
  _ => 2
}`);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.result.value as any).type).toBe("matchBlock");
    }
  });

  it("still parses a call to a function named match", () => {
    const result = assignmentParser(`const y = match(r)`);
    expect(result.success).toBe(true);
    if (result.success) expect((result.result.value as any).type).not.toBe("matchBlock");
  });

  it("backtracks past the closing paren: match(r) + 1 is a binop over a call", () => {
    const result = assignmentParser(`const y = match(r) + 1`);
    expect(result.success).toBe(true);
    if (result.success) expect((result.result.value as any).type).toBe("binOpExpression");
  });

  it("match block as a function argument does not parse (v1 restriction)", () => {
    const result = assignmentParser(`const y = f(match(r) { "a" => 1; _ => 2 })`);
    expect(result.success).toBe(false);
  });

  it("match block as a binop operand does not parse (v1 restriction)", () => {
    const result = assignmentParser(`const y = 1 + match(r) { "a" => 1; _ => 2 }`);
    expect(result.success).toBe(false);
  });

  it("no trailing over-consumption: next statement still parses", () => {
    const result = bodyParser(`const a = match(x) {
  "a" => 1
  _ => 2
}
const b = 2
`);
    expect(result.success).toBe(true);
    if (result.success) {
      const assigns = result.result.filter((n: any) => n.type === "assignment");
      expect(assigns.length).toBe(2);
    }
  });
});
```
(`bodyParser` is exported at parsers.ts:3673; adjust filtering for newline nodes.)

- [ ] **Step 2: Verify failure** — the first two and the last FAIL today.

- [ ] **Step 3: Implement**

1. Add `MatchBlock` to the `Expression` union (`lib/types.ts:79-92`) — needed for `Assignment.value`/`ReturnStatement.value` typing.
2. Factor the parser. The current `matchBlockParser` consumes trailing `optionalSemicolon, optionalSpacesOrNewline`; the expression form must not:
   ```typescript
   // Core form, no trailing statement whitespace — used at expression sites.
   export const matchBlockExprParser = label("a match expression", withLoc(seqC(
     set("type", "matchBlock"),
     str("match"),
     optionalSpaces,
     char("("),
     capture(exprParser, "expression"),
     char(")"),
     optionalSpaces,
     char("{"),
     captureCaptures(
       parseError(
         "expected match cases of the form `value => expression` separated by `;` or newlines, followed by `}`",
         optionalSpacesOrNewline,
         capture(many(or(blankLineParser, commentParser, matchBlockParserCase)), "cases"),
         optionalSpaces,
         char("}"),
       ),
     ),
   )));

   export const matchBlockParser = label("a match block", map(
     seqC(
       capture(matchBlockExprParser, "block"),
       optionalSemicolon,
       optionalSpacesOrNewline,
     ),
     (r: { block: MatchBlock }) => r.block,
   ));
   ```
3. Wire the two sites (NOT `baseAtom` — expression positions beyond these two must stay parse errors):
   - `assignmentParser` RHS (parsers.ts:3353): `capture(or(lazy(() => messageThreadParser), lazy(() => matchBlockExprParser), exprParser), "value")`. Ordering matters: `matchBlockExprParser` before `exprParser`, or `match(r)` parses as a call and the `{` orphans. Backtracking: tarsec's `or` retries alternatives on failure (the existing `caseLhsParser` relies on this); the `match(r) + 1` test proves it — if it fails because tarsec commits after consumption, wrap the alternative in tarsec's attempt/backtrack combinator (check `node_modules/tarsec/dist/combinators.d.ts` for the name).
   - `returnStatementParser` value (parsers.ts:2677): same `or(lazy(() => matchBlockExprParser), exprParser)`.
   - Check the assignment variants funnel through the same RHS (`modifiedAssignmentParser` :3431, `bodyOptimizeAssignmentParser` :3486) — they do if they reuse `_assignmentParserInner`; verify.

- [ ] **Step 4: Run** — `pnpm test:run lib/parsers > /tmp/task5-pass.log 2>&1`, PASS.

- [ ] **Step 5: Commit** — `printf 'feat(parser): match expressions at assignment RHS and return sites\n' > /tmp/commitmsg && git add -A lib/ && git commit -F /tmp/commitmsg`

---

### Task 6: Lowering — expression matches, yield rewriting, all-paths checks

**Files:**
- Modify: `lib/lowering/patternLowering.ts`
- Create: `lib/lowering/loweringError.ts`
- Modify: `lib/parser.ts:276-281` (lowering errors → parse failure)
- Modify: `lib/types.ts` — `Assignment.matchExprSource?: { matchId: number }`; co-locate `EXPRESSION_NODE_TYPES` with the `Expression` union
- Test: `lib/lowering/patternLowering.matchExpr.test.ts` (new)

**Interfaces:**
- Consumes: `MatchBlock` as `Assignment.value`/`ReturnStatement.value` (Task 5); `MatchYield`, `matchExprId` fields (Task 4).
- Produces (consumed by Tasks 7/8):
  - `const x = match(E) {...}` → `[ ...loweredMatchStatements, Assignment{ ...original, value: varRef("__matchval_<id>"), matchExprSource: { matchId } } ]`.
  - `return match(E) {...}` → `[ ...loweredMatchStatements, ReturnStatement{ value: varRef("__matchval_<id>") } ]`.
  - The lowered match root carries `matchExprId` — attached at construction by passing the id INTO `lowerMatchBlock` (no post-hoc mutation): pass-through `MatchBlock` gets it; pattern path sets it on both the scrutinee `Assignment` (for exhaustiveness) and the root `IfElse` of the fold.
  - Every yield site in the lowered region is a `MatchYield { matchId }` node in place (Task 7 finds them by walking; no expression references are stored).
  - `LoweringError { message, loc? }` thrown for: statement-position-return (Task 10 enables), all-paths violations, bare return, is-form expression, concurrency-boundary return, module-level match expression.

- [ ] **Step 1: Write failing lowering tests**

`lib/lowering/patternLowering.matchExpr.test.ts`. Harness: `parseAgency(source)` runs lowering; verify the node-definition type string via `pnpm run ast` before writing the helper (plan placeholder `nodeDefinition`):

```typescript
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

function lowerBody(src: string): any[] {
  const parsed = parseAgency(src);
  if (!parsed.success) throw new Error(parsed.message);
  const main = parsed.result.nodes.find(
    (n: any) => n.type === "nodeDefinition" || n.type === "functionDefinition",
  );
  return main.body;
}

describe("expression match lowering", () => {
  it("literal arms: temp + tagged match + consumer with matching ids", () => {
    const body = lowerBody(`node main() {
  const val = match("a") {
    "a" => 1
    _ => 2
  }
  return val
}`);
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    expect(matchStmt.matchExprId).toBeTypeOf("number");
    const arm = matchStmt.cases.find((c: any) => c.type === "matchBlockCase");
    expect(arm.body[0].type).toBe("matchYield");
    expect(arm.body[0].matchId).toBe(matchStmt.matchExprId);
    expect(arm.body[0].value).toEqual(expect.objectContaining({ type: "number", value: "1" }));
    const assign = body.find((n: any) => n.type === "assignment" && n.variableName === "val");
    expect(assign.value.value).toBe(`__matchval_${matchStmt.matchExprId}`);
    expect(assign.matchExprSource.matchId).toBe(matchStmt.matchExprId);
    expect(body.indexOf(matchStmt)).toBeLessThan(body.indexOf(assign));
  });

  it("rewrites return in block arms to matchYield with the right value", () => {
    const body = lowerBody(`node main() {
  const val = match("a") {
    "a" => {
      print("hi")
      return 1
    }
    _ => 2
  }
  return val
}`);
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    const arm = matchStmt.cases.find((c: any) => c.type === "matchBlockCase");
    const y = arm.body.find((s: any) => s.type === "matchYield");
    expect(y.value).toEqual(expect.objectContaining({ type: "number", value: "1" }));
    expect(arm.body.some((s: any) => s.type === "returnStatement")).toBe(false);
  });

  it("return match(...) lowers to statements-then-return of the temp", () => {
    const body = lowerBody(`def f(x: string): number {
  return match(x) {
    "a" => 1
    _ => 2
  }
}`);
    const ret = body[body.length - 1];
    expect(ret.type).toBe("returnStatement");
    const matchStmt = body.find((n: any) => n.type === "matchBlock");
    expect(ret.value.value).toBe(`__matchval_${matchStmt.matchExprId}`);
  });

  it("pattern arms: scrutinee hoisted once, before the tagged chain", () => {
    const body = lowerBody(`node main(r: Result) {
  const val = match(r) {
    success(v) => v
    failure(e) => 0
  }
  return val
}`);
    const scrutinee = body.find((n: any) => n.type === "assignment" && n.matchSource);
    const chain = body.find((n: any) => n.type === "ifElse");
    expect(scrutinee.matchExprId).toBeTypeOf("number");
    expect(chain.matchExprId).toBe(scrutinee.matchExprId);
    expect(body.indexOf(scrutinee)).toBeLessThan(body.indexOf(chain));
  });

  it("guarded arms in expression position lower and yield", () => {
    const body = lowerBody(`node main(x: any) {
  const val = match(x) {
    { kind: "n", v } if (v > 0) => v
    _ => 0
  }
  return val
}`);
    expect(body.some((n: any) => n.matchExprId !== undefined)).toBe(true);
  });

  it("nested return match(...) inside an arm lowers inner-first", () => {
    const body = lowerBody(`node main(x: string) {
  const val = match(x) {
    "a" => {
      return match(x) {
        "a" => 1
        _ => 2
      }
    }
    _ => 3
  }
  return val
}`);
    const outer = body.find((n: any) => n.type === "matchBlock" && n.matchExprId !== undefined);
    const arm = outer.cases.find((c: any) => c.type === "matchBlockCase");
    // arm body: [ ...inner lowered statements..., matchYield(varRef __matchval_inner) ]
    const inner = arm.body.find((s: any) => s.type === "matchBlock" && s.matchExprId !== undefined);
    const y = arm.body.find((s: any) => s.type === "matchYield");
    expect(inner.matchExprId).not.toBe(outer.matchExprId);
    expect(y.matchId).toBe(outer.matchExprId);
    expect(y.value.value).toBe(`__matchval_${inner.matchExprId}`);
    expect(arm.body.indexOf(inner)).toBeLessThan(arm.body.indexOf(y));
  });
});

describe("expression match lowering errors", () => {
  function expectError(src: string, re: RegExp) {
    const parsed = parseAgency(src);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.message).toMatch(re);
  }
  const WRAP = (arm: string) => `node main(x: any) {
  const val = match(x) {
    ${arm}
    _ => 2
  }
  return val
}`;

  it("if without else does not yield on all paths", () =>
    expectError(WRAP(`"a" => {\n      if (true) { return 1 }\n    }`), /must return a value/i));
  it("if with non-yielding else errors", () =>
    expectError(WRAP(`"a" => {\n      if (true) { return 1 } else { print("no") }\n    }`), /must return a value/i));
  it("if with both branches yielding passes", () => {
    const parsed = parseAgency(WRAP(`"a" => {\n      if (true) { return 1 } else { return 2 }\n    }`));
    expect(parsed.success).toBe(true);
  });
  it("trailing yield after a non-yielding if passes", () => {
    const parsed = parseAgency(WRAP(`"a" => {\n      if (true) { return 1 }\n      return 2\n    }`));
    expect(parsed.success).toBe(true);
  });
  it("loop-only return does not count (syntactic rule)", () =>
    expectError(WRAP(`"a" => {\n      for (i in x) { return 1 }\n    }`), /must return a value/i));
  it("empty block arm errors", () =>
    expectError(WRAP(`"a" => { }`), /must return a value/i));
  it("assignment is not mistaken for a yield", () =>
    expectError(WRAP(`"a" => {\n      let y = 1\n    }`), /must return a value/i));
  it("bare return errors", () =>
    expectError(WRAP(`"a" => { return }`), /must return a value/i));
  it("return inside parallel in an arm errors", () =>
    expectError(WRAP(`"a" => {\n      parallel {\n        return 1\n      }\n    }`), /parallel|concurrency/i));
  it("match(x is ...) in expression position errors", () =>
    expectError(`node main(x: any) {\n  const val = match(x is { k }) {\n    _ => 2\n  }\n  return val\n}`, /cannot be used as an expression/i));
  it("module-level match expression errors", () =>
    expectError(`const g = match("a") {\n  "a" => 1\n  _ => 2\n}\nnode main() { return g }`, /module-level|top-level/i));
});
```
(Adjust the `parallel` block syntax to a real sample from `tests/agency/` before running; if `parallel` requires branches, use the actual form.)

- [ ] **Step 2: Verify failure** — `pnpm test:run lib/lowering/patternLowering.matchExpr.test.ts > /tmp/task6-fail.log 2>&1`.

- [ ] **Step 3: `LoweringError` + parse-failure channel**

`lib/lowering/loweringError.ts`:
```typescript
import { SourceLocation } from "../types/base.js";

export class LoweringError extends Error {
  loc?: SourceLocation;
  constructor(message: string, loc?: SourceLocation) {
    super(message);
    this.name = "LoweringError";
    this.loc = loc;
  }
}
```
In `lib/parser.ts` around :280, wrap `lowerPatterns` in try/catch; on `LoweringError`, return the same failure-object shape `parseAgency` uses for parse errors (read its other failure paths and copy the construction — message plus line from `e.loc`). Rethrow anything else.

- [ ] **Step 4: Implement the lowering**

All in `PatternLowerer`. Signature change (fixes anti-pattern A2 — tag at construction):

```typescript
private lowerMatchBlock(node: MatchBlock, matchExprId?: number): AgencyNode[]
```
- Pass-through path (:269-275): spread `matchExprId` into the returned node.
- Pattern path: set `matchExprId` on the scrutinee `Assignment` (:279) and on the root `IfElse` returned by `buildIfChainFromArms`.
- `lowerMatchIsForm`: if called with `matchExprId !== undefined`, throw `LoweringError("match(x is pattern) cannot be used as an expression; use it as a statement", node.loc)`.

Entry points:
```typescript
// in lowerAssignment, before existing value handling:
if (node.value && (node.value as AgencyNode).type === "matchBlock") {
  if (this.isModuleLevel) {
    throw new LoweringError(
      "match expressions are not supported in module-level initializers",
      node.loc,
    );
  }
  const region = this.lowerMatchExpressionCore(node.value as MatchBlock, node.loc);
  return [
    ...region.statements,
    { ...node, value: region.valueRef, matchExprSource: { matchId: region.matchId } },
  ];
}
```
`isModuleLevel`: the lowerer walks top-level nodes then recurses into bodies — track a depth flag set when descending into a node/def body (check how `lowerPatterns`/`this.lower` distinguish top level; if they do not, thread a boolean through the initial call).

```typescript
// in the returnStatement handling of this.lower:
if (node.value && (node.value as AgencyNode).type === "matchBlock") {
  const region = this.lowerMatchExpressionCore(node.value as MatchBlock, node.loc);
  return [...region.statements, { ...node, value: region.valueRef }];
}
```

Core:
```typescript
private lowerMatchExpressionCore(
  match: MatchBlock,
  loc: SourceLocation | undefined,
): { statements: AgencyNode[]; valueRef: Expression; matchId: number } {
  const matchId = this.counter++;
  const cases = match.cases.map((c) =>
    c.type === "matchBlockCase"
      ? { ...c, body: this.rewriteArmForYield(c.body, matchId, c) }
      : c,
  );
  const statements = this.lowerMatchBlock({ ...match, cases }, matchId);
  return { statements, valueRef: varRef(`__matchval_${matchId}`, loc), matchId };
}
```

Arm rewriting (uses `EXPRESSION_NODE_TYPES`, a runtime const co-located with the `Expression` union in `lib/types.ts` — check first whether an `isExpression` predicate already exists: `rg -n "isExpressionNode|EXPRESSION_NODE" lib/`):
```typescript
private rewriteArmForYield(
  body: AgencyNode[],
  matchId: number,
  arm: MatchBlockCase,
): AgencyNode[] {
  if (body.length === 1 && isExpressionNode(body[0])) {
    return [{ type: "matchYield", matchId, value: body[0] as Expression, loc: body[0].loc }];
  }
  const rewritten = this.rewriteReturnsToYields(body, matchId);
  if (!this.alwaysYields(rewritten)) {
    const loc =
      body[0]?.loc ??
      (arm.caseValue === "_" ? undefined : (arm.caseValue as AgencyNode).loc);
    throw new LoweringError(
      "match arm must return a value on every path when the match is used as an expression",
      loc,
    );
  }
  return rewritten;
}

private rewriteReturnsToYields(body: AgencyNode[], matchId: number): AgencyNode[] {
  const out: AgencyNode[] = [];
  for (const stmt of body) {
    switch (stmt.type) {
      case "returnStatement": {
        if (!stmt.value) {
          throw new LoweringError(
            "match arm must return a value on every path when the match is used as an expression",
            stmt.loc,
          );
        }
        if ((stmt.value as AgencyNode).type === "matchBlock") {
          // nested return match(...): lower inner first, yield its temp
          const inner = this.lowerMatchExpressionCore(stmt.value as MatchBlock, stmt.loc);
          out.push(...inner.statements);
          out.push({ type: "matchYield", matchId, value: inner.valueRef, loc: stmt.loc });
        } else {
          out.push({ type: "matchYield", matchId, value: stmt.value, loc: stmt.loc });
        }
        break;
      }
      case "ifElse":
        out.push({
          ...stmt,
          thenBody: this.rewriteReturnsToYields(stmt.thenBody, matchId),
          elseBody: stmt.elseBody
            ? this.rewriteReturnsToYields(stmt.elseBody, matchId)
            : undefined,
        });
        break;
      case "forLoop":
      case "whileLoop":
        out.push({ ...stmt, body: this.rewriteReturnsToYields(stmt.body, matchId) });
        break;
      case "matchBlock":
        out.push(stmt); // inner match owns its arm returns
        break;
      default: {
        if (isConcurrencyBlock(stmt) && containsReturn([stmt])) {
          throw new LoweringError(
            "cannot return from a match arm inside a parallel, fork, race, seq, or thread block",
            stmt.loc,
          );
        }
        out.push(stmt);
      }
    }
  }
  return out;
}

private alwaysYields(body: AgencyNode[]): boolean {
  for (const stmt of body) {
    if (stmt.type === "matchYield") return true;
    if (
      stmt.type === "ifElse" &&
      stmt.elseBody &&
      this.alwaysYields(stmt.thenBody) &&
      this.alwaysYields(stmt.elseBody)
    ) {
      return true;
    }
    // loops never count (syntactic all-paths rule, spec v1 restrictions #4)
  }
  return false;
}
```
Helpers:
- `isConcurrencyBlock(n)`: type is one of the real parallel/seq/fork/race/thread node type strings — verify with `rg -n '"parallelBlock"|"forkBlock"|"raceBlock"|"seqBlock"|"messageThread"' lib/types*` and use what exists.
- `containsReturn(nodes)`: use the walker identified in Task 1 (`walkNodesArray` or equivalent) filtered to `returnStatement`, EXCLUDING descents into nested `matchBlock` arm bodies (inner arms own their returns — same boundary as `rewriteReturnsToYields`). If the walker cannot express skip-subtrees, write the small recursion but document why the walker was insufficient.
- Note the `??` precedence fix in `rewriteArmForYield`'s loc fallback (explicit parens around the ternary).

Interaction note (feedback #7): nested expression matches in arm bodies that are NOT `return match(...)` (e.g. `const y = match(...)` as an arm statement) are handled later, when `lowerMatchBlock` → `foldArms`/`lowerMatchCase` runs `this.lower(arm.body)` — the recursive lowering dispatches `lowerAssignment` → the entry point above. The nested-match test in Step 1 plus a `const`-in-arm variant proves both routes; add that variant:
```typescript
it("const x = match(...) inside an arm body lowers via recursion", () => { /* same shape as nested test, assignment form */ });
```

- [ ] **Step 5: Run** — `pnpm test:run lib/lowering > /tmp/task6-pass.log 2>&1`, then `pnpm test:run lib/ > /tmp/task6-sweep.log 2>&1`. Pre-existing behavior untouched (statement matches unchanged — statement-position arm returns still compile as function returns until Task 10).

- [ ] **Step 6: Commit** — `printf 'feat(lowering): expression-position match lowers to matchval temp and matchYield arms\n' > /tmp/commitmsg && git add -A lib/ && git commit -F /tmp/commitmsg`

---

### Task 7: Typechecker — union typing + exhaustiveness hard error

**Files:**
- Create: `lib/typeChecker/matchExprTypes.ts` (the per-scope type pass)
- Modify: `lib/typeChecker/index.ts` (invoke it between `buildFlowGraphs` :316 and `checkScopes` :320)
- Modify: `lib/typeChecker/synthesizer.ts` (`__matchval_` lookup in the `variableName` case)
- Modify: `lib/typeChecker/inference.ts` (export `unionTypes` :159)
- Modify: `lib/typeChecker/utils.ts` (promote :134-141 into `emitAssignabilityError(actual, expected, loc, context, ctx)`; `checkType` calls it — no copy-paste)
- Modify: `lib/typeChecker/scopes.ts` (`checkAssignmentValue` :187 handles `matchExprSource`)
- Modify: `lib/typeChecker/flowBuilder.ts` (register `matchYield.value` as an expression occurrence so narrowing applies)
- Modify: `lib/typeChecker/matchExhaustiveness.ts` (`isExpression` severity)
- Modify: `lib/typeChecker/types.ts` (`TypeCheckerContext.matchExprTypes: Record<number, VariableType | "any">`)
- Test: `lib/typeChecker/matchExpression.test.ts` (new)

**Interfaces:**
- Consumes: `matchExprSource: { matchId }`, `matchExprId` tags, in-place `MatchYield` nodes (Task 6).
- Produces: `ctx.matchExprTypes[matchId]` = union of that match's yield types; `const val = match(...)` gives `val` that union; annotations check against it; expression-match exhaustiveness is a hard error.

- [ ] **Step 1: Write failing typechecker tests**

`lib/typeChecker/matchExpression.test.ts`, using the exact `check()` harness from `matchExhaustiveness.test.ts` (parseAgency → buildCompilationUnit → typeCheck → messages). Where a test needs the inferred type rather than an error, use a deliberate mismatch to force a diagnostic that NAMES the type:

```typescript
const TRY = `def tryParse(input: string): Result {
  if (input == "ok") {
    return success(42)
  }
  return failure("bad input")
}`;

it("annotation mismatch is exactly one assignability error", () => {
  const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  const val: boolean = match(r) {
    success(v) => "yes"
    failure(e) => "no"
  }
  return val
}`);
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/val/);
  expect(errs[0]).toMatch(/boolean/);
});

it("compatible annotation: no errors", () => {
  const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  const val: string = match(r) {
    success(v) => "yes"
    failure(e) => "no"
  }
  return val
}`);
  expect(errs).toEqual([]);
});

it("synthesis: union flows to downstream use", () => {
  // val: number | string; using it where boolean is required must error and
  // the message must mention the union members.
  const errs = check(`node main(x: string) {
  const val = match(x) {
    "a" => 1
    _ => "s"
  }
  const flag: boolean = val
  return flag
}`);
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/number/);
  expect(errs[0]).toMatch(/string/);
});

it("narrowed bindings type the yields (Result value flows through)", () => {
  // v is narrowed to the success payload; v is returned directly. Annotating
  // val as string must error mentioning number (payload of success(42)).
  const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  const val: string = match(r) {
    success(v) => v
    failure(e) => "fallback"
  }
  return val
}`);
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/number/);
});

it("nested expression match: inner union feeds the outer yield", () => {
  const errs = check(`node main(x: string) {
  const val: boolean = match(x) {
    "a" => {
      return match(x) {
        "b" => 1
        _ => 2
      }
    }
    _ => 3
  }
  return val
}`);
  expect(errs.length).toBe(1);
  expect(errs[0]).toMatch(/number/);
});

it("an any-typed yield collapses the union to any (no errors)", () => {
  const errs = check(`node main(x: any) {
  const val: boolean = match("k") {
    "k" => x
    _ => 1
  }
  return val
}`);
  expect(errs).toEqual([]);
});

it("expression exhaustiveness is a hard error even under silent config", () => {
  const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  const val = match(r) {
    success(v) => 1
  }
  return val
}`, { typechecker: { matchExhaustiveness: "silent" } });
  expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(true);
});

it("guarded arm does not count toward expression exhaustiveness", () => {
  const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  const val = match(r) {
    success(v) if (v > 0) => 1
    failure(e) => 0
  }
  return val
}`);
  expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(true);
});

it("statement match exhaustiveness still honors silent config", () => {
  const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match(r) {
    success(v) => print(v)
  }
  return 0
}`, { typechecker: { matchExhaustiveness: "silent" } });
  expect(errs).toEqual([]);
});
```

- [ ] **Step 2: Verify failure** — `pnpm test:run lib/typeChecker/matchExpression.test.ts > /tmp/task7-fail.log 2>&1`.

- [ ] **Step 3: Implement the type pass**

`lib/typeChecker/matchExprTypes.ts`:
```typescript
/** Computes the value type of every expression match: the union of its
 *  matchYield value types. Runs after buildScopes + buildFlowGraphs so scope
 *  types and narrowing are available, before checkScopes so consumers can
 *  read ctx.matchExprTypes. matchIds are computed in DESCENDING order per
 *  scope: inner matches have higher ids (the lowerer recurses inner-last), and
 *  an outer match's yield may be varRef(__matchval_<inner>). */
export function computeMatchExprTypes(scopes: ScopeInfo[], ctx: TypeCheckerContext): void {
  for (const info of scopes) {
    const yieldsByMatch: Record<number, MatchYield[]> = {};
    for (const { node } of walkNodes(info.body)) {
      if (node.type === "matchYield") {
        (yieldsByMatch[node.matchId] ??= []).push(node);
      }
    }
    const ids = Object.keys(yieldsByMatch).map(Number).sort((a, b) => b - a);
    for (const id of ids) {
      const types = yieldsByMatch[id].map((y) =>
        y.value ? synthType(y.value, info.scope, ctx) : "any",
      );
      ctx.matchExprTypes[id] = types.some((t) => t === "any")
        ? "any"
        : unionTypes(types as VariableType[]);
    }
  }
}
```
- Register `matchExprTypes: {}` in `makeContext` (index.ts:113) and the `TypeCheckerContext` type.
- `synthesizer.ts` `variableName` case: before the flow/scope lookup, if the name matches `/^__matchval_(\d+)$/`, return `ctx.matchExprTypes[Number(match[1])] ?? "any"`. (This makes the descending-order recursion work: synthing an outer yield that references an inner temp reads the already-computed inner entry.)
- Scope var type for the consumer: buildScopes ran BEFORE this pass and synthed `varRef(__matchval_N)` to "any" for the declared variable. Find where buildScopes records assignment-inferred types (`rg -n "synthType" lib/typeChecker/scopes.ts`); after computing the table, patch those entries: for each scope assignment with `matchExprSource`, set the variable's recorded type to `node.typeHint ?? ctx.matchExprTypes[matchId]`. If buildScopes instead synthesizes lazily at use sites, the `__matchval_` synthType hook already covers it — determine which by reading the code, and delete the patch step if lazy.
- `checkAssignmentValue` (scopes.ts:187): when `node.matchExprSource` is set and `node.typeHint` exists, compute `actual = ctx.matchExprTypes[node.matchExprSource.matchId]`, and call the promoted `emitAssignabilityError` helper when `actual !== "any" && !isAssignable(actual, node.typeHint, aliases)`. Skip the normal `checkType(node.value, ...)` for these assignments.
- `flowBuilder.ts`: register `matchYield` statements so `node.value` becomes a flow-graph expression occurrence (mirror how a bare expression statement or return value is walked) — this is what lets `success(v) => v` synth `v` at its narrowed type.
- `utils.ts`: extract lines 134-141 into `emitAssignabilityError(...)`; `checkType` uses it (single construction site).

- [ ] **Step 4: Exhaustiveness hard error**

`matchExhaustiveness.ts`:
- `MatchSite` gains `isExpression: boolean`; `normalizeSite` sets it from `node.matchExprId !== undefined` in both shapes (assignment :212, matchBlock :225).
- Severity restructure at :246: read `configured`; do not early-return on `silent` (expression sites still checked); in `checkSite`, `const severity = site.isExpression ? "error" : configured;` and skip when `severity === "silent"`.

- [ ] **Step 5: Run** — `pnpm test:run lib/typeChecker > /tmp/task7-pass.log 2>&1`. All pre-existing exhaustiveness/narrowing tests must stay green.

- [ ] **Step 6: Commit** — `printf 'feat(typechecker): union typing and hard exhaustiveness for match expressions\n' > /tmp/commitmsg && git add -A lib/ && git commit -F /tmp/commitmsg`

---

### Task 8: End-to-end — generator fixture + execution tests

**Files:**
- Create: `tests/typescriptGenerator/matchExpression.agency` (+ generated `.mjs`)
- Create: `tests/agency/matchExpression.agency` + `.test.json`
- Create: `tests/agency/substeps/interrupt-in-match-expression.agency` + `.test.json`
- Create: `tests/agency/substeps/interrupt-in-match-in-loop.agency` + `.test.json`
- Create: `tests/agency/substeps/handler-in-match-arm.agency` + `.test.json`

- [ ] **Step 1: Generator fixture with scripted assertions**

`tests/typescriptGenerator/matchExpression.agency`:
```
node main(x: string) {
  const val = match(x) {
    "a" => {
      print("in a")
      return 1
    }
    "b" => 2
    _ => {
      if (x == "z") {
        return 26
      }
      return 0
    }
  }
  return val
}
```
```bash
make fixtures > /tmp/task8-fixtures.log 2>&1
MJS=tests/typescriptGenerator/matchExpression.mjs
grep -q 'matchId:' $MJS && echo OPTS-OK
test "$(grep -c 'exitMatch(' $MJS)" -eq 4 && echo YIELDS-OK      # 4 yield sites
grep -q '__matchval_' $MJS && echo CONSUMER-OK
```
Then read the file once to sanity-check the mid-arm return sits inside a nested `ifElse` with the trailing yield as a separate step — but the scripted greps above are the record.

- [ ] **Step 2: Basic execution tests (split per scenario, side effects logged)**

`tests/agency/matchExpression.agency`:
```
import { getMutable, setMutable } from "../helpers/mutableVar.js"

def classify(x: number): string {
  return match(x) {
    0 => "zero"
    _ => {
      if (x > 100) {
        return "big"
      }
      return "small"
    }
  }
}

def onceScrutinee(): string {
  setMutable("scrutcount", getMutable("scrutcount", 0) + 1)
  return "hit"
}

node classifyAll() {
  return [classify(0), classify(500), classify(5)]
}

node blockArmSideEffect() {
  setMutable("log", "")
  const d = match("zero") {
    "zero" => {
      setMutable("log", "checking,")
      return "was zero"
    }
    _ => "not zero"
  }
  return getMutable("log", "") + d
}

node scrutineeOnce() {
  setMutable("scrutcount", 0)
  const r = match(onceScrutinee()) {
    "hit" => {
      let pad = 1
      return "matched"
    }
    _ => "no"
  }
  return [r, getMutable("scrutcount", 0)]
}

node nestedMatch(x: string) {
  return match(x) {
    "outer" => {
      return match("inner") {
        "inner" => "both"
        _ => "half"
      }
    }
    _ => "neither"
  }
}

node returnMatchInLoop() {
  setMutable("log", "")
  for (i in range(3)) {
    const tag = match(i) {
      0 => "z"
      _ => {
        if (i == 2) {
          return "two"
        }
        return "other"
      }
    }
    setMutable("log", getMutable("log", "") + tag + ",")
  }
  return getMutable("log", "")
}
```
`tests/agency/matchExpression.test.json` — one entry per node:
```json
{
  "tests": [
    { "nodeName": "classifyAll", "input": "", "expectedOutput": "[\"zero\",\"big\",\"small\"]", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "blockArmSideEffect", "input": "", "expectedOutput": "\"checking,was zero\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "scrutineeOnce", "input": "", "expectedOutput": "[\"matched\",1]", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "nestedMatch", "input": "\"outer\"", "expectedOutput": "\"both\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "returnMatchInLoop", "input": "", "expectedOutput": "\"z,two,other,\"", "evaluationCriteria": [{ "type": "exact" }] }
  ]
}
```
Wait — `returnMatchInLoop` expected output: i=0 → "z", i=1 → falls to `_`, `i == 2` false → "other", i=2 → "two". So `"z,other,two,"`. Use that. (This kind of trace-through belongs in the test description; double-check each expected value by hand before committing.)
Also verify the mid-arm-return-in-for scenario (feedback #8): `nestedMatch` plus `returnMatchInLoop` cover exit propagation through nested if and loop-adjacent flows without interrupts.

- [ ] **Step 3: Interrupt in expression match**

`tests/agency/substeps/interrupt-in-match-expression.agency`:
```
import { getMutable, setMutable } from "../../helpers/mutableVar.js"

node main(x: string) {
  setMutable("log", "start,")
  const val = match(x) {
    "go" => {
      setMutable("log", getMutable("log", "") + "before,")
      interrupt("proceed?")
      setMutable("log", getMutable("log", "") + "after,")
      return "approved"
    }
    _ => "skipped"
  }
  return getMutable("log", "") + val
}
```
`.test.json`:
```json
{
  "tests": [
    {
      "nodeName": "main",
      "description": "Yielded value survives pause/resume; earlier arm statements do not re-run",
      "input": "\"go\"",
      "expectedOutput": "\"start,before,after,approved\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "interruptHandlers": [{ "action": "approve", "expectedMessage": "proceed?" }]
    }
  ]
}
```

- [ ] **Step 4: Match expression in a loop with an interrupt**

`tests/agency/substeps/interrupt-in-match-in-loop.agency`:
```
import { getMutable, setMutable } from "../../helpers/mutableVar.js"

node main() {
  setMutable("log", "")
  for (i in range(3)) {
    const label = match(i) {
      1 => {
        interrupt("at one")
        return "ONE"
      }
      _ => "n${i}"
    }
    setMutable("log", getMutable("log", "") + label + ",")
  }
  return getMutable("log", "")
}
```
`.test.json` (expected `"n0,ONE,n2,"`): proves iteration 0 took `_`, iteration 1 resumed into the `1` arm and yielded, iteration 2 re-matched `_` (condbranch reset). A stale-`__matchval` failure mode cannot occur by construction — all-paths-yield guarantees a write before every read — note this as a comment in the `.agency` file.

- [ ] **Step 5: Handlers in block arms — both required assertions**

`tests/agency/substeps/handler-in-match-arm.agency` — first read one existing handle-block test (`rg -l "handle" tests/agency/ | head -3`, read one) and use its exact `handle`/raise syntax. The file must encode BOTH scenarios, and the `.test.json` must assert BOTH:
1. **Normal path:** a `handle` registered as an arm statement, the handled event raised later in the same arm → handler fires (log entry present).
2. **Resume path:** same registration, but an `interrupt()` sits between the `handle` statement and the raise; approve it; the handler must STILL fire after resume (this is the handler-re-registration-across-resume guarantee — the reason CLAUDE.md calls handlers safety infrastructure).
Additionally assert the negative from the design note: a `handle` placed textually AFTER a mid-arm `return` (inside an `if` that yields) does NOT fire when the yield path is taken — the arm unwound before registration, mirroring function-return semantics.
If handle-blocks cannot be raised within the same node in existing test patterns, split scenario 3 into whatever observable the existing handler tests use. Do not weaken the two required assertions.

- [ ] **Step 6: Run everything**

```bash
for t in tests/agency/matchExpression.test.json \
         tests/agency/substeps/interrupt-in-match-expression.test.json \
         tests/agency/substeps/interrupt-in-match-in-loop.test.json \
         tests/agency/substeps/handler-in-match-arm.test.json; do
  AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test $t >> /tmp/task8-exec.log 2>&1
done
```
Expected: all PASS. Debug via the generated `.js` next to each `.agency`.

- [ ] **Step 7: Commit** — `printf 'test: end-to-end match expression fixtures and interrupt/handler execution tests\n' > /tmp/commitmsg && git add -A tests/ && git commit -F /tmp/commitmsg`

---

### Task 9: Migrate existing Agency code to `return match(...)`

**Files (inventory from the migration sweep; re-grep to catch drift):**
- Modify: `tests/agency/graphEdges.agency`
- Modify: `tests/agency/pattern-matching/`: `resultPatternMatch`, `matchGuardFallthrough`, `patternMatch`, `resultPatternNested`, `resultPatternNestedObject`, `resultPatternMatchIs`, `matchIsForm`, `matchIsFailure` (`.agency` files)
- Modify: `stdlib/ui.agency` (~1618-1626, ~1871-1893), `stdlib/policy.agency` (~746-766)
- Modify: `lib/agents/agency-agent/agent.agency` (~922-923), `lib/agents/agency-agent/prompts/codeSample.agency` (~22-24)

- [ ] **Step 1: Re-run the inventory**

```bash
rg -n '=> return' --include-zero -g '*.agency' tests/ stdlib/ lib/ > /tmp/task9-inventory.txt
rg -n '=> return \{' -g '*.agency' stdlib/ lib/ >> /tmp/task9-inventory.txt   # multiline object bodies
```

- [ ] **Step 2: Rewrite all-arms-return matches to `return match(...)`**

Example — `resultPatternMatch.agency` `describe`:
```
def describe(input: string): string {
  let r = tryParse(input)
  return match(r) {
    success(v) => "got ${v}"
    failure(e) => "err: ${e}"
  }
}
```
(Trailing `return "unreachable"` deleted — exhaustive.) Apply mechanically to: `matchGuardFallthrough` (guards stay; `_` covers; drop `return "fallthrough"`), `patternMatch`, `resultPatternNested`, `resultPatternNestedObject`, `graphEdges`, both `stdlib/ui.agency` dispatchers, `stdlib/policy.agency`, `agent.agency`, `codeSample.agency`. Object-literal bodies (`ui.agency:1871`, `policy.agency:746-766`) use whichever form Task 1 Step 3 decided (`pat => ({ ... })` or `pat => { return { ... } }`) — grep for BOTH old forms and rewrite consistently to the chosen one.

- [ ] **Step 3: Restructure is-form matches (statement-only in v1)**

`matchIsForm.agency`, `matchIsFailure.agency`, `resultPatternMatchIs.agency`: rewrite arms from `cond => return X` to assignments plus a final return:
```
let out = ""
match(x is { type: "user", age }) {
  age >= 18 => out = "adult"
  _ => out = "minor"
}
return out
```
Keep patterns/guards; `.test.json` expected outputs must remain byte-identical — do not touch them.

- [ ] **Step 4: Rebuild and run affected tests**

```bash
make > /tmp/task9-make.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/pattern-matching > /tmp/task9-exec.log 2>&1
AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/graphEdges.test.json >> /tmp/task9-exec.log 2>&1
rg -l "handleKeyEvent|policy" tests/agency-js/ | head   # run any stdlib-covering suites found
```
Expected: PASS with unchanged expected outputs.

- [ ] **Step 5: Commit** — `printf 'refactor: migrate arm-level returns to return match(...) expressions\n' > /tmp/commitmsg && git add -A tests/ stdlib/ lib/ && git commit -F /tmp/commitmsg`

---

### Task 10: Forbid `return` in statement-position match arms

**Files:**
- Modify: `lib/lowering/patternLowering.ts` (`lowerMatchBlock`, `lowerMatchIsForm`)
- Test: `lib/lowering/patternLowering.matchExpr.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

```typescript
describe("statement-position return-in-arm errors", () => {
  function expectError(src: string, re: RegExp) {
    const parsed = parseAgency(src);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.message).toMatch(re);
  }

  it("single-statement return arm errors with the fixit", () =>
    expectError(`def f(x: string): string {
  match(x) {
    "a" => return "yes"
    _ => print("no")
  }
  return "no"
}`, /return match\(/));

  it("return nested in an if inside a block arm errors", () =>
    expectError(`def f(x: string): string {
  match(x) {
    "a" => {
      if (true) { return "yes" }
      print("hm")
    }
    _ => print("no")
  }
  return "no"
}`, /return match\(/));

  it("bare return in a statement arm errors", () =>
    expectError(`def f(x: string): string {
  match(x) {
    "a" => { return }
    _ => print("no")
  }
  return "no"
}`, /return match\(/));

  it("return inside a for loop inside a statement arm errors", () =>
    expectError(`def f(xs: any): string {
  match("k") {
    "k" => {
      for (x in xs) { return "found" }
    }
    _ => print("no")
  }
  return "no"
}`, /return match\(/));

  it("return-free statement arms still parse", () => {
    const parsed = parseAgency(`def f(x: string): string {
  match(x) {
    "a" => print("fine")
    _ => print("also fine")
  }
  return "ok"
}`);
    expect(parsed.success).toBe(true);
  });

  it("boundary: inner EXPRESSION match returns are legal inside an outer statement match arm", () => {
    const parsed = parseAgency(`def f(x: string): string {
  match(x) {
    "a" => {
      const v = match(x) {
        "a" => {
          return "inner-yield"
        }
        _ => "other"
      }
      print(v)
    }
    _ => print("no")
  }
  return "ok"
}`);
    expect(parsed.success).toBe(true);
  });

  it("boundary: statement match nested inside an expression-match arm still errors on ITS arm returns", () =>
    expectError(`node main(x: string) {
  const val = match(x) {
    "a" => {
      match(x) {
        "b" => return "illegal"
        _ => print("ok")
      }
      return "yield"
    }
    _ => "other"
  }
  return val
}`, /return match\(/));
});
```

- [ ] **Step 2: Verify** — all but the two positive cases FAIL (they currently parse).

- [ ] **Step 3: Implement**

In `lowerMatchBlock` (and `lowerMatchIsForm`), when `matchExprId === undefined` (statement position), scan each arm's ORIGINAL body with the Task 6 `containsReturn` (same nested-`matchBlock` boundary — an inner match's arms are its own concern; note bare `return` counts) and throw:
```typescript
throw new LoweringError(
  "`return` inside a match arm yields the match's value, but this match's value is unused — did you mean `return match(...)`?",
  offendingLoc,
);
```
Expression matches never hit this: Task 6 rewrote their returns to `matchYield` before `lowerMatchBlock` runs (any surviving `returnStatement` there belongs to an inner statement match, which is checked on its own recursion).

- [ ] **Step 4: Run + prove migration completeness**

```bash
pnpm test:run lib/ > /tmp/task10-sweep.log 2>&1
make > /tmp/task10-make.log 2>&1
```
Expected: PASS and clean build. Any failure = an unmigrated file; fix in Task 9 style.

- [ ] **Step 5: Commit** — `printf 'feat(lowering): error on return inside statement-position match arms\n' > /tmp/commitmsg && git add -A lib/ && git commit -F /tmp/commitmsg`

---

### Task 11: Documentation

**Files:**
- Modify: `docs/site/guide/pattern-matching.md`, `docs/dev/interrupts.md`, `docs/site/guide/basic-syntax.md` (if it enumerates expression forms)
- Modify: changelog (locate; the `util:changelog` skill may apply)

- [ ] **Step 0: Check for doc-directory guidance** — `find docs -name "AGENTS.md" | xargs -r ls` and follow any instructions relevant to the files below.

- [ ] **Step 1: Guide (`docs/site/guide/pattern-matching.md`)**

Add a "Match expressions" section: expression position (assignment RHS and `return match(...)` only — others are parse errors), implicit single-expression yields, block arms with explicit `return`, the `return`-yields rule with the migration before/after from the spec, the `=> ({...})`-or-block object-literal rule (whichever Task 1 decided), all-paths-yield errors, hard exhaustiveness, and the v1 restrictions (is-form statement-only; no returns across parallel/fork/race/seq/thread in arms; no module-level match initializers). Fix line ~201: exhaustiveness defaults to **error**.

- [ ] **Step 2: Dev doc (`docs/dev/interrupts.md`)**

Rewrite the "Match blocks" section (~:80): per-statement substeps like if/else; document `exitMatch(matchId, value)`/`_matchExit` next to break/continue; `__matchval_<id>` serializes as a frame local, no loop reset needed (write-before-read). Fix the stale template references (only `runnerIfElse.mustache` exists; loop resets live in `lib/runtime/runner.ts:828-836, 892-899`).

- [ ] **Step 3: Changelog** — breaking-change entry with the spec's before/after.

- [ ] **Step 4: Verify docs build and no stale examples**

```bash
rg -n '=> return' docs/site/guide/ && echo STALE-EXAMPLES-FOUND || echo GUIDE-CLEAN
# run the doc generation used by CI if stdlib doc comments changed:
pnpm run agency doc --help > /tmp/task11-doc.log 2>&1 || true  # find the real invocation in docs/site/cli/doc.md
```
Fix any `docs/site/guide/` example that still uses arm-level function returns.

- [ ] **Step 5: Commit** — `printf 'docs: match expressions guide, interrupts dev doc, changelog\n' > /tmp/commitmsg && git add -A docs/ && git commit -F /tmp/commitmsg`

---

## Self-review results

- **Spec coverage:** syntax → Tasks 1/2/5; return semantics → 4/6; breakage/migration → 9/10; expression rules → 6/7; runner/interrupts → 3/4/8; testing matrix → 1/3/5-8/10; docs → 11; every v1 restriction has both an enforcement site (grammar: positions; lowering: is-form, module-level, concurrency, all-paths) and a test.
- **Review items addressed:** #1/#2/#12 (check-time yield resolution + `matchExprTypes` table + descending-id ordering), #3/A1 (try/finally + throw test), #4 (design note + Task 8 Step 5 negative assertion), #5 (grammar-site wiring + backtracking tests), #6 (containsReturn boundary + loop-yield test), #7 (recursion note + const-in-arm test), #8 (returnMatchInLoop/nestedMatch e2e), #9 (runner comment), #10 (bodyParser tail check), #11 (template snapshot tests + NO-DRIFT check), #13 (module-level error + test), #14 (AGENTS.md step), A2 (matchExprId threaded into lowerMatchBlock), A3 (walker reuse), A4/D1/D2 (direct ternary + documented matchBlock guard), B1 (emitAssignabilityError helper), B2 (EXPRESSION_NODE_TYPES co-located), C1 (exitMatch owns storage), F1/G1 (typed guards, full names).
- **Type consistency check:** `exitMatch(matchId: number, value: unknown)` used consistently in Tasks 4 (impl+tests), 6 (interface note), 8 (fixture grep); `matchExprSource: { matchId: number }` in Tasks 6/7; `matchExprId?: number` on `MatchBlock`/`IfElse` in Tasks 4/6/7; `__matchval_<id>` naming identical in Tasks 4/6/7/8.
