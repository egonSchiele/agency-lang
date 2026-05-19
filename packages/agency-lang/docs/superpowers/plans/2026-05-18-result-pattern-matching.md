# Result Pattern Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `success` and `failure` as pattern keywords in `is` and `match` positions for ergonomic Result type unwrapping.

**Architecture:** New `ResultPattern` AST node type, parsed in pattern position when `success`/`failure` is encountered. The pattern lowering pass (`patternLowering.ts`) handles all desugaring. No changes needed downstream in typechecker, preprocessor, or TS builder. The Agency formatter (`agencyGenerator.ts`) operates on the un-lowered AST and DOES need a case for `resultPattern`.

**Nesting:** Result patterns may appear nested inside other patterns (e.g. `[success(v), _]`, `{ r: success(v) }`). This falls out of placing `resultPatternParser` inside `_matchPatternParser`, which is the inner parser used by `arrayMatchPatternParser` and `objectMatchPatternParser`. The lowering produces the expected accesses (e.g. `const v = arr[0].value`).

**Tech Stack:** Tarsec parser combinators, Vitest, Agency execution tests

**Spec:** `docs/superpowers/specs/2026-05-18-result-pattern-matching-design.md`

---

### Task 1: Add `ResultPattern` AST node type

**Files:**
- Modify: `lib/types/pattern.ts`

- [ ] **Step 1: Add the `ResultPattern` type and update unions**

In `lib/types/pattern.ts`, add the new type and include it in `MatchPattern`:

```typescript
export type ResultPattern = BaseNode & {
  type: "resultPattern";
  kind: "success" | "failure";
  binding: string | null; // null = bare form (no parens), string = binding identifier
};
```

Update the `MatchPattern` union to include `ResultPattern`:

```typescript
export type MatchPattern =
  | BindingPattern
  | Literal
  | ResultPattern;
```

Add `ResultPattern` to the import of `BaseNode` if not already imported.

- [ ] **Step 2: Verify the project builds**

Run: `cd /Users/adityabhargava/agency-lang && make`
Expected: Build succeeds with no type errors.

- [ ] **Step 3: Commit**

```
feat: add ResultPattern AST node type
```

---

### Task 2: Parse `success`/`failure` in pattern position

