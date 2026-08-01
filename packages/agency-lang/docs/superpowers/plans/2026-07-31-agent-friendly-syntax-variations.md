# Agent-Friendly Syntax Variations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Agency parser accept four syntax variations that models naturally write — `function` for `def`, `->` for the return-type `:`, either arrow in match arms and inline blocks, and `3..6` ranges — with `agency fmt` normalizing each back to canonical form.

**Architecture:** Every change is confined to `lib/parsers/parsers.ts`. Each variation produces an AST byte-identical to the canonical spelling, so `AgencyGenerator` needs no changes at all and normalization falls out for free. Ranges are the one exception to "pure token swap": `..` becomes an infix operator whose `apply` hook builds an ordinary `range(a, b)` function call at parse time, so no new AST node type, no new typing rules, and no new codegen.

**Tech Stack:** TypeScript, the [tarsec](https://egonschiele.github.io/tarsec/) parser combinator library, vitest.

## Global Constraints

- **All parser edits land in `lib/parsers/parsers.ts`.** No other production file changes. If you find yourself editing the typechecker, a generator, or a preprocessor, stop — something has gone wrong.
- **`AgencyGenerator` must not change.** It already emits `def` unconditionally (`lib/backends/agencyGenerator.ts:1176`) and `:` before a return type (`:1129`). If a round-trip test fails because the generator emits the wrong thing, the bug is that the parser recorded the spelling in the AST. Fix the parser, not the generator.
- **Run tests with `pnpm test:run <path>`,** never bare `pnpm test` (that starts watch mode). Save output to a file: `pnpm test:run <path> 2>&1 | tee /tmp/out.txt`. Tests in this repo are slow and expensive to re-run.
- **Do not run the full test suite.** Run only the files each task touches. CI runs everything on the PR.
- **Never commit on `main`,** and never amend or force-push.
- **Commit message bodies go in a file** passed to `git commit -F`, never inline on the command line — apostrophes break the shell.
- The AST equality assertion in every round-trip test is the point of the test. It is what proves a variation is a spelling and not a second construct.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `lib/parsers/parsers.ts` | Every production change | 1–6 |
| `lib/parsers/function.test.ts` | `function` keyword, `->` return type | 1, 2, 3 |
| `lib/parsers/matchBlock.test.ts` | `->` in match arms | 4 |
| `lib/parsers/blockArgument.test.ts` | `=>` in inline blocks | 4 |
| `lib/parsers/literals.test.ts` | Number-literal boundary | 5 |
| `lib/parsers/range.test.ts` (new) | Range operator and the bracket error | 6, 7 |
| `tests/agency/range.agency` (new) | One execution test for ranges | 8 |
| `docs/site/guide/*.md` | User-facing documentation | 9 |

Task order matters in one place only: **Task 5 must land before Task 6.** The range operator cannot parse `3..6` until the number parser stops swallowing both dots. Everything else is independent.

---

### Task 1: `bodyDeclarationParser` learns `function`

This is a live bug fix and ships independently of the rest. Because `function` is currently a legal identifier, a declaration written inside a body parses as a name followed by a call with a trailing block, compiles to plausible-looking TypeScript, and dies at run time with a `ReferenceError`. The same code written with `def` already produces a targeted error.

**Files:**
- Modify: `lib/parsers/parsers.ts:4584`
- Test: `lib/parsers/function.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on. `bodyDeclarationParser` stays `Parser<never>`.

- [ ] **Step 1: Write the failing test**

Add to `lib/parsers/function.test.ts`:

```ts
describe("nested declaration probe", () => {
  it("rejects a nested `function` declaration the same way it rejects `def`", () => {
    const src = `node main() {
  function inner() { print(1) }
  print("x")
}`;
    expect(() => parseAgency(src)).toThrow(/only legal at the top level/);
  });

  it("still rejects a nested `def` declaration", () => {
    const src = `node main() {
  def inner() { print(1) }
  print("x")
}`;
    expect(() => parseAgency(src)).toThrow(/only legal at the top level/);
  });
});
```

If `parseAgency` is not already imported in that file, add it from `"./parsers.js"` alongside the existing imports.

- [ ] **Step 2: Run the test to verify the first case fails**

```bash
pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/t1.txt
```

Expected: the `function` case FAILS (it parses today, so nothing throws), the `def` case PASSES.

- [ ] **Step 3: Add `function` to the probe**

At `lib/parsers/parsers.ts:4584`, inside `bodyDeclarationParser`, change:

```ts
    or(str("node"), str("def")),
```

to:

```ts
    or(str("node"), str("def"), str("function")),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/t1.txt
```

Expected: both cases PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/function.test.ts
git commit -m "fix: a nested function declaration is rejected like a nested def"
```

---

### Task 2: `function` as a second spelling of `def`

**Files:**
- Modify: `lib/parsers/parsers.ts:5730` (the keyword capture), `:215` (`RESERVED_WORDS`)
- Test: `lib/parsers/function.test.ts`

**Interfaces:**
- Consumes: Task 1's probe change (so a nested `function` still errors).
- Produces: nothing. The keyword is discarded at `parsers.ts:5848`, so `FunctionDefinition` is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `lib/parsers/function.test.ts`:

```ts
describe("function keyword", () => {
  it("parses `function` to the same AST as `def`", () => {
    const withFunction = parseAgency(`function add(a: number, b: number): number { return a + b }`);
    const withDef = parseAgency(`def add(a: number, b: number): number { return a + b }`);
    expect(stripLocs(withFunction)).toEqual(stripLocs(withDef));
  });

  it("normalizes `function` to `def` when formatted", () => {
    const formatted = new AgencyGenerator().generate(
      parseAgency(`function add(a: number, b: number): number { return a + b }`),
    );
    expect(formatted).toContain("def add(");
    expect(formatted).not.toContain("function add(");
  });

  it("accepts modifiers before `function`", () => {
    const withFunction = parseAgency(`export destructive function f() { print(1) }`);
    const withDef = parseAgency(`export destructive def f() { print(1) }`);
    expect(stripLocs(withFunction)).toEqual(stripLocs(withDef));
  });
});
```

`stripLocs` recursively deletes every `loc` key, because the two sources have different character offsets. If `function.test.ts` has no such helper already, add it near the top of the file:

```ts
function stripLocs<T>(node: T): T {
  if (Array.isArray(node)) return node.map(stripLocs) as unknown as T;
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "loc") continue;
      out[k] = stripLocs(v);
    }
    return out as T;
  }
  return node;
}
```

Import `AgencyGenerator` from `"../backends/agencyGenerator.js"` if it is not already imported.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/t2.txt
```

Expected: FAIL — `function add(...)` does not parse as a function definition today.

- [ ] **Step 3: Accept the keyword**

At `lib/parsers/parsers.ts:5730`, inside `_baseFunctionParser`, change:

```ts
    capture(str("def"), "keyword"),
```

to:

```ts
    capture(oneOfStr(["def", "function"]), "keyword"),
```

`oneOfStr` is already defined in this file at `:284`.

- [ ] **Step 4: Reserve the keyword**

At `lib/parsers/parsers.ts:215`, add `"function"` to `RESERVED_WORDS`. Put it next to `"def"` on the first line:

```ts
  "def", "function", "node", "return", "goto", "raise", "interrupt", "import", "export",
```

This list feeds identifier-hole filling in Template Agency only — it does not govern general identifier parsing. Its doc comment says to extend it when a new keyword lands.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/t2.txt
```

Expected: PASS, including the two Task 1 cases.

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/function.test.ts
git commit -m "feat(parser): accept function as a second spelling of def"
```

---

### Task 3: `->` as a return-type separator

The interesting case is not what follows a return type but what it can contain. A return type can itself be a function type, and function types already use `->`, so `def f() -> (string) -> string` puts two arrows in one signature. Greedy left-to-right consumption should handle it. The tests exist to prove that, not because we expect failure.

**Files:**
- Modify: `lib/parsers/parsers.ts:5703`
- Test: `lib/parsers/function.test.ts`

**Interfaces:**
- Consumes: `stripLocs` from Task 2.
- Produces: nothing. `functionReturnTypeParser` keeps its `Parser<VariableType>` type.

- [ ] **Step 1: Write the failing test**

Add to `lib/parsers/function.test.ts`:

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
      expect(stripLocs(parseAgency(arrow))).toEqual(stripLocs(parseAgency(colon)));
    });
  }

  it("normalizes the arrow to a colon when formatted", () => {
    const formatted = new AgencyGenerator().generate(
      parseAgency(`def f() -> (string) -> string { return g }`),
    );
    expect(formatted).toContain("def f(): (string) -> string");
  });
});
```

The last assertion is the one that pins the doubled-arrow behavior: the separator normalizes to `:` while the arrow *inside the type* stays an arrow.

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

One edit covers both `def` and `node`: `functionParser` (`:5757`) and `graphNodeParser` (`:5918`) both delegate to this parser.

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
- Consumes: `stripLocs` — copy the helper into each test file that needs it rather than exporting it, matching how these co-located test files are already written.
- Produces: nothing.

- [ ] **Step 1: Write the failing match-arm test**

Add to `lib/parsers/matchBlock.test.ts` (copy `stripLocs` from Task 2 into this file if absent):

```ts
describe("arm arrow", () => {
  it("accepts -> in a match arm", () => {
    const withArrow = parseAgency(`node main() { match (1) { 1 -> print("one") _ -> print("no") } }`);
    const withFat = parseAgency(`node main() { match (1) { 1 => print("one") _ => print("no") } }`);
    expect(stripLocs(withArrow)).toEqual(stripLocs(withFat));
  });

  it("normalizes -> to => when formatted", () => {
    const formatted = new AgencyGenerator().generate(
      parseAgency(`node main() { match (1) { 1 -> print("one") _ -> print("no") } }`),
    );
    expect(formatted).toContain("=>");
    expect(formatted).not.toMatch(/\d\s*->/);
  });

  it("does not confuse a guard ending in a negative comparison with the arrow", () => {
    const src = `node main() { match (1) { _ if (a >-3) -> print("yes") } }`;
    expect(() => parseAgency(src)).not.toThrow();
  });
});
```

- [ ] **Step 2: Write the failing inline-block test**

Add to `lib/parsers/blockArgument.test.ts` (copy `stripLocs` in if absent):

```ts
describe("inline block arrow", () => {
  it("accepts => in an inline block", () => {
    const withFat = parseAgency(`node main() { const ys = map(xs, \\n => n * 2) }`);
    const withThin = parseAgency(`node main() { const ys = map(xs, \\n -> n * 2) }`);
    expect(stripLocs(withFat)).toEqual(stripLocs(withThin));
  });

  it("normalizes => to -> when formatted", () => {
    const formatted = new AgencyGenerator().generate(
      parseAgency(`node main() { const ys = map(xs, \\n => n * 2) }`),
    );
    expect(formatted).toContain("->");
    expect(formatted).not.toContain("=>");
  });

  it("accepts => with multiple parenthesized params", () => {
    const withFat = parseAgency(`node main() { const ys = mapWithIndex(xs, \\(n, i) => n * i) }`);
    const withThin = parseAgency(`node main() { const ys = mapWithIndex(xs, \\(n, i) -> n * i) }`);
    expect(stripLocs(withFat)).toEqual(stripLocs(withThin));
  });
});
```

Note the doubled backslash: `\\n` in a TypeScript template literal produces the single `\` the Agency inline-block syntax needs.

- [ ] **Step 3: Run both to verify they fail**

```bash
pnpm test:run lib/parsers/matchBlock.test.ts lib/parsers/blockArgument.test.ts 2>&1 | tee /tmp/t4.txt
```

Expected: FAIL on the arrow-swap cases in both files.

- [ ] **Step 4: Accept both arrows in match arms**

At `lib/parsers/parsers.ts:3968`, change:

```ts
    str("=>"),
```

to:

```ts
    or(str("=>"), str("->")),
```

- [ ] **Step 5: Accept both arrows in inline blocks**

At `lib/parsers/parsers.ts:3795`, change:

```ts
      str("->"),
```

to:

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

### Task 5: Number-literal boundary

**This task must land before Task 6.** Today `numberParser` swallows any number of dots, so `3..6` becomes a single malformed number node with the text `"3..6"` — no parse error, no typecheck error. The range operator cannot see its `..` until this is fixed.

The fix is a **boundary rule, not a counting rule**. `many1WithJoin` is greedy, so simply rejecting a value with two dots would make `numberParser` fail outright on `3..6`, and the range operator would then have no left operand. What is needed is for the number parser to *stop early*, consuming `3` and leaving `..6` behind.

**Files:**
- Modify: `lib/parsers/parsers.ts:597-612`
- Test: `lib/parsers/literals.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `numberParser` keeps its `Parser<NumberLiteral>` type and its `{ type: "number", value: string }` result shape. Task 6 relies on it leaving `..6` in `rest` when given `3..6`.

- [ ] **Step 1: Write the failing test**

Add to `lib/parsers/literals.test.ts`:

```ts
describe("number literal boundary", () => {
  it("stops before a `..` so the rest is left for the range operator", () => {
    const r = numberParser("3..6");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.value).toBe("3");
    expect(r.rest).toBe("..6");
  });

  it("still parses a decimal", () => {
    const r = numberParser("3.5");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.value).toBe("3.5");
    expect(r.rest).toBe("");
  });

  it("still strips underscores", () => {
    const r = numberParser("1_000");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.value).toBe("1000");
  });

  it("stops at the second dot rather than building 1.2.3", () => {
    const r = numberParser("1.2.3");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.value).toBe("1.2");
    expect(r.rest).toBe(".3");
  });

  it("rejects a run with no digits", () => {
    expect(numberParser("..").success).toBe(false);
  });

  it("does not treat 1.2.3 as a valid whole expression", () => {
    expect(() => parseAgency(`node main() { const x = 1.2.3 }`)).toThrow();
  });
});
```

Import `numberParser` from `"./parsers.js"` if it is not already imported in that file.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:run lib/parsers/literals.test.ts 2>&1 | tee /tmp/t5.txt
```

Expected: FAIL — `numberParser("3..6")` currently returns value `"3..6"` with empty `rest`.

- [ ] **Step 3: Truncate the greedy match to a valid numeric prefix**

Replace `numberParser` at `lib/parsers/parsers.ts:597-612` with:

```ts
/** The longest prefix of `raw` that is a valid number: at most one `.`, and a
 *  `.` only when a digit follows it. Given `3..6` this returns `3`, leaving
 *  `..6` for the range operator; given `1.2.3` it returns `1.2`. Everything
 *  else in the character run (`-`, `_`, digits) is passed through unchanged so
 *  existing acceptance is untouched. */
function numericPrefix(raw: string): string {
  let seenDot = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== ".") continue;
    const nextIsDigit = /[0-9]/.test(raw[i + 1] ?? "");
    if (seenDot || !nextIsDigit) return raw.slice(0, i);
    seenDot = true;
  }
  return raw;
}

