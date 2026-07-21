# Type Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the main session (this project does not use subagent-driven development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the type-patterns spec (`/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-20-type-patterns-design.md`): `x is Type` as a runtime type test with narrowing, and `pattern: Type` in match arms.

**Architecture:** A new parse-level pattern node (`TypePattern`) flows through the existing pattern-lowering pass, which desugars it into a new expression node (`TypeTestExpression`). The builder compiles that node to either a cheap coarse check (Tier 1) or the existing schema-validation machinery (Tier 2, the same code path the bang uses). The type checker narrows on the node via the existing declarative `narrowers` table.

**Tech Stack:** tarsec parser combinators, the TsNode IR, Zod schemas via `validateExpr`, vitest.

## Global Constraints

- All work in `packages/agency-lang` (paths below are relative to it unless absolute).
- NEVER commit on main. Run `git branch --show-current` before every commit; work on the `type-patterns-spec` branch (or a `type-patterns` branch off it).
- Agency syntax in tests must follow `docs/site/guide/basic-syntax.md` (`def name(): T { }`, parenthesized conditions, `let`/`const` declarations).
- Save every test run's output to a file (`2>&1 | tee /tmp/tp-<task>.log`) so failures never require a rerun.
- Do not run the full agency test suite locally; run only the specific tests named in each task. CI runs the rest.
- No dynamic imports. Types, not interfaces. Objects, not maps. Arrays, not sets.
- Commit messages must not contain apostrophes typed on the command line — write the message to a file and use `git commit -F <file>` if needed; the messages below avoid apostrophes so `-m` is safe.
- After changing anything under `lib/runtime/` or stdlib, run `make` before running agency execution tests.
- Before the final PR, audit the whole diff against `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md`.

---

## Background: how patterns move through the pipeline today

Read this section before touching anything. It explains where each piece of the
feature lives and why, so no task below is a mystery.

The compile pipeline is:

```
parse → lowerPatterns → SymbolTable.build → typecheck → TypescriptPreprocessor → TypeScriptBuilder → printTs
```

Pattern syntax exists only at the very front. The parser
(`lib/parsers/parsers.ts`) produces pattern nodes (`lib/types/pattern.ts`:
`ObjectPattern`, `ArrayPattern`, `ResultPattern`, bare `variableName` binders,
literals, `IsExpression`). Then the pattern-lowering pass
(`lib/lowering/patternLowering.ts`) desugars ALL of it into plain Agency
constructs — assignments, if/else, binops, function calls — before the symbol
table or the type checker ever run. For example, `if (r is success(v))`
arrives at the checker as `if (isSuccess(r)) { const v = r.value; ... }`. The
checker has zero pattern-specific code; it narrows `r` because it recognizes
the `isSuccess(r)` condition shape, and the binding `v` picks up the narrowed
type through ordinary declaration inference.

Three consequences drive this plan's design:

**A note on the road not taken.** Result patterns lower to a plain call the
checker recognizes by shape: `r is success(v)` becomes `isSuccess(r)`, with no
dedicated AST node. We could have done the same here — lower Tier 1 to
`__coarseTypeTest(x, "string")` calls and narrow on the call shape. We chose a
dedicated node instead because the narrower needs the full `typeHint` (an
arbitrary `VariableType`, not one of two fixed kinds), and because the
Tier 1/Tier 2 decision needs scope-aware alias resolution that only the
builder has — a surviving node keeps the type attached until both consumers
have read it. The cost is one more `Expression` variant every walker must
know about; Task 1 pays it once.

**1. Type patterns need a lowered carrier the checker can recognize.** A Tier 1
test like `x is string` could lower to some `typeof`-ish check, but the checker
would then have to reverse-engineer "this binop means a type test" to narrow
`x`. Instead we lower every type pattern to one new expression node,
`TypeTestExpression { expression, typeHint }`, which survives lowering and is
compiled away only in the TypeScript builder. The checker narrows on it
directly (one new entry in the `narrowers` table — the narrowing README at
`docs/dev/typechecker/narrowing/README.md` explicitly designed for this: "a
new narrowing form is one table entry", and its capability table lists
typeof-style narrowing as "planned fast-follow — needs surface syntax". This
feature is that surface syntax.)

**2. Tier 2 must reuse `validateExpr`, not `Schema.parse`.** The spec says a
Tier 2 test runs shape checks AND `@validate` validators. The runtime
`Schema.parse` (`lib/runtime/schema.ts`) runs only the Zod shape check. The
bang operator gets validators through a different door: the builder helper
`validateExpr(t, value)` (`lib/backends/typescriptBuilder.ts:939`) emits
`__validateType(value, zodSchema)` when the resolved type carries no
`@validate` tags, and `await __validateChainRecursive(value, <descriptor>)`
when it does. The descriptor walker (`lib/runtime/validateChain.ts`) runs
validators outside Zod precisely so they can be async Agency functions. Type
patterns call the exact same helper and wrap it in `isSuccess(...)`. This
resolves spec open questions 3 and 5 concretely: the schema is reachable
because `validateExpr` already resolves any visible alias through
`this.scopes.visibleTypeAliasesFull()`, and yes, validator-bearing tests are
async — which is fine, because all generated Agency code is already async and
the lowered node compiles to an awaited expression exactly like the bang does.

**3. The bare-binder retirement happens in the parser.** Today
`_matchPatternParser` (`lib/parsers/parsers.ts:5435`) includes
`variableNameParser`, which is why `x is Person` currently parses as an
always-true binder. The `is` operator wraps atoms at
`lib/parsers/parsers.ts:2844` using that same pattern parser. We give `is` its
own right-hand-side parser that omits `variableNameParser` and instead parses
a *type* — so after `is`, a bare identifier can only ever be a type reference,
exactly as the spec's "grammar position decides" rule requires. Match arms
keep `variableNameParser` (the binding catch-all stays), and get the new
`: Type` suffix and `is Type` alternatives in `caseLhsParser`
(`lib/parsers/parsers.ts:3256`).

Two more subsystems matter:

**Exhaustiveness** (`lib/typeChecker/matchExhaustiveness.ts`) runs during
typechecking, *after* lowering — it works because the lowered match carries
`MatchArmMeta` (`lib/types/matchBlock.ts:29`, `{ caseValue: MatchPattern |
DefaultCase; guard?: Expression }`). Since `TypePattern` joins the
`MatchPattern` union, arm metadata flows automatically; we must make the
exhaustiveness pass treat a `typePattern` caseValue as non-contributing (never
counts toward coverage, never acts as a catch-all). This pass also has the
scopes and visible type aliases in hand, which makes it the natural home for
the spec's shadowing warning ("bare arm binder named like a type").

**The formatter** (`lib/backends/agencyGenerator.ts`) prints the *parse* AST
(pre-lowering), so it needs to print `TypePattern` in both spellings but never
sees `TypeTestExpression`.

### Handlers are untouched

Stated explicitly because handlers are safety infrastructure: type patterns
lower to boolean conditions and ordinary binder assignments only. No task
touches handler registration, `pushHandler`, interrupt flow, or checkpoint
state. If any implementation step finds itself near `__ctx.handlers`, stop —
something has gone wrong.

### Rule 1 (bind the original) falls out structurally

The existing lowering binds destructured names from the *source* expression
(`fieldAccess(source, key)` etc.), never from a validation result. Type
patterns only ADD a boolean conjunct to the arm/if condition; the binder
emission path is untouched. So "the pattern binds the original value, not the
validator-transformed copy" requires no code — but Task 10's execution test
pins it down so it can never regress.

### Tier mapping (exact)

Given the `TypeTestExpression`'s `typeHint`:

| typeHint shape | compiled check |
|---|---|
| `primitiveType` `string`/`number`/`boolean` | `__coarseTypeTest(v, "string" \| "number" \| "boolean")` |
| `primitiveType` `null` | `__coarseTypeTest(v, "null")` |
| `primitiveType` `object` | `__coarseTypeTest(v, "object")` (non-null, non-array) |
| `arrayType` whose element is `primitiveType any` | `__coarseTypeTest(v, "array")` |
| everything else (aliases, `T[]`, unions-via-alias, inline object types if they sneak in) | `isSuccess(<validateExpr(typeHint, v)>)` |

`__coarseTypeTest` is a new runtime helper (single evaluation of `v` — the
plain-object check references its argument three times, so it must be a
function, not an inlined expression). Other primitives (`any`, `unknown`,
`undefined`, `void`, `never`, `function`, `regex`) are not special-cased: they
fall to the schema path and behave however their Zod mapping behaves. The spec
only promises the six coarse checks.

### New diagnostics

- `AG1013` `typePatternUnknownType` (error): "`{name}` is not a type; to bind
  the value write `const {name} = x`." Fired by the checker when a
  `TypeTestExpression` typeHint names an alias that does not resolve.
- `AG5003` `bareArmBinderShadowsType` (warning): "`{name}` here binds the
  value; it does not test the type. Did you mean `p: {name}` or `is {name}`?"
  Fired by the exhaustiveness pass when an un-guarded bare-binder arm's name
  matches a visible type alias.

Verify both codes are unused before adding
(`grep -rn "AG1013\|AG5003" lib/ docs/` — confirmed free as of plan writing).

