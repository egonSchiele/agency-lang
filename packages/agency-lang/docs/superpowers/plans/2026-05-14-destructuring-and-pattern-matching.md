# Destructuring and Pattern Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified pattern language to Agency supporting destructuring and structural pattern matching across declarations, match blocks, `if`/`while` conditions (via `is` operator), and `for` loops.

**Architecture:** Pattern matching is syntactic sugar. The implementation adds new AST types and parsers, then a **lowering pass** that runs before the typechecker transforms all pattern syntax into existing Agency constructs. After lowering, the rest of the pipeline (typechecker, TypeScriptBuilder, preprocessor, LSP) sees only existing node types and requires **zero changes**.

The lowering transformations:

| Pattern syntax | Lowers to |
|---|---|
| `let [a, b] = items` | `let __tmp = items` + `let a = __tmp[0]` + `let b = __tmp[1]` |
| `let { name, age } = p` | `let __tmp = p` + `let name = __tmp.name` + `let age = __tmp.age` |
| `x is { type: "foo" }` | `x.type == "foo"` |
| `if (x is { type: "foo", val }) { f(val) }` | `if (x.type == "foo") { let val = x.val; f(val) }` |
| `match(x) { {type: "a", v} => f(v); _ => g() }` | `if (x.type == "a") { let v = x.v; f(v) } else { g() }` |
| `match(x is {s, b}) { s > 5 => f(b); _ => g(b) }` | `let __tmp = x` + `let s = __tmp.s` + `let b = __tmp.b` + `if (s > 5) { f(b) } else { g(b) }` |
| `for ([k, v] in entries) { ... }` | `for (__item in entries) { let k = __item[0]; let v = __item[1]; ... }` |

Lowered nodes preserve source locations (`loc`) from the original pattern nodes so the typechecker and LSP report errors at the correct positions.

The Agency formatter (AgencyGenerator) also needs updates so it can print pattern syntax back to source code.

**Tech Stack:** tarsec parser combinators, vitest for testing.

**Spec:** `docs/superpowers/specs/2026-05-14-destructuring-and-pattern-matching-design.md`

---

## Key Risks and Gotchas

1. **`{ }` in patterns vs expressions.** Object patterns look like object literals, but `agencyObjectParser` requires `key: value` pairs (no shorthand allowed in expressions — verified). So `{ a, b }` only parses successfully in pattern position. Patterns only appear in syntactically known positions: after `let`/`const` when followed by `{`/`[`, in match arm LHS, after `is`, in `for` loop variable position.

2. **`_` is a legal identifier.** `variableNameParser` allows `_` and `_foo` as identifiers. Both `defaultCaseParser` (currently `char("_")` with no boundary) and `wildcardPatternParser` must include a word-boundary check (`not(varNameChar)`) so they don't shadow real identifiers like `_foo`. In match arms, try `defaultCaseParser` first for backward compatibility.

3. **`is` operator right operand is a pattern, not an expression.** Do NOT put `is` in the `buildExpressionParser` operator table — `buildExpressionParser` parses both operands with the same `atom` parser, but patterns include shorthand binders (`{ a }`), wildcards, and rest forms that the standard expression parser does not accept (and should not, to keep `{a, b}` an error in expression position). Instead, wrap the atom parser so `is pattern` is absorbed at atom level before precedence climbing. `IsExpression` is its own AST node, NOT a `BinOpExpression`. Do NOT add `"is"` to the `PRECEDENCE` table.

4. **Two pattern parsers, by context.** Patterns mean different things in different positions:
   - **Binding context** (`let`/`const` LHS, `for` loop item var): only binders are legal — identifier, wildcard `_`, rest `...x`, nested array/object patterns of binders. Literals and arbitrary expressions are NOT legal.
   - **Match context** (match arm LHS, after `is`): binders + literals (string/number/boolean/null) for value matching.

   Use `bindingPatternParser` and `matchPatternParser` (or one parser with a context flag). Do NOT use a single `patternParser` that includes arbitrary `Expression` — that would accept `let [foo() + 1, b] = items`.

5. **Source locations.** The lowering pass must copy `loc` from pattern nodes to generated nodes. This ensures the typechecker, LSP, and error messages point to the correct source positions.

6. **Runtime failure semantics.** Per the spec, if a destructuring pattern doesn't match at runtime (e.g., `let { name } = null`), the function returns a `failure` Result. The lowering pass must generate a null/undefined check on the source expression before extracting bindings. See Task 4 for the concrete approach.

7. **Match arm backward compatibility.** Existing match arms only ever use literals (string, number) or `_` — verified across all fixtures. Replacing `exprParser` with `matchPatternParser` keeps these working since literals are still legal patterns.

8. **All match blocks with patterns lower to if/else.** This simplifies the implementation. Existing literal-only match blocks continue to work unchanged (the lowering pass only transforms arms that contain pattern nodes or guards). The lowering must bind the scrutinee to a temp first (`const __scrutinee = expr`) so the expression is evaluated exactly once, regardless of arm count.

9. **Shorthand binders in boolean `is` context are an error.** Inside `if (x is …)`, `while (x is …)`, or `match(x is …)`, shorthand binders like `{ name }` introduce variables. But in pure-boolean context (assignment RHS, function-call argument, return value, etc.), shorthand binders have nowhere to bind. The lowering pass must error when an `IsExpression` in pure-boolean context contains shorthand or rest binders.

10. **Array rest must be at the end.** `[a, ...rest]` is allowed; `[a, ...m, b]` is NOT. Enforce in the parser, not the lowering pass.

11. **Temp variables are always `const`.** Synthesized `__tmp` / `__scrutinee` / `__item` bindings are never reassigned, so always emit them as `const` regardless of the user's `declKind`.