export const numberParser: Parser<NumberLiteral> = label("a number", (input: string): ParserResult<NumberLiteral> => {
  const parser = seqC(
    set("type", "number"),
    capture(many1WithJoin(or(char("-"), char("."), char("_"), digit)), "value"),
  );
  const result = parser(input);
  if (!result.success) return result;
  const prefix = numericPrefix(result.result.value);
  // Require at least one digit. Without this check, bare runs of `-`, `.`,
  // and `_` (e.g. `.`, `-`, `--`, `..`, `_`) all parse as "numbers" with
  // no digits, which then leak into surrounding parses as nonsense AST
  // (e.g. `"-".repeat(5)` parses `.` as a number node).
  if (!/[0-9]/.test(prefix)) {
    return failure("expected a number with at least one digit", input);
  }
  return {
    ...result,
    result: { ...result.result, value: prefix.replace(/_/g, "") },
    rest: input.slice(prefix.length),
  };
});
```

Two things changed from the original beyond the truncation. The underscore strip moved out of the `capture` map so that `numericPrefix` scans the raw text and `prefix.length` still indexes into `input` correctly. And `rest` is now computed from the prefix length instead of being whatever the greedy parser left.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/literals.test.ts 2>&1 | tee /tmp/t5.txt
```

Expected: PASS.