## File structure

- `lib/types/pattern.ts` — add `TypePattern` (parse AST) and `TypeTestExpression` (lowered AST).
- `lib/parsers/parsers.ts` — `isRhsParser` (new `is` right side), `caseLhsParser` changes (`: Type` suffix, `is Type` arm), `typePatternParser`.
- `lib/parsers/pattern.test.ts`, `lib/parsers/matchBlock.test.ts` — parser tests (co-located, existing files).
- `lib/lowering/patternLowering.ts` — `typePattern` cases in `collectChecks`, `walkPattern`, binder emission.
- `lib/lowering/patternLowering.test.ts` — lowering tests (create if absent; check for an existing test file first and extend it).
- `lib/runtime/typeTest.ts` — `__coarseTypeTest` helper. Test: `lib/runtime/typeTest.test.ts`.
- `lib/backends/typescriptBuilder.ts` — `processTypeTestExpression`.
- `lib/typeChecker/synthesizer.ts` — synthesize `boolean`, unknown-alias diagnostic.
- `lib/typeChecker/narrowing.ts` — condition fact + `typeTest` narrower.
- `lib/typeChecker/matchExhaustiveness.ts` — non-contributing arms + AG5003.
- `lib/typeChecker/diagnostics.ts` — the two new codes.
- `lib/backends/agencyGenerator.ts` — formatter printing.
- `tests/typescriptGenerator/type-patterns.agency` (+ generated `.mjs`) — codegen fixture.
- `tests/agency/type-patterns.agency` + `type-patterns.test.json` — execution tests.
- `docs/site/guide/pattern-matching.md` — user docs.

Before starting: read `docs/dev/adding-features.md` (the "adding AST nodes"
section) — it enumerates every registration point a new node needs (walkers,
`isExpressionNode`, preprocessor traversal). Task 1 follows it.

---

### Task 1: AST nodes

**Files:**
- Modify: `lib/types/pattern.ts`
- Modify: registration points per `docs/dev/adding-features.md` (expect: `lib/types.ts` exports, `isExpressionNode` in `lib/types.ts`, `lib/utils/node.ts` walkers; find the authoritative list in the guide)

**Interfaces:**
- Produces: `TypePattern = BaseNode & { type: "typePattern"; pattern: BindingPattern | null; typeHint: VariableType }`, added to the `MatchPattern` union. `pattern: null` is the `is Type` / test-only form; non-null is the arm bind-and-test form.
- Produces: `TypeTestExpression = BaseNode & { type: "typeTestExpression"; expression: Expression; typeHint: VariableType }`, added to the `Expression` union and recognized by `isExpressionNode`.

- [ ] **Step 1:** Add both types to `lib/types/pattern.ts`:

```ts
export type TypePattern = BaseNode & {
  type: "typePattern";
  // null = test-only form (`is Type`); non-null = arm bind-and-test (`pattern: Type`).
  pattern: BindingPattern | null;
  typeHint: VariableType;
};

export type TypeTestExpression = BaseNode & {
  type: "typeTestExpression";
  expression: Expression;
  typeHint: VariableType;
};
```

Import `VariableType` from `../types.js` (mirror the existing `Expression`
import at the top of the file). Add `TypePattern` to the `MatchPattern` union.
Do NOT add it to `BindingPattern` — type patterns are illegal in
`let`/`const`/`for` per the spec, and keeping them out of that union makes the
restriction structural.

- [ ] **Step 2:** Follow the `docs/dev/adding-features.md` AST-node checklist for `TypeTestExpression`: add it to the `Expression` union, `isExpressionNode`, and every expression walker the guide names. Grep for an existing small expression node (`isExpression` is a good template) to find any switch the guide missed: `grep -rn "isExpression" lib --include=*.ts | grep -v test | grep -v pattern.ts`.

- [ ] **Step 3:** Run the whole unit build to catch missed union members: `pnpm run build 2>&1 | tee /tmp/tp-task1.log`. Expected: compiles clean (exhaustive switches over `Expression` will error until every registration point is done — that is the point).

- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat: TypePattern and TypeTestExpression AST nodes"`

### Task 2: Parser — `is Type` (retire the bare binder on the `is` right side)

**Files:**
- Modify: `lib/parsers/parsers.ts` (the `is` wrap at :2844 and the pattern-parser section at :5435)
- Test: `lib/parsers/pattern.test.ts`

**Interfaces:**
- Consumes: `TypePattern` from Task 1; `unionItemParser` (`parsers.ts:1439`, parses one non-union type including `T[]` suffixes).
- Produces: `typePatternParser` (exported, parses a type into a `TypePattern` with `pattern: null`) and `isRhsParser` (the new `is` right-hand-side parser). The `is` atom wrap uses `isRhsParser` instead of `matchPatternParser`.

- [ ] **Step 1: Write failing tests** in `lib/parsers/pattern.test.ts` (mirror the surrounding test style — they call exported parsers directly on strings):

```ts
describe("type patterns after is", () => {
  test("is string parses as a typePattern, not a binder", () => {
    const r = exprParser("x is string");
    expect(r.success).toBe(true);
    const is = (r as any).result;
    expect(is.type).toBe("isExpression");
    expect(is.pattern.type).toBe("typePattern");
    expect(is.pattern.pattern).toBeNull();
    expect(is.pattern.typeHint).toMatchObject({ type: "primitiveType", value: "string" });
  });

  test("is Person parses as a typePattern with an alias type", () => {
    const r = exprParser("x is Person");
    const is = (r as any).result;
    expect(is.pattern.type).toBe("typePattern");
  });

  test("is any[] parses as a coarse array typePattern", () => {
    const r = exprParser("x is any[]");
    const is = (r as any).result;
    expect(is.pattern.type).toBe("typePattern");
    expect(is.pattern.typeHint.type).toBe("arrayType");
  });

  test("structural patterns after is are unchanged", () => {
    const r = exprParser("x is { name }");
    expect((r as any).result.pattern.type).toBe("objectPattern");
  });

  test("result patterns after is are unchanged", () => {
    const r = exprParser("x is success(v)");
    expect((r as any).result.pattern.type).toBe("resultPattern");
  });

  test("null after is stays the literal pattern", () => {
    // Positive assertion (review test-audit item 3): asserting
    // not-typePattern would stay green if `is null` regressed to a binder.
    const r = exprParser("x is null");
    expect((r as any).result.pattern.type).toBe("null"); // adjust to the actual null-literal node type
  });

  test("is binds tighter than &&: x is string && y", () => {
    // The type parser on the is-RHS must not over-consume into the boolean
    // operator. Expected shape: (x is string) && y.
    const r = exprParser("x is string && y");
    expect(r.success).toBe(true);
    const top = (r as any).result;
    expect(top.type).toBe("binOpExpression");
    expect(top.operator).toBe("&&");
    expect(top.left.type).toBe("isExpression");
  });

  test("is with alias type followed by comparison: a is Person == b", () => {
    const r = exprParser("a is Person == b");
    expect(r.success).toBe(true);
    const top = (r as any).result;
    expect(top.type).toBe("binOpExpression");
    expect(top.left.type).toBe("isExpression");
  });
});
```

(Adjust `exprParser` to whatever the neighboring tests in that file actually
import for expression parsing; keep the assertions.)

- [ ] **Step 2:** Run and confirm the new tests fail: `pnpm test:run lib/parsers/pattern.test.ts 2>&1 | tee /tmp/tp-task2-fail.log`. Expected: the typePattern tests FAIL (today these parse as `variableName`).

- [ ] **Step 3: Implement.** Next to `_matchPatternParser` (:5435), add:

```ts
export const typePatternParser: Parser<TypePattern> = withLoc(
  map(unionItemParser, (t) => ({
    type: "typePattern" as const,
    pattern: null,
    typeHint: t,
  })),
);

// The `is` right-hand side: everything _matchPatternParser accepts EXCEPT the
// bare-identifier binder, which is retired after `is` — a top-level bare
// identifier there is always a type reference (see the type-patterns spec,
// "How is Type coexists with binder patterns").
const _isRhsParser = or(
  lazy(() => arrayMatchPatternParser),
  lazy(() => objectMatchPatternParser),
  restPatternParser,
  wildcardPatternParser,
  nullParser,
  booleanParser,
  unitLiteralParser,
  resultPatternParser,
  numberParser,
  _stringParser,
  typePatternParser,
);
export const isRhsParser: Parser<MatchPattern> = _isRhsParser as Parser<MatchPattern>;
```

Keep the ordering comments from `_matchPatternParser` in mind: literals and
result patterns run before `typePatternParser`, so `is null` / `is true` /
`is success` keep their existing meanings; `typePatternParser` is last and
catches type names (`string`, `Person`, `number[]`). Then change the `is`
wrap at :2855 from `capture(lazy(() => matchPatternParser), "pattern")` to
`capture(lazy(() => isRhsParser), "pattern")`.

- [ ] **Step 4:** Run: `pnpm test:run lib/parsers/pattern.test.ts 2>&1 | tee /tmp/tp-task2-pass.log`. Expected: PASS. If a pre-existing unit test asserted the binder behavior of `x is bareName`, update it to expect a typePattern — that behavior change is the point of the feature.

