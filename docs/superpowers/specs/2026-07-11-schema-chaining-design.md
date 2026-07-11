# Chained method calls on `schema(...)` expressions (issue #480)

**Issue:** #480 — `const r = schema(number).parseJSON("[1]")` fails to parse
("expected node body"); the workaround is binding the schema to a variable
first. Found while writing the utility-types execution tests (#478).

## Root cause (verified by repro, 2026-07-11)

Same failure class as the intersection-item parser bug fixed in #502: an
`or()` alternative commits to a prefix and strands the suffix.

- In the expression grammar's `baseAtom` (`lib/parsers/parsers.ts`),
  `schemaExpressionParser` is ordered before `valueAccessParser`. For
  `schema(number).parseJSON("[1]")` it succeeds on `schema(number)` and
  returns, leaving `.parseJSON("[1]")` unconsumed — the enclosing statement
  parse then fails.
- The value-access machinery can't rescue it: `_valueAccessParser`'s base
  alternatives are `_functionCallParser | variableNameParser`; a schema
  expression is not an admissible chain base.

`schema` cannot simply be parsed as a regular function call (owner question,
settled during brainstorm): its argument is written in the TYPE grammar, not
the value grammar. `schema(number[])`, `schema(string | null)`,
`schema(Record<string, number>)`, and `schema({name: string, age?: number})`
are all legal today and none of them parse as call arguments. `schema(...)`
is a keyword form (like TS `typeof`), so the schema atom must exist
regardless; this fix is about letting the existing chain machinery accept it
as a base.

## Design (Approach A — approved)

One new parser that COMPOSES the two existing ones, mirroring the established
`parenAccessParser` idiom (`(expr).chain`):

```ts
// `schema(T).method(...)...` — a schema expression used as an access-chain
// base. many1 is the gate: bare `schema(T)` never matches here, so the plain
// schemaExpressionParser alternatives (and everything that consumes them)
// keep their exact current behavior. Mirrors parenAccessParser.
const schemaAccessParser: Parser<ValueAccess> = map(
  seqC(
    capture(schemaExpressionParser, "base"),
    capture(many1(chainElementParser), "chain"),
  ),
  (result) =>
    ({
      type: "valueAccess" as const,
      base: result.base as unknown as AgencyNode,
      chain: result.chain,
    }) as ValueAccess,
);
```

Inserted at exactly two sites:

1. **`baseAtom`** — immediately BEFORE `schemaExpressionParser`, so
   expression positions (assignment RHS, arguments, returns, pipe operands)
   try the chained form first and fall back to the bare atom.
2. **`_valueAccessParser`** — immediately after the `parenAccessParser`
   attempt, so statement position works too (the body parser calls
   `_valueAccessParser` directly, bypassing `baseAtom`). This is a DELIBERATE
   behavior change to an already-parsing form (repro-verified 2026-07-11): a
   statement-position `schema(T).method()` parses TODAY, but as a call to an
   undefined function named `schema` with the chain hung off it — wrong node
   kind, undefined-function diagnostics, wrong codegen. Schema-with-chain now
   wins first and produces the correct `schemaExpression`-based access. A
   parse pin covers the old-vs-new shape explicitly.

No AST changes: `ValueAccess.base` is already `AgencyNode`
(`lib/types/access.ts:13`). No parser return-type changes: a chained schema
is always wrapped in `ValueAccess` (the `many1` gate guarantees it).

### Why not the alternatives

- **B (schema as a general value-access base):** the no-chain case would
  return a bare `SchemaExpression` from `_valueAccessParser`, widening its
  return union and silently changing what statement position, `try schema(...)`,
  and the assignment-target parser see. All probably benign, each needing
  audit + pins — a day of edge verification to avoid ~6 lines.
- **C (general postfix-chain level over all atoms):** the textbook grammar
  (would also fix the `new Foo().bump()` sibling gap, which today needs
  parens), but it changes chaining behavior for every atom kind at once.
  Out of proportion for this issue; the `new` gap stays a known non-goal.

### Downstream (verified ready, pinned by tests rather than changed)

- **Checker:** `synthValueAccess` resolves the base generically via
  `synthType(expr.base, ...)`, and the `schemaExpression` case already
  produces `Schema<T>`; the chain walk then types `.parse`/`.parseJSON` as it
  does for a bound variable. Expected: chained and bind-first forms type
  identically.
- **Codegen:** `processValueAccess` (typescriptBuilder.ts) emits the base via
  the generic expression path; `schemaExpression` has its own emit case.
- **Flow/narrowing:** `asPathReference`/`narrowedPathPrefix` gate on
  `base.type === "variableName"`, so a schema base simply never narrows —
  safe by construction.
- **Formatter:** `AgencyGenerator` prints `ValueAccess` generically and has a
  `schemaExpression` case; a round-trip test pins the composition.

### Performance

`schemaAccessParser` is anchored on the literal `schema(` and fails within
one token on all other input; `chainElementParser` is memoized. No benchmark
gate needed (no new backtracking level); the full parse-test suite is the
guard.

## Non-goals

- `new Foo().bump()` without parens (sibling gap, same class — file or fold
  into a future postfix-level change if it ever hurts).
- Any change to bare `schema(T)` parsing, in any position.
- Schema-method TYPE improvements (e.g. what `.parseJSON` returns) — the
  checker's existing behavior is pinned as-is, not extended.

## Tests (red-first)

1. **Parse pins** (new `lib/parsers/schemaChaining.test.ts` or appended to
   the existing schema parse tests): chained call parses as `valueAccess`
   with `schemaExpression` base + call chain — RED on main with the exact
   "expected node body" class failure. Rows: `schema(number).parseJSON("[1]")`
   (expression position), the same in statement position, a type-grammar arg
   (`schema({a: number}).parse(x)`), a two-element chain
   (`schema(number).parseJSON("5").value`), and bare `schema(number)`
   unchanged (still a plain `schemaExpression`, both positions).
2. **Checker pin:** the chained form synthesizes the same type as the
   bind-first form (both `Result`-typed from `parseJSON`); no new
   diagnostics.
3. **Execution test** (`tests/agency/`): chained `parseJSON` accept AND
   reject paths return the same Results as the bind-first form (no LLM
   calls).
4. **Codegen fixture** (`tests/typescriptGenerator/`): one golden file with
   the chained form; zero churn elsewhere.
5. **Formatter round-trip** (`agencyGenerator.test.ts`):
   `schema(number).parseJSON("[1]")` prints back exactly.

## Estimated size

~15 lines of parser code, ~5 test files touched. Half a day including the PR.