- [ ] **Step 5: Run the neighbouring literal suites for regressions**

The number parser feeds unit literals and binary expressions, so check those too:

```bash
pnpm test:run lib/parsers/unitLiteral.test.ts lib/parsers/binop.test.ts lib/parsers/dataStructures.test.ts 2>&1 | tee /tmp/t5b.txt
```

Expected: PASS. If a unit-literal test fails on something like `1.5s`, the prefix scan is stopping too early — check that `numericPrefix` allows a dot followed by a digit.

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/literals.test.ts
git commit -m "fix(parser): a number literal stops at a second dot instead of swallowing it"
```

---

### Task 6: The `..` range operator

`..` becomes an infix operator whose `apply` hook builds a `range(a, b)` function call directly. No new AST node type, so nothing downstream — typechecker, generator, runtime — needs to know ranges exist.

Precedence sits between additive and relational, so `a + 1 .. b - 1` groups as `range(a + 1, b - 1)` and `x .. y == z` groups as `range(x, y) == z`.

**Files:**
- Modify: `lib/parsers/parsers.ts:3437-3470` (the operator table)
- Create: `lib/parsers/range.test.ts`

**Interfaces:**
- Consumes: `numberParser` from Task 5, leaving `..6` in `rest` when given `3..6`.
- Produces: a `FunctionCall` node with `functionName: "range"` and two positional arguments. Task 7 relies on that shape; Task 8 relies on it executing.

- [ ] **Step 1: Write the failing test**

Create `lib/parsers/range.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "./parsers.js";
import { AgencyGenerator } from "../backends/agencyGenerator.js";