Evidence for the break (recorded 2026-07-20, plan review finding 6): the
following search over every `.agency` file in `tests/`, `lib/`, `examples/`,
`docs/`, and the repo-level `docs/` found 77 candidate lines, all of them
English prose inside block comments and docstrings — zero code uses of the
`is`-binder form:

```bash
grep -rnE "\bis[[:space:]]+[A-Za-z_][A-Za-z0-9_]*" --include=*.agency \
  tests lib examples docs ../../docs \
  | grep -vE "//|/\*| \* " \
  | grep -vE "\bis[[:space:]]+(success|failure|null|true|false)\b" \
  | grep -vE "\"|'"
```

Re-run it during this task and hand-triage any new hits before proceeding; a
real code hit means a migration entry in the PR body, not a silent break.

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat: parse is Type as a type pattern, retiring the bare is-binder"`

### Task 3: Parser — match arms: `pattern: Type` suffix and `is Type` arms

**Files:**
- Modify: `lib/parsers/parsers.ts` (`caseLhsParser` :3256, `defaultCaseParser` :3245)
- Test: `lib/parsers/matchBlock.test.ts`

**Interfaces:**
- Consumes: `typePatternParser`, `unionItemParser`, `TypePattern` from Tasks 1–2.
- Produces: match arms whose `caseValue` can be a `TypePattern` with a non-null inner `pattern` (`s: string`, `{name}: Person`, `[x,y]: number[]`), a null inner pattern (`is Person`, `_: null`), alongside all existing arm forms.

- [ ] **Step 1: Write failing tests** in `lib/parsers/matchBlock.test.ts`, driving `matchBlockParserCase`:

```ts
test("binder with type suffix: s: string =>", () => {
  const r = matchBlockParserCase("s: string => s");
  expect(r.success).toBe(true);
  const cv = (r as any).result.caseValue;
  expect(cv.type).toBe("typePattern");
  expect(cv.pattern).toMatchObject({ type: "variableName", value: "s" });
  expect(cv.typeHint).toMatchObject({ type: "primitiveType", value: "string" });
});

test("object pattern with type suffix and guard", () => {
  const r = matchBlockParserCase("{name, age}: Person if (age > 100) => name");
  const res = (r as any).result;
  expect(res.caseValue.type).toBe("typePattern");
  expect(res.caseValue.pattern.type).toBe("objectPattern");
  expect(res.guard).toBeDefined();
});

test("is Type as an arm", () => {
  const r = matchBlockParserCase("is boolean => 1");
  const cv = (r as any).result.caseValue;
  expect(cv.type).toBe("typePattern");
  expect(cv.pattern).toBeNull();
});

test("wildcard with type suffix: _: null =>", () => {
  const r = matchBlockParserCase("_: null => 0");
  const cv = (r as any).result.caseValue;
  expect(cv.type).toBe("typePattern");
  expect(cv.pattern).toBeNull();
});

test("bare binder arm still binds", () => {
  const r = matchBlockParserCase("other => other");
  expect((r as any).result.caseValue.type).toBe("variableName");
});

test("array pattern with type suffix: [x, y]: number[]", () => {
  const r = matchBlockParserCase("[x, y]: number[] => x");
  const cv = (r as any).result.caseValue;
  expect(cv.type).toBe("typePattern");
  expect(cv.pattern.type).toBe("arrayPattern");
  expect(cv.typeHint.type).toBe("arrayType");
});

// Regression suite (plan review finding 3): caseLhsParser is being
// restructured, and its exprParser fallback is load-bearing for the
// match(expr is pattern) guard form. These arm shapes must keep parsing.
test("REGRESSION: expression-guard arm still parses", () => {
  const r = matchBlockParserCase("role == \"admin\" => grantAll");
  expect(r.success).toBe(true);
  expect((r as any).result.caseValue.type).toBe("binOpExpression");
});

test("REGRESSION: literal arm still parses", () => {
  const r = matchBlockParserCase("\"small\" => 1");
  expect(r.success).toBe(true);
  expect((r as any).result.caseValue.type).toBe("string");
});

test("REGRESSION: bare wildcard arm still parses", () => {
  const r = matchBlockParserCase("_ => 0");
  expect((r as any).result.caseValue).toBe("_");
});

test("object pattern with internal colon is not a type suffix", () => {
  const r = matchBlockParserCase("{ type: \"click\", x } => x");
  expect((r as any).result.caseValue.type).toBe("objectPattern");
});

test("inline object type as the suffix", () => {
  const r = matchBlockParserCase("person: {name: string, age: number} => person");
  const cv = (r as any).result.caseValue;
  expect(cv.type).toBe("typePattern");
  expect(cv.pattern).toMatchObject({ type: "variableName", value: "person" });
  expect(cv.typeHint.type).toBe("objectType");
});
```

- [ ] **Step 2:** Run and confirm the new tests fail: `pnpm test:run lib/parsers/matchBlock.test.ts 2>&1 | tee /tmp/tp-task3-fail.log`.

- [ ] **Step 3: Implement in `caseLhsParser`.** Keep the change minimal and
declarative (plan review finding 3 + anti-pattern audit): the existing
function's shape — ordered alternatives, each gated by the `=>`/`if`
lookahead, with `exprParser` as the final fallback — is preserved; we add two
named alternatives and one suffix combinator rather than rewriting the
dispatcher imperatively. The `exprParser` fallback is load-bearing (it is how
expression-guard arms and the `match(expr is pattern)` form parse) and must
remain the last resort untouched.

```ts
// The existing lookahead, factored out unchanged: an arm LHS is only
// accepted when the next token is `=>` or a guard `if`.
function armFollowsPattern(rest: string): boolean {
  const trimmed = rest.replace(/^[ \t]+/, "");
  return trimmed.startsWith("=>") || /^if[^A-Za-z0-9_]/.test(trimmed);
}

// Wrap a parser so it only succeeds when the arm lookahead holds after it.
function armGated<T>(parser: Parser<T>): Parser<T> {
  return (input: string) => {
    const result = parser(input);
    if (!result.success) {
      return result;
    }
    if (!armFollowsPattern(result.rest)) {
      return fail("arm LHS must be followed by => or a guard")(input);
    }
    return result;
  };
}

// `is Type` arm: the test-only form.
const isArmParser: Parser<TypePattern> = withLoc(
  map(
    seqC(str("is"), not(varNameChar), spaces, capture(typePatternParser, "typePattern")),
    (captures) => captures.typePattern,
  ),
);

// `_ : Type` — wildcard with a type suffix; equivalent to the is-form.
const wildcardSuffixParser: Parser<TypePattern> = withLoc(
  map(
    seqC(defaultCaseParser, optionalSpaces, char(":"), optionalSpaces,
         capture(unionItemParser, "typeHint")),
    (captures) => ({ type: "typePattern" as const, pattern: null, typeHint: captures.typeHint }),
  ),
);

// `pattern : Type` — bind-and-test, only for the shapes the spec allows.
const patternSuffixParser: Parser<TypePattern> = withLoc(
  (input: string) => {
    const patternResult = lazy(() => matchPatternParser)(input);
    if (!patternResult.success) {
      return patternResult;
    }
    const pattern = patternResult.result as MatchPattern;
    const suffixable =
      pattern.type === "variableName" ||
      pattern.type === "objectPattern" ||
      pattern.type === "arrayPattern";
    if (!suffixable) {
      return fail("pattern kind does not take a type suffix")(input);
    }
    const suffixResult = seqC(
      optionalSpaces, char(":"), optionalSpaces,
      capture(unionItemParser, "typeHint"),
    )(patternResult.rest);
    if (!suffixResult.success) {
      return fail("no arm-level type suffix")(input);
    }
    return success(
      { type: "typePattern", pattern, typeHint: (suffixResult.result as { typeHint: VariableType }).typeHint },
      suffixResult.rest,
    );
  },
);

const caseLhsParser: Parser<unknown> = (input: string) => {
  const armAlternatives = or(
    armGated(isArmParser),
    armGated(wildcardSuffixParser),
    armGated(patternSuffixParser),
    armGated(defaultCaseParser),
    armGated(lazy(() => matchPatternParser)),
  )(input);
  if (armAlternatives.success) {
    return armAlternatives;
  }
  return exprParser(input);
};
```

Ordering notes: `wildcardSuffixParser` before `defaultCaseParser` so `_ :
Type` is not truncated to `_`; `patternSuffixParser` before the plain pattern
so `s: string` is not truncated to a binder `s` (which would then fail the
lookahead on `:`). Adapt the combinator mechanics to the tarsec idioms used
in this file (exact `success`/`fail` shapes, `captureCaptures`, how `withLoc`
composes with hand-rolled parser functions — mirror `resultPatternParser`).
The internal-colon test passes for free because `objectMatchPatternParser`
consumes its braces (including inner colons) before the suffix check runs.

- [ ] **Step 4:** Run: `pnpm test:run lib/parsers/matchBlock.test.ts lib/parsers/pattern.test.ts 2>&1 | tee /tmp/tp-task3-pass.log`. Expected: PASS.