12. **No exhaustiveness check.** Match blocks without a `_` arm that fail to match at runtime silently do nothing. Same as today's behavior; not adding exhaustiveness checking in this pass.

---

## File Structure

### New files
- `lib/types/pattern.ts` — AST node types for patterns
- `lib/lowering/patternLowering.ts` — Lowering pass: transforms pattern AST nodes into existing Agency AST nodes
- `lib/lowering/patternLowering.test.ts` — Unit tests for the lowering pass
- `lib/parsers/pattern.test.ts` — Parser tests for the pattern parser
- `tests/typescriptGenerator/destructuringArray.agency` + `.mjs` — Generator fixture
- `tests/typescriptGenerator/destructuringObject.agency` + `.mjs` — Generator fixture
- `tests/typescriptGenerator/isOperator.agency` + `.mjs` — Generator fixture
- `tests/typescriptGenerator/matchBlockPatterns.agency` + `.mjs` — Generator fixture
- `tests/agency/destructuring.agency` + `.test.json` — Execution tests
- `tests/agency/patternMatch.agency` + `.test.json` — Execution tests
- `tests/agency/isOperator.agency` + `.test.json` — Execution tests

### Modified files
- `lib/types.ts` — Add pattern types to `Expression` union, add `IsExpression`
- `lib/types/matchBlock.ts` — Expand `MatchBlockCase.caseValue` to accept patterns, add optional `guard`
- `lib/types/forLoop.ts` — Change `itemVar` to `string | ObjectPattern | ArrayPattern`
- `lib/types/assignment.ts` — Add optional `pattern?: BindingPattern` field
- `lib/parsers/parsers.ts` — Add pattern parsers (binding + match), modify assignment/match/for/expression parsers
- `lib/runtime/destructure.ts` (new file) — Runtime helpers for object rest (`__objectRest(source, excludedKeys)`) and the null/undefined failure check
- Pipeline entry point (wherever `parse → SymbolTable → buildCompilationUnit → ...` is orchestrated) — insert lowering pass after parse, before everything else

### Pipeline placement

The lowering pass runs in the **compile/typecheck path only**, NOT in the format path:

- **Format path** (runs on save): `parse → AgencyGenerator` — sees original pattern AST, prints it back as pattern syntax. No lowering.
- **Compile path**: `parse → **lowerPatterns** → SymbolTable → typechecker → preprocessor → builder → printTs`
- **LSP diagnostics**: `parse → **lowerPatterns** → typechecker`

The AgencyGenerator must handle pattern nodes directly (Task 11) because it sees the un-lowered AST.

### NOT modified
- `lib/backends/typescriptBuilder.ts` — no changes needed (sees only lowered AST)
- `lib/typeChecker/checker.ts` — no changes needed (sees only lowered AST)
- `lib/typeChecker/synthesizer.ts` — no changes needed
- `lib/preprocessors/typescriptPreprocessor.ts` — no changes needed
- `lib/ir/tsIR.ts` — no changes needed

---

## Task 1: Pattern AST Types

Define the AST node types that represent patterns.

**Files:**
- Create: `lib/types/pattern.ts`
- Modify: `lib/types.ts`
- Modify: `lib/types/matchBlock.ts`
- Modify: `lib/types/forLoop.ts`
- Modify: `lib/types/binop.ts`

- [ ] **Step 1: Create pattern type definitions**

Create `lib/types/pattern.ts`:
```typescript
import { BaseNode } from "./base.js";
import { Expression } from "../types.js";

export type ObjectPatternProperty = {
  type: "objectPatternProperty";
  key: string;
  value: Pattern;
};

export type ObjectPatternShorthand = {
  type: "objectPatternShorthand";
  name: string;
};

export type ObjectPattern = BaseNode & {
  type: "objectPattern";
  properties: (ObjectPatternProperty | ObjectPatternShorthand | RestPattern)[];
};

export type ArrayPattern = BaseNode & {
  type: "arrayPattern";
  elements: Pattern[];
};

export type RestPattern = BaseNode & {
  type: "restPattern";
  identifier: string;
};

export type WildcardPattern = BaseNode & {
  type: "wildcardPattern";
};

export type IsExpression = BaseNode & {
  type: "isExpression";
  expression: Expression;
  pattern: MatchPattern;
};

// A binding pattern: only variable bindings, no value-matching.
// Used in let/const LHS and for-loop item position.
export type BindingPattern =
  | ObjectPattern         // properties are themselves restricted to binders
  | ArrayPattern          // elements are themselves restricted to binders
  | RestPattern
  | WildcardPattern
  | VariableNameLiteral;  // bare identifier

// A match pattern: binders OR literal value matchers.
// Used in match arm LHS and after `is`.
export type MatchPattern =
  | BindingPattern
  | Literal;              // string, number, boolean, null

// Convenience union when context doesn't matter (e.g. formatter dispatch).
export type Pattern = MatchPattern;
```

Note: `ObjectPattern.properties` and `ArrayPattern.elements` should be parameterized or validated by context — in binding context they only contain binders; in match context they can also contain literals. Simplest approach: parse them with the right sub-parser (`bindingPatternParser` vs `matchPatternParser`) so the resulting AST is well-formed by construction.

- [ ] **Step 2: Export pattern types from types.ts**

Add `export * from "./types/pattern.js";` to `lib/types.ts`. Add `IsExpression` to the `Expression` union type.

- [ ] **Step 3: Update MatchBlockCase, ForLoop, and Assignment types**

See the spec for the exact type changes. Key changes:
- `MatchBlockCase.caseValue`: `Expression | DefaultCase` → `MatchPattern | DefaultCase`, add optional `guard?: Expression`
- `MatchBlock.expression`: `Expression` → `Expression | IsExpression`
- `ForLoop.itemVar`: `string` → `string | ObjectPattern | ArrayPattern`
- `Assignment`: add optional `pattern?: BindingPattern` field

