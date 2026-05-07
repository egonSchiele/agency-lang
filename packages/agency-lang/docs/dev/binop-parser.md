# Binary Expression Parser

The binary expression parser (`lib/parsers/binop.test.ts` for tests, `lib/types/binop.ts` for the precedence table) uses a technique called **precedence climbing** to parse expressions that can contain nested operators, chained operations, parentheses, and operators at different precedence levels — all in a single pass.

This document walks through the algorithm in detail.

## The problem

A flat parser like `seqC(left, op, right)` can parse `1 + 2`, but it can't handle:

- **Chaining:** `1 + 2 + 3` (more than one operator)
- **Precedence:** `1 + 2 * 3` (multiplication should bind tighter than addition)
- **Parentheses:** `(1 + 2) * 3` (override natural precedence)
- **Logical operators:** `(x < 2) && (y < 3)` (new operator types with their own precedence)

The precedence-climbing algorithm handles all of these cases.

## Precedence table

Every operator has a numeric precedence level. Higher numbers mean tighter binding:

| Level | Operators        | Meaning                  |
|-------|------------------|--------------------------|
| -1    | `\|>`            | Pipe                     |
| 0     | `+=` `-=` `*=` `/=` `??=` `\|\|=` `catch` | Compound assignment / catch |
| 1     | `\|\|` `??`      | Logical OR / nullish coalescing |
| 2     | `&&`             | Logical AND              |
| 3     | `==` `===` `!=` `!==` `=~` `!~` | Equality / pattern match |
| 4     | `<` `>` `<=` `>=` `instanceof` `in` | Comparison         |
| 5     | `+` `-`          | Addition, subtraction    |
| 6     | `*` `/` `%`      | Multiplication, division, modulo |
| 7     | `**`             | Exponentiation           |

All operators are left-associative.

## The two functions

The parser is built from two mutually recursive functions:

### `parseAtom(input)`

Parses the smallest unit of an expression — a simple value (boolean, variable, number, string).

```
parseAtom(input):
  return parse a boolean, variable access, or literal
```

### `parseExprPrec(input, minPrec)`

This is the core of the algorithm. It parses an expression, but only consumes operators whose precedence is `>= minPrec`. This single parameter is what makes precedence and associativity work.

```
parseExprPrec(input, minPrec):
  left = parseAtom(input)

  while there is an operator next and its precedence >= minPrec:
    op = consume the operator
    right = parseExprPrec(remaining, prec(op) + 1)
    left = BinOp(left, op, right)

  return left
```

Two things to notice:

1. The `while` loop is what enables **chaining** — it keeps consuming operators as long as they meet the minimum precedence threshold.
2. The recursive call uses `prec(op) + 1` as the new minimum — this is what creates **left-associativity** and **precedence**.

## How precedence works

Consider parsing `1 + 2 * 3` where `+` has precedence 5 and `*` has precedence 6.

```
parseExprPrec("1 + 2 * 3", minPrec=0)
│
├─ parseAtom("1 + 2 * 3") → 1, rest = " + 2 * 3"
│
├─ Loop iteration 1:
│  ├─ See operator '+' (prec 5). Is 5 >= 0? Yes. Consume it.
│  │
│  ├─ parseExprPrec("2 * 3", minPrec=6)     // prec(+) + 1 = 6
│  │  │
│  │  ├─ parseAtom("2 * 3") → 2, rest = " * 3"
│  │  │
│  │  ├─ Loop iteration 1:
│  │  │  ├─ See operator '*' (prec 6). Is 6 >= 6? Yes. Consume it.
│  │  │  │
│  │  │  ├─ parseExprPrec("3", minPrec=7)   // prec(*) + 1 = 7
│  │  │  │  ├─ parseAtom("3") → 3
│  │  │  │  ├─ No more operators (or none with prec >= 7)
│  │  │  │  └─ return 3
│  │  │  │
│  │  │  └─ left = BinOp(2, *, 3)
│  │  │
│  │  ├─ No more operators
│  │  └─ return BinOp(2, *, 3)
│  │
│  └─ left = BinOp(1, +, BinOp(2, *, 3))
│
├─ No more operators
└─ return BinOp(1, +, BinOp(2, *, 3))
```

The critical moment is when `parseExprPrec` is called with `minPrec=6` after seeing `+`. This means: "only consume operators with precedence >= 6." The `*` operator has precedence 6, so it gets consumed by the inner call, not the outer loop. This is what makes `*` bind tighter than `+`.

If the expression were `1 * 2 + 3` instead, here's what happens:

```
parseExprPrec("1 * 2 + 3", minPrec=0)
│
├─ parseAtom → 1
│
├─ See '*' (prec 6). Is 6 >= 0? Yes. Consume it.
│  ├─ parseExprPrec("2 + 3", minPrec=7)   // prec(*) + 1 = 7
│  │  ├─ parseAtom → 2
│  │  ├─ See '+' (prec 5). Is 5 >= 7? NO. Stop.
│  │  └─ return 2
│  └─ left = BinOp(1, *, 2)
│
├─ See '+' (prec 5). Is 5 >= 0? Yes. Consume it.
│  ├─ parseExprPrec("3", minPrec=6)
│  │  └─ return 3
│  └─ left = BinOp(BinOp(1, *, 2), +, 3)
│
└─ return BinOp(BinOp(1, *, 2), +, 3)
```

The `+` has precedence 5, which is less than the `minPrec=7` required inside the `*`'s right-hand side, so it doesn't get consumed there. Instead, control returns to the outer loop, which sees `+` and handles it at the top level.

## How chaining works (left-associativity)

Consider `1 + 2 + 3` where `+` has precedence 5.

```
parseExprPrec("1 + 2 + 3", minPrec=0)
│
├─ parseAtom → 1
│
├─ Loop iteration 1:
│  ├─ See '+' (prec 5). Is 5 >= 0? Yes.
│  ├─ parseExprPrec("2 + 3", minPrec=6)   // prec(+) + 1 = 6
│  │  ├─ parseAtom → 2
│  │  ├─ See '+' (prec 5). Is 5 >= 6? NO. Stop.
│  │  └─ return 2
│  └─ left = BinOp(1, +, 2)
│
├─ Loop iteration 2:
│  ├─ See '+' (prec 5). Is 5 >= 0? Yes.
│  ├─ parseExprPrec("3", minPrec=6)
│  │  └─ return 3
│  └─ left = BinOp(BinOp(1, +, 2), +, 3)
│
└─ return BinOp(BinOp(1, +, 2), +, 3)
```

The `+ 1` in `prec(op) + 1` is what makes this left-associative. When parsing the right side of the first `+`, the recursive call uses `minPrec=6`. The second `+` also has precedence 5, and since `5 < 6`, it does **not** get consumed by the inner call. Instead, it falls through to the outer `while` loop, which builds the tree leftward: `(1 + 2) + 3`.

If we used `prec(op)` instead of `prec(op) + 1`, the second `+` would be consumed by the inner call (since `5 >= 5`), producing right-associative grouping: `1 + (2 + 3)`. That `+ 1` is the entire difference between left- and right-associativity.

## The `binOpParser` wrapper

The exported `binOpParser` function wraps `parseExprPrec` with one additional check: it only succeeds if the result is actually a `BinOpExpression` (i.e., at least one operator was consumed). If the input is just a bare value like `x`, the parser returns failure. This is necessary because `binOpParser` sits in an `or(...)` chain alongside other parsers (like the variable parser), and we don't want it to "steal" inputs that should be handled by those other parsers.

```typescript
export const binOpParser: Parser<BinOpExpression> = (input) => {
  const result = parseExprPrec(input, 0);
  if (!result.success) return result;

  // Only succeed if we actually parsed a binary expression (not just an atom)
  if (result.result.type === "binOpExpression") {
    // Consume optional trailing semicolon
    ...
    return success(result.result, finalRest);
  }

  return failure("expected binary expression", input);
};
```

## Code generation

When the code generators (`TypeScriptGenerator`, `AgencyGenerator`) emit code for a `BinOpExpression`, they use precedence-aware logic to decide whether parentheses are needed around child `BinOpExpression` nodes. This avoids unnecessary parentheses in common cases like chained same-operator expressions.

The rules are implemented as two helper methods in `BaseGenerator`:

**Left child**: parens only if `childPrec < parentPrec`. Same or higher precedence is safe because left-associativity naturally groups the left child first.

**Right child**: parens if `childPrec <= parentPrec`. Equal precedence needs parens because re-parsing without them would left-associate differently.

```typescript
protected needsParensLeft(child: BinOpArgument, parentOp: Operator): boolean {
  if (child.type !== "binOpExpression") return false;
  return PRECEDENCE[child.operator] < PRECEDENCE[parentOp];
}

protected needsParensRight(child: BinOpArgument, parentOp: Operator): boolean {
  if (child.type !== "binOpExpression") return false;
  return PRECEDENCE[child.operator] <= PRECEDENCE[parentOp];
}
```

Examples:
- `BinOp(BinOp(1, +, 2), +, 3)` → `1 + 2 + 3` (no parens, same prec left child)
- `BinOp(BinOp(1, +, 2), *, 3)` → `(1 + 2) * 3` (parens needed, lower prec left child)
- `BinOp(1, -, BinOp(2, +, 3))` → `1 - (2 + 3)` (parens needed, same prec right child)
- `BinOp(1, +, BinOp(2, *, 3))` → `1 + 2 * 3` (no parens, higher prec right child)