**Files:**
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/parsers/pattern.test.ts`

The parser needs to recognize `success` and `failure` in pattern position (inside `matchPatternParser`). The tricky part: `success` and `failure` are also valid function names in expression position (e.g. `return success(42)`), so we must only intercept them in pattern position, which is already scoped — `matchPatternParser` is only called from `is` and match-arm contexts.

- [ ] **Step 1: Write parser unit tests**

Add to `lib/parsers/pattern.test.ts`:

```typescript
describe("result pattern", () => {
  it("parses bare `success` as a result pattern", () => {
    const result = matchPatternParser("success");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "resultPattern",
      kind: "success",
      binding: null,
    });
    expect(result.rest).toBe("");
  });

  it("parses bare `failure` as a result pattern", () => {
    const result = matchPatternParser("failure");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "resultPattern",
      kind: "failure",
      binding: null,
    });
    expect(result.rest).toBe("");
  });

  it("parses `success(v)` with binding", () => {
    const result = matchPatternParser("success(v)");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "resultPattern",
      kind: "success",
      binding: "v",
    });
    expect(result.rest).toBe("");
  });

  it("parses `failure(err)` with binding", () => {
    const result = matchPatternParser("failure(err)");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "resultPattern",
      kind: "failure",
      binding: "err",
    });
    expect(result.rest).toBe("");
  });

  it("rejects empty parens `success()` as a parse error", () => {
    // Per spec: success() with no argument in pattern position is a parse error.
    // The parser should detect `(` followed by `)` with no identifier and fail.
    const result = matchPatternParser("success()");
    expect(result.success).toBe(false);
  });

  it("rejects empty parens `failure()` as a parse error", () => {
    const result = matchPatternParser("failure()");
    expect(result.success).toBe(false);
  });

  it("parses `success(value)` in is-expression context", () => {
    const result = exprParser("result is success(value)");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "isExpression",
      pattern: {
        type: "resultPattern",
        kind: "success",
        binding: "value",
      },
    });
  });

  it("parses `result is success` (bare) in is-expression context", () => {
    const result = exprParser("result is success");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "isExpression",
      pattern: {
        type: "resultPattern",
        kind: "success",
        binding: null,
      },
    });
  });

  it("parses success(v) as a match arm LHS", () => {
    const result = matchBlockParserCase("  success(v) => return v");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.caseValue).toMatchObject({
      type: "resultPattern",
      kind: "success",
      binding: "v",
    });
  });

  it("does NOT match an identifier with a longer name (`successful`)", () => {
    // Boundary check: `successful` must parse as a variable name pattern,
    // not as a `success` result pattern with trailing `ful` left in `rest`.
    const result = matchPatternParser("successful");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.type).toBe("variableName");
    expect(result.rest).toBe("");
  });

  it("parses success(v) nested inside an array match pattern", () => {
    const result = matchPatternParser("[success(v), _]");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "arrayPattern",
      elements: [
        { type: "resultPattern", kind: "success", binding: "v" },
        { type: "wildcardPattern" },
      ],
    });
  });

  it("parses failure(e) nested inside an object match pattern", () => {
    const result = matchPatternParser("{ r: failure(e) }");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "objectPattern",
      properties: [
        {
          type: "objectPatternProperty",
          key: "r",
          value: { type: "resultPattern", kind: "failure", binding: "e" },
        },
      ],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run -- --reporter=verbose lib/parsers/pattern.test.ts 2>&1 | tee /tmp/pattern-test-1.txt`
Expected: FAIL — `resultPattern` type not recognized.

- [ ] **Step 3: Implement the result pattern parser**

In `lib/parsers/parsers.ts`, add a `resultPatternParser` and insert it into `_matchPatternParser`. The parser must be placed BEFORE `variableNameParser` so that `success` and `failure` are intercepted before they'd parse as bare variable names.

First, import `ResultPattern` from `../types/pattern.js` at the top of the file (add to the existing pattern import block).

Then add the parser near the other pattern parsers (around line 3525, before `_matchPatternParser`):

```typescript
const resultPatternParser: Parser<ResultPattern> = withLoc((input: string) => {
  // Try "success" or "failure" keyword
  const kwResult = or(str("success"), str("failure"))(input);
  if (!kwResult.success) return kwResult;
  const kind = kwResult.result as "success" | "failure";

  // Check that the keyword is not followed by an identifier char
  // (so "successful" doesn't match)
  const boundary = not(varNameChar)(kwResult.rest);
  if (!boundary.success) return fail("not a result pattern keyword boundary")(input);

  // Check for `(` — if present, must contain an identifier (not empty parens)
  const rest = kwResult.rest;
  if (rest.length > 0 && rest[0] === "(") {
    // Reject empty parens: `success()` is a parse error in pattern position.
    // Use `optionalSpacesOrNewline` so `success(\n)` is also detected as empty.
    const emptyCheck = seqC(char("("), optionalSpacesOrNewline, char(")"))(rest);
    if (emptyCheck.success) {
      return fail("empty parens not allowed in result pattern; use `success` (bare) or `success(name)` (with binding)")(input);
    }

    // Try `(identifier)` binding. Use `optionalSpacesOrNewline` to tolerate
    // line breaks inside the parens, matching the style of array/object
    // pattern parsers.
    const bindingResult = seqC(
      char("("),
      optionalSpacesOrNewline,
      capture(variableNameParser, "binding"),
      optionalSpacesOrNewline,
      char(")"),
    )(rest);

    if (bindingResult.success) {
      return success(
        {
          type: "resultPattern" as const,
          kind,
          binding: (bindingResult.result as any).binding.value,
        },
        bindingResult.rest,
      );
    }

    // `(` present but no valid binding — fail
    return fail("expected identifier in result pattern binding")(input);
  }

  // Bare form (no parens)
  return success(
    {
      type: "resultPattern" as const,
      kind,
      binding: null,
    },
    rest,
  );
});
```

Then update `_matchPatternParser` to include `resultPatternParser` before `variableNameParser`:

```typescript
const _matchPatternParser = (input: string): ParserResult<MatchPattern> => {
  const parser = or(
    lazy(() => arrayMatchPatternParser),
    lazy(() => objectMatchPatternParser),
    restPatternParser,
    wildcardPatternParser,
    nullParser,
    booleanParser,
    unitLiteralParser,
    resultPatternParser,     // NEW: before variableNameParser
    variableNameParser,
    numberParser,
    _stringParser,
  );
  return parser(input) as ParserResult<MatchPattern>;
};
```

Note: `resultPatternParser` must come after `wildcardPatternParser` (so `_` still works) but before `variableNameParser` (so `success`/`failure` are intercepted).

Also import `fail` from tarsec if not already imported (check existing imports).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run -- --reporter=verbose lib/parsers/pattern.test.ts 2>&1 | tee /tmp/pattern-test-2.txt`
Expected: All new tests PASS. All existing tests still PASS.

- [ ] **Step 5: Verify full test suite still passes**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run 2>&1 | tee /tmp/full-test-1.txt`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```
feat: parse success/failure as result patterns in pattern position
```

---

### Task 3: Lower result patterns in `is` and `match` positions

**Files:**
- Modify: `lib/lowering/patternLowering.ts`
- Modify: `lib/lowering/patternLowering.test.ts`

This is the core task. We extend `patternToCondition`, `extractBindings`, and `assertNoBindersInBoolIs` to handle `ResultPattern` nodes.

- [ ] **Step 1: Write lowering unit tests**

Add to `lib/lowering/patternLowering.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// Result patterns
// ---------------------------------------------------------------------------

describe("result patterns", () => {
  describe("is operator — boolean context (no binding)", () => {
    it("lowers `let x = r is success` to isSuccess call", () => {
      const lowered = lower(`let r = success(1)\nlet x = r is success`);
      // [r assignment, x assignment with isSuccess call]
      expect(lowered).toHaveLength(2);
      const xAssign = lowered[1] as Assignment;
      expect(xAssign.variableName).toBe("x");
      // The value should be a functionCall to isSuccess
      expect(xAssign.value.type).toBe("functionCall");
      expect((xAssign.value as any).functionName).toBe("isSuccess");
    });

    it("lowers `let x = r is failure` to isFailure call", () => {
      const lowered = lower(`let r = failure("err")\nlet x = r is failure`);
      expect(lowered).toHaveLength(2);
      const xAssign = lowered[1] as Assignment;
      expect(xAssign.value.type).toBe("functionCall");
      expect((xAssign.value as any).functionName).toBe("isFailure");
    });
  });

  describe("is operator — binding context (if)", () => {
    it("lowers `if (r is success(v))` to isSuccess guard + const binding", () => {
      const lowered = lower(`let r = success(1)\nif (r is success(v)) {\n  print(v)\n}`);
      // [r assignment, ifElse]
      expect(lowered).toHaveLength(2);
      const ifNode = lowered[1] as IfElse;
      expect(ifNode.type).toBe("ifElse");
      // condition should be isSuccess(r)
      expect(ifNode.condition.type).toBe("functionCall");
      expect((ifNode.condition as any).functionName).toBe("isSuccess");
      // thenBody should start with const v = r.value
      const vBind = ifNode.thenBody[0] as Assignment;
      expect(vBind.variableName).toBe("v");
      expect(vBind.declKind).toBe("const");
      expect(vBind.value.type).toBe("valueAccess");
    });

    it("lowers `if (r is failure(e))` to isFailure guard + const binding", () => {
      const lowered = lower(`let r = failure("oops")\nif (r is failure(e)) {\n  print(e)\n}`);
      expect(lowered).toHaveLength(2);
      const ifNode = lowered[1] as IfElse;
      expect(ifNode.condition.type).toBe("functionCall");
      expect((ifNode.condition as any).functionName).toBe("isFailure");
      const eBind = ifNode.thenBody[0] as Assignment;
      expect(eBind.variableName).toBe("e");
      expect(eBind.declKind).toBe("const");
    });
  });

  describe("is operator — binding context (while)", () => {
    it("lowers `while (r is success(v))` to isSuccess guard + binding prepended to body", () => {
      const lowered = lower(
        `let r = success(1)\nwhile (r is success(v)) {\n  print(v)\n}`,
      );
      // [r assignment, whileLoop]
      expect(lowered).toHaveLength(2);
      const whileNode = lowered[1] as WhileLoop;
      expect(whileNode.type).toBe("whileLoop");
      expect(whileNode.condition.type).toBe("functionCall");
      expect((whileNode.condition as any).functionName).toBe("isSuccess");
      // body[0] must be `const v = r.value` so v is re-bound each iteration
      const vBind = whileNode.body[0] as Assignment;
      expect(vBind.variableName).toBe("v");
      expect(vBind.declKind).toBe("const");
      expect(vBind.value.type).toBe("valueAccess");
    });
  });

  describe("nested result patterns inside other patterns", () => {
    it("lowers `[success(v), _]` arm to length+isSuccess checks and arr[0].value binding", () => {
      const lowered = lower(
        `let arr = [success(1), failure("e")]\nmatch (arr) {\n  [success(v), _] => print(v)\n  _ => print("none")\n}`,
      );
      // [arr assignment, scrutinee assignment, ifElse]
      expect(lowered).toHaveLength(3);
      const ifNode = lowered[2] as IfElse;
      // condition is `length >= 2 && isSuccess(__scrutinee_n[0])`
      // (combined via && — top-level is a binOp)
      expect(ifNode.condition.type).toBe("binOpExpression");
      // The first binding in the then-body is the nested result-pattern binding.
      const vBind = ifNode.thenBody[0] as Assignment;
      expect(vBind.variableName).toBe("v");
      expect(vBind.declKind).toBe("const");
      expect(vBind.value.type).toBe("valueAccess");
    });
  });

  describe("is operator — binding in pure-boolean context is an error", () => {
    it("rejects `let x = r is success(v)`", () => {
      expect(() => lower(`let r = success(1)\nlet x = r is success(v)`))
        .toThrow(PatternLoweringError);
    });

    it("rejects `let x = r is failure(e)`", () => {
      expect(() => lower(`let r = failure("e")\nlet x = r is failure(e)`))
        .toThrow(PatternLoweringError);
    });
  });

  describe("match arms", () => {
    it("lowers match with success/failure arms to if/else-if chain", () => {
      const lowered = lower(
        `let r = success(42)\nmatch (r) {\n  success(v) => print(v)\n  failure(e) => print(e)\n}`
      );
      // [r assignment, scrutinee assignment, if/else-if chain]
      expect(lowered).toHaveLength(3);
      const scrutinee = lowered[1] as Assignment;
      expect(scrutinee.variableName).toMatch(/^__scrutinee_/);
      const ifNode = lowered[2] as IfElse;
      expect(ifNode.type).toBe("ifElse");
      // condition: isSuccess(__scrutinee)
      expect(ifNode.condition.type).toBe("functionCall");
      expect((ifNode.condition as any).functionName).toBe("isSuccess");
      // thenBody: const v = __scrutinee.value, then print(v)
      const vBind = ifNode.thenBody[0] as Assignment;
      expect(vBind.variableName).toBe("v");
      // elseBody: isFailure check
      expect(ifNode.elseBody).toBeDefined();
      const elseIf = ifNode.elseBody![0] as IfElse;
      expect(elseIf.condition.type).toBe("functionCall");
      expect((elseIf.condition as any).functionName).toBe("isFailure");
    });
  });
});
```

Also add `PatternLoweringError` to the import from `./patternLowering.js` if not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run -- --reporter=verbose lib/lowering/patternLowering.test.ts 2>&1 | tee /tmp/lowering-test-1.txt`
Expected: FAIL — `resultPattern` not handled in lowering.

- [ ] **Step 3: Implement result pattern lowering**

In `lib/lowering/patternLowering.ts`, make these changes:

**3a. Import `ResultPattern`:**

Add `ResultPattern` to the import from `../types/pattern.js`.

**3b. Add a helper to build `isSuccess`/`isFailure` call nodes:**

Note: `isSuccess` and `isFailure` are already registered as builtins in `lib/typeChecker/builtins.ts` (lines 86-87), so the generated `functionCall` nodes will pass typechecking.

```typescript
function resultCheckCall(
  kind: "success" | "failure",
  source: Expression,
  loc: SourceLocation | undefined,
): FunctionCall {
  return {
    type: "functionCall",
    functionName: kind === "success" ? "isSuccess" : "isFailure",
    arguments: [source],
    loc: loc as SourceLocation,
  };
}
```

**3c. Extend `collectChecks` in `patternToCondition`:**

Add a case for `resultPattern` before the `default` case:

```typescript
case "resultPattern":
  checks.push(resultCheckCall(pattern.kind, source, pattern.loc));
  break;
```

**3d. Extend `extractBindings`:**

Add a case for `resultPattern` before the `default` case in the switch:

```typescript
case "resultPattern": {
  if (pattern.binding === null) return [];
  const field = pattern.kind === "success" ? "value" : "error";
  return [makeAssign(pattern.binding, fieldAccess(source, field, loc), declKind, loc)];
}
```

**3e. Extend `assertNoBindersInBoolIs` / `walkPattern`:**

In `walkPattern`, add an `else if` branch for `resultPattern` inside the `if ("type" in pattern)` block, after the existing `objectPatternProperty` branch. The `visit(pattern)` call at the top of the function already runs unconditionally, so the visitor callback in `assertNoBindersInBoolIs` will see the node. This branch just prevents falling through to any future default logic:

```typescript
// Inside walkPattern, after the existing else-if branches:
} else if (pattern.type === "resultPattern") {
  // leaf — no child patterns to recurse into
}
```

In `assertNoBindersInBoolIs`, add inside the `walkPattern` callback:

```typescript
if (p.type === "resultPattern" && (p as ResultPattern).binding !== null) {
  throw new PatternLoweringError(
    `result pattern binder in pure-boolean \`is\` context has nowhere to bind; use \`if (x is ${(p as ResultPattern).kind}(...))\` to introduce variables`,
    loc,
  );
}
```

Add `ResultPattern` to the import at the top if needed.

**3f. Mark `resultPattern` as a pattern arm in `lowerMatchBlock`:**

The `hasPatternArms` check (around line 256) needs to also detect `resultPattern`. Update the condition:

```typescript
const hasPatternArms = node.cases.some(
  (c) =>
    c.type === "matchBlockCase" &&
    ((c.caseValue !== "_" &&
      (c.caseValue.type === "objectPattern" ||
       c.caseValue.type === "arrayPattern" ||
       c.caseValue.type === "resultPattern")) ||
      c.guard !== undefined),
);
```

- [ ] **Step 4: Run lowering tests to verify they pass**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run -- --reporter=verbose lib/lowering/patternLowering.test.ts 2>&1 | tee /tmp/lowering-test-2.txt`
Expected: All new and existing tests PASS.