- [ ] **Step 5:** Sanity-parse a real file: write `/tmp` is off-limits for agency runs, so create `als-spike/tp-parse-check.agency` — no, keep it in the repo temp-free: run `pnpm run ast` on a heredoc file inside the package:

```bash
cat > /tmp/tp-check.agency <<'EOF'
node main() {
  const x: any = 5
  match (x) {
    null => print("null")
    s: string => print(s)
    is boolean => print("flag")
    _ => print("other")
  }
}
EOF
pnpm run ast /tmp/tp-check.agency 2>&1 | tee /tmp/tp-task3-ast.log
```

(`pnpm run ast` only parses — it does not execute — so a file outside the
package is fine here.) Expected: JSON AST with `typePattern` case values.

- [ ] **Step 6:** Commit: `git add -A && git commit -m "feat: parse match-arm type suffix and is-Type arms"`

### Task 4: Runtime helper `__coarseTypeTest`

**Files:**
- Create: `lib/runtime/typeTest.ts`
- Create: `lib/runtime/typeTest.test.ts`
- Modify: the runtime barrel/exports so generated code can import it (find where `__validateType` is exported for generated code — `grep -rn "__validateType" lib/runtime/index.ts lib/backends` — and register `__coarseTypeTest` the same way)

**Interfaces:**
- Produces: `__coarseTypeTest(value: unknown, kind: CoarseKind): boolean` with `type CoarseKind = "string" | "number" | "boolean" | "null" | "object" | "array"`.

- [ ] **Step 1: Write the failing test** `lib/runtime/typeTest.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { __coarseTypeTest } from "./typeTest.js";

describe("__coarseTypeTest", () => {
  test("string", () => {
    expect(__coarseTypeTest("hi", "string")).toBe(true);
    expect(__coarseTypeTest(5, "string")).toBe(false);
  });
  test("number", () => {
    expect(__coarseTypeTest(5, "number")).toBe(true);
    expect(__coarseTypeTest("5", "number")).toBe(false);
  });
  test("boolean", () => {
    expect(__coarseTypeTest(false, "boolean")).toBe(true);
    expect(__coarseTypeTest(0, "boolean")).toBe(false);
  });
  test("null is loose: matches undefined like the literal null pattern does", () => {
    // The literal `null` pattern lowers to `== null` (loose), which matches
    // undefined. The coarse check must agree or `null =>` and `_: null` would
    // disagree on interop-produced undefined.
    expect(__coarseTypeTest(null, "null")).toBe(true);
    expect(__coarseTypeTest(undefined, "null")).toBe(true);
    expect(__coarseTypeTest(0, "null")).toBe(false);
    expect(__coarseTypeTest("", "null")).toBe(false);
  });
  test("undefined matches no other coarse kind", () => {
    expect(__coarseTypeTest(undefined, "object")).toBe(false);
    expect(__coarseTypeTest(undefined, "string")).toBe(false);
  });
  test("object excludes null and arrays", () => {
    expect(__coarseTypeTest({ a: 1 }, "object")).toBe(true);
    expect(__coarseTypeTest(null, "object")).toBe(false);
    expect(__coarseTypeTest([1], "object")).toBe(false);
  });
  test("array", () => {
    expect(__coarseTypeTest([], "array")).toBe(true);
    expect(__coarseTypeTest({ length: 0 }, "array")).toBe(false);
  });
});
```

- [ ] **Step 2:** Run: `pnpm test:run lib/runtime/typeTest.test.ts 2>&1 | tee /tmp/tp-task4-fail.log`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `lib/runtime/typeTest.ts`:

```ts
export type CoarseKind = "string" | "number" | "boolean" | "null" | "object" | "array";

/** Tier 1 type-pattern check. A function (not inlined codegen) so the tested
 *  value is evaluated exactly once even for the multi-reference object case. */
export function __coarseTypeTest(value: unknown, kind: CoarseKind): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      // Loose on purpose: the literal null pattern lowers to `== null`, and
      // the runtime already normalizes undefined to null elsewhere (__nn).
      return value === null || value === undefined;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
  }
}
```

Register it wherever the runtime exposes `__validateType` to generated code.

- [ ] **Step 4:** Run: `pnpm test:run lib/runtime/typeTest.test.ts 2>&1 | tee /tmp/tp-task4-pass.log`. Expected: PASS. Then `make 2>&1 | tail -5` (runtime changed).

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat: __coarseTypeTest runtime helper for tier-1 type patterns"`

### Task 5: Lowering — typePattern becomes a TypeTestExpression conjunct

**Files:**
- Modify: `lib/lowering/patternLowering.ts` (`collectChecks` :1034, `walkPattern` :1135, `assertNoBindersInBoolIs` :1102, and the binder-emission path used by `lowerMatchBlock` / `lowerIfElse`)
- Test: extend the existing lowering tests (find them: `ls lib/lowering/*.test.ts`; if none exist, create `lib/lowering/patternLowering.test.ts` mirroring how other lowering behavior is tested — check `git log --oneline -- lib/lowering` for where its tests landed)

**Interfaces:**
- Consumes: `TypePattern`, `TypeTestExpression` (Task 1).
- Produces: for `x is T` (null inner pattern), the lowered condition is exactly `{ type: "typeTestExpression", expression: x, typeHint: T }`. For an arm `p: T`, the condition is `typeTest && <inner-pattern checks>` and the binders are emitted by the existing machinery against the scrutinee (Rule 1: originals, untransformed).

- [ ] **Step 1: Write failing tests** (drive `lowerPatterns` on a parsed snippet and inspect the lowered AST):

```ts
test("is Type lowers to a typeTestExpression condition", () => {
  const ast = parse(`node main() { const x: any = 1\n if (x is string) { print(x) } }`);
  const lowered = lowerPatterns(ast);
  const cond = findFirst(lowered, (n) => n.type === "ifElse").condition;
  expect(cond.type).toBe("typeTestExpression");
  expect(cond.typeHint).toMatchObject({ type: "primitiveType", value: "string" });
});

test("arm binder with type suffix binds the ORIGINAL scrutinee", () => {
  const ast = parse(`node main() { const x: any = 1\n match (x) { s: string => print(s)\n _ => print("no") } }`);
  const lowered = lowerPatterns(ast);
  // The arm body must contain `const s = <scrutinee temp>` — a plain
  // assignment from the source, NOT from any validation result.
  const assign = findFirst(lowered, (n) => n.type === "assignment" && n.name === "s");
  expect(assign.value.type).toBe("variableName");
});

test("destructuring arm with type suffix emits the field binders", () => {
  // Guards the specific gate at patternLowering.ts:426-429 (see Step 3): if
  // typePattern is not routed as a destructure-style arm, `name` is never
  // bound and this fails.
  const ast = parse(`node main() { const x: any = 1\n match (x) { {name}: Person => print(name)\n _ => print("no") } }`);
  const lowered = lowerPatterns(ast);
  const assign = findFirst(lowered, (n) => n.type === "assignment" && n.name === "name");
  expect(assign).toBeDefined();
  expect(assign.value.type).toBe("valueAccess");
});

test("array pattern with type suffix emits element binders and the array test", () => {
  const ast = parse(`node main() { const x: any = 1\n match (x) { [a, b]: number[] => print(a)\n _ => print("no") } }`);
  const lowered = lowerPatterns(ast);
  expect(findFirst(lowered, (n) => n.type === "assignment" && n.name === "a")).toBeDefined();
  expect(findFirst(lowered, (n) => n.type === "typeTestExpression")).toBeDefined();
});

test("lowered match keeps the typePattern in MatchArmMeta", () => {
  // Task 8 exhaustiveness and AG5003 read MatchArmMeta.caseValue; lowering
  // preserves { caseValue, guard } at patternLowering.ts:464 today — confirm
  // typePattern arms flow through it unchanged.
  const ast = parse(`node main() { const x: any = 1\n match (x) { s: string => print(s)\n _ => print("no") } }`);
  const lowered = lowerPatterns(ast);
  const meta = findMatchArmMeta(lowered);
  expect(meta.some((m) => m.caseValue?.type === "typePattern")).toBe(true);
});

test("typePattern binders in pure-boolean is remain an error", () => {
  // Cannot be produced by the parser today (suffix form is arm-only), but the
  // lowering guard must still reject it defensively.
  expect(() =>
    assertNoBindersInBoolIsExposedForTest({
      type: "typePattern",
      pattern: { type: "variableName", value: "s" },
      typeHint: { type: "primitiveType", value: "string" },
    }),
  ).toThrow(/nowhere to bind/);
});
```

(Use whatever parse/inspect helpers the existing lowering tests use; the
assertions are the contract.)

- [ ] **Step 2:** Run and confirm failure: `pnpm test:run lib/lowering 2>&1 | tee /tmp/tp-task5-fail.log`.

- [ ] **Step 3: Implement.**

In `collectChecks` (:1034), add before the `default` literal case:

```ts
case "typePattern": {
  checks.push({
    type: "typeTestExpression",
    expression: cloneExpr(source),
    typeHint: pattern.typeHint,
    loc: pattern.loc,
  } as Expression);
  if (pattern.pattern) {
    collectChecks(pattern.pattern as MatchPattern, source, checks);
  }
  break;
}
```

