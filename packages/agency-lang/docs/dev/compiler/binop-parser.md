# Binary Expression Parser

Agency parses binary expressions with **precedence climbing**: one pass that handles nested operators, chained operations, parentheses, and operators at different precedence levels.

The algorithm itself lives in tarsec's `buildExpressionParser` combinator, not in this repo. Agency supplies the pieces:

| Piece | Where |
|-------|-------|
| The operator table (precedence levels and associativity) | `_exprParserBase` in `lib/parsers/parsers.ts` |
| `binOpParser`, the filter that other parsers call | `lib/parsers/parsers.ts` |
| `Operator` and the `PRECEDENCE` map used by code generation | `lib/types/binop.ts` |
| Tests | `lib/parsers/binop.test.ts` |

This document walks through what the table says and why the algorithm behaves the way it does.

## The problem

A flat parser like `seqC(left, op, right)` can parse `1 + 2`, but it can't handle:

- **Chaining:** `1 + 2 + 3` (more than one operator)
- **Precedence:** `1 + 2 * 3` (multiplication should bind tighter than addition)
- **Parentheses:** `(1 + 2) * 3` (override natural precedence)
- **Logical operators:** `(x < 2) && (y < 3)` (new operator types with their own precedence)

The precedence-climbing algorithm handles all of these cases.

## The operator table

`buildExpressionParser(atom, table, parenParser)` takes an array of precedence levels, highest binding first. Each level lists its operators with an `assoc` of `"left"` or `"right"`. Agency's table:

| Level | Operators | Associativity |
|-------|-----------|---------------|
| 7 | `**` | right |
| 6 | `*=` `/=` | right |
| 6 | `*` `/` `%` | left |
| 5 | `+=` `-=` | right |
| 5 | `+` `-` | left |
| 4 | `instanceof` `in` `<=` `>=` `<` `>` | left |
| 3 | `===` `!==` `=~` `==` `!~` `!=` | left |
| 2 | `&&=` | right |
| 2 | `&&` | left |
| 1 | `??=` `\|\|=` | right |
| 1 | `??` `\|\|` | left |
| 0 | `catch` | left |
| -1 | `\|>` | left |

Within a level, multi-character operators come first so that `*=` is not mis-read as `*` followed by `=`, and `<=` is not mis-read as `<`.

The atom is `atomWithIs` (a value, optionally followed by `is <pattern>`), and the paren parser is a custom `parenParser` rather than tarsec's default.

## How `buildExpressionParser` works

The combinator builds one parser per precedence level, wrapping the previous level. The innermost parser is the base: a parenthesized sub-expression, or failing that, an atom. Each wrapper parses `nextLevel (op nextLevel)*` for its own operators.

Because a level can only ever see operators from its own row, an operator with a higher precedence has already been consumed by an inner level by the time an outer level looks. That is what makes `*` bind tighter than `+`.

### Precedence, worked through

Consider `1 + 2 * 3`. The additive level runs first and delegates its left operand to the multiplicative level.

```
additive("1 + 2 * 3")
├─ multiplicative("1 + 2 * 3") → 1, rest = " + 2 * 3"
│  (sees '+', which is not one of its operators, so it stops)
├─ sees '+', consumes it
├─ multiplicative("2 * 3")
│  ├─ 2, rest = " * 3"
│  ├─ sees '*', consumes it
│  └─ 3  →  BinOp(2, *, 3)
└─ BinOp(1, +, BinOp(2, *, 3))
```

Now `1 * 2 + 3`. The multiplicative level parses `1 * 2` and stops at `+`, because `+` is not one of its operators. Control returns to the additive level, which consumes the `+`.

```
additive("1 * 2 + 3")
├─ multiplicative("1 * 2 + 3") → BinOp(1, *, 2), rest = " + 3"
├─ sees '+', consumes it
├─ multiplicative("3") → 3
└─ BinOp(BinOp(1, *, 2), +, 3)
```

### Associativity

A left-associative level folds its operands leftward as it loops, so `1 + 2 + 3` becomes `BinOp(BinOp(1, +, 2), +, 3)`. A right-associative level recurses into itself for the right operand instead, so `2 ** 3 ** 4` becomes `BinOp(2, **, BinOp(3, **, 4))`.

Exponentiation and the compound assignments are the right-associative operators. Everything else is left-associative.

## The `binOpParser` wrapper

`binOpParser` delegates to `exprParser` and adds one check: it only succeeds if the result is actually a `BinOpExpression`, meaning at least one operator was consumed. A bare value like `x` is a failure. This matters because `binOpParser` sits in an `or(...)` chain alongside other parsers such as the variable parser, and it must not steal inputs those parsers should handle.

```typescript
export const binOpParser: Parser<BinOpExpression> = (input: string) => {
  const result = exprParser(input);
  if (!result.success) return result;

  if (result.result.type !== "binOpExpression") {
    return failure("expected binary expression", input);
  }

  // Consume optional trailing semicolon
  const semiResult = optionalSemicolon(result.rest);
  const finalRest = semiResult.success ? semiResult.rest : result.rest;
  return success(result.result as BinOpExpression, finalRest);
};
```

`exprParser` itself wraps `_exprParserBase` with one refusal: a JavaScript ternary. A `?` that is not `?.` or `??`, followed by an expression and a `:`, produces a committed failure with the ternary diagnostic.

## Code generation

When the code generators (`TypeScriptGenerator`, `AgencyGenerator`) emit code for a `BinOpExpression`, they use precedence-aware logic to decide whether parentheses are needed around child `BinOpExpression` nodes. This avoids unnecessary parentheses in common cases like chained same-operator expressions.

Code generation reads a separate precedence source: the `PRECEDENCE` map in `lib/types/binop.ts`. It is keyed by operator rather than ordered by level, and it also carries the unary operators (`!`, `typeof`, `void` at 8; `++`, `--` at 9) that the parser table has no rows for. It disagrees with the parser table in one place: the compound assignments sit at level 0 here, but the parser groups each one with the arithmetic operator it is built from.

The rules are two helper methods, duplicated in `TypeScriptBuilder` and `AgencyGenerator`:

**Left child**: parens only if `childPrec < parentPrec`. Same or higher precedence is safe because left-associativity naturally groups the left child first. Right-associative `**` is the exception, so `(2 ** 3) ** 4` keeps its parens.

**Right child**: parens if `childPrec <= parentPrec`. Equal precedence needs parens because re-parsing without them would left-associate differently.

```typescript
private needsParensLeft(child: BinOpArgument, parentOp: Operator): boolean {
  if (child.type !== "binOpExpression") return false;
  // For right-associative ops like **, (2 ** 3) ** 4 needs parens on the left
  if (parentOp === "**") return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
  return PRECEDENCE[child.operator] < PRECEDENCE[parentOp];
}

private needsParensRight(child: BinOpArgument, parentOp: Operator): boolean {
  if (child.type !== "binOpExpression") return false;
  return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
}
```

Examples:
- `BinOp(BinOp(1, +, 2), +, 3)` → `1 + 2 + 3` (no parens, same prec left child)
- `BinOp(BinOp(1, +, 2), *, 3)` → `(1 + 2) * 3` (parens needed, lower prec left child)
- `BinOp(1, -, BinOp(2, +, 3))` → `1 - (2 + 3)` (parens needed, same prec right child)
- `BinOp(1, +, BinOp(2, *, 3))` → `1 + 2 * 3` (no parens, higher prec right child)