function stripLocs<T>(node: T): T {
  if (Array.isArray(node)) return node.map(stripLocs) as unknown as T;
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "loc") continue;
      out[k] = stripLocs(v);
    }
    return out as T;
  }
  return node;
}

describe("range operator", () => {
  const pairs: [string, string][] = [
    [`node main() { const r = 3..6 }`, `node main() { const r = range(3, 6) }`],
    [`node main() { for (i in 3..6) { print(i) } }`, `node main() { for (i in range(3, 6)) { print(i) } }`],
    [`node main() { f(3..6) }`, `node main() { f(range(3, 6)) }`],
    [`node main() { const r = a..b }`, `node main() { const r = range(a, b) }`],
    [`node main() { const r = a + 1..b - 1 }`, `node main() { const r = range(a + 1, b - 1) }`],
  ];

  for (const [range, call] of pairs) {
    it(`parses ${range.trim()} identically to its range() form`, () => {
      expect(stripLocs(parseAgency(range))).toEqual(stripLocs(parseAgency(call)));
    });
  }

  it("normalizes to a range() call when formatted", () => {
    const formatted = new AgencyGenerator().generate(parseAgency(`node main() { const r = 3..6 }`));
    expect(formatted).toContain("range(3, 6)");
    expect(formatted).not.toContain("..");
  });

  it("keeps `.`, `..` and `...` distinct", () => {
    expect(() => parseAgency(`node main() { const a = [1, 2]
const b = [...a, 3] }`)).not.toThrow();
    expect(() => parseAgency(`def f(...xs: number[]) { print(xs) }
node main() { f(1, 2) }`)).not.toThrow();
    expect(() => parseAgency(`node main() { const o = { a: 1 }
print(o.a) }`)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:run lib/parsers/range.test.ts 2>&1 | tee /tmp/t6.txt
```

Expected: FAIL on every range case.

- [ ] **Step 3: Add the range builder**

Next to `makeBinOp` at `lib/parsers/parsers.ts:3364`, add:

```ts
/** `a..b` is not a binary operator in the AST — it builds the same
 *  `range(a, b)` call someone would write by hand. This follows
 *  comprehensionDesugar's approach: emit a shape the rest of the compiler
 *  already understands, so typing, codegen, and the runtime are inherited
 *  rather than reimplemented. `agency fmt` therefore prints `range(a, b)`,
 *  which is the intended normalization. */
function makeRangeCall(left: Expression, right: Expression): Expression {
  return {
    type: "functionCall" as const,
    functionName: "range",
    arguments: [left, right],
  } as Expression;
}
```

If the `FunctionCall` type requires fields beyond these three, match whatever `parseAgency("range(3, 6)")` produces — the test asserts AST equality against exactly that, so any mismatch will show up immediately as a diff.

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

Do **not** add `".."` to the `Operator` union or the `PRECEDENCE` map in `lib/types/binop.ts`. Neither is needed: no `binOpExpression` node with operator `..` is ever created, so the generator never has to decide how to parenthesize one.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/range.test.ts 2>&1 | tee /tmp/t6.txt
```

Expected: PASS.

- [ ] **Step 6: Run the expression suites for regressions**

```bash
pnpm test:run lib/parsers/binop.test.ts lib/parsers/expression.test.ts lib/parsers/access.test.ts 2>&1 | tee /tmp/t6b.txt
```

Expected: PASS. Member access (`o.a`) and spread (`[...a]`) are the two things most likely to be disturbed by a new dot operator.

- [ ] **Step 7: Check the prelude assumption**

`range` reaches user files through the standard-library prelude, and the lowering assumes it is in scope. Two places that assumption could fail: a file that defines its own `range`, and a file the prelude is not injected into — including `stdlib/index.agency`, where `range` itself is defined and a range expression would be circular.

```bash
grep -rn '\.\.' stdlib/*.agency | grep -v '\.\.\.' | tee /tmp/t6c.txt
pnpm test:run lib/parsers/importStatement.test.ts 2>&1 | tee /tmp/t6d.txt
```

Expected: no `..` ranges anywhere in the standard library, so the circularity is latent rather than live. If any turn up, rewrite them as explicit `range()` calls in the same commit. Record the finding either way — the docs step in Task 9 tells users about the shadowing case, and this step confirms the standard library is not already relying on something that cannot work.

- [ ] **Step 8: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/range.test.ts
git commit -m "feat(parser): .. is an infix range operator lowering to range(a, b)"
```

---

### Task 7: The bracketed-range error

Under an infix reading, `[3..6]` is an array *containing* a range — one element, not three. A `for` loop over it runs once and binds the whole array, with no error. Because the bracketed form is what models reach for out of Haskell and CoffeeScript habit, this is the one shape where permissiveness would produce a silently wrong answer, so it gets a targeted parse error instead.

The error fires only when a range sits **directly** inside brackets as the sole element. `[(3..6)]` is how you write an array genuinely containing a range.

**Files:**
- Modify: `lib/parsers/parsers.ts` near `:2274` (the literal alternatives list)
- Test: `lib/parsers/range.test.ts`

**Interfaces:**
- Consumes: the `..` operator from Task 6.
- Produces: nothing. The probe is `Parser<never>`, matching `bodyDeclarationParser`.

- [ ] **Step 1: Write the failing test**

Add to `lib/parsers/range.test.ts`:

```ts
describe("bracketed range", () => {
  it("rejects a lone range inside brackets", () => {
    expect(() => parseAgency(`node main() { const r = [3..6] }`)).toThrow(
      /builds an array containing a range/,
    );
  });

  it("names both fixes in the message", () => {
    let message = "";
    try {
      parseAgency(`node main() { const r = [3..6] }`);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("3..6");
    expect(message).toContain("[(3..6)]");
  });

  it("accepts a parenthesized range as an array element", () => {
    const parenthesized = parseAgency(`node main() { const r = [(3..6)] }`);
    const explicit = parseAgency(`node main() { const r = [range(3, 6)] }`);
    expect(stripLocs(parenthesized)).toEqual(stripLocs(explicit));
  });

  it("accepts two ranges in one array", () => {
    const ranges = parseAgency(`node main() { const r = [3..6, 8..9] }`);
    const explicit = parseAgency(`node main() { const r = [range(3, 6), range(8, 9)] }`);
    expect(stripLocs(ranges)).toEqual(stripLocs(explicit));
  });

  it("accepts a range alongside another element", () => {
    const mixed = parseAgency(`node main() { const r = [1, 3..6] }`);
    const explicit = parseAgency(`node main() { const r = [1, range(3, 6)] }`);
    expect(stripLocs(mixed)).toEqual(stripLocs(explicit));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:run lib/parsers/range.test.ts 2>&1 | tee /tmp/t7.txt
```

Expected: the first two cases FAIL — `[3..6]` currently parses as a one-element array. The last three should already PASS from Task 6.

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
 * Only the bare form is caught. `[(3..6)]` parses normally, which is why the
 * message points at it: it is the way to write what `[3..6]` looks like it says.
 *
 * Throws rather than returning `failure(...)` for the same reason
 * `bodyDeclarationParser` does — a plain failure would be shadowed by a sibling
 * alternative in the enclosing `or(...)`.
 */
const bracketedRangeParser: Parser<never> = (input: string) => {
  const probe = seqC(
    char("["),
    optionalSpacesOrNewline,
    lazy(() => exprParser),
    optionalSpaces,
    str(".."),
  );
  const probed = probe(input);
  if (!probed.success) return failure("", input);
  return committedFailure(BRACKETED_RANGE_MESSAGE, probed.rest);
};
```

Note the probe stops at the `..` rather than parsing through to `]`. Parsing the left operand with `exprParser` would consume the whole `3..6` range in one go, so the `..` would already be gone — stopping at the operator is what makes the shape detectable.

That has a consequence worth knowing: `[3..6, 8..9]` also matches this prefix. To keep the multi-element cases legal, extend the probe to require a closing `]` after the right operand:

```ts
const bracketedRangeParser: Parser<never> = (input: string) => {
  const probe = seqC(
    char("["),
    optionalSpacesOrNewline,
    lazy(() => exprParser),
    optionalSpacesOrNewline,
    char("]"),
  );
  const probed = probe(input);
  if (!probed.success) return failure("", input);
  // exprParser consumed a range only if the source between the brackets held a
  // top-level `..`; re-check the consumed span rather than the AST, because a
  // hand-written `range(3, 6)` produces the identical node.
  const consumed = input.slice(0, input.length - probed.rest.length);
  if (!/[^.]\.\.[^.]/.test(consumed)) return failure("", input);
  return committedFailure(BRACKETED_RANGE_MESSAGE, probed.rest);
};
```

Use the second version. The `[^.]` guards on either side keep `...` (spread) from matching. Register it in the literal alternatives at `:2274`, immediately **before** `lazy(() => agencyArrayParser)`:

```ts
    lazy(() => bracketedRangeParser),
    lazy(() => agencyArrayParser),
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test:run lib/parsers/range.test.ts 2>&1 | tee /tmp/t7.txt
```

Expected: PASS on all cases. If `[3..6, 8..9]` now throws, the closing-bracket requirement is not being enforced — the probe is matching a prefix rather than the whole literal.

- [ ] **Step 5: Run the data-structure suites for regressions**

```bash
pnpm test:run lib/parsers/dataStructures.test.ts lib/parsers/comprehension.test.ts lib/parsers/literalDelimiter.test.ts 2>&1 | tee /tmp/t7b.txt
```

Expected: PASS. Comprehensions (`[x * 2 for x in xs]`) share the `[` opener and are the most likely thing to be disturbed.

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/range.test.ts
git commit -m "feat(parser): a lone range in brackets is a targeted error"
```

---

### Task 8: Execution test for ranges

The three token swaps need no runtime test — they produce byte-identical trees, which the AST assertions already prove. Ranges are doing more work, and the loop header is exactly where a mistake would show. Agency execution tests need no LLM calls, so this is nearly free.

Agency execution tests are a pair of files: a `.agency` file whose nodes **return**
values, and a `.test.json` naming each node with its expected output. There is no
inline assertion helper — the JSON does the asserting.

**Files:**
- Create: `tests/agency/range.agency`
- Create: `tests/agency/range.test.json`

**Interfaces:**
- Consumes: the `range()` call shape from Task 6.
- Produces: nothing.

- [ ] **Step 1: Write the Agency file**

Create `tests/agency/range.agency`:

```ts
// 3..6 is exclusive, so a loop over it runs three times summing to 12.
// This is the failure the bracketed-range error exists to prevent: if the
// range collapsed to a single value, count would be 1.
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
    }
  ]
}
```

- [ ] **Step 3: Run it**

```bash
pnpm run agency test tests/agency/range.agency 2>&1 | tee /tmp/t8.txt
```

Expected: both PASS. A `loopHeader` result of `[1,...]` means the range is being treated as a single value rather than expanded — check Task 6's operator registration.

- [ ] **Step 4: Commit**

```bash
git add tests/agency/range.agency tests/agency/range.test.json
git commit -m "test: ranges expand correctly in a loop header"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/site/guide/basic-syntax.md`, `functions.md`, `blocks.md`, `match-expressions.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Fix the trailing-comment claim**

`docs/site/guide/basic-syntax.md` currently says a comment cannot follow code on the same line and shows `const x = 5 // this is a comment` under "Not allowed". The advice is right but the reason is wrong: it parses, and the comment text survives — `agency fmt` relocates it onto its own line above the next item, which can change what it appears to describe.

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

Add to `docs/site/guide/basic-syntax.md`, directly after the "Array slice syntax" section, so the two half-open constructs are explained together:

```markdown
## Ranges

`a..b` counts from `a` up to but not including `b`:

```ts
for (i in 3..6) {
  print(i)      // 3, 4, 5
}
```

The end is excluded, matching both `range()` and slice syntax — `arr[1:4]`
also stops before index 4. `a..b` is exactly `range(a, b)`, and `agency fmt`
writes it that way.

Note that `[3..6]` is an array *containing* a range, not a range, so it is a
compile error with a message pointing at the fix. Write `3..6` for the range
itself, or `[(3..6)]` if you really do want an array holding one range.

Ranges use the `range` function from the standard library, which is
auto-imported. A file that defines its own `range` will change what `a..b`
means in that file.
```

- [ ] **Step 4: Cross-reference from the other three guides**

In `docs/site/guide/functions.md`, after the "Define a function using `def`" opening, add:

```markdown
`function` also works and is normalized to `def` by `agency fmt`, as is `->` in
place of the `:` before a return type. See
[Syntax the parser also accepts](/guide/basic-syntax#syntax-the-parser-also-accepts).
```

In `docs/site/guide/match-expressions.md`, after the first example, add:

```markdown
Arms may use `->` instead of `=>`; `agency fmt` normalizes to `=>`.
```

In `docs/site/guide/blocks.md`, in the "Inline blocks" section, add:

```markdown
`=>` works in place of `->` here too, and `agency fmt` normalizes to `->`.
```

- [ ] **Step 5: Verify the docs build**

```bash
pnpm run docs:build 2>&1 | tail -20 | tee /tmp/t9.txt
```

If there is no such script, check `package.json` for the docs command and run that. Expected: no broken-link or build errors.

- [ ] **Step 6: Commit**

```bash
git add docs/site/guide/
git commit -m "docs: accepted syntax variations, ranges, and the trailing comment rule"
```

---

### Task 10: Changelog and fixture check

**Files:**
- Modify: `CHANGELOG.md`
- Possibly regenerate: `tests/formatter/` fixtures

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Check whether formatter fixtures need regenerating**

```bash
pnpm test:run tests/formatter 2>&1 | tee /tmp/t10.txt
```

None of these four changes alters how *canonical* source prints, so fixtures should be untouched. If they pass, note that explicitly in the PR description so the next person does not repeat the check. If any fail, run `make fixtures` and inspect the diff carefully — a fixture change here would mean a variation *is* being recorded in the AST, which contradicts the design and should be reported rather than absorbed.

- [ ] **Step 2: Add the changelog entry**

Add under a new dated heading at the top of `CHANGELOG.md`, matching the existing format:

```markdown
### Language / Parser
- **The parser accepts syntax variations models commonly write** — `function`
  for `def`, `->` for the `:` before a return type, either arrow in match arms
  and inline blocks, and `a..b` ranges. Each parses to the same tree as the
  canonical spelling, and `agency fmt` normalizes them.
- **Ranges** — `3..6` is `range(3, 6)`, counting up to but not including the
  end, like slices and `range()`. `[3..6]` is a compile error pointing at the
  fix, because it would otherwise silently build an array holding one range.
- **Breaking — `function` is now a reserved word.** It was previously usable as
  a variable name.
- **`agency fmt` is now lossy for these spellings.** A hand-written `function`
  becomes `def` and `3..6` becomes `range(3, 6)`, with no way to keep the
  original.
- Fixed: a nested `function` declaration inside a body silently misparsed as a
  name plus a call and failed at run time; it now produces the same error a
  nested `def` does.
- Fixed: a number literal no longer swallows a second dot, so `1.2.3` is an
  error instead of a malformed number node.
```

**Do not touch any other part of `CHANGELOG.md`.**

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for the syntax variations"
```

- [ ] **Step 4: Open the PR**

Write the description to a file first — apostrophes on the command line break the shell.

```bash
gh pr create --title "Accept the syntax variations agents actually write" --body-file /tmp/pr-body.md
```

The description should link the spec at
`docs/superpowers/specs/2026-07-31-agent-friendly-syntax-variations-design.md`,
state the two breaking changes (`function` reserved, `fmt` lossy), and record
the formatter-fixture result from Step 1.

---

## Anti-Pattern Audit

Before opening the PR, read `docs/dev/anti-patterns.md` and
`docs/dev/coding-standards.md` and check the diff against them. Then run:

```bash
pnpm run lint:structure 2>&1 | tee /tmp/lint.txt
```

Two things specific to this change to look for:

- **No parallel mechanism.** Ranges must lower to the existing `range()` call.
  If a `rangeExpression` AST node appeared anywhere, that is the wrong design —
  it would need walker coverage, typechecker support, and generator support, and
  the whole point is to inherit all three.
- **No comment narrating the obvious.** The comments quoted in this plan explain
  *why* a choice was made (why `..` is not a binOp, why the probe throws, why
  the number parser truncates). Do not add comments restating what the code
  does.
