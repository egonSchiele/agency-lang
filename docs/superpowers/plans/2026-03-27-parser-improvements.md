# Parser Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the Agency parser with a unified Expression type, `buildExpressionParser` for operator precedence, parenthesized expressions, unary operators, arbitrary expressions in string interpolation and function arguments, and source location tracking via `withSpan`.

**Architecture:** Replace the manual precedence-climbing algorithm in `binop.ts` with tarsec's `buildExpressionParser`. Create a unified `exprParser` using `lazy` for recursion. Use `withSpan` to populate `BaseNode.loc`. Widen ad-hoc expression unions in AST types to use a new `Expression` type. Remove `.trim()` from `normalizeCode` so source positions are accurate.

**Tech Stack:** tarsec (parser combinator library, v0.1.8 — already a dependency), vitest (testing)

---

## File Structure

### New files
- `lib/parsers/expression.ts` — Unified expression parser using `buildExpressionParser`, `lazy`, and the atom parser. Single source of truth for parsing any expression.
- `lib/parsers/expression.test.ts` — Tests for the unified expression parser, including new syntax: parenthesized expressions, unary operators, arbitrary expressions in interpolation.

### Modified files
- `lib/types.ts` — Add `Expression` type union. Widen `Assignment.value`.
- `lib/types/binop.ts` — Replace `BinOpArgument` with `Expression`.
- `lib/types/access.ts` — Widen `AccessChainElement` index type.
- `lib/types/dataStructures.ts` — Widen `SplatExpression.value`, `AgencyArray.items`, `AgencyObjectKV.value`.
- `lib/types/function.ts` — Widen `FunctionCall.arguments`.
- `lib/types/ifElse.ts` — Widen `IfElse.condition`.
- `lib/types/whileLoop.ts` — Widen `WhileLoop.condition`.
- `lib/types/forLoop.ts` — Widen `ForLoop.iterable`.
- `lib/types/returnStatement.ts` — Widen `ReturnStatement.value`.
- `lib/types/specialVar.ts` — Widen `SpecialVar.value`.
- `lib/types/matchBlock.ts` — Widen `MatchBlock.expression`, `MatchBlockCase.caseValue`.
- `lib/types/literals.ts` — Widen `InterpolationSegment.expression`.
- `lib/parsers/binop.ts` — Rewrite to use `buildExpressionParser`.
- `lib/parsers/literals.ts` — Update interpolation parser to accept `exprParser`.
- `lib/parsers/functionCall.ts` — Update arguments to use `exprParser`.
- `lib/parsers/access.ts` — Update index access to use `exprParser`.
- `lib/parsers/dataStructures.ts` — Update array items and object values to use `exprParser`.
- `lib/parsers/function.ts` — Update `assignmentParser`, `ifParser`, `whileLoopParser`, `forLoopParser` to use `exprParser`.
- `lib/parsers/returnStatement.ts` — Update to use `exprParser`.
- `lib/parsers/specialVar.ts` — Update to use `exprParser`.
- `lib/parsers/matchBlock.ts` — Update expression and case value parsing to use `exprParser`.
- `lib/parser.ts` — Remove `.trim()` from `normalizeCode`. Add `withSpan` wrapping to populate `BaseNode.loc`.

---

## Task 1: Add the `Expression` type and widen AST types

This is a pure type-level change. No parser code changes. All existing tests should continue to pass because we're only widening unions.

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/types/binop.ts`
- Modify: `lib/types/access.ts`
- Modify: `lib/types/dataStructures.ts`
- Modify: `lib/types/function.ts`
- Modify: `lib/types/ifElse.ts`
- Modify: `lib/types/whileLoop.ts`
- Modify: `lib/types/forLoop.ts`
- Modify: `lib/types/returnStatement.ts`
- Modify: `lib/types/specialVar.ts`
- Modify: `lib/types/matchBlock.ts`
- Modify: `lib/types/literals.ts`

- [ ] **Step 1: Add Expression type to `lib/types.ts`**

Add after the existing imports and before the `Scope` type:

```ts
export type Expression =
  | ValueAccess
  | Literal
  | FunctionCall
  | BinOpExpression
  | AgencyArray
  | AgencyObject;
```

- [ ] **Step 2: Widen `Assignment.value` in `lib/types.ts`**

Change `Assignment.value` from the current ad-hoc union to:

```ts
value: Expression | MessageThread;
```

Add `Expression` to the import if needed (it's defined in the same file, so no import needed). `MessageThread` stays as a separate alternative because it's a block statement, not an expression.

- [ ] **Step 3: Widen types in `lib/types/binop.ts`**

Replace the `BinOpArgument` type with:

```ts
import { Expression } from "../types.js";

