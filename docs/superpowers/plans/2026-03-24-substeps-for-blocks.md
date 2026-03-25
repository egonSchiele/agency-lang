# Substeps for Block-Level State Serialization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable precise mid-block resumption after interrupts by adding substep guards inside if/else block bodies.

**Architecture:** Add a `subStep` field to `TsStepBlock` for generic substep support. Add a new `TsIfSteps` IR node that handles condbranch tracking and substep guard emission for if/else blocks, using Mustache templates for the generated code. Replace `processIfElse` in the builder with `processIfElseWithSteps` which produces `TsIfSteps` nodes. No runtime changes.

**Tech Stack:** TypeScript, Vitest, typestache (Mustache templates), Agency compiler pipeline

**Spec:** `docs/superpowers/specs/2026-03-24-substeps-for-blocks-design.md`

---

### Task 1: Extend TsStepBlock IR with subStep field

This adds generic substep support to `TsStepBlock`. While `TsIfSteps` handles if/else specifically, the `subStep` field on `TsStepBlock` will be used by `TsIfSteps` for wrapping individual statements within branch bodies, and will later be reused for match blocks, thread blocks, etc.

**Files:**
- Modify: `lib/ir/tsIR.ts:277-283`
- Modify: `lib/ir/builders.ts:355-362`
- Modify: `lib/ir/prettyPrint.ts:242-250`
- Modify or create: `lib/ir/prettyPrint.test.ts`

- [ ] **Step 1: Add `subStep` field to `TsStepBlock` interface**

In `lib/ir/tsIR.ts`, add the optional `subStep` field:

```typescript
/** A resumable step block — wraps body in `if (__step <= N) { ... __stack.step++; }`.
 * When subStep is set, uses substep variable names instead (e.g. __sub_3, __substep_3). */
export interface TsStepBlock {
  kind: "stepBlock";
  stepIndex: number;
  body: TsNode;
  branchCheck?: boolean;
  subStep?: number[];
}
```

- [ ] **Step 2: Update the `stepBlock` builder function**

In `lib/ir/builders.ts`, add the optional `subStep` parameter:

```typescript
stepBlock(
  stepIndex: number,
  body: TsNode,
  _branchCheck?: boolean,
  _subStep?: number[],
): TsStepBlock {
  const branchCheck = _branchCheck ?? false;
  return { kind: "stepBlock", stepIndex, body, branchCheck, subStep: _subStep };
},
```

- [ ] **Step 3: Write unit tests for substep pretty printing**

In `lib/ir/prettyPrint.test.ts`, add tests:

```typescript
it("should emit substep guards when subStep is set", () => {
  const node = ts.stepBlock(
    0,
    ts.raw("await print('hello');"),
    false,
    [3],
  );
  const result = printTs(node);
  expect(result).toContain("__sub_3 <= 0");
  expect(result).toContain("__stack.locals.__substep_3");
  expect(result).not.toContain("__stack.step++");
});

it("should emit nested substep variable names", () => {
  const node = ts.stepBlock(
    0,
    ts.raw("await print('hello');"),
    false,
    [3, 1],
  );
  const result = printTs(node);
  expect(result).toContain("__sub_3_1 <= 0");
  expect(result).toContain("__stack.locals.__substep_3_1");
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test:run`
Expected: FAIL — the current stepBlock case doesn't handle subStep.

- [ ] **Step 5: Update the stepBlock case in prettyPrint**

In `lib/ir/prettyPrint.ts`, update the `"stepBlock"` case:

```typescript
case "stepBlock": {
  const stepBody = printBody(node.body, indent);
  if (node.subStep) {
    const subKey = node.subStep.join("_");
    const guardVar = `__sub_${subKey}`;
    const counterExpr = `__stack.locals.__substep_${subKey}`;
    return `if (${guardVar} <= ${node.stepIndex}) {\n` +
      `${stepBody}\n` +
      `${ind(indent + 1)}${counterExpr} = ${node.stepIndex + 1};\n${ind(indent)}}`;
  }
  const guard = node.branchCheck
    ? `if (__step <= ${node.stepIndex} || (__stack.branches && __stack.branches[${node.stepIndex}])) {`
    : `if (__step <= ${node.stepIndex}) {`;
  return `${guard}\n` +
    `${stepBody}\n` +
    `${ind(indent + 1)}__stack.step++;\n${ind(indent)}}`;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test:run`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add lib/ir/tsIR.ts lib/ir/builders.ts lib/ir/prettyPrint.ts lib/ir/prettyPrint.test.ts
git commit -m "feat: add subStep field to TsStepBlock for substep guard support"
```

---

### Task 2: Create Mustache templates for TsIfSteps code generation

The pretty-print logic for `TsIfSteps` is complex (condbranch evaluation, const declarations, branch dispatch with substep guards). Use Mustache templates to keep the generated code readable and maintainable.

**Files:**
- Create: `lib/templates/backends/typescriptGenerator/ifStepsCondbranch.mustache`
- Create: `lib/templates/backends/typescriptGenerator/ifStepsBranchDispatch.mustache`

Templates are compiled to TypeScript via typestache (`pnpm run templates`). The generated `.ts` files export a `default` render function. See existing templates like `lib/templates/backends/typescriptGenerator/interruptReturn.mustache` for the pattern.

- [ ] **Step 1: Create the condbranch evaluation template**

Create `lib/templates/backends/typescriptGenerator/ifStepsCondbranch.mustache`:

```mustache
if ({{{condbranchStore}}} === undefined) {
{{#branches}}
  {{#first}}if{{/first}}{{^first}}} else if{{/first}} ({{{condition}}}) {
    {{{condbranchStore}}} = {{{index}}};
{{/branches}}
{{#hasElse}}
  } else {
    {{{condbranchStore}}} = {{{elseIndex}}};
  }
{{/hasElse}}
{{^hasElse}}
  } else {
    {{{condbranchStore}}} = -1;
  }
{{/hasElse}}
}
const {{{condbranchVar}}} = {{{condbranchStore}}};
const {{{subVar}}} = {{{subStore}}} ?? 0;
```

- [ ] **Step 2: Create the branch dispatch template**

Create `lib/templates/backends/typescriptGenerator/ifStepsBranchDispatch.mustache`:

```mustache
{{#allBranches}}
{{#first}}if{{/first}}{{^first}}} else if{{/first}} ({{{condbranchVar}}} === {{{branchIndex}}}) {
{{#statements}}
  if ({{{subVar}}} <= {{{stmtIndex}}}) {
    {{{stmtCode}}}
    {{{subStore}}} = {{{nextIndex}}};
  }
{{/statements}}
{{/allBranches}}
}
```

- [ ] **Step 3: Compile templates**

Run: `pnpm run templates`
Verify that `.ts` files are generated alongside the `.mustache` files.

- [ ] **Step 4: Commit**

```bash
git add lib/templates/backends/typescriptGenerator/ifStepsCondbranch.mustache lib/templates/backends/typescriptGenerator/ifStepsCondbranch.ts lib/templates/backends/typescriptGenerator/ifStepsBranchDispatch.mustache lib/templates/backends/typescriptGenerator/ifStepsBranchDispatch.ts
git commit -m "feat: add Mustache templates for TsIfSteps code generation"
```

---

### Task 3: Add TsIfSteps IR node and prettyPrint

**Files:**
- Modify: `lib/ir/tsIR.ts` (add `TsIfSteps` and `TsIfStepsBranch` to union)
- Modify: `lib/ir/builders.ts` (add `ts.ifSteps` builder)
- Modify: `lib/ir/prettyPrint.ts` (add `"ifSteps"` case using templates)
- Modify: `lib/ir/prettyPrint.test.ts` (add unit tests)

- [ ] **Step 1: Define `TsIfSteps` interface and add to `TsNode` union**

In `lib/ir/tsIR.ts`, add after `TsStepBlock`:

```typescript
/** A branch in a TsIfSteps node */
export interface TsIfStepsBranch {
  condition: TsNode;
  body: TsNode[];
}

/** An if/else block with substep guards for each branch body.
 * Handles condbranch tracking (which branch was taken) and substep
 * guards within each branch. Used inside step-counted bodies to
 * enable precise mid-block interrupt resumption. */
export interface TsIfSteps {
  kind: "ifSteps";
  /** The substep path for naming variables (e.g. [3] or [2, 1]) */
  subStepPath: number[];
  /** The branches — first is the "if", rest are "else if" */
  branches: TsIfStepsBranch[];
  /** Optional else body */
  elseBranch?: TsNode[];
}
```

Add `| TsIfSteps` to the `TsNode` union type (around line 43).

- [ ] **Step 2: Add `ts.ifSteps` builder function**

In `lib/ir/builders.ts`, import `TsIfStepsBranch` from `./tsIR.js` and add:

```typescript
ifSteps(
  subStepPath: number[],
  branches: TsIfStepsBranch[],
  elseBranch?: TsNode[],
): TsIfSteps {
  return { kind: "ifSteps", subStepPath, branches, elseBranch };
},
```

- [ ] **Step 3: Write unit tests**

In `lib/ir/prettyPrint.test.ts`:

```typescript
describe("TsIfSteps", () => {
  it("should emit condbranch tracking and substep guards", () => {
    const node = ts.ifSteps(
      [3],
      [
        {
          condition: ts.raw("__stack.locals.x > 5"),
          body: [ts.raw("await print('big');")],
        },
      ],
      [ts.raw("await print('small');")],
    );
    const result = printTs(node);
    // Condbranch evaluation
    expect(result).toContain("__stack.locals.__condbranch_3 === undefined");
    expect(result).toContain("__stack.locals.__condbranch_3 = 0");
    expect(result).toContain("__stack.locals.__condbranch_3 = 1");
    // Const declarations
    expect(result).toContain("const __condbranch_3 = __stack.locals.__condbranch_3");
    expect(result).toContain("const __sub_3 = __stack.locals.__substep_3 ?? 0");
    // Branch dispatch with substep guards
    expect(result).toContain("if (__condbranch_3 === 0)");
    expect(result).toContain("if (__sub_3 <= 0)");
    expect(result).toContain("await print('big');");
    expect(result).toContain("__stack.locals.__substep_3 = 1");
    // Else branch
    expect(result).toContain("if (__condbranch_3 === 1)");
    expect(result).toContain("await print('small');");
  });

  it("should emit condbranch with else-if chains", () => {
    const node = ts.ifSteps(
      [3],
      [
        {
          condition: ts.raw("__stack.locals.x > 10"),
          body: [ts.raw("await print('very big');")],
        },
        {
          condition: ts.raw("__stack.locals.x > 5"),
          body: [ts.raw("await print('big');")],
        },
      ],
      [ts.raw("await print('small');")],
    );
    const result = printTs(node);
    expect(result).toContain("__stack.locals.__condbranch_3 = 0");
    expect(result).toContain("__stack.locals.__condbranch_3 = 1");
    expect(result).toContain("__stack.locals.__condbranch_3 = 2");
    expect(result).toContain("if (__condbranch_3 === 0)");
    expect(result).toContain("if (__condbranch_3 === 1)");
    expect(result).toContain("if (__condbranch_3 === 2)");
  });

  it("should emit condbranch -1 when there is no else branch", () => {
    const node = ts.ifSteps(
      [3],
      [
        {
          condition: ts.raw("__stack.locals.x > 5"),
          body: [ts.raw("await print('big');")],
        },
      ],
    );
    const result = printTs(node);
    expect(result).toContain("__stack.locals.__condbranch_3 = -1");
    expect(result).not.toContain("__condbranch_3 === -1");
  });

  it("should use nested variable names for nested subStepPath", () => {
    const node = ts.ifSteps(
      [2, 1],
      [
        {
          condition: ts.raw("condition"),
          body: [ts.raw("await doSomething();")],
        },
      ],
    );
    const result = printTs(node);
    expect(result).toContain("__condbranch_2_1");
    expect(result).toContain("__substep_2_1");
    expect(result).toContain("__sub_2_1");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test:run`
Expected: FAIL — no `ifSteps` case in prettyPrint.

- [ ] **Step 5: Implement the `ifSteps` case in prettyPrint**

In `lib/ir/prettyPrint.ts`, import the compiled templates and add a case for `"ifSteps"`:

```typescript
import * as renderIfStepsCondbranch from "../templates/backends/typescriptGenerator/ifStepsCondbranch.js";
import * as renderIfStepsBranchDispatch from "../templates/backends/typescriptGenerator/ifStepsBranchDispatch.js";
```

```typescript
case "ifSteps": {
  const subKey = node.subStepPath.join("_");
  const condbranchVar = `__condbranch_${subKey}`;
  const condbranchStore = `__stack.locals.__condbranch_${subKey}`;
  const subVar = `__sub_${subKey}`;
  const subStore = `__stack.locals.__substep_${subKey}`;

  // Render condbranch evaluation + const declarations
  const condbranchCode = renderIfStepsCondbranch.default({
    condbranchStore,
    condbranchVar,
    subVar,
    subStore,
    branches: node.branches.map((b, i) => ({
      condition: printTs(b.condition, indent + 1),
      index: i,
      first: i === 0,
    })),
    hasElse: !!node.elseBranch,
    elseIndex: node.branches.length,
  });

  // Render branch dispatch with substep guards
  const allBranches = [...node.branches.map(b => b.body)];
  if (node.elseBranch) allBranches.push(node.elseBranch);

  const dispatchCode = renderIfStepsBranchDispatch.default({
    condbranchVar,
    subVar,
    subStore,
    allBranches: allBranches.map((body, branchIdx) => ({
      branchIndex: branchIdx,
      first: branchIdx === 0,
      statements: body.map((stmt, stmtIdx) => ({
        stmtIndex: stmtIdx,
        stmtCode: printTs(stmt, indent + 2),
        nextIndex: stmtIdx + 1,
      })),
    })),
  });

  return condbranchCode + "\n" + dispatchCode;
}
```

Note: The exact template data shape may need adjustment once the Mustache templates are written and tested. The templates and this case should be iterated together until the output matches the spec's expected output. Pay attention to indentation — use the `ind()` helper or bake indentation into the template data as needed.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test:run`
Expected: All PASS. If not, iterate on the templates and prettyPrint case until output matches.

- [ ] **Step 7: Commit**

```bash
git add lib/ir/tsIR.ts lib/ir/builders.ts lib/ir/prettyPrint.ts lib/ir/prettyPrint.test.ts
git commit -m "feat: add TsIfSteps IR node with condbranch tracking and substep guards"
```

---

### Task 4: Update the builder to emit TsIfSteps for if/else

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

This replaces the existing `processIfElse` method with `processIfElseWithSteps`, which produces `TsIfSteps` nodes instead of `TsIf` nodes.

**Important context:**
- `processIfElse` is only reachable through `processStatement`, which is called from `processBodyAsParts` (for node/function bodies) and from branch body processing. Every user-facing if/else goes through a stepped body.
- `TsIf` continues to exist as an IR node for programmatic use (e.g. `forkBranchSetup` creates `TsIf` nodes via `ts.if()`), but we stop generating it from Agency `IfElse` AST nodes.
- For nested if/else handling: `processIfElseWithSteps` must push/pop `_subStepPath` around branch body processing, and intercept nested ifElse statements in branch bodies to call itself recursively.

- [ ] **Step 1: Add `_subStepPath` instance variable**

In `lib/backends/typescriptBuilder.ts`, near the other private instance variables (around line 119), add:

```typescript
/** Tracks the current substep nesting path. Empty when at the top level
 * of a stepped body. Non-empty when inside a block (if/else, etc.) that
 * has been broken into substeps. Used to generate unique variable names
 * like __substep_3_1 for nested blocks. */
private _subStepPath: number[] = [];
```

- [ ] **Step 2: Replace `processIfElse` with `processIfElseWithSteps`**

Replace the existing `processIfElse` method (lines 676-721) with:

```typescript
private processIfElseWithSteps(node: IfElse, stepIndex: number): TsNode {
  const subStepPath = [...this._subStepPath, stepIndex];

  // Helper to process a branch body, handling nested ifElse recursively
  const processBranchBody = (body: AgencyNode[]): TsNode[] => {
    const savedPath = this._subStepPath;
    this._subStepPath = subStepPath;
    const result = body.map((stmt, i) => {
      if (stmt.type === "ifElse") {
        return this.processIfElseWithSteps(stmt as IfElse, i);
      }
      return this.processStatement(stmt);
    });
    this._subStepPath = savedPath;
    return result;
  };

  // Flatten the else-if chain (same logic as the old processIfElse)
  const branches: { condition: TsNode; body: TsNode[] }[] = [];
  let elseBranch: TsNode[] | undefined;

  // First branch
  branches.push({
    condition: this.processNode(node.condition),
    body: processBranchBody(node.thenBody),
  });

  // Flatten else-if chain
  let current: IfElse | undefined =
    node.elseBody?.length === 1 && node.elseBody[0].type === "ifElse"
      ? (node.elseBody[0] as IfElse)
      : undefined;
  let remainingElse = current ? undefined : node.elseBody;

  while (current) {
    branches.push({
      condition: this.processNode(current.condition),
      body: processBranchBody(current.thenBody),
    });
    if (
      current.elseBody?.length === 1 &&
      current.elseBody[0].type === "ifElse"
    ) {
      current = current.elseBody[0] as IfElse;
    } else {
      remainingElse = current.elseBody;
      current = undefined;
    }
  }

  if (remainingElse && remainingElse.length > 0) {
    elseBranch = processBranchBody(remainingElse);
  }

  return ts.ifSteps(subStepPath, branches, elseBranch);
}
```

- [ ] **Step 3: Update the dispatch in `processStatement`**

In `processStatement` (around line 516-517), update the ifElse case:

```typescript
case "ifElse":
  return this.processIfElseWithSteps(node, this._currentStepIndex);
```

Note: `_currentStepIndex` is set by `processBodyAsParts` before calling `processStatement`, so it will have the correct step index for top-level if/else. For nested if/else, the index is passed directly by `processIfElseWithSteps`'s `processBranchBody`.

- [ ] **Step 4: Check `auditNode` in `lib/ir/audit.ts`**

The new `TsIfSteps` is a TsNode kind. Check if `auditNode()` needs a case for it. Since the branch body statements are individually processed (and may already have audit nodes from `processStatement`), `auditNode` should return `null` for `"ifSteps"`. Add `case "ifSteps": return null;` if needed.

- [ ] **Step 5: Run tests to see what breaks**

Run: `pnpm test:run`
Expected: The existing ifElse generator fixture (`tests/typescriptGenerator/ifElse.mjs`) will fail because the output format has changed. Other fixtures with if/else will also fail.

- [ ] **Step 6: Regenerate fixtures**

Run: `make fixtures`
This will regenerate all `.mjs` fixture files to match the new output.

- [ ] **Step 7: Inspect the regenerated `tests/typescriptGenerator/ifElse.mjs`**

Read the file and verify:
- Each if/else block inside a step block now has condbranch tracking
- Each branch body has substep guards
- The `__condbranch_N` and `__substep_N` variable names use the correct step indices
- Else-if chains are correctly flattened
- Nested if statements (the one at line 20-27 of the .agency file) have nested substep paths (e.g. `__condbranch_7_1`, `__substep_7_1`)

- [ ] **Step 8: Run all tests**

Run: `pnpm test:run`
Expected: All PASS with regenerated fixtures.

- [ ] **Step 9: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/ir/audit.ts tests/
git commit -m "feat: replace processIfElse with processIfElseWithSteps for substep support"
```

---

### Task 5: Integration test — interrupt inside if body

**Files:**
- Create: `tests/agency/substeps/interrupt-in-if.agency`
- Create: `tests/agency/substeps/interrupt-in-if.test.json`

This test verifies that interrupting inside an if body resumes correctly: statements before the interrupt don't re-execute, and statements after do execute.

- [ ] **Step 1: Create the Agency source file**

Create `tests/agency/substeps/interrupt-in-if.agency`:

```agency
node main(x: number) {
  result = "start"
  if (x > 5) {
    result = "big"
    return interrupt("check")
    result = "confirmed big"
  } else {
    result = "small"
  }
  return result
}
```

- [ ] **Step 2: Create the test file**

Create `tests/agency/substeps/interrupt-in-if.test.json`. Consult `docs/INTERRUPT_TESTING.md` for the test format with interrupt handlers. The test should:
- Call `main` with `x = 10` (enters the if branch)
- Handle the interrupt with an approve response
- Verify the final result is `"confirmed big"` (not `"big"` or `"start"`)

- [ ] **Step 3: Run the test**

Run: `pnpm run agency test tests/agency/substeps/interrupt-in-if.test.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agency/substeps/
git commit -m "test: add agency test for interrupt inside if body"
```

---

### Task 6: Integration test — interrupt inside else body

**Files:**
- Create: `tests/agency/substeps/interrupt-in-else.agency`
- Create: `tests/agency/substeps/interrupt-in-else.test.json`

- [ ] **Step 1: Create the Agency source file**

Create `tests/agency/substeps/interrupt-in-else.agency`:

```agency
node main(x: number) {
  result = "start"
  if (x > 5) {
    result = "big"
  } else {
    result = "small"
    return interrupt("check")
    result = "confirmed small"
  }
  return result
}
```

- [ ] **Step 2: Create the test file**

Create `tests/agency/substeps/interrupt-in-else.test.json`. The test should:
- Call `main` with `x = 3` (enters the else branch)
- Handle the interrupt with an approve response
- Verify the final result is `"confirmed small"`

- [ ] **Step 3: Run the test**

Run: `pnpm run agency test tests/agency/substeps/interrupt-in-else.test.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agency/substeps/
git commit -m "test: add agency test for interrupt inside else body"
```

---

### Task 7: Integration test — interrupt inside else-if chain

**Files:**
- Create: `tests/agency/substeps/interrupt-in-elseif.agency`
- Create: `tests/agency/substeps/interrupt-in-elseif.test.json`

- [ ] **Step 1: Create the Agency source file**

Create `tests/agency/substeps/interrupt-in-elseif.agency`:

```agency
node main(x: number) {
  if (x > 10) {
    result = "very big"
  } else if (x > 5) {
    result = "big"
    return interrupt("check")
    result = "confirmed big"
  } else {
    result = "small"
  }
  return result
}
```

- [ ] **Step 2: Create the test file**

Create `tests/agency/substeps/interrupt-in-elseif.test.json`. The test should:
- Call `main` with `x = 7` (enters the else-if branch)
- Handle the interrupt with an approve response
- Verify the final result is `"confirmed big"`

- [ ] **Step 3: Run the test**

Run: `pnpm run agency test tests/agency/substeps/interrupt-in-elseif.test.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agency/substeps/
git commit -m "test: add agency test for interrupt inside else-if chain"
```

---

### Task 8: Integration test — nested if with interrupt

**Files:**
- Create: `tests/agency/substeps/interrupt-in-nested-if.agency`
- Create: `tests/agency/substeps/interrupt-in-nested-if.test.json`

- [ ] **Step 1: Create the Agency source file**

Create `tests/agency/substeps/interrupt-in-nested-if.agency`:

```agency
node main(x: number, y: number) {
  result = "start"
  if (x > 5) {
    result = "outer"
    if (y > 3) {
      result = "inner"
      return interrupt("check")
      result = "confirmed inner"
    }
    result = result + " done"
  }
  return result
}
```

- [ ] **Step 2: Create the test file**

Create `tests/agency/substeps/interrupt-in-nested-if.test.json`. The test should:
- Call `main` with `x = 10, y = 5` (enters both if branches)
- Handle the interrupt with an approve response
- Verify the final result is `"confirmed inner done"` (inner block resumes, then outer continues)

- [ ] **Step 3: Run the test**

Run: `pnpm run agency test tests/agency/substeps/interrupt-in-nested-if.test.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agency/substeps/
git commit -m "test: add agency test for interrupt inside nested if"
```

---

### Task 9: Full regression check

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test:run`
Expected: All tests pass.

- [ ] **Step 2: Build the project**

Run: `make all`
Expected: Clean build with no errors.

- [ ] **Step 3: Run all agency tests**

Run: `pnpm run agency test tests/agency`
Expected: All tests pass.

- [ ] **Step 4: Commit any remaining changes**

If there are any fixture regeneration changes not yet committed:

```bash
git add -A
git commit -m "chore: regenerate all fixtures for substep changes"
```