In `walkPattern` (:1135), add a `typePattern` case that recurses into
`pattern.pattern` when non-null (this makes `assertNoBindersInBoolIs` reject
inner binders for free, satisfying the defensive test).

In the binder-emission path (the code near `lowerMatchBlock` :760–:890 that
turns object/array/binder patterns into assignments from the scrutinee), add
the same delegation: a `typePattern` emits the binders of its inner pattern
(if any) against the same source, and nothing else.

THE gate most likely to be missed (plan review finding 4):
`patternLowering.ts:426-429` decides which arms get destructure-style
handling by checking `caseValue.type === "objectPattern" || "arrayPattern" ||
"resultPattern"`. A `typePattern` caseValue is not in that list, so without a
change a `{name}: Person` arm silently falls to the else path and never emits
its binders. Route `typePattern` arms whose inner pattern is an
object/array pattern through the destructure branch (dispatching on the INNER
pattern's type), and confirm the `MatchArmMeta` construction at `:464` passes
the original `typePattern` node through as `caseValue` — Task 8 depends on
seeing it. Then sweep the rest: find every `switch` or `if`-chain in the file
that dispatches on pattern `.type` (grep `"objectPattern"` within the file)
and make sure each one either handles `typePattern` or provably cannot
receive it (binding-position code cannot — `TypePattern` is not in
`BindingPattern`).

- [ ] **Step 4:** Run: `pnpm test:run lib/lowering 2>&1 | tee /tmp/tp-task5-pass.log`. Expected: PASS.

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat: lower type patterns to TypeTestExpression conjuncts"`

### Task 6: Builder — compile TypeTestExpression

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (new `processTypeTestExpression`, wired into `processNode`; reuse `validateExpr` :939)
- Test: `tests/typescriptGenerator/type-patterns.agency` + regenerated fixtures

**Interfaces:**
- Consumes: `TypeTestExpression`, `__coarseTypeTest` (registered import), `validateExpr`, `isSuccess` (already a runtime export — `resultCheckCall` in lowering emits calls to it, so the import plumbing exists).
- Produces: Tier 1 → `__coarseTypeTest(<v>, "<kind>")`; Tier 2 → `isSuccess(<validateExpr output>)` (which is `isSuccess(__validateType(v, <zod>))` without validators, `isSuccess(await __validateChainRecursive(v, <descriptor>))` with).

- [ ] **Step 1: Write the fixture source** `tests/typescriptGenerator/type-patterns.agency`:

```ts
type Person = {
  name: string,
  age: number,
}

def describe(value: any): string {
  if (value is string) {
    return "text"
  }
  if (value is any[]) {
    return "list"
  }
  if (value is object) {
    return "object"
  }
  match (value) {
    null => "null"
    n: number => "number"
    {name}: Person => "person: ${name}"
    p: {tag: string} => "tagged: ${p.tag}"
    _ => "other"
  }
}

node main() {
  print(describe("hi"))
}
```

- [ ] **Step 2: Implement `processTypeTestExpression`:**

```ts
private processTypeTestExpression(node: TypeTestExpression): TsNode {
  const value = this.processNode(node.expression);
  const coarse = coarseKindFor(node.typeHint);
  if (coarse !== null) {
    return ts.call(ts.id("__coarseTypeTest"), [value, ts.str(coarse)]);
  }
  return ts.call(ts.id("isSuccess"), [this.validateExpr(node.typeHint, value)]);
}
```

with a module-level helper:

```ts
/** Tier 1 mapping: which coarse runtime check a typeHint compiles to, or null
 *  for the schema (Tier 2) path. See the type-patterns spec, "Tier 1". */
function coarseKindFor(t: VariableType): CoarseKind | null {
  if (t.type === "primitiveType") {
    if (t.value === "string" || t.value === "number" || t.value === "boolean"
        || t.value === "null" || t.value === "object") {
      return t.value;
    }
    return null;
  }
  if (t.type === "arrayType"
      && t.itemType?.type === "primitiveType" && t.itemType.value === "any") {
    return "array";
  }
  return null;
}
```

(Adjust the `arrayType` field name to the real AST — check `lib/types.ts` for
the array-type node shape.) Wire the `"typeTestExpression"` case into the
builder's `processNode` dispatch, and register `__coarseTypeTest` in the
generated-code import list the same way `isSuccess`/`__validateType` are.
Match the file's existing `ts.*` IR idioms (see `docs/dev/typescript-ir.md`);
`validateExpr` already embeds its own `await` when it emits the chain call.

- [ ] **Step 3:** Rebuild fixtures: `make fixtures 2>&1 | tee /tmp/tp-task6-fixtures.log`. Inspect `tests/typescriptGenerator/type-patterns.mjs`: Tier 1 sites call `__coarseTypeTest`, the `Person` arm goes through `isSuccess(__validateType(...))` (no validators in this fixture).

- [ ] **Step 4:** Run the generator test suite: `pnpm test:run tests/typescriptGenerator 2>&1 | tee /tmp/tp-task6-pass.log`. Expected: PASS, and no OTHER fixture changed (if one did, the `is` parser change leaked — stop and investigate before continuing).

- [ ] **Step 4b: Verify `object` agreement between coarse check and schema.**
`schema(object)` is `z.record(z.string(), z.any())`
(`typeToZodSchema.ts:115`); the coarse check rejects arrays by spec. Check
whether `z.record` accepts arrays (one-line vitest or node eval). If it does,
the bang (`const o: object! = [1]`) and the pattern (`[1] is object` → false)
disagree on arrays for the same type — document the divergence in the guide
(the pattern's exclusion of arrays is deliberate and the more useful reading)
rather than changing either behavior in this PR.

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat: compile TypeTestExpression to coarse checks and schema validation"`

### Task 7: Type checker — synthesis, unknown-type error, narrowing

**Files:**
- Modify: `lib/typeChecker/synthesizer.ts` (synthesize `boolean`; AG1013 on unresolved alias)
- Modify: `lib/typeChecker/diagnostics.ts` (add `typePatternUnknownType` AG1013)
- Modify: `lib/typeChecker/narrowing.ts` (`analyzeCondition` fact + `typeTest` entry in the `narrowers` table)
- Test: the co-located checker/narrowing test files (find the ones covering `analyzeCondition` and `synth`: `grep -rln "analyzeCondition" lib/typeChecker --include=*.test.ts`)

**Interfaces:**
- Consumes: `TypeTestExpression`.
- Produces: `typeTestExpression` synthesizes to `boolean`; `if (x is T)` narrows `x` to `T` in the then-branch only (positive-only per spec); `AG1013` on `x is NotAType`.

- [ ] **Step 1: Write failing tests** (in the style of the existing checker tests — typecheck a source string, assert diagnostics/types):

CRITICAL test-design rule for this task (from plan review finding 1): never
use an `any`-typed scrutinee in a test whose job is to prove narrowing — `any`
permits every operation, so such a test passes whether or not narrowing works.
Every narrowing test below uses a union scrutinee and an operation that is
ILLEGAL on the un-narrowed union, so the test fails when narrowing is broken.

```ts
test("is number narrows a union so the branch typechecks (fails without narrowing)", () => {
  // x: string | number. `x + 1` needs `number`; without narrowing this is a
  // type error, so this test can only pass if narrowing works.
  const { diagnostics } = check(`
    def f(x: string | number): number {
      if (x is number) {
        return x + 1
      }
      return 0
    }
  `);
  expect(diagnostics).toHaveLength(0);
});

test("arm binder receives the narrowed type (fails without narrowing)", () => {
  const { diagnostics } = check(`
    def wantsNumber(n: number): number {
      return n
    }
    def f(x: string | number): number {
      match (x) {
        n: number => wantsNumber(n)
        _ => 0
      }
    }
  `);
  expect(diagnostics).toHaveLength(0);
});

test("tier 2 narrowing: field access valid only after the Person test", () => {
  const { diagnostics } = check(`
    type Person = { name: string }
    def f(x: string | Person): string {
      match (x) {
        {name}: Person => name
        _ => "none"
      }
    }
  `);
  expect(diagnostics).toHaveLength(0);
});

test("the expression synthesizes boolean, not any", () => {
  const { diagnostics } = check(`
    def f(x: any): string {
      const b: string = x is string
      return b
    }
  `);
  expect(diagnostics.length).toBeGreaterThan(0);
});

test("unknown type name in is-position is AG1013, and ONLY AG1013", () => {
  // AG1006 (type alias not defined) fires on the generic type-resolution
  // path. The typeTest synthesizer must resolve its typeHint in a mode that
  // suppresses AG1006 so the tailored AG1013 is the single diagnostic —
  // double-firing or AG1006-only both fail this test.
  const { diagnostics } = check(`
    def f(x: any): boolean {
      return x is Bogus
    }
  `);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].code).toBe("AG1013");
});

test("is object narrows to the opaque object primitive: member access errors", () => {
  // Decision (plan review finding 8): `object` stays opaque. `is object`
  // means "I can stringify or pass this along", not "I can read fields" —
  // field reads require a shape test ({title}: Titled or is SomeAlias).
  const { diagnostics } = check(`
    def f(draft: string | object): string {
      if (draft is object) {
        return draft.title
      }
      return ""
    }
  `);
  expect(diagnostics.length).toBeGreaterThan(0);
});

test("JS-native class names get the tailored AG1013 message", () => {
  const { diagnostics } = check(`
    def f(x: any): boolean {
      return x is Date
    }
  `);
  const d = diagnostics.find((d) => d.code === "AG1013");
  expect(d?.message).toMatch(/JavaScript class/);
});

test("bare generic type parameters are a compile error", () => {
  // A type parameter has no runtime schema (erased), so `is T` cannot be
  // compiled. Adjust the source to however parameterized aliases/functions
  // actually put a type parameter in scope at an expression site; if no such
  // position exists in the language today, assert the alias-resolution path
  // treats an unresolved parameter name as AG1013 and document that.
  const { diagnostics } = check(`
    type Box<T> = { value: T }
    def f(x: any): boolean {
      return x is T
    }
  `);
  expect(diagnostics.some((d) => d.code === "AG1013")).toBe(true);
});

test("narrowing is positive-only: after-branch stays un-narrowed", () => {
  // v1 has NO negative narrowing for TYPE patterns, so after the early
  // return x is STILL string | number and `x + 1` must error. This pins the
  // positive-only decision; if negative narrowing lands later, this test
  // flips on purpose. NOTE: do not write this test with `is null` — that
  // parses as the LITERAL null pattern, which lowers to `x == null` and
  // already narrows both branches through the existing exact-null machinery.
  const { diagnostics } = check(`
    def f(x: string | number): number {
      if (x is string) {
        return 0
      }
      return x + 1
    }
  `);
  expect(diagnostics.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2:** Run and confirm failures: `pnpm test:run lib/typeChecker 2>&1 | tee /tmp/tp-task7-fail.log` (expect the first two to fail: unknown node in synthesis, no AG1013).

- [ ] **Step 3: Implement.**

Diagnostics entry (`lib/typeChecker/diagnostics.ts`, next to the AG5002 block):

```ts
typePatternUnknownType: {
  code: "AG1013",
  severity: "error",
  message: "`{name}` is not a type; to bind the value write `const {name} = x`.",
},
```

When the unresolved name is a well-known JS class, swap in a tailored message
(same code, different text — mirror however existing diagnostics vary their
message): for names in
`["Date", "Map", "Set", "RegExp", "Error", "Promise", "Function", "Symbol"]`,
emit "`{name}` is a JavaScript class, not an Agency type; type patterns only
test Agency types. Use `is object` or a helper function." Type patterns never
mean `instanceof` — the tailored message is how users find that out.

Synthesizer: a `typeTestExpression` case that (a) synthesizes the inner
expression, (b) resolves `node.typeHint` through the same alias-resolution
path `validateExpr`-adjacent checker code uses (grep `resolveTypeDeep` /
`visibleTypeAliases` in `lib/typeChecker`), emitting `typePatternUnknownType`
when an alias name does not resolve, and (c) returns `boolean`.

Diagnostic exclusivity (plan review finding 2): the generic resolution path
emits `AG1006` ("Type alias '{alias}' is not defined") for undefined aliases.
For a typeHint reached through a type pattern, AG1013 must be the SOLE
diagnostic — resolve in a mode that suppresses AG1006 for this site (pass a
flag or catch the unresolved case before the generic path reports). The
"exactly one diagnostic" test above enforces this; if the suppression turns
out to be invasive, the documented fallback is to drop AG1013 and reuse
AG1006, but the binding hint ("to bind the value write const ...") is worth a
real attempt since that confusion is specific to this feature.

Narrowing (`lib/typeChecker/narrowing.ts`): in `analyzeCondition`, recognize a
`typeTestExpression` whose subject is a bare variable (extend to member paths
only if the existing `Reference` extraction makes it free) and produce a
then-branch fact `{ variableName, refine: { kind: "typeTest", type: node.typeHint } }`
with NO else-branch fact (positive-only). Add a `typeTest` entry to the
`narrowers` table whose apply step returns the refined type (resolved through
the alias table). The README documents the table contract; mirror the
`discriminant` entry's shape.

- [ ] **Step 4:** Run: `pnpm test:run lib/typeChecker 2>&1 | tee /tmp/tp-task7-pass.log`. Expected: PASS, no regressions in the narrowing suite.

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat: typecheck and narrow type patterns, AG1013 for unknown type names"`

### Task 8: Exhaustiveness and the shadowing warning

**Files:**
- Modify: `lib/typeChecker/matchExhaustiveness.ts`
- Modify: `lib/typeChecker/diagnostics.ts` (add `bareArmBinderShadowsType` AG5003)
- Test: the existing exhaustiveness test file (`grep -rln "matchNotExhaustive" lib --include=*.test.ts`)

**Interfaces:**
- Consumes: `MatchArmMeta` with `caseValue: TypePattern`.
- Produces: type-pattern arms never count toward coverage and never act as catch-alls; AG5003 warning on un-guarded bare-binder arms named like a visible type.

- [ ] **Step 1: Write failing tests:**

```ts
test("type-pattern arms do not satisfy exhaustiveness", () => {
  const { diagnostics } = check(`
    def f(x: "a" | "b"): number {
      match (x) {
        s: string => 1
      }
    }
  `);
  expect(diagnostics.some((d) => d.code === "AG5002")).toBe(true);
});

test("coarse type arms over a fully covered union still demand _", () => {
  // Spec v1 decision: type-pattern arms NEVER earn exhaustiveness credit,
  // even when coarse Tier 1 arms provably cover the closed union.
  const { diagnostics } = check(`
    def f(x: string | number): number {
      match (x) {
        is string => 1
        is number => 2
      }
    }
  `);
  expect(diagnostics.some((d) => d.code === "AG5002")).toBe(true);
});

test("property-position binder named like a type warns AG5003", () => {
  // `{name: string}` in PATTERN position binds the name field to a variable
  // called `string` — a footgun once type patterns exist, because it reads
  // like a field type test. Warn the same way as bare binder arms.
  const { diagnostics } = check(`
    def f(x: any): string {
      match (x) {
        {name: string} => string
        _ => "no"
      }
    }
  `);
  expect(diagnostics.some((d) => d.code === "AG5003")).toBe(true);
});

test("bare binder arm named like a type warns AG5003", () => {
  const { diagnostics } = check(`
    type Person = { name: string }
    def f(x: any): string {
      match (x) {
        Person => "bound"
        _ => "no"
      }
    }
  `);
  expect(diagnostics.some((d) => d.code === "AG5003" && d.severity === "warning")).toBe(true);
});

test("AG5003 negatives: ordinary binders and guarded arms do not warn", () => {
  const { diagnostics } = check(`
    type Person = { name: string }
    def f(x: any): string {
      match (x) {
        other if (other != null) => "guarded"
        rest => "bound"
      }
    }
  `);
  expect(diagnostics.some((d) => d.code === "AG5003")).toBe(false);
});
```

- [ ] **Step 2:** Run and confirm the first and third fail: `pnpm test:run lib/typeChecker 2>&1 | tee /tmp/tp-task8-fail.log`.

- [ ] **Step 3: Implement.** In `matchExhaustiveness.ts`: wherever arms are
normalized (the `NormalizedArm` construction), treat `caseValue.type ===
"typePattern"` exactly like a guarded arm — present, but contributing nothing
to coverage and never a catch-all. In the same pass (it has `scopes` and the
alias tables in hand), when an un-guarded arm's `caseValue` is a bare
`variableName` whose name matches a visible type alias or a primitive type
name (`string`, `number`, `boolean`, `object`), emit:

```ts
bareArmBinderShadowsType: {
  code: "AG5003",
  severity: "warning",
  message: "`{name}` here binds the value; it does not test the type. Did you mean `p: {name}` or `is {name}`?",
},
```

Apply the same check one level down: walk each arm's object-pattern
properties, and when an `objectPatternProperty` value is a bare
`variableName` binder whose name matches a visible type or primitive
(`{name: string}`), emit AG5003 with a property-flavored variant of the
message ("`{field}: {name}` here binds the field to a variable called
`{name}`; field-level type tests are not supported — test the whole value
with a typed pattern instead"). Same code, so one config knob governs both.

- [ ] **Step 4:** Run: `pnpm test:run lib/typeChecker 2>&1 | tee /tmp/tp-task8-pass.log`. Expected: PASS.

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat: type-pattern arms never satisfy exhaustiveness, warn on type-shadowing binders"`

### Task 9: Formatter

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Test: the formatter round-trip tests (find them: `grep -rln "agencyGenerator" tests lib --include=*.test.ts | head`)

**Interfaces:**
- Consumes: parse-level `TypePattern` (never `TypeTestExpression` — the formatter runs pre-lowering).
- Produces: `x is string`, `s: string => ...`, `is boolean => ...`, `{name, age}: Person => ...` all round-trip through `pnpm run fmt` unchanged.

Known, intended normalization (plan review finding 7): `_: Type` and
`is Type` parse to the identical node (`typePattern` with `pattern: null`),
so the formatter prints both as `is Type`. Do not assert byte-identity for
the `_: Type` spelling in round-trip tests; assert it formats to `is Type`.
Preserving the user's original spelling would need a discriminator field on
the node and is not worth it.

- [ ] **Step 1: Write a failing round-trip test** with a source containing every spelling (the `describe` example from Task 6 is a good body), asserting format(parse(src)) === src modulo whitespace, in the style of the existing formatter tests. Include one non-round-trip assertion: `_: string => 0` formats as `is string => 0`.

- [ ] **Step 2:** Run and confirm failure, saving output to `/tmp/tp-task9-fail.log`.

- [ ] **Step 3: Implement** printing in `agencyGenerator.ts`: find where match-arm `caseValue` and `isExpression` patterns print (grep `"resultPattern"` in the file for the dispatch site) and add: `typePattern` with null inner prints `is <type>` in arm position and just `<type>` after an `is` operator (the surrounding `is` token is already printed by the isExpression printer); non-null inner prints `<pattern>: <type>`. Reuse the existing type-printing helper the generator uses for annotations.

- [ ] **Step 4:** Run the formatter tests, saving to `/tmp/tp-task9-pass.log`. Expected: PASS.

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat: format type patterns"`

### Task 10: Execution tests (runtime semantics end-to-end)

**Files:**
- Create: `tests/agency/type-patterns.agency`
- Create: `tests/agency/type-patterns.test.json`

**Interfaces:**
- Consumes: everything above. No LLM calls — pure runtime behavior (per `docs/misc/TESTING.md`).

- [ ] **Step 1: Write the test program** `tests/agency/type-patterns.agency`:

```ts
// Execution tests for type patterns (spec 2026-07-20-type-patterns-design.md).
// Covers: tier-1 coarse checks, tier-2 shape + validator checks, Rule 1
// (binds the ORIGINAL value, validators decide the match but never rewrite),
// arm ordering, and the is-operator in plain conditions.

def isAdult(age: number): Result<number> {
  if (age < 18) {
    return failure("too young")
  }
  return success(age)
}

def clampAge(age: number): Result<number> {
  if (age < 0) {
    return success(1)
  }
  return success(age)
}

type Person = {
  name: string,
  @validate(isAdult) age: number,
}

type Repaired = {
  name: string,
  @validate(clampAge) age: number,
}

def describe(value: any): string {
  match (value) {
    null => "null"
    s: string => "string:${s}"
    n: number => "number:${n}"
    is boolean => "boolean"
    is any[] => "array"
    {name}: Person => "person:${name}"
    is object => "object"
    _ => "other"
  }
}

node coarse() {
  const parts = [
    describe(null),
    describe("hi"),
    describe(42),
    describe(true),
    describe([1, 2]),
    describe({ name: "Ada", age: 30 }),
    describe({ x: 1 }),
  ]
  print(parts.join("|"))
}

node validatorRejects() {
  // Right shape, failing validator: must NOT match Person, falls to object.
  print(describe({ name: "Kid", age: 12 }))
}

node bindsOriginal() {
  // Rule 1 with a transforming validator: clampAge repairs age -5 to 1, so
  // the match SUCCEEDS, but the bound value must be the ORIGINAL (-5).
  const u: any = { name: "Neg", age: -5 }
  match (u) {
    {age}: Repaired => print("matched:${age}")
    _ => print("no match")
  }
}

node isCondition() {
  // Branch-dispatch test only: v is `any`, so this cannot observe narrowing
  // (that is Task 7's job at compile time). It pins that the branch executes.
  const v: any = "text"
  if (v is string) {
    print("len:${v.length}")
  }
}

node typedArrayTier2() {
  // The number[] schema path is per-element: a string element must fail.
  const good: any = [1, 2]
  const bad: any = [1, "two"]
  let out = ""
  if (good is number[]) {
    out = "good-yes"
  }
  if (bad is number[]) {
    out = "${out},bad-yes"
  } else {
    out = "${out},bad-no"
  }
  print(out)
}

node isBoolean() {
  const v: any = 5
  const b = v is string
  if (b == false) {
    print("not-a-string")
  }
}

node matchGuardForm() {
  // The match(expr is pattern) guard form with a type pattern.
  const v: any = { name: "Ada", age: 30 }
  match (v is Person) {
    true => print("is-person")
    _ => print("not-person")
  }
}

node looseNull() {
  // undefined from JS interop must behave like null in all three null arms.
  const obj: any = {}
  const missing: any = obj["nope"]
  if (missing is null) {
    print("missing-is-null")
  }
}
```

- [ ] **Step 2: Write** `tests/agency/type-patterns.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "coarse",
      "description": "Tier 1 coarse checks and tier 2 Person arm dispatch correctly across null, string, number, boolean, array, valid person, and plain object.",
      "input": "",
      "expectedOutput": "\"null|string:hi|number:42|boolean|array|person:Ada|object\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "validatorRejects",
      "description": "Right shape but failing validator does not match the named type; falls through to the object arm.",
      "input": "",
      "expectedOutput": "\"object\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "bindsOriginal",
      "description": "A transforming validator counts as a pass but the bound value is the original, untransformed one (Rule 1).",
      "input": "",
      "expectedOutput": "\"matched:-5\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "isCondition",
      "description": "is string in an if-condition narrows so .length typechecks and runs.",
      "input": "",
      "expectedOutput": "\"len:4\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "isBoolean",
      "description": "is Type works as a plain boolean expression in a pure-boolean context.",
      "input": "",
      "expectedOutput": "\"not-a-string\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "matchGuardForm",
      "description": "match(expr is Type) guard form works with a type pattern on the scrutinee.",
      "input": "",
      "expectedOutput": "\"is-person\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "typedArrayTier2",
      "description": "is number[] runs the per-element schema: all-number array passes, mixed array fails.",
      "input": "",
      "expectedOutput": "\"good-yes,bad-no\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "looseNull",
      "description": "Missing-key access (normalized null/undefined) matches is null.",
      "input": "",
      "expectedOutput": "\"missing-is-null\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

(Adjust the exact print/join formatting and expectedOutput quoting to match a
neighboring test pair like `early-return-before-loop` — the assertions and
node set are the contract. Check the actual `describe` match-arm string
interpolation output before finalizing expectedOutput.)

- [ ] **Step 3:** Run: `make && pnpm run agency test tests/agency/type-patterns.agency 2>&1 | tee /tmp/tp-task10.log`. Expected: all nodes pass. Debug from the log, not by rerunning blindly.

- [ ] **Step 4:** Commit: `git add -A && git commit -m "test: type patterns execution coverage incl. validator and Rule 1 semantics"`

### Task 11: Documentation

**Files:**
- Modify: `docs/site/guide/pattern-matching.md` (new "Type patterns" section)
- Modify: `docs/dev/typechecker/narrowing/README.md` (capability table: flip the typeof-split row to ✅ with the `is Type` syntax; note positive-only)
- Modify: `lib/typeChecker/diagnosticExplanations.ts` if the repo pattern requires an explanation entry per new code (check how AG5002 is documented there)

- [ ] **Step 1:** Write the guide section: both spellings, the tier table from the spec, Rule 1 including the transforming-validator caveat (copy the spec's plain-English framing: "a type pattern tells you this is repairable, not this is already valid"), the three-null-spellings note, exhaustiveness (always add `_`), and the `is`-binder retirement with the exact AG1013 error text. Follow `docs/dev/general-writing-tips.md`: plain prose, examples with data.
- [ ] **Step 2:** Update the narrowing README rows and the diagnostics explanations.
- [ ] **Step 3:** Commit: `git add -A && git commit -m "docs: type patterns guide section and narrowing capability update"`

### Task 12: stdlib `Json` type — the real answer to "is this JSON-serializable?"

Checking "is this value a plain JSON-serializable tree" is a common need that
no coarse check can answer (serializability is a property of the whole tree,
and `is object` deliberately says nothing about contents). Tier 2 runs
validators, so the right UX is a stdlib type whose validator IS the precise
check. After this task, `x is Json`, `j: JsonObject => ...`, `const d: Json! =
input`, and `def save(data: Json)` all work through existing machinery.

Definition of "JSON-serializable" (round-trips through
`JSON.parse(JSON.stringify(x))` unchanged): accept `null`, booleans, strings,
finite numbers, arrays of Json, and plain objects (prototype is
`Object.prototype` or `null`) whose values are Json. Reject `undefined`,
functions, class instances (a `Date` stringifies but comes back a string — it
does not round-trip; `Map` loses its contents), `NaN`/`Infinity` (stringify to
`null`, silently lossy), and cyclic structures.

**Files:**
- Create: `lib/runtime/jsonValue.ts` (the recursive walk — TS for speed and cycle handling)
- Create: `lib/runtime/jsonValue.test.ts`
- Modify: the stdlib module that owns general value types (inspect `lib/stdlib/` and the prelude auto-import list in `lib/prelude.ts`; put `Json`/`JsonObject` where they will be auto-imported — mind the TDZ and `_emit` registration gotchas of the std::index prelude, and first `grep -rn "type Json" lib docs` to confirm the names are free)

**Interfaces:**
- Produces: runtime `__isJsonValue(value: unknown): { ok: true } | { ok: false; path: string; reason: string }`; stdlib `isJsonValue(v: any): Result<any>` validator; prelude types `Json` (`@validate(isJsonValue) type Json = any`) and `JsonObject` (`Record<string, Json>` — verify the alias-with-validated-element path survives #630; if Record drops the validator, define `JsonObject` as `@validate(isJsonObject) type JsonObject = object` with its own thin wrapper instead, and say so in the docstring).

- [ ] **Step 1: Write the failing runtime test** `lib/runtime/jsonValue.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { __isJsonValue } from "./jsonValue.js";

describe("__isJsonValue", () => {
  test("accepts json primitives, arrays, and plain objects", () => {
    expect(__isJsonValue(null).ok).toBe(true);
    expect(__isJsonValue("s").ok).toBe(true);
    expect(__isJsonValue(3.5).ok).toBe(true);
    expect(__isJsonValue(false).ok).toBe(true);
    expect(__isJsonValue([1, ["a", null]]).ok).toBe(true);
    expect(__isJsonValue({ a: { b: [1, "x"] } }).ok).toBe(true);
    expect(__isJsonValue(Object.create(null)).ok).toBe(true);
  });
  test("rejects non-round-tripping values with a path", () => {
    expect(__isJsonValue(new Date()).ok).toBe(false);
    expect(__isJsonValue({ a: new Map() }).ok).toBe(false);
    expect(__isJsonValue({ a: [1, NaN] })).toMatchObject({ ok: false, path: "a[1]" });
    expect(__isJsonValue(Infinity).ok).toBe(false);
    expect(__isJsonValue(undefined).ok).toBe(false);
    expect(__isJsonValue({ f: () => 1 }).ok).toBe(false);
  });
  test("rejects cycles instead of hanging", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(__isJsonValue(cyclic)).toMatchObject({ ok: false, reason: expect.stringContaining("cycle") });
  });
});
```

- [ ] **Step 2:** Run: `pnpm test:run lib/runtime/jsonValue.test.ts 2>&1 | tee /tmp/tp-task12-fail.log`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `lib/runtime/jsonValue.ts`:

```ts
type JsonCheck = { ok: true } | { ok: false; path: string; reason: string };

/** Precise "round-trips through JSON.stringify/parse" check. Plain data
 *  only: class instances (Date, Map, ...) and non-finite numbers are
 *  rejected because stringify silently rewrites them. */
export function __isJsonValue(value: unknown): JsonCheck {
  // Coding standards: arrays, not sets — the visited list is an array; the
  // O(depth) scan is fine because it only holds the current ancestor chain.
  return walkJson(value, "", []);
}

function walkJson(value: unknown, path: string, ancestors: unknown[]): JsonCheck {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, path, reason: "non-finite number serializes to null" };
    }
    return { ok: true };
  }
  if (Array.isArray(value)) {
    if (ancestors.includes(value)) {
      return { ok: false, path, reason: "cycle detected" };
    }
    const nested = [...ancestors, value];
    for (let i = 0; i < value.length; i++) {
      const result = walkJson(value[i], path === "" ? `[${i}]` : `${path}[${i}]`, nested);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, path, reason: "not a plain object (class instance)" };
    }
    if (ancestors.includes(value)) {
      return { ok: false, path, reason: "cycle detected" };
    }
    const nested = [...ancestors, value];
    for (const key of Object.keys(value)) {
      const result = walkJson(
        (value as Record<string, unknown>)[key],
        path === "" ? key : `${path}.${key}`,
        nested,
      );
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }
  return { ok: false, path, reason: `${typeof value} is not JSON-serializable` };
}
```

- [ ] **Step 4:** Run: `pnpm test:run lib/runtime/jsonValue.test.ts 2>&1 | tee /tmp/tp-task12-pass.log`. Expected: PASS.

- [ ] **Step 5: Wire the stdlib type.** In the chosen stdlib module, add the validator and types with doc comments (docstrings are tool descriptions — keep them terse and user-facing):

```ts
/** Succeeds when v is a plain JSON tree that round-trips through
    JSON.stringify unchanged. Rejects class instances, functions,
    non-finite numbers, and cycles, with the failing path. */