export type BinOpArgument = Expression;
```

Update `BinOpExpression.left` and `BinOpExpression.right` to use `Expression`:

```ts
export type BinOpExpression = BaseNode & {
  type: "binOpExpression";
  operator: Operator;
  left: Expression;
  right: Expression;
};
```

Note: keeping `BinOpArgument` as an alias for backwards compatibility in case downstream code references it, but its definition is now just `Expression`.

- [ ] **Step 4: Widen types in `lib/types/function.ts`**

Change `FunctionCall.arguments` to:

```ts
arguments: Expression[];
```

Remove the ad-hoc union. Add `import { Expression } from "../types.js"`.

- [ ] **Step 5: Widen types in `lib/types/ifElse.ts`**

Change `IfElse.condition` to:

```ts
condition: Expression;
```

Remove the ad-hoc union imports that are no longer needed. Add `import { Expression } from "../types.js"`.

- [ ] **Step 6: Widen types in remaining files**

Apply the same pattern to each file — replace ad-hoc expression unions with `Expression`:

- `lib/types/whileLoop.ts`: `WhileLoop.condition` → `Expression`
- `lib/types/forLoop.ts`: `ForLoop.iterable` → `Expression`
- `lib/types/returnStatement.ts`: `ReturnStatement.value` → `Expression`
- `lib/types/specialVar.ts`: `SpecialVar.value` → `Expression`
- `lib/types/matchBlock.ts`: `MatchBlock.expression` → `Expression`, `MatchBlockCase.caseValue` → `Expression | DefaultCase`
- `lib/types/literals.ts`: `InterpolationSegment.expression` → `Expression`
- `lib/types/dataStructures.ts`: `SplatExpression.value` → `Expression`, `AgencyArray.items` → `(Expression | SplatExpression)[]`, `AgencyObjectKV.value` → `Expression`
- `lib/types/access.ts`: `AccessChainElement` index case → `index: Expression`

- [ ] **Step 7: Build and run tests**

Run: `pnpm run build && pnpm test:run`

Expected: All tests pass. This is a type-widening change only — existing values are all subtypes of `Expression`, so no runtime behavior changes.

- [ ] **Step 8: Commit**

```
git add lib/types.ts lib/types/*.ts
git commit -m "Add unified Expression type and widen ad-hoc expression unions in AST types"
```

---

## Task 2: Create the unified expression parser with `buildExpressionParser`

Replace the manual precedence-climbing algorithm in `binop.ts` with tarsec's `buildExpressionParser`. Create a new `expression.ts` that is the single source of truth for parsing any expression.

**Files:**
- Create: `lib/parsers/expression.ts`
- Create: `lib/parsers/expression.test.ts`
- Modify: `lib/parsers/binop.ts`

**Important context:**
- `buildExpressionParser` takes an atom parser, an operator table (highest precedence first), and an optional custom paren parser.
- It handles parenthesized sub-expressions automatically via `lazy`.
- The `apply` function on each operator receives the left and right parsed values and returns the combined result.
- The operator table supports `"left"` and `"right"` associativity.
- Tarsec's `Span` type has `start: Position` and `end: Position` where `Position` has `offset`, `line`, `column` (all 0-based).

- [ ] **Step 1: Write failing tests for the new expression parser**

Create `lib/parsers/expression.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { exprParser } from "./expression.js";

describe("exprParser", () => {
  describe("atoms", () => {
    it("should parse a number", () => {
      const result = exprParser("42");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({ type: "number", value: "42" });
      }
    });

    it("should parse a variable name", () => {
      const result = exprParser("foo");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({ type: "variableName", value: "foo" });
      }
    });

    it("should parse a string", () => {
      const result = exprParser('"hello"');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("string");
      }
    });

    it("should parse a boolean", () => {
      const result = exprParser("true");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({ type: "boolean", value: true });
      }
    });

    it("should parse an array literal", () => {
      const result = exprParser("[1, 2, 3]");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("agencyArray");
      }
    });

    it("should parse an object literal", () => {
      const result = exprParser('{ key: "value" }');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("agencyObject");
      }
    });
  });

  describe("binary operations", () => {
    it("should parse addition", () => {
      const result = exprParser("1 + 2");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "binOpExpression",
          operator: "+",
          left: { type: "number", value: "1" },
          right: { type: "number", value: "2" },
        });
      }
    });

    it("should respect precedence: * before +", () => {
      const result = exprParser("1 + 2 * 3");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "binOpExpression",
          operator: "+",
          left: { type: "number", value: "1" },
          right: {
            type: "binOpExpression",
            operator: "*",
            left: { type: "number", value: "2" },
            right: { type: "number", value: "3" },
          },
        });
      }
    });

    it("should be left-associative: 1 - 2 - 3 = (1 - 2) - 3", () => {
      const result = exprParser("1 - 2 - 3");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "binOpExpression",
          operator: "-",
          left: {
            type: "binOpExpression",
            operator: "-",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "2" },
          },
          right: { type: "number", value: "3" },
        });
      }
    });

    it("should parse comparison operators", () => {
      const result = exprParser("a == b");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
        expect(result.result.operator).toBe("==");
      }
    });

    it("should parse logical operators", () => {
      const result = exprParser("a && b || c");
      expect(result.success).toBe(true);
      if (result.success) {
        // || is lower precedence than &&
        expect(result.result.operator).toBe("||");
      }
    });

    it("should parse assignment operators", () => {
      const result = exprParser("x += 1");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.operator).toBe("+=");
      }
    });
  });

  describe("parenthesized expressions", () => {
    it("should parse (expr)", () => {
      const result = exprParser("(42)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({ type: "number", value: "42" });
      }
    });

    it("should override precedence with parens", () => {
      const result = exprParser("(1 + 2) * 3");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "binOpExpression",
          operator: "*",
          left: {
            type: "binOpExpression",
            operator: "+",
            left: { type: "number", value: "1" },
            right: { type: "number", value: "2" },
          },
          right: { type: "number", value: "3" },
        });
      }
    });

    it("should handle nested parens", () => {
      const result = exprParser("((1 + 2))");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("binOpExpression");
      }
    });
  });

  describe("unary operators", () => {
    it("should parse logical not", () => {
      const result = exprParser("!x");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          type: "binOpExpression",
          operator: "!",
          left: { type: "boolean", value: true },
          right: { type: "variableName", value: "x" },
        });
      }
    });

    it("should parse !x && y as (!x) && y", () => {
      const result = exprParser("!x && y");
      expect(result.success).toBe(true);
      if (result.success) {
        // ! binds tighter than &&
        expect(result.result.operator).toBe("&&");
      }
    });

    it("should parse negative number literals", () => {
      const result = exprParser("-42");
      expect(result.success).toBe(true);
      if (result.success) {
        // -42 is a number literal, not unary negation
        expect(result.result).toEqual({ type: "number", value: "-42" });
      }
    });
  });

  describe("value access and function calls", () => {
    it("should parse property access", () => {
      const result = exprParser("foo.bar");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("valueAccess");
      }
    });

    it("should parse function calls", () => {
      const result = exprParser("foo(1, 2)");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("functionCall");
      }
    });

    it("should parse function call as expression argument", () => {
      const result = exprParser("foo(bar())");
      expect(result.success).toBe(true);
    });

    it("should parse binary operation as function argument", () => {
      const result = exprParser("foo(a + b)");
      expect(result.success).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/parsers/expression.test.ts`

Expected: FAIL — `exprParser` does not exist yet.

- [ ] **Step 3: Implement the unified expression parser**

Create `lib/parsers/expression.ts`:

```ts
import {
  buildExpressionParser,
  char,
  failure,
  lazy,
  or,
  Parser,
  str,
  success,
} from "tarsec";
import { Expression } from "../types.js";
import { BinOpExpression, Operator } from "../types/binop.js";
import { optionalSpaces } from "./utils.js";

// --- Unary operators ---
// Desugared into BinOpExpression to avoid adding a new AST node type:
//   !x  becomes  { op: "!", left: { type: "boolean", value: true }, right: x }
// The builder must handle "!" specially (generating `!x`, not `true ! x`).
//
// Note: unary `-` is NOT included. Negative number literals like `-42` are already
// handled by numberParser in literals.ts. If we added unary `-`, it would conflict:
// `-42` would parse as `0 - 42` instead of the number literal `-42`.
// This matches the current Agency behavior where `-x` is not valid syntax.
// If unary negation is needed in the future, numberParser must first be changed
// to stop accepting leading `-`.

const unaryNotParser: Parser<Expression> = (input: string) => {
  const bangResult = char("!")(input);
  if (!bangResult.success) return bangResult;
  // Recurse to atom (not exprParser) so `!` binds tightly: `!x && y` = `(!x) && y`
  const atomResult = lazy(() => atom)(bangResult.rest);
  if (!atomResult.success) return failure("expected expression after !", input);
  return success(
    {
      type: "binOpExpression" as const,
      operator: "!" as Operator,
      left: { type: "boolean" as const, value: true },
      right: atomResult.result,
    } as BinOpExpression,
    atomResult.rest,
  );
};

// The atom parser: the smallest unit of an expression.
// Order matters — try more specific parsers first.
// All sub-parsers use lazy() to break circular import chains:
//   expression.ts -> access.ts -> functionCall.ts -> (after Task 3) expression.ts
//   expression.ts -> literals.ts -> (after Task 3) expression.ts
// lazy() defers evaluation until parse time, when all modules are fully loaded.
const atom: Parser<Expression> = or(
  unaryNotParser,
  lazy(() => require("./dataStructures.js").agencyArrayParser),
  lazy(() => require("./dataStructures.js").agencyObjectParser),
  lazy(() => require("./literals.js").booleanParser),
  lazy(() => require("./access.js").valueAccessParser),
  lazy(() => require("./literals.js").literalParser),
);

// NOTE on lazy imports above: The actual implementation should use dynamic lazy
// references, not require(). The exact pattern depends on how tarsec's lazy
// interacts with ESM. The simplest approach that works with ESM circular imports:
// define atom as a function that evaluates the imports at call time:
//
//   const atom: Parser<Expression> = (input: string) => {
//     const { agencyArrayParser, agencyObjectParser } = await import("./dataStructures.js");
//     // ... but this is async, which doesn't work for parsers.
//   };
//
// The real fix: since all these parsers are themselves defined as functions (not
// evaluated at import time), ESM circular imports work fine as long as the import
// bindings are resolved by the time a parser is actually *called*. So the lazy()
// wrappers ensure we don't evaluate the imported parsers during module init.
// Replace the require() calls above with proper ESM imports at the top of the file,
// and wrap each one in lazy():
//
//   import { valueAccessParser } from "./access.js";
//   const atom = or(
//     unaryNotParser,
//     lazy(() => agencyArrayParser),
//     lazy(() => agencyObjectParser),
//     lazy(() => booleanParser),
//     lazy(() => valueAccessParser),
//     lazy(() => literalParser),
//   );

// Operator helper: parse an operator with optional surrounding whitespace
function wsOp(opStr: string): Parser<string> {
  return (input: string) => {
    const r1 = optionalSpaces(input);
    if (!r1.success) return r1;
    const r2 = str(opStr)(r1.rest);
    if (!r2.success) return r2;
    const r3 = optionalSpaces(r2.rest);
    if (!r3.success) return r3;
    return { success: true as const, result: opStr, rest: r3.rest };
  };
}

// Build a BinOpExpression AST node
function makeBinOp(op: string): (left: Expression, right: Expression) => Expression {
  return (left, right) => ({
    type: "binOpExpression" as const,
    operator: op as Operator,
    left,
    right,
  });
}

// Custom paren parser with whitespace handling.
// The default paren parser in buildExpressionParser does `input[0] === "("` and
// `rest[0] === ")"` — no whitespace skipping. So `( 1 + 2 )` (space before `)`)
// would fail. This custom parser handles optional whitespace inside parens.
let _exprParser: Parser<Expression>;
const parenParser: Parser<Expression> = (input: string) => {
  const openResult = char("(")(input);
  if (!openResult.success) return openResult;
  const wsResult1 = optionalSpaces(openResult.rest);
  if (!wsResult1.success) return wsResult1;
  const exprResult = _exprParser(wsResult1.rest);
  if (!exprResult.success) return failure("expected expression inside parentheses", input);
  const wsResult2 = optionalSpaces(exprResult.rest);
  if (!wsResult2.success) return wsResult2;
  const closeResult = char(")")(wsResult2.rest);
  if (!closeResult.success) return failure("expected closing parenthesis", input);
  return success(exprResult.result, closeResult.rest);
};

// Operator table: highest precedence first
// See lib/types/binop.ts PRECEDENCE record for reference
export const exprParser: Parser<Expression> = buildExpressionParser<Expression>(
  atom,
  [
    // Precedence 6: multiplicative
    [
      { op: wsOp("*="), assoc: "right", apply: makeBinOp("*=") },
      { op: wsOp("/="), assoc: "right", apply: makeBinOp("/=") },
      { op: wsOp("*"), assoc: "left", apply: makeBinOp("*") },
      { op: wsOp("/"), assoc: "left", apply: makeBinOp("/") },
    ],
    // Precedence 5: additive
    [
      { op: wsOp("+="), assoc: "right", apply: makeBinOp("+=") },
      { op: wsOp("-="), assoc: "right", apply: makeBinOp("-=") },
      { op: wsOp("+"), assoc: "left", apply: makeBinOp("+") },
      { op: wsOp("-"), assoc: "left", apply: makeBinOp("-") },
    ],
    // Precedence 4: relational
    [
      { op: wsOp("<="), assoc: "left", apply: makeBinOp("<=") },
      { op: wsOp(">="), assoc: "left", apply: makeBinOp(">=") },
      { op: wsOp("<"), assoc: "left", apply: makeBinOp("<") },
      { op: wsOp(">"), assoc: "left", apply: makeBinOp(">") },
    ],
    // Precedence 3: equality
    [
      { op: wsOp("=="), assoc: "left", apply: makeBinOp("==") },
      { op: wsOp("!="), assoc: "left", apply: makeBinOp("!=") },
    ],
    // Precedence 2: logical AND
    [
      { op: wsOp("&&"), assoc: "left", apply: makeBinOp("&&") },
    ],
    // Precedence 1: logical OR
    [
      { op: wsOp("||"), assoc: "left", apply: makeBinOp("||") },
    ],
  ],
  parenParser,
);

// Wire up the circular reference for parenParser
_exprParser = exprParser;
```

**Important implementation notes:**
- **No unary `-` operator.** The `numberParser` in `literals.ts` already accepts `-42` as a number literal. Adding unary `-` would create an ambiguity where `-42` parses as `0 - 42` instead. If unary negation is needed in the future, first change `numberParser` to stop accepting leading `-`.
- **`!` operator binds tightly.** The `unaryNotParser` recurses to `atom`, not to `exprParser`. This means `!x && y` parses as `(!x) && y`, matching TypeScript semantics.
- **`!` added to the `Operator` type.** Add `"!"` to the union in `lib/types/binop.ts` and `"!": 7` to the `PRECEDENCE` record. The builder needs a case for `!` — this is a follow-up task.
- **Circular imports handled with `lazy()`.** All atom sub-parsers are wrapped in `lazy()` so they aren't evaluated during module initialization. ESM will have the import bindings resolved by the time any parser is actually called.
- **Custom paren parser with whitespace.** The default `buildExpressionParser` paren handler doesn't skip whitespace inside parens, so `( 1 + 2 )` would fail. The custom `parenParser` handles `optionalSpaces` after `(` and before `)`.
- **Assignment operators (`+=`, `-=`, `*=`, `/=`) placed within their corresponding precedence groups.** They must appear before their base operator (e.g., `*=` before `*`) so the two-character version is tried first. They use `"right"` associativity.
- The `<=` and `>=` operators must come before `<` and `>` in the relational group.
- The atom parser tries `valueAccessParser` before `literalParser` because `valueAccessParser` handles function calls and property chains which start with identifiers.

- [ ] **Step 4: Run expression tests**

Run: `pnpm vitest run lib/parsers/expression.test.ts`

Expected: Most tests PASS. Some may need adjustment based on exact AST shapes. Fix any failures.

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `pnpm test:run`

Expected: All existing tests still pass. The new `expression.ts` is not wired into any existing parsers yet.

- [ ] **Step 6: Commit**

```
git add lib/parsers/expression.ts lib/parsers/expression.test.ts lib/types/binop.ts
git commit -m "Add unified expression parser using buildExpressionParser"
```

---

## Task 3: Wire `exprParser` into existing parsers

Replace ad-hoc expression unions in existing parsers with `exprParser`. This is the main integration step.

**Files:**
- Modify: `lib/parsers/function.ts` (assignmentParser, ifParser, whileLoopParser, forLoopParser)
- Modify: `lib/parsers/functionCall.ts`
- Modify: `lib/parsers/access.ts` (index access)
- Modify: `lib/parsers/dataStructures.ts` (array items, object values)
- Modify: `lib/parsers/returnStatement.ts`
- Modify: `lib/parsers/specialVar.ts`
- Modify: `lib/parsers/matchBlock.ts`
- Modify: `lib/parsers/binop.ts`

**Important context:**
- When replacing `or(binOpParser, booleanParser, valueAccessParser, literalParser)` with `exprParser`, be careful about parse order. `exprParser` already includes all of these in its atom parser.
- The old `binOpParser` only succeeded if the result was actually a `BinOpExpression` (not just an atom). The new `exprParser` succeeds for any expression, including atoms. This is the desired behavior — anywhere an expression was expected, you can now put any expression.
- `lib/parsers/binop.ts` can be simplified to just re-export from `expression.ts`, or its callers can be updated to import from `expression.ts` directly.

- [ ] **Step 1: Update `lib/parsers/binop.ts`**

Replace the entire implementation with a re-export from the expression parser:

```ts
// The expression parser now handles all binary operations via buildExpressionParser.
// This file re-exports for backwards compatibility with existing imports.
export { exprParser as binOpParser } from "./expression.js";
```

Wait — this changes the behavior. The old `binOpParser` only matched if the result was a `BinOpExpression`. Some callers may depend on this. Instead, keep `binOpParser` as a wrapper that only succeeds for `BinOpExpression`:

```ts
import { Parser } from "tarsec";
import { BinOpExpression } from "../types/binop.js";
import { exprParser } from "./expression.js";

export const binOpParser: Parser<BinOpExpression> = (input: string) => {
  const result = exprParser(input);
  if (!result.success) return result;
  if (result.result.type !== "binOpExpression") {
    return { success: false, rest: input, message: "expected binary operation" };
  }
  return { ...result, result: result.result as BinOpExpression };
};
```

- [ ] **Step 2: Update `lib/parsers/functionCall.ts`**

Replace the argument parser's `or(...)` with `exprParser`. In `_functionCallParser`, where arguments are parsed, change:

```ts
// Old:
capture(
  sepBy(comma, or(agencyArrayParser, agencyObjectParser, binOpParser, booleanParser, valueAccessParser, literalParser)),
  "arguments",
)
// New:
capture(
  sepBy(comma, exprParser),
  "arguments",
)
```

Add `import { exprParser } from "./expression.js"` and remove now-unused imports.

- [ ] **Step 3: Update `lib/parsers/access.ts`**

In `indexChainParser`, replace the limited `or(_functionCallParser, variableNameParser, literalParser)` for the index expression with `exprParser`:

```ts
// Old:
capture(or(_functionCallParser, variableNameParser, literalParser), "index"),
// New:
capture(exprParser, "index"),
```

Add `import { exprParser } from "./expression.js"`.

- [ ] **Step 4: Update `lib/parsers/dataStructures.ts`**

In `agencyArrayParser`, replace the item parser with `exprParser` (plus `splatParser`):

```ts
// Old:
sepBy(commaWithNewline, or(splatParser, agencyObjectParser, valueAccessParser, booleanParser, literalParser))
// New:
sepBy(commaWithNewline, or(splatParser, exprParser))
```

In `agencyObjectKVParser`, replace the value parser:

```ts
// Old:
capture(or(agencyObjectParser, agencyArrayParser, valueAccessParser, booleanParser, literalParser), "value")
// New:
capture(exprParser, "value")
```

Also update `splatParser` to use `exprParser` for its value (currently limited to `ValueAccess | FunctionCall | Literal`):

```ts
// Old:
capture(or(valueAccessParser, literalParser), "value")
// New:
capture(exprParser, "value")
```

Add `import { exprParser } from "./expression.js"`.

- [ ] **Step 5: Update `lib/parsers/function.ts`**

In `assignmentParser`, replace the value union with `exprParser`:

```ts
// Old:
capture(or(binOpParser, messageThreadParser, booleanParser, valueAccessParser, agencyArrayParser, agencyObjectParser, literalParser), "value")
// New:
capture(or(messageThreadParser, exprParser), "value")
```

`messageThreadParser` stays as a separate alternative because it's not an expression.

In `ifParser`, `whileLoopParser`, replace condition parsers:

```ts
// Old:
capture(or(binOpParser, booleanParser, valueAccessParser, literalParser), "condition")
// New:
capture(exprParser, "condition")
```

In `forLoopParser`, replace iterable parser:

```ts
// Old:
capture(or(functionCallParser, valueAccessParser, literalParser), "iterable")
// New:
capture(exprParser, "iterable")
```

Add `import { exprParser } from "./expression.js"`.

- [ ] **Step 6: Update `lib/parsers/returnStatement.ts`**

Read this file first, then replace the return value's `or(...)` with `exprParser`.

- [ ] **Step 7: Update `lib/parsers/specialVar.ts`**

Read this file first, then replace the value's `or(...)` with `exprParser`.

- [ ] **Step 8: Update `lib/parsers/matchBlock.ts`**

Read this file first, then replace the expression and case value `or(...)` unions with `exprParser`.

- [ ] **Step 9: Update `lib/parsers/literals.ts` — string interpolation**

In `interpolationSegmentParser`, replace the restricted parser with `exprParser`:

```ts
// Old:
capture(or(_valueAccessParser, variableNameParser), "expression")
// New:
capture(exprParser, "expression")
```

This enables `"${foo()}"` and `"${a + b}"`. Remove the function call rejection logic that currently throws an error for function calls in interpolation.

Add `import { exprParser } from "./expression.js"`.

**Note on `bodyParser` and `agencyNode`:** The `bodyParser` in `lib/parsers/function.ts` and the `agencyNode` parser in `lib/parser.ts` both list `binOpParser` as an alternative. Since `binOpParser` is now a filtering wrapper around `exprParser`, this still works — standalone binary operations in function bodies continue to parse correctly. No changes needed to these parsers in this task. A future simplification could replace some of their alternatives with `exprParser`, but that's out of scope.

- [ ] **Step 10: Run the full test suite**

Run: `pnpm run build && pnpm test:run`

Expected: Most tests pass. Some tests may fail if they test the old restriction that function calls are forbidden in interpolation, or if the exact parse order produces slightly different AST shapes. Fix any failures:
- Tests that assert function calls are rejected in interpolation should be updated to assert they succeed.
- Tests that depend on specific parsing order may need adjustment.

- [ ] **Step 11: Commit**

```
git add lib/parsers/*.ts
git commit -m "Wire unified exprParser into all expression positions"
```

---

## Task 4: Add tests for new syntax features

Now that the unified expression parser is wired in, add tests for the new capabilities.

**Files:**
- Modify: `lib/parsers/expression.test.ts`
- Modify: `lib/parsers/literals.test.ts`
- Modify: `lib/parsers/functionCall.test.ts`

- [ ] **Step 1: Add parenthesized expression tests**

Add to `lib/parsers/expression.test.ts`:

```ts
describe("parenthesized expressions in context", () => {
  it("should parse parenthesized function call", () => {
    const result = exprParser('(foo("hi"))');
    expect(result.success).toBe(true);
  });

  it("should parse deeply nested parens", () => {
    const result = exprParser("(((x)))");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({ type: "variableName", value: "x" });
    }
  });
});
```

- [ ] **Step 2: Add string interpolation expression tests**

Add to `lib/parsers/literals.test.ts`:

```ts
describe("arbitrary expressions in interpolation", () => {
  it("should allow function calls in interpolation", () => {
    const result = stringParser('"${foo()}"');
    expect(result.success).toBe(true);
  });

  it("should allow binary operations in interpolation", () => {
    const result = stringParser('"result: ${a + b}"');
    expect(result.success).toBe(true);
  });

  it("should allow method calls in interpolation", () => {
    const result = stringParser('"${obj.method()}"');
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Add function argument expression tests**

Add to `lib/parsers/functionCall.test.ts`:

```ts
describe("arbitrary expressions as arguments", () => {
  it("should allow binary operation as argument", () => {
    const result = functionCallParser("foo(a + b)");
    expect(result.success).toBe(true);
  });

  it("should allow nested function call as argument", () => {
    const result = functionCallParser("foo(bar(baz()))");
    expect(result.success).toBe(true);
  });

  it("should allow parenthesized expression as argument", () => {
    const result = functionCallParser("foo((a + b) * c)");
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 4: Add unary operator tests**

Add to `lib/parsers/expression.test.ts`:

```ts
describe("unary operators in context", () => {
  it("should parse not in condition", () => {
    const result = exprParser("!done && running");
    expect(result.success).toBe(true);
    if (result.success) {
      // ! binds tighter than &&
      expect(result.result.operator).toBe("&&");
    }
  });

  it("should parse double negation", () => {
    const result = exprParser("!!x");
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 5: Run all tests**

Run: `pnpm test:run`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```
git add lib/parsers/expression.test.ts lib/parsers/literals.test.ts lib/parsers/functionCall.test.ts
git commit -m "Add tests for new expression syntax: parens, unary ops, interpolation, function args"
```

---

## Task 5: Add source location tracking with `withSpan`

Add `withSpan` to parsers to populate `BaseNode.loc`. This can be done incrementally — start with the most important parsers (those needed for "go to definition").

**Files:**
- Modify: `lib/parser.ts` (remove `.trim()` from `normalizeCode`)
- Modify: `lib/parsers/expression.ts`
- Modify: `lib/parsers/function.ts`
- Modify: `lib/parsers/access.ts`
- Modify: `lib/parsers/literals.ts`

**Important context:**
- `withSpan<T>(parser)` returns `Parser<{ value: T; span: Span }>` where `Span` has `start: Position` and `end: Position`.
- `Position` has `offset: number`, `line: number`, `column: number` (all 0-based).
- `BaseNode.loc` has `line: number`, `col: number`, `start: number`, `end: number`.
- `setInputStr` is already called in `_parseAgency()`, so `withSpan` will work.
- The `.trim()` in `normalizeCode` must be removed first, otherwise column numbers will be wrong.

- [ ] **Step 1: Remove `.trim()` from `normalizeCode` in `lib/parser.ts`**

Change `normalizeCode`:

```ts
// Old:
export const normalizeCode = (code: string) => {
  return code
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
};

// New:
export const normalizeCode = (code: string) => {
  return code;
};
```

Or simply remove the function and pass the input directly. But keeping the function as a no-op is safer for now in case other callers use it.

- [ ] **Step 2: Run tests to check if removing `.trim()` breaks anything**

Run: `pnpm run build && pnpm test:run`

**This may cause significant test failures.** The `.trim()` stripped all leading whitespace from every line, so the parser has never seen indented code. Agency uses explicit `{` and `}` for blocks, and syntactic rules generally use `optionalSpaces` between tokens, so the parser *should* handle leading whitespace. But some parsers may not. If there are widespread failures:
- Audit which parsers fail with leading whitespace
- Add `optionalSpaces` or `optionalSpacesOrNewline` at the start of block body parsers where needed
- Fix the failing tests

Some tests may fail if they relied on leading whitespace being stripped. Fix any failures — this is the correct behavior now.

- [ ] **Step 3: Create a `withLoc` helper**

Add to `lib/parsers/expression.ts` (or a new `lib/parsers/loc.ts`):

```ts
import { withSpan, Parser } from "tarsec";
import { BaseNode, SourceLocation } from "../types/base.js";

// Wraps a parser to populate BaseNode.loc from tarsec's Span
export function withLoc<T extends BaseNode>(parser: Parser<T>): Parser<T> {
  return (input: string) => {
    const result = withSpan(parser)(input);
    if (!result.success) return result;
    const { value, span } = result.result;
    return {
      success: true as const,
      result: {
        ...value,
        loc: {
          line: span.start.line,
          col: span.start.column,
          start: span.start.offset,
          end: span.end.offset,
        },
      },
      rest: result.rest,
    };
  };
}
```

This converts tarsec's `Span` into `BaseNode.loc` format.

- [ ] **Step 4: Apply `withLoc` to key parsers**

Start with the parsers most important for "go to definition":

In `lib/parsers/function.ts`:
- Wrap `functionParser` with `withLoc`
- Wrap `graphNodeParser` with `withLoc`
- Wrap `assignmentParser` with `withLoc`

In `lib/parsers/access.ts`:
- Wrap `valueAccessParser` with `withLoc`

In `lib/parsers/literals.ts`:
- Wrap `variableNameParser` with `withLoc`

In `lib/parsers/expression.ts`:
- Wrap the atom parser or the individual sub-parsers with `withLoc`

The approach: wrap the outermost parser for each AST node type. Since `loc` is optional on `BaseNode`, parsers that don't have `withLoc` simply won't populate it.

- [ ] **Step 5: Add tests for source locations**

Add to `lib/parsers/expression.test.ts`:

```ts
import { setInputStr } from "tarsec";

describe("source locations", () => {
  it("should populate loc on parsed expression", () => {
    const input = "foo + bar";
    setInputStr(input);
    const result = exprParser(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.loc).toBeDefined();
      expect(result.result.loc.line).toBe(0);
      expect(result.result.loc.col).toBe(0);
      expect(result.result.loc.start).toBe(0);
    }
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `pnpm run build && pnpm test:run`

**`toEqual` breakage strategy:** vitest's `toEqual` checks for extra properties, so adding `loc` to AST nodes will fail tests that use `toEqual` against expected objects without `loc`. The strategy:

1. **Only apply `withLoc` at the `parseAgency` level** — wrap the top-level parser in `lib/parser.ts`, not the individual sub-parsers. This means tests that call individual parsers directly (e.g., `assignmentParser("x = 1")`) will NOT get `loc`, so they pass unchanged. Only the full `parseAgency()` pipeline produces `loc`.

2. **For integration tests** (in `tests/typescriptGenerator/` etc.) that go through `parseAgency`, the downstream code ignores `loc` so there's no issue — the generated TypeScript is the same regardless of whether `loc` is present.

This approach means zero test changes for `loc`. The `loc` data is available to consumers of `parseAgency()` (like a future VS Code extension) but doesn't leak into unit tests.

- [ ] **Step 7: Commit**

```
git add lib/parser.ts lib/parsers/*.ts
git commit -m "Add source location tracking via withSpan/withLoc"
```

---

## Task 6: Integration testing and cleanup

Verify the full pipeline works end-to-end and clean up.

**Files:**
- Test: `tests/typescriptGenerator/*.agency` (existing fixture tests)
- Test: `tests/typescriptBuilder/*.agency` (existing fixture tests)

- [ ] **Step 1: Run the full integration test suite**

Run: `pnpm run build && pnpm test:run`

Expected: All tests pass including integration fixtures.

- [ ] **Step 2: Test with example Agency files**

Run a few example files through the compiler to verify end-to-end:

```bash
pnpm run compile examples/hello.agency
pnpm run ast examples/hello.agency
```

Check that the output looks correct and includes `loc` data where expected.

- [ ] **Step 3: Remove unused imports and dead code**

Go through modified parser files and remove imports that are no longer needed after switching to `exprParser`. For example, `functionCall.ts` may no longer need to import `binOpParser`, `agencyArrayParser`, etc. if it now only imports `exprParser`.

- [ ] **Step 4: Run final test suite**

Run: `pnpm run build && pnpm test:run`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "Clean up unused imports after expression parser unification"
```
