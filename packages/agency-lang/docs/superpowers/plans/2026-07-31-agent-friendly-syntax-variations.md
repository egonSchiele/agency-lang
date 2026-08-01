# Agent-Friendly Syntax Variations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Tasks 6, 7 and 9 were not shipped.** Ranges were dropped before merge (see
> the note at the top of the spec). Task 5's number-grammar fix was kept as an
> independent bug fix. Everything else shipped as written.

**Goal:** Let the Agency parser accept four syntax variations that models naturally write — `function` for `def`, `->` for the return-type `:`, either arrow in match arms and inline blocks, and `3..6` ranges — with `agency fmt` normalizing each back to canonical form.

**Architecture:** Every production change is confined to `lib/parsers/parsers.ts`. Each variation produces an AST identical to the canonical spelling, so `AgencyGenerator` needs no changes and normalization falls out for free. Ranges are the one construct doing more than a token swap: `..` becomes an infix operator whose `apply` hook builds an ordinary `range(a, b)` call at parse time, so no new AST node type, no new typing rules, no new codegen.

**Tech Stack:** TypeScript, the [tarsec](https://egonschiele.github.io/tarsec/) parser combinator library, vitest.

## Global Constraints

Every task's requirements implicitly include this section. The API facts below were verified against the source; getting any of them wrong costs a confusing debugging session.

**`parseAgency` returns a result. It does not throw.**

```ts
import { parseAgency } from "@/parser.js";   // lib/parser.ts:273 — NOT ./parsers.js
```

Its signature is `parseAgency(input, config = {}, applyTemplate = true, lower = true)` and it returns:

```ts
type ParseAgencyResult =
  | { success: true; result: AgencyProgram; rest: string }
  | { success: false; message?: string; rest: string; errorData?: ParseAgencyErrorData };
```

Verified on three inputs: a nested `def` returns `success: false`, a nested `function` returns `success: true`, and outright garbage (`const = = =`) also *returns* rather than throwing. So:

- **Never write `expect(() => parseAgency(src)).toThrow(...)`.** It can never pass.
- **Never write `expect(() => parseAgency(src)).not.toThrow()`.** It passes for any input, including garbage, so it asserts nothing.
- Always assert on the returned object.

**Always pass `applyTemplate: false`.** `parseAgency(src, {}, false)`. The default renders the entire standard-library prelude into the source before parsing, which is pure noise for these tests. `lib/parsers/function.test.ts:11` already imports and calls it this way.

**Use the global `toEqualWithoutLoc` matcher, not a hand-written helper.** `lib/parsers/vitest.setup.ts:47` registers it for every test file with no import needed, and 24 files already use it. Its `normalize` strips three things — `loc`, `delimiter`, and `newLine` nodes — where a hand-rolled `loc`-only stripper would leave stray newline nodes that make a correct implementation fail.

**Use `formatSource` for every normalization assertion.**

```ts
import { formatSource } from "@/formatter.js";   // lib/formatter.ts:9
```

It takes a source string and returns `string | null`. Do **not** use `new AgencyGenerator().generate(...)`: `generate` takes an `AgencyProgram` (not a parse result) and returns `{ output: string }` (not a string), and going through `parseAgency` with default arguments would format the whole prelude.

**A shared test helper.** Several tasks need "parse this and give me the program". Define this at the top of each test file that needs it:

```ts
function program(src: string) {
  const parsed = parseAgency(src, {}, false);
  if (!parsed.success) throw new Error(`expected a successful parse, got: ${parsed.message}`);
  return parsed.result;
}
```

This is a test-local convenience for readability, not a substitute for asserting on `success` — failure cases must still assert `parsed.success === false` and check `parsed.message` directly.

**Other constraints:**

- **All parser edits land in `lib/parsers/parsers.ts`.** If you find yourself editing the typechecker, a generator, or a preprocessor, stop — something has gone wrong.
- **`AgencyGenerator` must not change.** If a normalization test fails, the bug is that the parser recorded the spelling in the AST. Fix the parser.
- **Run tests with `pnpm test:run <path>`,** never bare `pnpm test` (watch mode). Save output: `pnpm test:run <path> 2>&1 | tee /tmp/out.txt`. Do not run the full suite; CI does that.
- **Never commit on `main`;** never amend or force-push.
- **Commit message bodies go in a file** passed to `git commit -F` — apostrophes break the shell.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `lib/parsers/parsers.ts` | Every production change | 1–7 |
| `lib/parsers/function.test.ts` | `function` keyword, `->` return type | 1, 2, 3 |
| `lib/parsers/matchBlock.test.ts` | `->` in match arms | 4 |
| `lib/parsers/blockArgument.test.ts` | `=>` in inline blocks | 4 |
| `lib/parsers/literals.test.ts` | Number-literal grammar | 5 |
| `lib/parsers/range.test.ts` (new) | Range operator, bracket error, precedence | 6, 7 |
| `lib/runtime/template/fill.test.ts` | `RESERVED_WORDS` coverage | 2 |
| `lib/formatter.test.ts` | Idempotence across all four | 8 |
| `tests/agency/range.agency` + `.test.json` (new) | Execution test for ranges | 9 |
| `docs/site/guide/*.md`, `CHANGELOG.md` | Documentation | 10, 11 |

**One ordering constraint: Task 5 must land before Task 6.** The range operator cannot see its `..` while the number parser still swallows both dots. Everything else is independent.

---

### Task 1: `bodyDeclarationParser` learns `function`

A live bug fix that ships independently. Because `function` is currently a legal identifier, a declaration written inside a body parses as a name followed by a call with a trailing block, compiles to plausible-looking TypeScript, and dies at run time with a `ReferenceError`. Verified: the `function` form returns `success: true` today, while the identical code with `def` returns `success: false` with "…only legal at the top level of a file."

**Files:**
- Modify: `lib/parsers/parsers.ts:4584`, and `BODY_DECLARATION_MESSAGE` near `:4615`
- Test: `lib/parsers/function.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `bodyDeclarationParser` stays `Parser<never>`.

- [ ] **Step 1: Write the failing test**

Add to `lib/parsers/function.test.ts`. `parseAgency` is already imported there at `:11`.

```ts
describe("nested declaration probe", () => {
  const nested = (kw: string) => `node main() {
  ${kw} inner() { print(1) }
  print("x")
}`;

  it("rejects a nested `function` declaration", () => {
    const parsed = parseAgency(nested("function"), {}, false);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toMatch(/only legal at the top level/);
  });

  it("still rejects a nested `def` declaration", () => {
    const parsed = parseAgency(nested("def"), {}, false);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toMatch(/only legal at the top level/);
  });

  it("names every keyword it catches in the message", () => {
    const parsed = parseAgency(nested("function"), {}, false);
    if (parsed.success) throw new Error("expected a failed parse");
    expect(parsed.message).toMatch(/function/);
  });

  it("still accepts a top-level declaration", () => {
    expect(parseAgency(`def inner() { print(1) }`, {}, false).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/t1.txt
```

Expected: the `function` case FAILS (it returns `success: true` today), the message test FAILS, the `def` case and the top-level case PASS.

- [ ] **Step 3: Teach the probe the new keyword**

At `lib/parsers/parsers.ts:4584`, inside `bodyDeclarationParser`, change:

```ts
    or(str("node"), str("def")),
```

to:

```ts
    or(str("node"), str("def"), str("function")),
```

- [ ] **Step 4: Update the message**

`BODY_DECLARATION_MESSAGE` (near `:4615`) currently says `node` and `def` declarations are only legal at the top level. An author who wrote `function` would be told about `def`, which is the opposite of the feedback quality this whole change exists to improve. Add the third keyword:

```ts
const BODY_DECLARATION_MESSAGE =
  "`node`, `def` and `function` declarations are only legal at the top level of a file.";
```

Match the exact surrounding wording rather than copying this string verbatim — read the current constant first and change only the keyword list.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/t1.txt
```

Expected: all four PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/function.test.ts
git commit -m "fix: a nested function declaration is rejected like a nested def"
```

---

### Task 2: `function` as a second spelling of `def`

**Files:**
- Modify: `lib/parsers/parsers.ts:5730` (keyword capture), `:215` (`RESERVED_WORDS`)
- Test: `lib/parsers/function.test.ts`, `lib/runtime/template/fill.test.ts`

**Interfaces:**
- Consumes: Task 1's probe change.
- Produces: nothing. The keyword is discarded at `:5848`, so `FunctionDefinition` is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `lib/parsers/function.test.ts`, and add the `program` helper from Global Constraints at the top of the file if it is not already there:

```ts
describe("function keyword", () => {
  it("parses `function` to the same AST as `def`", () => {
    expect(program(`function add(a: number, b: number): number { return a + b }`))
      .toEqualWithoutLoc(program(`def add(a: number, b: number): number { return a + b }`));
  });

  it("accepts modifiers before `function`", () => {
    expect(program(`export destructive function f() { print(1) }`))
      .toEqualWithoutLoc(program(`export destructive def f() { print(1) }`));
  });

  it("normalizes `function` to `def` when formatted", () => {
    const formatted = formatSource(`function add(a: number, b: number): number { return a + b }`);
    expect(formatted).toContain("def add(");
    expect(formatted).not.toContain("function add(");
  });

  // RESERVED_WORDS governs identifier-hole filling only, not general
  // identifier parsing, so `function` stays usable as a variable name.
  // Pinned so the changelog claim matches reality.
  it("leaves `function` usable as an identifier", () => {
    expect(parseAgency(`node main() { const function = 5\nprint(function) }`, {}, false).success)
      .toBe(true);
  });
});
```

Add `import { formatSource } from "@/formatter.js";` to the file's imports.

- [ ] **Step 2: Write the `RESERVED_WORDS` test**

`RESERVED_WORDS`' only consumer is `fill()` at `lib/runtime/template/fill.ts:375`. Without this test, Step 4 could be deleted entirely and every other test would still pass.

Read `lib/runtime/template/fill.test.ts` first to match how it builds a template and calls `fill`, then add a case asserting that filling an identifier hole with `"function"` is rejected the same way an existing keyword like `"if"` is. Mirror the existing keyword-rejection test in that file exactly, changing only the keyword.

- [ ] **Step 3: Run both to verify they fail**

```bash
pnpm test:run lib/parsers/function.test.ts lib/runtime/template/fill.test.ts 2>&1 | tee /tmp/t2.txt
```

Expected: FAIL — `function add(...)` does not parse as a function definition, and `"function"` is not yet rejected by `fill`.

- [ ] **Step 4: Accept the keyword**

At `lib/parsers/parsers.ts:5730`, inside `_baseFunctionParser`, change:

```ts
    capture(str("def"), "keyword"),
```

to:

```ts
    capture(oneOfStr(["def", "function"]), "keyword"),
```

`oneOfStr` is defined in this file at `:284`.

- [ ] **Step 5: Reserve the keyword for hole filling**

At `lib/parsers/parsers.ts:215`, add `"function"` to `RESERVED_WORDS`, next to `"def"`:

```ts
  "def", "function", "node", "return", "goto", "raise", "interrupt", "import", "export",
```

This list feeds identifier-hole filling in Template Agency only. It does not govern general identifier parsing, which is why the test in Step 1 asserts `const function = 5` still parses.

- [ ] **Step 6: Run both to verify they pass**

```bash
pnpm test:run lib/parsers/function.test.ts lib/runtime/template/fill.test.ts 2>&1 | tee /tmp/t2.txt
```

Expected: PASS, including Task 1's cases.

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/function.test.ts lib/runtime/template/fill.test.ts
git commit -m "feat(parser): accept function as a second spelling of def"
```

---

### Task 3: `->` as a return-type separator

The interesting case is not what follows a return type but what it can contain. A return type can itself be a function type, and function types already use `->`, so `def f() -> (string) -> string` puts two arrows in one signature.

**Files:**
- Modify: `lib/parsers/parsers.ts:5703`
- Test: `lib/parsers/function.test.ts`

**Interfaces:**
- Consumes: the `program` helper and `formatSource` import from Task 2.
- Produces: nothing. `functionReturnTypeParser` keeps its `Parser<VariableType>` type.

- [ ] **Step 1: Write the failing test**

```ts
describe("arrow return type", () => {
  const pairs: [string, string][] = [
    [`def f() -> string { return "x" }`, `def f(): string { return "x" }`],
    [`node main() -> string { return "x" }`, `node main(): string { return "x" }`],
    [`def f() -> string! { return "x" }`, `def f(): string! { return "x" }`],
    [`def f() -> string raises <*> { return "x" }`, `def f(): string raises <*> { return "x" }`],
    [`def f() -> (string) -> string { return g }`, `def f(): (string) -> string { return g }`],
    [
      `def f() -> (string) -> string raises <*> { return g }`,
      `def f(): (string) -> string raises <*> { return g }`,
    ],
    [
      `node main() -> (string) -> string { return g }`,
      `node main(): (string) -> string { return g }`,
    ],
  ];

  for (const [arrow, colon] of pairs) {
    it(`parses ${arrow} identically to its colon form`, () => {
      expect(program(arrow)).toEqualWithoutLoc(program(colon));
    });
  }

  it("normalizes the separator without touching the arrow inside the type", () => {
    expect(formatSource(`def f() -> (string) -> string { return g }`))
      .toContain("def f(): (string) -> string");
  });
});
```

The last assertion is the one that pins doubled-arrow behavior: the separator normalizes to `:` while the arrow *inside the type* stays an arrow.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/t3.txt
```

Expected: FAIL on every arrow case.

- [ ] **Step 3: Accept the arrow**

At `lib/parsers/parsers.ts:5703`, inside `functionReturnTypeParser`, change:

```ts
    char(":"),
```

to:

```ts
    or(char(":"), str("->")),
```

One edit covers both `def` and `node`: `functionParser` (`:5757`) and `graphNodeParser` (`:5918`) both delegate here.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/t3.txt
```

Expected: PASS. If the doubled-arrow cases fail, the separator parser is consuming greedily into the type — report it rather than working around it, because it means the disambiguation assumption in the spec was wrong.

- [ ] **Step 5: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/function.test.ts
git commit -m "feat(parser): accept -> as a return type separator"
```

---

### Task 4: `=>` and `->` interchangeable

Block *types* at `lib/parsers/parsers.ts:1765` already accept both arrows. This makes match arms and inline blocks agree with them.

**Files:**
- Modify: `lib/parsers/parsers.ts:3968` (match arms), `:3795` (inline blocks)
- Test: `lib/parsers/matchBlock.test.ts`, `lib/parsers/blockArgument.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Add the `program` helper and the `parseAgency` / `formatSource` imports to each test file.
- Produces: nothing.

- [ ] **Step 1: Write the failing match-arm test**

Add to `lib/parsers/matchBlock.test.ts`:

```ts
describe("arm arrow", () => {
  it("accepts -> in a match arm", () => {
    expect(program(`node main() { match (1) { 1 -> print("one") _ -> print("no") } }`))
      .toEqualWithoutLoc(program(`node main() { match (1) { 1 => print("one") _ => print("no") } }`));
  });

  it("normalizes -> to => when formatted", () => {
    const formatted = formatSource(`node main() { match (1) { 1 -> print("one") _ -> print("no") } }`);
    expect(formatted).toContain("=>");
    expect(formatted).not.toMatch(/\d\s*->/);
  });

  // The risk here is MISparsing, not failing to parse: `>-` sitting next to
  // the arrow. A success check cannot see that, so compare the trees.
  it("does not confuse a guard ending in a negative comparison with the arrow", () => {
    expect(program(`node main() { match (1) { _ if (a >-3) -> print("yes") } }`))
      .toEqualWithoutLoc(program(`node main() { match (1) { _ if (a >-3) => print("yes") } }`));
  });

  // Where the two edits in this task meet.
  it("accepts an inline block as an arm body with either arrow", () => {
    expect(program(`node main() { match (1) { 1 -> map(xs, \\n => n * 2) _ -> [] } }`))
      .toEqualWithoutLoc(program(`node main() { match (1) { 1 => map(xs, \\n -> n * 2) _ => [] } }`));
  });
});
```

- [ ] **Step 2: Write the failing inline-block test**

Add to `lib/parsers/blockArgument.test.ts`:

```ts
describe("inline block arrow", () => {
  it("accepts => in an inline block", () => {
    expect(program(`node main() { const ys = map(xs, \\n => n * 2) }`))
      .toEqualWithoutLoc(program(`node main() { const ys = map(xs, \\n -> n * 2) }`));
  });

  it("accepts => with multiple parenthesized params", () => {
    expect(program(`node main() { const ys = mapWithIndex(xs, \\(n, i) => n * i) }`))
      .toEqualWithoutLoc(program(`node main() { const ys = mapWithIndex(xs, \\(n, i) -> n * i) }`));
  });

  it("normalizes => to -> when formatted", () => {
    const formatted = formatSource(`node main() { const ys = map(xs, \\n => n * 2) }`);
    expect(formatted).toContain("->");
    expect(formatted).not.toContain("=>");
  });
});
```

The doubled backslash is deliberate: `\\n` in a TypeScript template literal produces the single `\` the inline-block syntax needs.

- [ ] **Step 3: Run both to verify they fail**

```bash
pnpm test:run lib/parsers/matchBlock.test.ts lib/parsers/blockArgument.test.ts 2>&1 | tee /tmp/t4.txt
```

Expected: FAIL on the arrow-swap cases in both files.

- [ ] **Step 4: Accept both arrows in match arms**

At `lib/parsers/parsers.ts:3968`, change `str("=>"),` to:

```ts
    or(str("=>"), str("->")),
```

- [ ] **Step 5: Accept both arrows in inline blocks**

At `lib/parsers/parsers.ts:3795`, change `str("->"),` to:

```ts
      or(str("->"), str("=>")),
```

- [ ] **Step 6: Run both to verify they pass**

```bash
pnpm test:run lib/parsers/matchBlock.test.ts lib/parsers/blockArgument.test.ts 2>&1 | tee /tmp/t4.txt
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/matchBlock.test.ts lib/parsers/blockArgument.test.ts
git commit -m "feat(parser): accept either arrow in match arms and inline blocks"
```

---

### Task 5: A real number-literal grammar

**This task must land before Task 6.** Today `numberParser` swallows any number of dots, so `3..6` becomes one malformed number node with the text `"3..6"` — no parse error, no typecheck error. The range operator cannot see its `..` until this is fixed.

The current grammar is `many1WithJoin(or(char("-"), char("."), char("_"), digit))` — "any run of dashes, dots, underscores and digits" — a description that was never true of numbers, propped up by a post-check that rejects runs with no digit. The fix is to **state the actual grammar**, so the parser stops in the right place by construction. Do not add a scanning loop that truncates an over-match: that keeps the wrong grammar and bolts imperative repair on top, and it forces manual `rest` arithmetic that has to stay in sync with the captured text.

**Files:**
- Modify: `lib/parsers/parsers.ts:597-612`
- Test: `lib/parsers/literals.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `numberParser` keeps its `Parser<NumberLiteral>` type and `{ type: "number", value: string }` result shape. Task 6 relies on it leaving `..6` in `rest` when given `3..6`.

- [ ] **Step 1: Write the failing test**

Add to `lib/parsers/literals.test.ts`. Import `numberParser` from `"./parsers.js"` if it is not already imported (this one *is* in `parsers.ts`, unlike `parseAgency`).

```ts
describe("number literal grammar", () => {
  it("stops before a `..` so the rest is left for the range operator", () => {
    const r = numberParser("3..6");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.value).toBe("3");
    expect(r.rest).toBe("..6");
  });

  it("stops at the second dot rather than building 1.2.3", () => {
    const r = numberParser("1.2.3");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.value).toBe("1.2");
    expect(r.rest).toBe(".3");
  });

  it("parses a decimal", () => {
    const r = numberParser("3.5");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.value).toBe("3.5");
    expect(r.rest).toBe("");
  });

  it("parses a negative number", () => {
    const r = numberParser("-3");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.value).toBe("-3");
  });

  it("strips underscores and leaves the rest intact", () => {
    const r = numberParser("1_000 + 2");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.value).toBe("1000");
    expect(r.rest).toBe(" + 2");
  });

  it("rejects a run with no digits", () => {
    expect(numberParser("..").success).toBe(false);
    expect(numberParser(".").success).toBe(false);
  });

  it("leaves unit literals working", () => {
    expect(parseAgency(`node main() { const t = 1.5s\nconst c = $0.50 }`, {}, false).success)
      .toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:run lib/parsers/literals.test.ts 2>&1 | tee /tmp/t5.txt
```

Expected: FAIL — `numberParser("3..6")` currently returns value `"3..6"` with empty `rest`.

- [ ] **Step 3: Replace the grammar**

Replace `numberParser` at `lib/parsers/parsers.ts:597-612` with:

```ts
/** Digits with optional `_` separators, e.g. `1_000`. */
const digitRun = many1WithJoin(or(digit, char("_")));

export const numberParser: Parser<NumberLiteral> = label("a number", map(
  seqC(
    set("type", "number"),
    capture(
      mapJoin(
        // An optional sign, an integer part, and at most one fractional part
        // whose dot MUST be followed by a digit. That last requirement is what
        // makes `3..6` stop after `3`, leaving `..6` for the range operator,
        // and what makes `1.2.3` stop after `1.2`.
        seqC(
          optional(char("-")),
          digitRun,
          optional(mapJoin(seqC(char("."), digitRun))),
        ),
      ),
      "value",
    ),
  ),
  (r: any) => ({ ...r, value: String(r.value).replace(/_/g, "") }),
));
```

`mapJoin` concatenates a `seqC`'s captured pieces into one string. If tarsec exposes it under a different name in this codebase, find the helper the file already uses for the same job — `many1WithJoin` at the original `:600` is the sibling — and use that. The shape to preserve is: build the text declaratively, then strip underscores once at the end.

Note what this removes. The old "at least one digit" post-check is gone because `digitRun` requires one by construction. There is no manual `rest` arithmetic, because the combinator tracks it. And the leading `-` is now explicitly a *sign* rather than a character that could appear anywhere in the run.

That last point is a small deliberate behavior change: the old grammar accepted `1-2` as a single "number". Nothing should depend on that, but if a test elsewhere breaks on it, report the finding rather than restoring the old permissiveness.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/literals.test.ts 2>&1 | tee /tmp/t5.txt
```

Expected: PASS.

- [ ] **Step 5: Run the neighbouring suites for regressions**

`numberParser` feeds unit literals and binary expressions, and `unitLiteralParser` sits directly in front of it.

```bash
pnpm test:run lib/parsers/unitLiteral.test.ts lib/parsers/binop.test.ts lib/parsers/dataStructures.test.ts lib/parsers/literals.test.ts 2>&1 | tee /tmp/t5b.txt
```

Expected: PASS. A unit-literal failure on something like `1.5s` means the fractional part is not being accepted — check that the dot branch is `optional`, not required.

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/literals.test.ts
git commit -m "fix(parser): state the real number grammar instead of a greedy dot run"
```

---

### Task 6: The `..` range operator

`..` becomes an infix operator whose `apply` hook builds a `range(a, b)` call directly. No new AST node type, so nothing downstream — typechecker, generator, runtime — needs to know ranges exist.

Precedence sits between additive and relational, so `a + 1 .. b - 1` groups as `range(a + 1, b - 1)` and `x .. y == z` groups as `range(x, y) == z`.

**Files:**
- Modify: `lib/parsers/parsers.ts` near `:3364` (the builder) and `:3437` (the operator table)
- Create: `lib/parsers/range.test.ts`

**Interfaces:**
- Consumes: `numberParser` from Task 5, leaving `..6` in `rest` when given `3..6`.
- Produces: `makeRangeCall(left, right)` returning a `FunctionCall` with `functionName: "range"` and two positional arguments. Task 7 reads the `__fromRangeOp` marker it sets; Task 9 relies on it executing.

- [ ] **Step 1: Write the failing test**

Create `lib/parsers/range.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "@/parser.js";
import { formatSource } from "@/formatter.js";

function program(src: string) {
  const parsed = parseAgency(src, {}, false);
  if (!parsed.success) throw new Error(`expected a successful parse, got: ${parsed.message}`);
  return parsed.result;
}

describe("range operator", () => {
  const pairs: [string, string][] = [
    [`node main() { const r = 3..6 }`, `node main() { const r = range(3, 6) }`],
    [`node main() { for (i in 3..6) { print(i) } }`, `node main() { for (i in range(3, 6)) { print(i) } }`],
    [`node main() { f(3..6) }`, `node main() { f(range(3, 6)) }`],
    [`node main() { const r = a..b }`, `node main() { const r = range(a, b) }`],
    [`node main() { const r = -3..6 }`, `node main() { const r = range(-3, 6) }`],
    [`node main() { const r = 5..5 }`, `node main() { const r = range(5, 5) }`],
    [`node main() { const r = 6..3 }`, `node main() { const r = range(6, 3) }`],
  ];

  for (const [range, call] of pairs) {
    it(`parses ${range.trim()} identically to its range() form`, () => {
      expect(program(range)).toEqualWithoutLoc(program(call));
    });
  }

  it("binds looser than additive", () => {
    expect(program(`node main() { const r = a + 1..b - 1 }`))
      .toEqualWithoutLoc(program(`node main() { const r = range(a + 1, b - 1) }`));
  });

  it("binds tighter than relational", () => {
    expect(program(`node main() { const r = x..y == z }`))
      .toEqualWithoutLoc(program(`node main() { const r = range(x, y) == z }`));
  });

  it("normalizes to a range() call when formatted", () => {
    const formatted = formatSource(`node main() { const r = 3..6 }`);
    expect(formatted).toContain("range(3, 6)");
    expect(formatted).not.toContain("..");
  });

  it("carries a source location", () => {
    const parsed = parseAgency(`node main() { const r = 3..6 }`, {}, false);
    if (!parsed.success) throw new Error("expected a successful parse");
    const found = JSON.stringify(parsed.result).includes(`"functionName":"range"`);
    expect(found).toBe(true);
    // A range with no loc leaves diagnostics nothing to point at.
    expect(JSON.stringify(parsed.result)).toMatch(/"functionName":"range"[^}]*|"loc"/);
  });
});

describe("dot runs stay distinct", () => {
  it("spread still parses as a spread", () => {
    expect(program(`node main() { const a = [1, 2]\nconst b = [...a, 3] }`))
      .toEqualWithoutLoc(program(`node main() { const a = [1, 2]\nconst b = [...a, 3] }`));
    expect(JSON.stringify(program(`node main() { const b = [...a, 3] }`))).toContain("splat");
  });

  it("variadic parameters still parse", () => {
    const parsed = parseAgency(`def f(...xs: number[]) { print(xs) }\nnode main() { f(1, 2) }`, {}, false);
    expect(parsed.success).toBe(true);
    expect(JSON.stringify(parsed)).toContain("variadic");
  });

  it("member access still parses", () => {
    expect(JSON.stringify(program(`node main() { const o = { a: 1 }\nprint(o.a) }`)))
      .toContain("valueAccess");
  });
});
```

If a field name in one of the `toContain` assertions does not match the real AST (`splat`, `variadic`, `valueAccess`), run `pnpm run ast` on the snippet and use the actual key. The point of each is to prove the construct parsed *as itself*, not merely that parsing succeeded.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:run lib/parsers/range.test.ts 2>&1 | tee /tmp/t6.txt
```

Expected: FAIL on every range case; the dot-run block should already PASS.

- [ ] **Step 3: Add the range builder**

Next to `makeBinOp` at `lib/parsers/parsers.ts:3364`, add:

```ts
/** Marks a `range()` call as having come from `..` rather than being written
 *  by hand. Non-enumerable so it stays out of JSON, `Object.entries`, and
 *  structural equality — the AST a test sees is identical to a hand-written
 *  `range(3, 6)`, which is the design rule. `bracketedRangeParser` reads it to
 *  tell `[3..6]` (an error) from `[range(3, 6)]` (legal). */
const RANGE_OP_MARKER = "__fromRangeOp";

export function isRangeOperatorCall(node: unknown): boolean {
  return typeof node === "object" && node !== null && RANGE_OP_MARKER in node;
}

/** `a..b` is not a binary operator in the AST — it builds the same
 *  `range(a, b)` call someone would write by hand. Same approach as
 *  comprehensionDesugar: emit a shape the rest of the compiler already
 *  understands, so typing, codegen, and the runtime are inherited rather than
 *  reimplemented. `agency fmt` therefore prints `range(a, b)`. */
function makeRangeCall(left: Expression, right: Expression): Expression {
  const node: FunctionCall = {
    type: "functionCall",
    functionName: "range",
    arguments: [left, right],
  };
  if (left.loc && right.loc) {
    node.loc = { ...left.loc, end: right.loc.end };
  }
  Object.defineProperty(node, RANGE_OP_MARKER, { value: true, enumerable: false });
  return node;
}
```

Import `FunctionCall` from `../types/function.js` if it is not already imported. Its three required fields are exactly the ones set here (`lib/types/function.ts:80`), so no `as` cast is needed — let the compiler check the shape rather than silencing it.

- [ ] **Step 4: Add the precedence level**

In the operator table at `lib/parsers/parsers.ts:3437`, insert a new level **between** the additive level (precedence 5) and the relational level (precedence 4):

```ts
    // Precedence 4.5: ranges. Looser than additive so `a + 1..b - 1` reads as
    // range(a + 1, b - 1); tighter than relational so `x..y == z` compares the
    // range. Builds a `range()` call, not a binOp node — see makeRangeCall.
    [
      { op: wsOp(".."), assoc: "left" as const, apply: makeRangeCall },
    ],
```

Do **not** add `".."` to the `Operator` union or the `PRECEDENCE` map in `lib/types/binop.ts`. No `binOpExpression` with operator `..` is ever created, so the generator never has to parenthesize one.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/range.test.ts 2>&1 | tee /tmp/t6.txt
```

Expected: PASS.

- [ ] **Step 6: Run the expression suites for regressions**

```bash
pnpm test:run lib/parsers/binop.test.ts lib/parsers/expression.test.ts lib/parsers/access.test.ts 2>&1 | tee /tmp/t6b.txt
```

Expected: PASS. Member access and spread are the two things most likely to be disturbed by a new dot operator.

- [ ] **Step 7: Check the prelude assumption**

`range` reaches user files through the standard-library prelude, and the lowering assumes it is in scope. Two ways that could fail: a file defining its own `range`, and a file the prelude is not injected into — including `stdlib/index.agency`, where `range` itself is defined and a range expression would be circular.

```bash
grep -rn '[^.]\.\.[^.]' stdlib/*.agency | tee /tmp/t6c.txt
```

Expected: no `..` ranges anywhere in the standard library, so the circularity is latent rather than live. If any turn up, rewrite them as explicit `range()` calls in this commit. Record the result either way — Task 10's docs step tells users about the shadowing case, and this step confirms the standard library is not already relying on something that cannot work.

- [ ] **Step 8: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/range.test.ts
git commit -m "feat(parser): .. is an infix range operator lowering to range(a, b)"
```

---

### Task 7: The bracketed-range error

Under an infix reading, `[3..6]` is an array *containing* a range — one element, not three. A `for` loop over it runs once and binds the whole array, with no error. Because the bracketed form is what models reach for out of Haskell and CoffeeScript habit, this is the one shape where permissiveness produces a silently wrong answer, so it gets a targeted parse error.

The detection must be **structural**, reading the marker `makeRangeCall` set. Do not match `..` against the consumed source text: that cannot tell code from data, so `["a..b"]` — an array holding one string that happens to contain two dots — would be rejected as an error. It also re-derives by pattern-matching what the parse already determined, which is the "no parallel mechanism" rule the anti-pattern catalog names.

**Files:**
- Modify: `lib/parsers/parsers.ts` near `bodyDeclarationParser`, registered at `:3316`
- Test: `lib/parsers/range.test.ts`

**Interfaces:**
- Consumes: `isRangeOperatorCall` from Task 6.
- Produces: nothing. The probe is `Parser<never>`, matching `bodyDeclarationParser`.

- [ ] **Step 1: Write the failing test**

Add to `lib/parsers/range.test.ts`:

```ts
describe("bracketed range", () => {
  it("rejects a lone range inside brackets", () => {
    const parsed = parseAgency(`node main() { const r = [3..6] }`, {}, false);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toMatch(/builds an array containing a range/);
  });

  it("names both fixes in the message", () => {
    const parsed = parseAgency(`node main() { const r = [3..6] }`, {}, false);
    if (parsed.success) throw new Error("expected a failed parse");
    expect(parsed.message).toContain("3..6");
    expect(parsed.message).toContain("[(3..6)]");
  });

  it("accepts a parenthesized range as an array element", () => {
    expect(program(`node main() { const r = [(3..6)] }`))
      .toEqualWithoutLoc(program(`node main() { const r = [range(3, 6)] }`));
  });

  it("accepts a hand-written range() call as a lone element", () => {
    expect(parseAgency(`node main() { const r = [range(3, 6)] }`, {}, false).success).toBe(true);
  });

  // The case a text-matching implementation gets wrong: the dots are DATA.
  it("accepts a lone string containing two dots", () => {
    expect(program(`node main() { const r = ["a..b"] }`))
      .toEqualWithoutLoc(program(`node main() { const r = ["a..b"] }`));
    expect(parseAgency(`node main() { const r = ["a..b"] }`, {}, false).success).toBe(true);
    expect(parseAgency(`node main() { const r = [f("a..b")] }`, {}, false).success).toBe(true);
  });

  it("accepts two ranges in one array", () => {
    expect(program(`node main() { const r = [3..6, 8..9] }`))
      .toEqualWithoutLoc(program(`node main() { const r = [range(3, 6), range(8, 9)] }`));
  });

  it("accepts a range alongside another element", () => {
    expect(program(`node main() { const r = [1, 3..6] }`))
      .toEqualWithoutLoc(program(`node main() { const r = [1, range(3, 6)] }`));
  });

  it("leaves comprehensions alone", () => {
    expect(parseAgency(`node main() { const xs = [1, 2]\nconst r = [x * 2 for x in xs] }`, {}, false).success)
      .toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:run lib/parsers/range.test.ts 2>&1 | tee /tmp/t7.txt
```

Expected: the first two cases FAIL — `[3..6]` currently parses as a one-element array. The rest should already PASS from Task 6.

- [ ] **Step 3: Add the probe**

Add near `bodyDeclarationParser` in `lib/parsers/parsers.ts`, following that parser's structure:

```ts
const BRACKETED_RANGE_MESSAGE =
  "`[3..6]` builds an array containing a range, not a range. " +
  "Write `3..6` for the range itself, or `[(3..6)]` if you really want " +
  "an array containing a range.";

/**
 * `[3..6]` is the range spelling in Haskell, CoffeeScript, and bash, so models
 * write it constantly. Under Agency's infix reading it means "an array holding
 * one range", which loops exactly once and binds the whole array — a silently
 * wrong answer rather than an error. Commit to a targeted message instead.
 *
 * The check is structural, reading the marker `makeRangeCall` sets. Matching
 * `..` against the source text would reject `["a..b"]`, where the dots are data.
 *
 * Only the bare form is caught: `[(3..6)]` and `[range(3, 6)]` parse normally,
 * which is why the message points at the former.
 *
 * Throws rather than returning `failure(...)` for the same reason
 * `bodyDeclarationParser` does — a plain failure would be shadowed by a sibling
 * alternative in the enclosing `or(...)`.
 */
const bracketedRangeParser: Parser<never> = (input: string) => {
  const probe = seqC(
    char("["),
    optionalSpacesOrNewline,
    capture(lazy(() => exprParser), "element"),
    optionalSpacesOrNewline,
    char("]"),
  );
  const probed = probe(input);
  if (!probed.success) return failure("", input);
  if (!isRangeOperatorCall((probed.result as { element: unknown }).element)) {
    return failure("", input);
  }
  return committedFailure(BRACKETED_RANGE_MESSAGE, probed.rest);
};
```

Requiring the closing `]` is what keeps `[3..6, 8..9]` and `[1, 3..6]` legal: in both, the probe reaches a `,` where it expects `]` and declines.

- [ ] **Step 4: Register it in the expression atom list**

Add to the atom alternatives at `lib/parsers/parsers.ts:3316`, immediately **before** `lazy(() => agencyArrayParser)`:

```ts
  lazy(() => bracketedRangeParser),
  lazy(() => agencyArrayParser),
```

This is the expression path. Do not use `:2274` — that occurrence of `agencyArrayParser` is inside `staticTagArgParser` (declared at `:2270`), which handles arguments to validation tags like `@validate(...)` only. Registering there would leave `const r = [3..6]` in ordinary code parsing silently as a one-element array, exactly the outcome this task exists to prevent.

Read the ordering comments at `:3297-3315` before inserting. Several parsers **must** precede `agencyArrayParser` because it would otherwise consume the opening `[`, and `comprehensionParser` is one of them. Placing the probe directly before `agencyArrayParser` preserves all of those constraints.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/range.test.ts 2>&1 | tee /tmp/t7.txt
```

Expected: PASS on all cases. If `["a..b"]` fails, the check is reading source text rather than the marker.

- [ ] **Step 6: Run the data-structure suites for regressions**

```bash
pnpm test:run lib/parsers/dataStructures.test.ts lib/parsers/comprehension.test.ts lib/parsers/literalDelimiter.test.ts lib/parsers/codeLiteral.test.ts 2>&1 | tee /tmp/t7b.txt
```

Expected: PASS. Comprehensions and code literals share the `[` opener and are the most likely things to be disturbed.

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/range.test.ts
git commit -m "feat(parser): a lone range in brackets is a targeted error"
```

---

### Task 8: Formatter idempotence

The spec asks for this explicitly and no other task covers it. Task 11's fixture check is a different thing — it verifies canonical source is unchanged, not that a *normalized* file is a fixed point.

**Files:**
- Modify: `lib/formatter.test.ts`

**Interfaces:**
- Consumes: all four variations.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Add to `lib/formatter.test.ts`. `formatSource` is already imported there at `:2`.

```ts
describe("syntax variations are a fixed point after one format", () => {
  const variations: [string, string][] = [
    ["function keyword", `function add(a: number, b: number): number { return a + b }`],
    ["arrow return type", `def f() -> string { return "x" }`],
    ["thin arrow in a match arm", `node main() { match (1) { 1 -> print("one") _ -> print("no") } }`],
    ["fat arrow in an inline block", `node main() { const ys = map(xs, \\n => n * 2) }`],
    ["range", `node main() { for (i in 3..6) { print(i) } }`],
  ];

  for (const [name, src] of variations) {
    it(`formatting ${name} twice matches formatting it once`, () => {
      const once = formatSource(src);
      expect(once).not.toBeNull();
      expect(formatSource(once as string)).toBe(once);
    });
  }
});
```

- [ ] **Step 2: Run it**

```bash
pnpm test:run lib/formatter.test.ts 2>&1 | tee /tmp/t8.txt
```

Expected: PASS. A failure means the generator emits something the parser reads back differently — report it rather than adjusting the test, because it would mean normalization is not actually converging.

- [ ] **Step 3: Commit**

```bash
git add lib/formatter.test.ts
git commit -m "test: formatting a normalized variation is a fixed point"
```

---

### Task 9: Execution test for ranges

The three token swaps need no runtime test — they produce identical trees, which the AST assertions already prove. Ranges are doing more work, and the loop header is where a mistake would show.

Agency execution tests are a pair of files: a `.agency` file whose nodes **return** values, and a `.test.json` naming each node with its expected output. There is no inline assertion helper.

**Files:**
- Create: `tests/agency/range.agency`, `tests/agency/range.test.json`

**Interfaces:**
- Consumes: the `range()` call shape from Task 6.
- Produces: nothing.

- [ ] **Step 1: Write the Agency file**

Create `tests/agency/range.agency`:

```ts
// 3..6 is exclusive, so a loop over it runs three times summing to 12.
// Returning both numbers catches two failure modes with one assertion: a
// collapsed range shows up as count 1, and an inclusive end shows up as 15.
node loopHeader() {
  let total = 0
  let count = 0
  for (i in 3..6) {
    total = total + i
    count = count + 1
  }
  return [count, total]
}

// Non-literal endpoints go through the same path as literals.
node variableEndpoints() {
  const start = 2
  const end = 5
  let count = 0
  for (i in start..end) {
    count = count + 1
  }
  return count
}

// An inverted range yields nothing rather than counting backwards.
node inverted() {
  let count = 0
  for (i in 6..3) {
    count = count + 1
  }
  return count
}
```

- [ ] **Step 2: Write the expectations**

Create `tests/agency/range.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "loopHeader",
      "description": "3..6 yields three values summing to 12",
      "input": "",
      "expectedOutput": "[3,12]",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "variableEndpoints",
      "description": "a range with variable endpoints expands the same way",
      "input": "",
      "expectedOutput": "3",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "inverted",
      "description": "an inverted range yields no values",
      "input": "",
      "expectedOutput": "0",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

If `range(6, 3)` turns out to behave differently, change the expectation to match the real behavior and note it — the point is to pin whatever it does, since neither the spec nor the plan defined it.

- [ ] **Step 3: Build**

```bash
make 2>&1 | tail -20 | tee /tmp/t9-build.txt
```

**This step is not optional.** Tasks 1 through 7 all run under vitest, which reads TypeScript sources directly and never needs a build. `pnpm run agency` is `node ./dist/scripts/agency.js` and reads compiled output, so without a build it exercises a `dist/` that predates every parser change and the test fails for a reason unrelated to the code. That asymmetry is the trap.

- [ ] **Step 4: Run the execution test**

```bash
pnpm run agency test tests/agency/range.agency 2>&1 | tee /tmp/t9.txt
```

Expected: all three PASS. A `loopHeader` result of `[1,...]` means the range is being treated as a single value rather than expanded — check Task 6's operator registration.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/range.agency tests/agency/range.test.json
git commit -m "test: ranges expand correctly in a loop header"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/site/guide/basic-syntax.md`, `functions.md`, `blocks.md`, `match-expressions.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Fix the trailing-comment claim**

`docs/site/guide/basic-syntax.md` says a comment cannot follow code on the same line and shows `const x = 5 // this is a comment` under "Not allowed". The advice is right but the reason is wrong: it parses, and the text survives — `agency fmt` relocates it onto its own line above the next item, which can change what it appears to describe.

Replace the "Not allowed" framing with:

```markdown
> Note: a comment can follow code on the same line, but `agency fmt` will move
> it onto its own line above whatever comes next. Because that can change what
> the comment appears to describe, prefer putting comments on their own line.
```

- [ ] **Step 2: Document the accepted variations**

Add to `docs/site/guide/basic-syntax.md`, after the Functions section:

```markdown
## Syntax the parser also accepts

Agency accepts a few spellings borrowed from other languages, so code written
out of habit still compiles. `agency fmt` rewrites each one into the canonical
form shown on the right.

| Also accepted | Canonical |
|---|---|
| `function add(a, b) { ... }` | `def add(a, b) { ... }` |
| `def add(a, b) -> number` | `def add(a, b): number` |
| `match (x) { 1 -> "one" }` | `match (x) { 1 => "one" }` |
| `map(xs, \n => n * 2)` | `map(xs, \n -> n * 2)` |

These are the same construct written differently, not separate features, so
there is nothing extra to learn — write whichever comes naturally and format
the file.
```

- [ ] **Step 3: Document ranges**

Add to `docs/site/guide/basic-syntax.md`, directly after the "Array slice syntax" section, so the two half-open constructs sit together:

````markdown
## Ranges

`a..b` counts from `a` up to but not including `b`:

```ts
for (i in 3..6) {
  print(i)      // 3, 4, 5
}
```

The end is excluded, matching both `range()` and slice syntax — `arr[1:4]` also
stops before index 4. `a..b` is exactly `range(a, b)`, and `agency fmt` writes
it that way.

One thing to watch: `[3..6]` is an array *containing* a range, not a range, so
it is a compile error with a message pointing at the fix. Write `3..6` for the
range itself, or `[(3..6)]` if you really do want an array holding one range.
The error only fires when the range is the array's only element — `[1, 3..6]`
is a two-element array and is perfectly legal.

Ranges use the `range` function from the standard library, which is
auto-imported. A file that defines its own `range` changes what `a..b` means in
that file.
````

- [ ] **Step 4: Cross-reference from the other three guides**

In `docs/site/guide/functions.md`, after the "Define a function using `def`" opening:

```markdown
`function` also works and is normalized to `def` by `agency fmt`, as is `->` in
place of the `:` before a return type. See
[Syntax the parser also accepts](/guide/basic-syntax#syntax-the-parser-also-accepts).
```

In `docs/site/guide/match-expressions.md`, after the first example:

```markdown
Arms may use `->` instead of `=>`; `agency fmt` normalizes to `=>`.
```

In `docs/site/guide/blocks.md`, in the "Inline blocks" section:

```markdown
`=>` works in place of `->` here too, and `agency fmt` normalizes to `->`.
```

- [ ] **Step 5: Review the diff**

There is no docs build or link checker to run — the guide markdown is staged into `stdlib/docs/` by a plain `cp -r` in the Makefile. Read the diff instead, and confirm the anchor in the `functions.md` link matches the heading added in Step 2.

- [ ] **Step 6: Commit**

```bash
git add docs/site/guide/
git commit -m "docs: accepted syntax variations, ranges, and the trailing comment rule"
```

---

### Task 11: Fixture check, changelog, PR

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Check the formatter fixtures**

```bash
pnpm test:run lib/formatter.test.ts 2>&1 | tee /tmp/t11.txt
```

Note the path. Do **not** run `pnpm test:run tests/formatter` — `vitest.config.ts:20` excludes the whole `tests/` tree from the unit run, and `tests/formatter/` holds Agency fixture files (`roundtrip.agency`, `generics.agency`) rather than tests. That command finds nothing and exits 1, which reads like a failure when it is not a run at all. The tests that consume those fixtures live in `lib/formatter.test.ts` at `:141` and `:185`.

None of these changes alters how *canonical* source prints, so the fixtures should be untouched. If they pass, say so explicitly in the PR description so the next person does not repeat the check. If any fail, run `make fixtures` and inspect the diff carefully — a fixture change here would mean a variation *is* being recorded in the AST, which contradicts the design and should be reported rather than absorbed.

- [ ] **Step 2: Add the changelog entry**

Add under a new dated heading at the top of `CHANGELOG.md`, matching the existing format:

````markdown
### Language / Parser
- **The parser accepts syntax variations models commonly write** — `function`
  for `def`, `->` for the `:` before a return type, either arrow in match arms
  and inline blocks, and `a..b` ranges. Each parses to the same tree as the
  canonical spelling, and `agency fmt` normalizes them.
- **Ranges** — `3..6` is `range(3, 6)`, counting up to but not including the
  end, like slices and `range()`. `[3..6]` is a compile error pointing at the
  fix, because it would otherwise silently build an array holding one range.
- **`agency fmt` is now lossy for these spellings.** A hand-written `function`
  becomes `def` and `3..6` becomes `range(3, 6)`, with no way to keep the
  original.
- Fixed: a nested `function` declaration inside a body silently misparsed as a
  name plus a call and failed at run time; it now produces the same error a
  nested `def` does.
- Fixed: a number literal no longer swallows a second dot, so `1.2.3` is an
  error instead of a malformed number node.
````

Note what is deliberately **not** claimed: `function` is not a reserved word in general. It was added to `RESERVED_WORDS`, but that list governs identifier-hole filling in Template Agency only, so `const function = 5` still parses — which Task 2 pins with a test. If that test failed and you made `function` genuinely reserved, add a breaking-change line here saying so.

**Do not touch any other part of `CHANGELOG.md`.**

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for the syntax variations"
```

- [ ] **Step 4: Open the PR**

Write the body to a file first — apostrophes on the command line break the shell.

```bash
gh pr create --title "Accept the syntax variations agents actually write" --body-file /tmp/pr-body.md
```

The description should link the spec at
`docs/superpowers/specs/2026-07-31-agent-friendly-syntax-variations-design.md`,
state that `agency fmt` is now lossy for these spellings, record the
formatter-fixture result from Step 1, and note the two independent bug fixes
(nested `function`, and the number-literal grammar).

---

## Anti-Pattern Audit

Before opening the PR, read `docs/dev/anti-patterns.md` and
`docs/dev/coding-standards.md` and check the diff against them. Then run:

```bash
pnpm run lint:structure 2>&1 | tee /tmp/lint.txt
```

Four things specific to this change:

- **No parallel mechanism.** Ranges must lower to the existing `range()` call.
  A `rangeExpression` AST node would need walker coverage, typechecker support,
  and generator support — inheriting all three is the entire point.
- **No re-deriving what the parser knows.** The bracketed-range check reads a
  marker set during parsing. If it grew a regex over source text, that is a
  second mechanism for something the parse already determined, and it cannot
  tell code from data.
- **Declarative over imperative.** Task 5 states a number grammar. If it ended
  up as a scanning loop with a mutable flag plus manual `rest` arithmetic, the
  grammar is still wrong and the repair is bolted on top.
- **No comment narrating the obvious.** The comments quoted in this plan explain
  *why* a choice was made — why `..` is not a binOp, why the probe throws, why
  the marker is non-enumerable. Do not add comments restating what code does.