**Do NOT modify `lib/types/binop.ts`.** `IsExpression` is its own AST node, not a `BinOpExpression`. Adding `"is"` to `Operator` / `PRECEDENCE` would suggest the operator-table approach, which doesn't work (see Risk #3).

- [ ] **Step 4: Commit**

```
feat: add pattern AST types for destructuring and pattern matching
```

---

## Task 2: Pattern Parsers (Binding + Match)

Build two recursive pattern parsers — one for binding contexts, one for match contexts. Not yet plugged into existing parsers.

**Files:**
- Modify: `lib/parsers/parsers.ts`
- Create: `lib/parsers/pattern.test.ts`

- [ ] **Step 1: Write failing tests**

Create `lib/parsers/pattern.test.ts` with tests for:

**bindingPatternParser** (only binders allowed):
- Bare identifier `foo`
- Wildcard `_` (and verify `_foo` parses as identifier, NOT wildcard + garbage)
- Rest `...rest`
- Array patterns `[a, b]`, `[a, _, b]`, `[first, ...rest]`, nested `[[a, b], c]`
- Object patterns `{ name }`, `{ name: n, age: a }`, `{ name, ...rest }`, nested `{ coords: [x, y] }`, `{ address: { street, city } }`
- **Rejection cases:** `[1, 2]` (literal in binding position), `[foo()]` (expression in binding position), `[a, ...b, c]` (rest not at end)

**matchPatternParser** (binders + literals):
- Everything bindingPatternParser accepts, PLUS:
- Literals: string `"foo"`, number `42`, boolean `true`, `null`
- Mixed: `{ type: "showPolicy", policy }` (literal value + shorthand binder), `[1, x, 3]` (literal + binder + literal)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agency-lang && npx vitest run lib/parsers/pattern.test.ts 2>&1 | tee /tmp/pattern-parser-test.txt`

- [ ] **Step 3: Implement the pattern parsers**

Add pattern parsers to `lib/parsers/parsers.ts`. Define them with mutual recursion via `lazy()`.

**Shared building blocks:**
- `wildcardPatternParser` — `seqC(char("_"), not(varNameChar))` — word-boundary check is critical because `_foo` is a legal identifier.
- `restPatternParser` — `str("...")` + `many1WithJoin(varNameChar)`.

**bindingPatternParser** = `or(arrayBindingPattern, objectBindingPattern, restPatternParser, wildcardPatternParser, variableNameParser)`
- `arrayBindingPattern` = `[ bindingPattern, bindingPattern, ... ]`
  - **Enforce array rest at end:** if any element is a `restPattern` and it is not the last element, return a parse error (`"rest pattern must be the last element of an array pattern"`).
- `objectBindingPattern` = `{ propBinding, propBinding, ... }` where propBinding is `key: bindingPattern | ...rest | shorthand`
  - `propBindingWithValue` (`key: pattern`) must be tried before `propBindingShorthand` (the `:` disambiguates).

**matchPatternParser** = `or(arrayMatchPattern, objectMatchPattern, restPatternParser, wildcardPatternParser, simpleLiteralParser)`
- `arrayMatchPattern` / `objectMatchPattern` recurse into `matchPatternParser` for elements/values (so literals are allowed inside).
- Same array-rest-at-end enforcement.
- `simpleLiteralParser` already exists at [parsers.ts:638](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L638) and includes `variableNameParser`, so bare identifiers work as match-context binders too.

**Important:** In match context, a bare `variableName` is a *binder* (introduces a new variable bound to the scrutinee), NOT a value comparison. This is the standard pattern-matching convention. Document this clearly.

- [ ] **Step 4: Export and run tests**

Run: `cd packages/agency-lang && npx vitest run lib/parsers/pattern.test.ts 2>&1 | tee /tmp/pattern-parser-test.txt`

- [ ] **Step 5: Commit**

```
feat: add recursive pattern parser for destructuring
```

---

## Task 3: Plug Parsers — Declarations, Match, For, `is`

Wire the pattern parser into the assignment, match block, for loop, and expression parsers.

**Files:**
- Modify: `lib/parsers/parsers.ts`
- Add to: `lib/parsers/pattern.test.ts`

- [ ] **Step 1: Write failing tests for all integration points**

Add tests for:
- `let [a, b] = items` — parsed by assignment parser, produces `pattern` field
- `let { name, age } = person` — same
- `match(step) { { type: "show", v } => f(v) }` — match arm with object pattern
- `match(step) { { s, b } if (s > 5) => f(b) }` — match arm with guard
- `match(response is { status, body }) { ... }` — match with `is` expression
- `for ([k, v] in entries) { ... }` — for loop with pattern
- `step is { type: "showPolicy" }` — `is` operator in expression
- `x is { a } && y > 5` — `is` composes with `&&`

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Modify the assignment parser**

In `_assignmentParserInner`, try destructuring path first: `let`/`const` followed by `arrayBindingPattern | objectBindingPattern`, then `=`, then value. Set `variableName = "__destructured"` (sentinel) and store the pattern in the `pattern` field. Fall through to existing parser if destructuring doesn't match.

- [ ] **Step 4: Modify the match arm parser**

In `matchBlockParserCase`:
- Update `defaultCaseParser` (currently `char("_")` at [parsers.ts:2097](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L2097)) to `seqC(char("_"), not(varNameChar))` so `_foo` doesn't get parsed as default case.
- Replace `or(defaultCaseParser, exprParser)` with `or(defaultCaseParser, matchPatternParser)`.
- Add optional guard: `if (expr)` between the pattern and `=>`. The guard binds with the variables introduced by the pattern, so it must be parsed AFTER the pattern but BEFORE the `=>`.

- [ ] **Step 5: Modify the for loop parser**

In [forLoopParser at parsers.ts:2812](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L2812), replace `capture(many1WithJoin(varNameChar), "itemVar")` with `capture(or(arrayBindingPattern, objectBindingPattern, many1WithJoin(varNameChar)), "itemVar")`.

- [ ] **Step 6: Add `is` to the expression parser**

Wrap the `atom` parser with `atomWithIs` that absorbs trailing `is pattern`:

```typescript
const atomWithIs: Parser<Expression> = (input: string) => {
  const baseResult = atom(input);
  if (!baseResult.success) return baseResult;
  // `spaces` requires ≥1 whitespace, `not(varNameChar)` after `is` ensures we
  // don't match `isFoo` or `island`. Mirrors the existing `wsKeyword` helper.
  const isCheck = seqC(
    spaces,
    str("is"),
    not(varNameChar),
    spaces,
    capture(matchPatternParser, "pattern"),
  )(baseResult.rest);
  if (!isCheck.success) return baseResult;
  return success({
    type: "isExpression",
    expression: baseResult.result,
    pattern: isCheck.result.pattern,
  } as IsExpression, isCheck.rest);
};
```

Replace `atom` with `atomWithIs` in the `buildExpressionParser` call at [parsers.ts:1809](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L1809). The right side of `is` uses `matchPatternParser` (binders + literals are both legal).

- [ ] **Step 7: Run all parser tests**

Run: `cd packages/agency-lang && npx vitest run lib/parsers/pattern.test.ts 2>&1 | tee /tmp/all-parser-tests.txt`

- [ ] **Step 8: Commit**

```
feat: wire pattern parser into declarations, match, for, and expressions
```

---

## Task 4: Lowering Pass

The core of the implementation. A single function that walks the AST and transforms all pattern nodes into existing Agency constructs. After this pass runs, the AST contains no pattern-specific nodes.

**Design principle:** This is pure syntactic sugar. Every pattern construct lowers to code you could have written by hand. The lowering pass runs once, early in the pipeline (after parsing, before typechecking), and the rest of the pipeline is completely unaware that patterns exist.

**Files:**
- Create: `lib/lowering/patternLowering.ts`
- Create: `lib/lowering/patternLowering.test.ts`
- Create: `lib/runtime/destructure.ts` — runtime helpers (`__objectRest`, optionally `__assertNonNull`)

- [ ] **Step 1: Write failing tests for the lowering pass**

Create `lib/lowering/patternLowering.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { lowerPatterns } from "./patternLowering.js";