- [ ] **Step 5: Run full unit test suite**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run 2>&1 | tee /tmp/full-test-2.txt`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```
feat: lower result patterns in is and match positions
```

---

### Task 4: Teach the Agency formatter about result patterns

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/backends/agencyGenerator.test.ts`

The formatter runs on the un-lowered AST (it's used by `pnpm run fmt`), so it sees raw `resultPattern` nodes. Both the `processNode` switch and the `formatPattern` switch need updating, otherwise `formatPattern` will fall through to its `default` branch and call `processNode` on the `resultPattern`, which in turn throws `Unhandled Agency node type: resultPattern`.

- [ ] **Step 1: Write formatter unit tests**

Add to `lib/backends/agencyGenerator.test.ts`:

```typescript
describe("result patterns", () => {
  it("formats `r is success` (bare boolean form)", () => {
    const src = `node main() {\n  let r = success(1)\n  let x = r is success\n}\n`;
    expect(format(src)).toBe(src);
  });

  it("formats `r is failure` (bare boolean form)", () => {
    const src = `node main() {\n  let r = failure("e")\n  let x = r is failure\n}\n`;
    expect(format(src)).toBe(src);
  });

  it("formats `r is success(v)` with binding", () => {
    const src = `node main() {\n  let r = success(1)\n  if (r is success(v)) {\n    print(v)\n  }\n}\n`;
    expect(format(src)).toBe(src);
  });

  it("formats `r is failure(e)` with binding", () => {
    const src = `node main() {\n  let r = failure("e")\n  if (r is failure(e)) {\n    print(e)\n  }\n}\n`;
    expect(format(src)).toBe(src);
  });

  it("formats result patterns as match arm LHS", () => {
    const src = `node main() {\n  let r = success(1)\n  match (r) {\n    success(v) => print(v)\n    failure(e) => print(e)\n  }\n}\n`;
    expect(format(src)).toBe(src);
  });

  it("formats result patterns nested inside an array match pattern", () => {
    const src = `node main() {\n  let arr = [success(1), failure("e")]\n  match (arr) {\n    [success(v), _] => print(v)\n    _ => print("none")\n  }\n}\n`;
    expect(format(src)).toBe(src);
  });
});
```

(Use whichever `format` helper / fixture pattern the existing tests in this file use; the snippets above are just the round-trip shape.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run -- --reporter=verbose lib/backends/agencyGenerator.test.ts 2>&1 | tee /tmp/fmt-test-1.txt`
Expected: FAIL — formatter throws or mis-renders `resultPattern`.

- [ ] **Step 3: Add formatter cases for `resultPattern`**

In `lib/backends/agencyGenerator.ts`:

**3a.** Add `"resultPattern"` to the `processNode` switch alongside the other pattern cases (around line 298-302):

```typescript
case "objectPattern":
case "arrayPattern":
case "restPattern":
case "wildcardPattern":
case "resultPattern":
  return this.formatPattern(node);
```

**3b.** Add a `resultPattern` case to `formatPattern` (around line 510-522), before the `default`:

```typescript
case "resultPattern": {
  const rp = pattern as ResultPattern;
  return rp.binding === null ? rp.kind : `${rp.kind}(${rp.binding})`;
}
```

Add `ResultPattern` to the existing type imports from `../types/pattern.js` at the top of the file.

- [ ] **Step 4: Run formatter tests to verify they pass**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run -- --reporter=verbose lib/backends/agencyGenerator.test.ts 2>&1 | tee /tmp/fmt-test-2.txt`
Expected: All formatter tests PASS.

- [ ] **Step 5: Run full unit test suite**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run 2>&1 | tee /tmp/full-test-3.txt`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```
feat: format result patterns in the Agency formatter
```

---

### Task 5: Add Agency execution tests

**Files:**
- Create: `tests/agency/pattern-matching/resultPatternIs.agency`
- Create: `tests/agency/pattern-matching/resultPatternIs.test.json`
- Create: `tests/agency/pattern-matching/resultPatternMatch.agency`
- Create: `tests/agency/pattern-matching/resultPatternMatch.test.json`
- Create: `tests/agency/pattern-matching/resultPatternMatchIs.agency`
- Create: `tests/agency/pattern-matching/resultPatternMatchIs.test.json`
- Create: `tests/agency/pattern-matching/resultPatternBoolIs.agency`
- Create: `tests/agency/pattern-matching/resultPatternBoolIs.test.json`
- Create: `tests/agency/pattern-matching/resultPatternNested.agency`
- Create: `tests/agency/pattern-matching/resultPatternNested.test.json`

These tests compile and run Agency code end-to-end, verifying the full pipeline works.

- [ ] **Step 1: Create `resultPatternIs.agency` — `is` with binding in `if`**

```agency
def tryParse(input: string): Result {
  if (input == "ok") {
    return success(42)
  }
  return failure("bad input")
}

node main() {
  let r1 = tryParse("ok")
  let r2 = tryParse("bad")

  let v1 = -1
  if (r1 is success(val)) {
    v1 = val
  }

  let e1 = ""
  if (r2 is failure(err)) {
    e1 = err
  }

  return [v1, e1]
}
```

- [ ] **Step 2: Create `resultPatternIs.test.json`**

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "[42,\"bad input\"]",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 3: Create `resultPatternMatch.agency` — `match` with success/failure arms**

```agency
def tryParse(input: string): Result {
  if (input == "ok") {
    return success(42)
  }
  return failure("bad input")
}

def describe(input: string): string {
  let r = tryParse(input)
  match (r) {
    success(v) => return "got ${v}"
    failure(e) => return "err: ${e}"
  }
  return "unreachable"
}

node main() {
  let r1 = describe("ok")
  let r2 = describe("bad")
  return [r1, r2]
}
```

- [ ] **Step 4: Create `resultPatternMatch.test.json`**

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "[\"got 42\",\"err: bad input\"]",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 5: Create `resultPatternMatchIs.agency` — `match(result is success(v))` form**

```agency
def tryParse(input: string): Result {
  if (input == "ok") {
    return success(42)
  }
  return failure("bad input")
}

def classify(input: string): any {
  let r = tryParse(input)
  match (r is success(v)) {
    v > 10 => return "big"
    _ => return "small"
  }
  return "unreachable"
}

node main() {
  let r1 = classify("ok")
  let r2 = classify("bad")
  return [r1, isFailure(r2)]
}
```

- [ ] **Step 6: Create `resultPatternMatchIs.test.json`**

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "[\"big\",true]",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 7: Create `resultPatternBoolIs.agency` — bare boolean `is` form**

```agency
def tryParse(input: string): Result {
  if (input == "ok") {
    return success(42)
  }
  return failure("bad input")
}

node main() {
  let r1 = tryParse("ok")
  let r2 = tryParse("bad")

  let s1 = r1 is success
  let s2 = r2 is success
  let f1 = r1 is failure
  let f2 = r2 is failure

  return [s1, s2, f1, f2]
}
```

- [ ] **Step 8: Create `resultPatternBoolIs.test.json`**

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "[true,false,false,true]",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 9: Create `resultPatternNested.agency` — result patterns nested in array/object patterns**

```agency
def describe(arr: any): string {
  match (arr) {
    [success(v), _] => return "head ok: ${v}"
    [failure(e), _] => return "head err: ${e}"
    _ => return "other"
  }
  return "unreachable"
}

node main() {
  let a1 = [success(1), failure("e")]
  let a2 = [failure("oops"), success(2)]
  return [describe(a1), describe(a2)]
}
```

- [ ] **Step 10: Create `resultPatternNested.test.json`**

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "[\"head ok: 1\",\"head err: oops\"]",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

- [ ] **Step 11: Run all new execution tests**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm run agency test tests/agency/pattern-matching/resultPatternIs.test.json tests/agency/pattern-matching/resultPatternMatch.test.json tests/agency/pattern-matching/resultPatternMatchIs.test.json tests/agency/pattern-matching/resultPatternBoolIs.test.json tests/agency/pattern-matching/resultPatternNested.test.json 2>&1 | tee /tmp/exec-test-1.txt`
Expected: All tests PASS.

- [ ] **Step 12: Run existing pattern matching tests to verify no regressions**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm run agency test tests/agency/pattern-matching/ 2>&1 | tee /tmp/exec-test-2.txt`
Expected: All tests PASS.

- [ ] **Step 13: Regenerate fixtures**

Run: `cd /Users/adityabhargava/agency-lang && make fixtures`
Expected: Fixtures regenerated successfully, including new `.js` files for the new tests.

- [ ] **Step 14: Commit**

```
test: add execution tests for result pattern matching
```

---

### Task 6: Update documentation

**Files:**
- Modify: `docs/site/guide/pattern-matching.md`
- Modify: `docs/site/guide/error-handling.md`

- [ ] **Step 1: Add result patterns section to `pattern-matching.md`**

Add a new section after "Match blocks" (before "For loop destructuring"):

```markdown
## Result patterns

The `success` and `failure` keywords work as patterns for ergonomic
Result type unwrapping.

### Boolean test

```agency
let worked = result is success
let failed = result is failure
```

### Binding in `if`/`while`

```agency
if (result is success(value)) {
    print(value)   // value is the unwrapped success value
}

if (result is failure(err)) {
    print(err)     // err is the error string
}
```

### In match blocks

```agency
match (result) {
    success(v) => print("Got: ${v}")
    failure(e) => print("Error: ${e}")
}
```

### Combined with `match(expr is pattern)` form

```agency
match (result is success(v)) {
    v > 0  => print("positive")
    _      => print("zero or negative")
}
```

### Nested inside other patterns

Result patterns may appear as nested elements inside array or object
match patterns:

```agency
match (pair) {
    [success(v), _] => print("first ok: ${v}")
    [failure(e), _] => print("first err: ${e}")
    _               => print("other")
}
```

Note: `failure(e)` binds only the error string. For checkpoint,
functionName, or args, use the traditional `if (isFailure(result))`
form and access fields on the result variable directly.
```

- [ ] **Step 2: Update the error-handling.md to mention result patterns**

Locate the section in `docs/site/guide/error-handling.md` that shows the `if (isSuccess(result))` / `if (isFailure(result))` unwrapping idiom (search for "isSuccess" in the file — it appears under the heading that introduces success/failure checks). Add a note immediately after that example pointing to pattern matching:

```markdown
You can also use result patterns for more concise unwrapping — see
[Pattern Matching](pattern-matching.md#result-patterns).
```

- [ ] **Step 3: Verify the docs read well**

Read both files and confirm the new sections are consistent with each other and with the spec.

- [ ] **Step 4: Commit**

```
docs: document result pattern matching syntax
```

---

### Task 7: Final validation

- [ ] **Step 1: Run full unit test suite**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm test:run 2>&1 | tee /tmp/final-unit.txt`
Expected: All tests pass.

- [ ] **Step 2: Run full Agency execution test suite**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm run agency test tests/agency/ 2>&1 | tee /tmp/final-exec.txt`
Expected: All tests pass.

- [ ] **Step 3: Run structural linter**

Run: `cd /Users/adityabhargava/agency-lang/packages/agency-lang && pnpm run lint:structure 2>&1 | tee /tmp/final-lint.txt`
Expected: No violations.

- [ ] **Step 4: Build everything**

Run: `cd /Users/adityabhargava/agency-lang && make`
Expected: Clean build.