def isJsonValue(v: any): Result<any> {
  // thin wrapper over the runtime __isJsonValue; return failure(reason at path)
}

/** A value that round-trips through JSON: null, booleans, strings, finite
    numbers, arrays of Json, and plain objects of Json. */
@validate(isJsonValue)
type Json = any;
```

Run `make` (stdlib changed), then `make doc` (stdlib docstrings changed —
plain `make` leaves `docs/site/stdlib/*.md` stale).

- [ ] **Step 6: Execution test.** Add a node to `tests/agency/type-patterns.agency` + expectation:

```ts
node jsonCheck() {
  const good: any = { a: [1, "x", null] }
  const bad: any = { a: [1, "x"], when: now() }   // use any expression yielding a Date-like/class value; adjust to a real stdlib source of a non-plain object
  let out = ""
  if (good is Json) {
    out = "good-yes"
  }
  if (bad is Json) {
    out = "${out},bad-yes"
  } else {
    out = "${out},bad-no"
  }
  print(out)
}
```

Expected output `"good-yes,bad-no"`. Run: `make && pnpm run agency test tests/agency/type-patterns.agency 2>&1 | tee /tmp/tp-task12-exec.log`.

- [ ] **Step 7:** Add `Json` to the guide section written in Task 11 (the "how do I check for a JSON object" question gets `is Json` / `is JsonObject` as the answer, with `is object` explicitly framed as the coarse fallback). Commit: `git add -A && git commit -m "feat: stdlib Json type with precise round-trip validator"`

### Task 13: Pre-PR audit and PR

- [ ] **Step 1:** Audit the full diff against `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md`: `git diff main...HEAD | tee /tmp/tp-final-diff.log`, then read the two docs and check each rule. Run `pnpm run lint:structure 2>&1 | tee /tmp/tp-lint.log`.
- [ ] **Step 2:** Run the focused test set once more (`pnpm test:run lib/parsers lib/lowering lib/typeChecker lib/runtime/typeTest.test.ts tests/typescriptGenerator 2>&1 | tee /tmp/tp-final.log`). Do NOT run the full agency suite; CI does.
- [ ] **Step 3:** Confirm branch: `git branch --show-current` (must not be main). Write the PR description to a file (no command-line apostrophes) and open the PR with `gh pr create --title "Type patterns: matching on the type of a value" --body-file /tmp/tp-pr-body.md`. The body links the spec and names the deliberate behavior change (bare `is`-binder retirement) prominently for review.

---

## Self-review notes (run against the spec before executing)

- Spec "Spelling 1 / Spelling 2" → Tasks 2, 3. Coexistence rules 1–3 → Tasks 2 (is-RHS), 3 (arm suffix + binder survival), 8 (AG5003).
- Tier 1 table → Tasks 4, 6. Tier 2 via schema + validators → Task 6 (`validateExpr`), pinned at runtime by Task 10 (`validatorRejects`).
- Rule 1 including the transforming-validator hole → structural (Task 5 background) + Task 10 `bindsOriginal`.
- Rule 2 (no declaration-position type patterns) → structural: `TypePattern` is not in `BindingPattern` (Task 1).
- Narrowing positive-only → Task 7. Exhaustiveness non-contribution → Task 8.
- Spec open questions: OQ1 → Task 3 lookahead design; OQ2 → parser emits type position, checker resolves (Tasks 2, 7); OQ3 → `validateExpr` (Task 6); OQ4 → result patterns ordered before `typePatternParser` (Task 2 test); OQ5 → async chain already handled by `validateExpr` emitting `await` (background section).
- Known limitation to state in the PR: narrowing covers bare-variable subjects (member paths only if free); `is (A | B)` via parenthesized types may incidentally parse — both are acceptable v1 per spec scope.
- Plan-review round (2026-07-20, see `2026-07-20-type-patterns-REVIEW.md`): all 8 findings applied — falsifiable narrowing tests (union scrutinees, never `any`), AG1013/AG1006 exclusivity decision + test, caseLhsParser kept as gated `or(...)` alternatives with a 4-case regression suite, the `:426-429` lowering gate named with destructure/meta tests, the TypeTestExpression-vs-call-shape tradeoff documented, the is-binder retirement grep recorded (77 hits, all comments), the `_: Type` → `is Type` formatter normalization documented, `is object` pinned opaque. Plus the test-audit adds: is-precedence parser tests, `[x, y]: number[]` parser+lowering coverage, tier-2 `number[]` runtime node, boolean-synthesis test, AG5003 negatives, coarse-union-still-needs-`_` test, positive-only pinned via `is string` (NOT `is null`, which inherits the literal `== null` both-branch narrowing — spec updated to say so).
- Edge-case round (2026-07-20 follow-up): loose null (Task 4) keeps `null =>` / `is null` / `_: null` agreeing on undefined; JS-native names get a tailored AG1013 and bare type parameters error (Task 7); inline object types in arm position are supported and tested (Tasks 3, 6); AG5003 extends to property-position binders named like types (Task 8); `match(x is T)` guard form and interop-null covered at runtime (Task 10). Validators through built-in generics inherit issue #630 (shape-only for Record until fixed) — noted in the spec and the PR body.