describe("lowerPatterns", () => {
  describe("array destructuring", () => {
    it("lowers let [a, b] = items", () => {
      // Input: Assignment with pattern: ArrayPattern([a, b]), value: items
      // Output: [
      //   Assignment(__tmp, items),
      //   Assignment(a, __tmp[0]),
      //   Assignment(b, __tmp[1]),
      // ]
      const input = makeAssignment({
        declKind: "let",
        pattern: arrayPattern(["a", "b"]),
        value: varName("items"),
      });
      const result = lowerPatterns([input]);
      expect(result).toHaveLength(3);
      expect(result[0].variableName).toMatch(/^__tmp/);
      expect(result[1].variableName).toBe("a");
      expect(result[2].variableName).toBe("b");
    });
  });

  describe("object destructuring", () => {
    it("lowers let { name, age } = person", () => {
      const input = makeAssignment({
        declKind: "let",
        pattern: objectPattern([shorthand("name"), shorthand("age")]),
        value: varName("person"),
      });
      const result = lowerPatterns([input]);
      expect(result).toHaveLength(3); // tmp + name + age
      expect(result[1].variableName).toBe("name");
      expect(result[2].variableName).toBe("age");
    });
  });

  describe("is operator in boolean context", () => {
    it('lowers x is { type: "foo" } to x.type == "foo"', () => {
      const input = makeAssignment({
        declKind: "const",
        variableName: "result",
        value: isExpr(varName("x"), objectPattern([
          prop("type", stringLiteral("foo")),
        ])),
      });
      const result = lowerPatterns([input]);
      expect(result).toHaveLength(1);
      expect(result[0].value.type).toBe("binOpExpression");
      expect(result[0].value.operator).toBe("==");
    });
  });

  describe("if with is", () => {
    it("lowers if (x is { type: 'foo', val }) to if + bindings", () => {
      const input = makeIfElse({
        condition: isExpr(varName("x"), objectPattern([
          prop("type", stringLiteral("foo")),
          shorthand("val"),
        ])),
        thenBody: [makeFunctionCall("f", [varName("val")])],
      });
      const result = lowerPatterns([input]);
      expect(result).toHaveLength(1);
      const ifNode = result[0];
      expect(ifNode.type).toBe("ifElse");
      // condition should be x.type == "foo"
      expect(ifNode.condition.type).toBe("binOpExpression");
      // thenBody should start with: const val = x.val
      expect(ifNode.thenBody[0].type).toBe("assignment");
      expect(ifNode.thenBody[0].variableName).toBe("val");
    });
  });

  describe("match with patterns lowers to if/else", () => {
    it("lowers match with pattern arms to if/else chain", () => {
      const input = makeMatchBlock({
        expression: varName("step"),
        cases: [
          matchCase(objectPattern([prop("type", stringLiteral("show")), shorthand("v")]),
            makeFunctionCall("f", [varName("v")])),
          matchCase("_", makeFunctionCall("g", [])),
        ],
      });
      const result = lowerPatterns([input]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("ifElse");
    });
  });

  describe("for loop with pattern", () => {
    it("lowers for ([k, v] in entries) to for (__item in entries) + bindings", () => {
      const input = makeForLoop({
        itemVar: arrayPattern(["k", "v"]),
        iterable: varName("entries"),
        body: [makeFunctionCall("print", [varName("k")])],
      });
      const result = lowerPatterns([input]);
      expect(result).toHaveLength(1);
      const forNode = result[0];
      expect(forNode.type).toBe("forLoop");
      expect(typeof forNode.itemVar).toBe("string"); // lowered to a plain string
      // body should start with bindings
      expect(forNode.body[0].variableName).toBe("k");
      expect(forNode.body[1].variableName).toBe("v");
    });
  });
});
```

Note: The helper functions (`makeAssignment`, `arrayPattern`, `objectPattern`, etc.) build AST nodes for testing. Define them at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agency-lang && npx vitest run lib/lowering/patternLowering.test.ts 2>&1 | tee /tmp/lowering-test.txt`

- [ ] **Step 3: Add runtime helpers**

Create `lib/runtime/destructure.ts`:

```typescript
/**
 * Object-rest helper: returns a shallow copy of `source` with `excludedKeys` omitted.
 * Used by `let { a, b, ...rest } = obj` lowering.
 */
export function __objectRest<T extends Record<string, unknown>>(
  source: T,
  excludedKeys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const exclude = new Set(excludedKeys);
  for (const key of Object.keys(source)) {
    if (!exclude.has(key)) result[key] = source[key];
  }
  return result;
}
```

Re-export from `lib/runtime/index.ts`. The lowering pass emits `__objectRest(__tmp, ["a", "b"])` for object-rest bindings.

- [ ] **Step 4: Implement the lowering pass**

Create `lib/lowering/patternLowering.ts`:

```typescript
import { AgencyNode, Assignment, Expression } from "../types.js";
import { Pattern, IsExpression, ObjectPattern, ArrayPattern } from "../types/pattern.js";
import { IfElse } from "../types/ifElse.js";
import { ForLoop } from "../types/forLoop.js";
import { MatchBlock, MatchBlockCase } from "../types/matchBlock.js";

/**
 * Lower all pattern syntax to existing Agency AST constructs.
 * After this pass, the AST contains no pattern-specific nodes.
 *
 * Runs after parsing, before typechecking/preprocessing/codegen.
 * Preserves source locations so errors point to original code.
 */
export function lowerPatterns(nodes: AgencyNode[]): AgencyNode[] {
  return nodes.flatMap(node => lowerNode(node));
}

function lowerNode(node: AgencyNode): AgencyNode[] {
  switch (node.type) {
    case "assignment":
      return lowerAssignment(node);
    case "ifElse":
      return [lowerIfElse(node)];
    case "whileLoop":
      return [lowerWhileLoop(node)];
    case "matchBlock":
      return lowerMatchBlock(node);
    case "forLoop":
      return [lowerForLoop(node)];
    case "functionDefinition":
    case "graphNodeDefinition":
      // Recurse into bodies
      return [{ ...node, body: lowerPatterns(node.body) }];
    default:
      return [node];
  }
}
```

Key lowering functions:

**`lowerAssignment`**: If the assignment has a `pattern` field, expand it:
```typescript
function lowerAssignment(node: Assignment): AgencyNode[] {
  if (!node.pattern) {
    // Pure-boolean `is` context: const result = x is { type: "foo" }
    // → const result = (x.type == "foo")
    // Reject shorthand binders here because they have nowhere to bind.
    if (node.value.type === "isExpression") {
      assertNoBindersInBoolIs(node.value);
      return [{ ...node, value: lowerIsExprBoolean(node.value) }];
    }
    return [node];
  }

  const loc = node.loc;
  const userDeclKind = node.declKind || "const";
  const tempName = freshTemp();

  // Temp is ALWAYS const — it's never reassigned.
  const tempAssign: Assignment = {
    type: "assignment", variableName: tempName, declKind: "const",
    value: node.value, loc,
  };

  // Generate a runtime null/undefined check so that destructuring null/undefined
  // produces a `failure` Result rather than a TypeError. Skipped for array
  // patterns where we can rely on length checks.
  const nullCheck = makeNullCheck(tempName, node.pattern, loc);

  const bindings = extractBindings(node.pattern, varAccess(tempName), userDeclKind, loc);
  return [tempAssign, ...nullCheck, ...bindings];
}
```

**`assertNoBindersInBoolIs`**: walk the pattern; if any `objectPatternShorthand`, `objectPatternProperty` whose value is a binder, or top-level array binder is found, throw a compile-time error pointing at the binder's `loc`. This implements Risk #9.

**`lowerMatchBlock`**: All match blocks with pattern arms become if/else chains. Always bind the scrutinee to a temp first so it's evaluated exactly once:
```typescript
function lowerMatchBlock(node: MatchBlock): AgencyNode[] {
  // If match(expr is pattern), lower the is-destructuring first
  if (node.expression.type === "isExpression") {
    return lowerMatchIsForm(node);
  }

  // Check if any arm uses patterns (not just literals) or has a guard
  const hasPatternArms = node.cases.some(c =>
    c.type === "matchBlockCase" &&
    (c.caseValue?.type === "objectPattern" ||
     c.caseValue?.type === "arrayPattern" ||
     c.guard));

  if (!hasPatternArms) return [node]; // leave literal-only match blocks unchanged

  // Bind the scrutinee to a temp (evaluate once, even if expression has side effects).
  const scrutineeName = freshTemp();
  const scrutineeAssign: Assignment = {
    type: "assignment", variableName: scrutineeName, declKind: "const",
    value: node.expression, loc: node.loc,
  };

  // Walk arms in order. Build a nested if/else chain where each arm becomes:
  //   if (<patternCondition> && <guard?>) { <bindings>; <body> } else <next-arm>
  // Literal arms in a mixed match also lower to `if (__scrutinee == literal)`.
  const ifChain = buildIfChainFromArms(node.cases, varAccess(scrutineeName), node.loc);
  return [scrutineeAssign, ifChain];
}
```

**`lowerMatchIsForm`**: `match(x is { s, b }) { s > 5 => f(b); _ => g(b) }` lowers to: bind scrutinee, extract binders once, then build an if/else chain over guards:
```typescript
function lowerMatchIsForm(node: MatchBlock): AgencyNode[] {
  const isExpr = node.expression as IsExpression;
  const scrutineeName = freshTemp();
  const scrutineeAssign: Assignment = {
    type: "assignment", variableName: scrutineeName, declKind: "const",
    value: isExpr.expression, loc: node.loc,
  };
  const nullCheck = makeNullCheck(scrutineeName, isExpr.pattern, node.loc);
  const bindings = extractBindings(isExpr.pattern, varAccess(scrutineeName), "const", node.loc);

  // Each arm's caseValue is now used as a *guard* expression (boolean).
  // Default `_` arm becomes the final else.
  const ifChain = buildIfChainFromGuardArms(node.cases, node.loc);
  return [scrutineeAssign, ...nullCheck, ...bindings, ifChain];
}
```

**`lowerIfElse`**: If the condition is an `IsExpression`, extract checks and bindings:
```typescript
function lowerIfElse(node: IfElse): IfElse {
  if (node.condition.type === "isExpression") {
    const { condition, bindings } = lowerIsExprWithBindings(node.condition);
    return {
      ...node,
      condition,
      thenBody: [...bindings, ...lowerPatterns(node.thenBody)],
      elseBody: node.elseBody ? lowerPatterns(node.elseBody) : undefined,
    };
  }
  return {
    ...node,
    thenBody: lowerPatterns(node.thenBody),
    elseBody: node.elseBody ? lowerPatterns(node.elseBody) : undefined,
  };
}
```

**`lowerForLoop`**: Replace pattern itemVar with a temp var and prepend bindings (always `const` for the temp; the user's iteration var was already a binder, never reassigned):
```typescript
function lowerForLoop(node: ForLoop): ForLoop {
  if (typeof node.itemVar === "string") {
    return { ...node, body: lowerPatterns(node.body) };
  }
  const tempItem = freshTemp();
  const nullCheck = makeNullCheck(tempItem, node.itemVar, node.loc);
  const bindings = extractBindings(node.itemVar, varAccess(tempItem), "const", node.loc);
  return {
    ...node,
    itemVar: tempItem,
    body: [...nullCheck, ...bindings, ...lowerPatterns(node.body)],
  };
}
```

**`lowerWhileLoop`**: Same shape as `lowerIfElse` — handle `is` in the condition by extracting checks and binding the binders into the loop body. The bindings re-execute every iteration (correct semantics — the scrutinee may change).
```typescript
function lowerWhileLoop(node: WhileLoop): WhileLoop {
  if (node.condition.type === "isExpression") {
    const { condition, bindings } = lowerIsExprWithBindings(node.condition);
    return {
      ...node,
      condition,
      body: [...bindings, ...lowerPatterns(node.body)],
    };
  }
  return { ...node, body: lowerPatterns(node.body) };
}
```

**`extractBindings`**: The core recursive function that turns a pattern + source expression into a list of Assignment nodes:
```typescript
function extractBindings(
  pattern: Pattern, source: Expression, declKind: "let" | "const", loc?: SourceLocation,
): Assignment[] {
  switch (pattern.type) {
    case "objectPattern": {
      // Compute excluded keys for any rest pattern (must be done up-front
      // because we need the list of all named keys).
      const namedKeys: string[] = pattern.properties.flatMap(p =>
        p.type === "objectPatternShorthand" ? [p.name]
        : p.type === "objectPatternProperty" ? [p.key]
        : []
      );
      return pattern.properties.flatMap(prop => {
        if (prop.type === "objectPatternShorthand") {
          return [makeAssign(prop.name, fieldAccess(source, prop.name), declKind, loc)];
        } else if (prop.type === "objectPatternProperty") {
          return extractBindings(prop.value, fieldAccess(source, prop.key), declKind, loc);
        } else if (prop.type === "restPattern") {
          // const rest = __objectRest(source, ["a", "b"])
          return [makeAssign(prop.identifier, makeObjectRestCall(source, namedKeys), declKind, loc)];
        }
        return [];
      });
    }
    case "arrayPattern":
      return pattern.elements.flatMap((el, i) => {
        if (el.type === "wildcardPattern") return [];
        if (el.type === "restPattern") {
          // Parser already enforces: rest is last element. So `i` is the
          // start index of the slice.
          return [makeAssign(el.identifier, sliceCall(source, i), declKind, loc)];
        }
        return extractBindings(el, indexAccess(source, i), declKind, loc);
      });
    case "variableName":
      return [makeAssign(pattern.value, source, declKind, loc)];
    case "wildcardPattern":
    case "restPattern":
      return [];
    default:
      return []; // literals don't produce bindings
  }
}

// Generates: __objectRest(source, ["key1", "key2", ...])
function makeObjectRestCall(source: Expression, excludedKeys: string[]): Expression {
  return {
    type: "functionCall",
    functionName: "__objectRest",
    arguments: [source, { type: "agencyArray", items: excludedKeys.map(k => stringLit(k)) }],
  } as Expression;
}
```

**`makeNullCheck`**: Generates a runtime check that yields a `failure` Result when the source is null/undefined. The exact mechanism depends on Agency's existing failure infrastructure — investigate `lib/runtime/result.ts` (or equivalent) and use whatever the `try`/`catch` paths produce. The simplest viable form:
```typescript
function makeNullCheck(tempName: string, pattern: BindingPattern, loc?: SourceLocation): AgencyNode[] {
  // Only generate for object patterns (array indexing on null also throws,
  // but length checks in patternToCondition handle most cases).
  if (pattern.type !== "objectPattern") return [];
  // Generates the equivalent of:
  //   if (__tmp == null) { return failure("cannot destructure " + typeof __tmp) }
  return [makeNullCheckIf(tempName, loc)];
}
```
Document the failure semantics in `docs/site/guide/pattern-matching.md`.

**`patternToCondition`**: Extracts boolean checks from a pattern (for `is` and match arms):
```typescript
function patternToCondition(pattern: Pattern, source: Expression): Expression | null {
  const checks: Expression[] = [];
  collectChecks(pattern, source, checks);
  if (checks.length === 0) return null;
  return checks.reduce((a, b) => makeBinOp(a, "&&", b));
}

function collectChecks(pattern: Pattern, source: Expression, checks: Expression[]): void {
  switch (pattern.type) {
    case "objectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "objectPatternShorthand") {
          // In boolean context: check field exists
          checks.push(makeBinOp(fieldAccess(source, prop.name), "!=", nullLiteral()));
        } else if (prop.type === "objectPatternProperty") {
          collectChecks(prop.value, fieldAccess(source, prop.key), checks);
        }
      }
      break;
    case "arrayPattern":
      // Check length
      const count = pattern.elements.filter(e => e.type !== "restPattern").length;
      checks.push(makeBinOp(fieldAccess(source, "length"), ">=", numLiteral(count)));
      pattern.elements.forEach((el, i) => {
        if (el.type !== "wildcardPattern" && el.type !== "restPattern" && el.type !== "variableName") {
          collectChecks(el, indexAccess(source, i), checks);
        }
      });
      break;
    case "variableName":
    case "wildcardPattern":
    case "restPattern":
      break; // always matches
    default:
      // Literal — equality check
      checks.push(makeBinOp(source, "==", pattern as Expression));
      break;
  }
}
```

**Helper functions** (`varAccess`, `fieldAccess`, `indexAccess`, `makeBinOp`, `makeAssign`, `sliceCall`, `freshTemp`, `stringLit`, `makeNullCheckIf`, `buildIfChainFromArms`, `buildIfChainFromGuardArms`, etc.) build Agency AST nodes. These are straightforward factory functions that construct existing AST types like `ValueAccess`, `BinOpExpression`, `Assignment`, `FunctionCall`, `IfElse`. `freshTemp` should be a per-pass counter so temp names don't collide across nested patterns.

- [ ] **Step 5: Run tests**

Run: `cd packages/agency-lang && npx vitest run lib/lowering/patternLowering.test.ts 2>&1 | tee /tmp/lowering-test.txt`

Add tests covering the new behavior:
- Match block with side-effecting scrutinee — verify expression appears exactly once after lowering.
- `let { a } = null` — verify lowered code returns a `failure` Result.
- `is` in pure-boolean context with shorthand binders — verify compile-time error.
- `while (x is { v }) { ... }` — verify bindings appear at top of body.
- Nested patterns with multiple `__tmp` names — verify no collision.

- [ ] **Step 6: Commit**

```
feat: add pattern lowering pass
```

---

## Task 5: Wire Lowering into the Pipeline

Insert the lowering pass into the **compilation and LSP paths only**. The format path (AgencyGenerator) must NOT use lowering — it needs the original pattern AST to print patterns back as patterns.

**Files:**
- Modify: Compilation pipeline entry point(s) (find where `parse → SymbolTable.build → ...` is orchestrated)
- Modify: LSP diagnostics entry point (if separate)
- Do NOT modify: the format/`pnpm run fmt` path

- [ ] **Step 1: Find all pipeline entry points**

Search for where the compilation pipeline is orchestrated. The CLAUDE.md says:
`parse → SymbolTable.build → buildCompilationUnit → TypescriptPreprocessor → TypeScriptBuilder.build() → printTs()`

Find all call sites. There are at least two paths:
1. **Compile path** — used by `pnpm run compile` and `pnpm run agency run`
2. **LSP/typecheck path** — used by the LSP for diagnostics and hover

The lowering pass must be inserted in both paths, after parsing, before `SymbolTable.build` and/or typechecking.

The **format path** (`pnpm run fmt`, AgencyGenerator, on-save formatting) must NOT call lowering. Verify this path is separate.

- [ ] **Step 2: Insert the lowering pass into the compile path**

```typescript
import { lowerPatterns } from "../lowering/patternLowering.js";

// After parsing:
const parsed = parse(source);
const lowered = { ...parsed, nodes: lowerPatterns(parsed.nodes) };
// Continue with lowered AST:
const symbols = SymbolTable.build(lowered);
// ...
```

- [ ] **Step 3: Insert the lowering pass into the LSP path**

Find where the LSP runs the typechecker on parsed AST. Insert `lowerPatterns()` before the typechecker call.

- [ ] **Step 4: Verify the format path does NOT lower**

Run `pnpm run fmt` on an agency file with patterns (once formatter support is added in Task 11). Confirm patterns are preserved, not expanded.

- [ ] **Step 5: Run the full test suite**

Run: `cd packages/agency-lang && pnpm test:run 2>&1 | tee /tmp/pipeline-test.txt`

Existing tests should still pass since the lowering pass is a no-op for code without patterns.

- [ ] **Step 6: Commit**

```
feat: wire pattern lowering pass into compilation and LSP pipelines
```

---

## Task 6: End-to-End — Array Destructuring

Verify array destructuring works through the full pipeline.

**Files:**
- Create: `tests/typescriptGenerator/destructuringArray.agency` + `.mjs`
- Create: `tests/agency/destructuring.agency` + `.test.json`

- [ ] **Step 1: Write generator fixture**

Create `tests/typescriptGenerator/destructuringArray.agency`:
```
node main() {
  let items = [1, 2, 3, 4, 5]
  let [a, b] = items
  print(a)
  print(b)
  const [first, _, third] = items
  print(first)
  print(third)
  const [head, ...rest] = items
  print(head)
  print(rest)
}
```

Run `make fixtures`, inspect the `.mjs` output.

- [ ] **Step 2: Write execution test**

Create `tests/agency/destructuring.agency`:
```
node main() {
  let items = [10, 20, 30, 40, 50]
  let [a, b] = items
  return [a, b]
}
```

Test JSON: expect `[10,20]`.

- [ ] **Step 3: Run tests**

Run: `cd packages/agency-lang && pnpm run agency test tests/agency/destructuring.agency 2>&1 | tee /tmp/destructuring-test.txt`

- [ ] **Step 4: Commit**

```
feat: array destructuring in let/const declarations
```

---

## Task 7: End-to-End — Object Destructuring

**Files:**
- Create: `tests/typescriptGenerator/destructuringObject.agency` + `.mjs`
- Modify: `tests/agency/destructuring.agency` + `.test.json`

- [ ] **Step 1: Write fixture and execution tests**

Test cases: `let { name, age } = person`, `let { name: n, ...rest } = person`, nested `let { coords: [x, y] } = loc`.

- [ ] **Step 2: Run tests**

- [ ] **Step 3: Commit**

```
feat: object destructuring in let/const declarations
```

---

## Task 8: End-to-End — `is` Operator

**Files:**
- Create: `tests/typescriptGenerator/isOperator.agency` + `.mjs`
- Create: `tests/agency/isOperator.agency` + `.test.json`

- [ ] **Step 1: Write tests for boolean `is`**

`step is { type: "showPolicy" }` → boolean check.

- [ ] **Step 2: Write tests for `if (expr is pattern)` with bindings**

`if (step is { type: "showPolicy", policy }) { return policy }` → condition + bindings in body.

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```
feat: `is` operator for structural pattern matching
```

---

## Task 9: End-to-End — Match with Patterns

**Files:**
- Create: `tests/typescriptGenerator/matchBlockPatterns.agency` + `.mjs`
- Create: `tests/agency/patternMatch.agency` + `.test.json`

- [ ] **Step 1: Write tests for pattern match arms**

Tagged union dispatch with destructuring. Guards.

- [ ] **Step 2: Write tests for `match(expr is pattern)` form**

Destructure-once, condition arms.

- [ ] **Step 3: Verify existing literal match blocks still work**

Run all existing match block tests to confirm backward compatibility.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```
feat: pattern matching in match blocks
```

---

## Task 10: End-to-End — For Loop Destructuring

**Files:**
- Modify: `tests/agency/destructuring.agency` + `.test.json`

- [ ] **Step 1: Write tests**

`for ([k, v] in entries) { ... }` and `for ({ name, age } in users) { ... }`.

- [ ] **Step 2: Run tests**

- [ ] **Step 3: Commit**

```
feat: pattern destructuring in for loops
```

---

## Task 11: Agency Formatter (AgencyGenerator)

Update the formatter so it can print pattern syntax back to source. Without this, `pnpm run fmt` would break on files with patterns.

**Files:**
- Modify: the AgencyGenerator file (find via `Grep` for `AgencyGenerator`)

- [ ] **Step 1: Find the formatter**

Search for `AgencyGenerator` or the formatter that handles `matchBlock`, `assignment`, `forLoop`.

- [ ] **Step 2: Add pattern formatting**

Handle new node types:
- `ObjectPattern` → `{ key: pattern, shorthand, ...rest }`
- `ArrayPattern` → `[pattern, pattern, ...]`
- `RestPattern` → `...identifier`
- `WildcardPattern` → `_`
- `IsExpression` → `expr is pattern`
- Match arms with guards → `pattern if (guard) => body`
- Assignment with pattern → `let [a, b] = expr`
- ForLoop with pattern itemVar → `for ([k, v] in items) { ... }`

- [ ] **Step 3: Test formatting round-trips**

Write an agency file with all pattern features, run `pnpm run fmt`, verify output matches.

- [ ] **Step 4: Commit**

```
feat: formatter support for destructuring and pattern matching
```

---

## Task 12: Documentation

**Files:**
- Modify: `docs/site/guide/basic-syntax.md`
- Create or modify: `docs/site/guide/pattern-matching.md`
- Modify: `docs/dev/adding-features.md`

- [ ] **Step 1: Add destructuring to basic syntax docs**

- [ ] **Step 2: Document pattern matching and `is`**

Cover: match blocks with patterns, `is` operator (boolean + binding), `match(expr is pattern)`, for loop destructuring, guards.

- [ ] **Step 3: Update dev docs**

Add to `docs/dev/adding-features.md`:
```markdown
## Adding a new pattern form

1. Add the AST type to `lib/types/pattern.ts` and the `Pattern` union.
2. Add a parser case in the pattern parser section of `lib/parsers/parsers.ts`.
3. Add lowering logic in `lib/lowering/patternLowering.ts`.
4. Update the formatter in the AgencyGenerator.
5. Add parser, lowering, and integration tests.
```

- [ ] **Step 4: Commit**

```
docs: add destructuring and pattern matching documentation
```

---

## Task 13: Final Validation

- [ ] **Step 1: Run the full test suite**

Run: `cd packages/agency-lang && pnpm test:run 2>&1 | tee /tmp/final-test-run.txt`

- [ ] **Step 2: Run the structural linter**

Run: `cd packages/agency-lang && pnpm run lint:structure 2>&1 | tee /tmp/lint-output.txt`

- [ ] **Step 3: Rebuild all fixtures**

Run: `cd packages/agency-lang && make fixtures 2>&1 | tee /tmp/fixtures-output.txt`

- [ ] **Step 4: Run execution tests**

Run: `cd packages/agency-lang && pnpm run agency test tests/agency/ 2>&1 | tee /tmp/agency-tests.txt`

- [ ] **Step 5: Fix any regressions**

- [ ] **Step 6: Commit**

```
fix: address regressions from destructuring and pattern matching
```
