# Code Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Agency programs generate other Agency programs by filling typed holes in template files, so that code handed to `run()` has a structure a human wrote and gaps that are checked before they are filled.

**Architecture:** A new `Hole` AST node makes `#name` legal Agency syntax in four positions. A template is an ordinary `.agency` file containing holes, loaded into a `Code` value — the existing `AST` type extended with a fragment kind, so a `Code` value can hold a whole program, a statement list, or a single expression. `fill()` substitutes values into holes: plain values become literal nodes and are never parsed, `Code` values graft as trees, and identifier holes accept strings only after validation. Hygienic renaming runs at fill time using a reserved ASCII prefix, so renamed names survive being printed to source and re-parsed by a subprocess.

**Tech Stack:** TypeScript, the tarsec parser combinator library (`lib/parsers/`), vitest for unit tests, and the `.agency` + `.test.json` execution test format.

---

## Background: read this before starting

**What this feature is for.** Agency can already run a program in a subprocess where the parent's `handle` blocks govern what the child may do (`stdlib/agency.agency:108`, `:208`, `:308`). That controls the child's *behaviour*. Nothing controls its *structure*: `runCode` takes a string, and if a model produced that string, the model chose the entire shape of the program. A human writes the skeleton, the model fills gaps, each gap is checked.

**The rule the whole feature rests on.** **Nothing supplied to `fill` is ever parsed as Agency source.** Fill a hole with `"readFile(\"/etc/passwd\")"` and the generated program gets a string literal containing those characters, not a call. If you ever write code that parses a filler value, stop: you have reintroduced the injection bug this feature exists to prevent. Tasks 10 and 11 implement this; Task 12 covers the one narrow exception.

**Read the spec:** `docs/superpowers/specs/2026-07-22-code-templates-design.md`. This plan says what to type; the spec says why.

**How to run things:**

```bash
make                                     # build everything; REQUIRED after changing any stdlib file
make doc                                 # regenerate docs/site/stdlib/*.md from docstrings
pnpm test:run path/to/file.test.ts       # run one vitest file
pnpm run a test tests/agency/x.test.json # run one Agency execution test
pnpm run ast file.agency                 # parse and print the AST as JSON
```

Do **not** run the full Agency test suite locally; CI runs it. Save test output to a file so you need not rerun to see failures.

---

## Decisions made before Task 1

Three questions had to be settled before any code could be written. They are recorded here because several tasks depend on them and because two were mistakes in the previous draft of this plan.

### Decision 1: `Code` extends the existing `AST` type; it is not a new opaque thing

`stdlib/agency.agency:420-424` already defines `type AST = { type: "agencyProgram", nodes: any[], docComment?: any }`, and `parseAST` / `writeAST` / `format` already deliver "an AST is an ordinary first-class value you can hold, pass, and print." The new surface is holes, `fill`, hygiene, and checking — not first-class-ness, which the codebase already has.

But `AST` alone is insufficient, for a reason that is easy to miss: **a bare expression is not a parseable Agency program.** Verified — `pnpm run ast` on a file containing only `42` fails with `expected ... an assignment, a function call, ...`. The top-level grammar takes statements and declarations, not expressions. So `AST`, whose `nodes` are top-level items, cannot represent "a `Code` value holding one expression", and an `expr` hole could never be filled with `Code` at all.

`Code` therefore adds a fragment kind:

```
export type Code = {
  type: "agencyProgram",
  kind: "program" | "statements" | "expr",
  nodes: any[],
  docComment?: any
}
```

`kind: "program"` is what `loadTemplate` produces. The other two come from new fragment-parsing entry points (Task 8). `nodesFor` checks fragment kind against hole sort, so grafting an expression fragment into a `statements` hole is a clear error rather than a silent malformation.

**Consequence to document, not to prevent:** because a `Code` value is a plain record, `fill(t, { v: parseAST(modelOutput) })` is a two-call injection path. That is deliberate — a template author who parses model output has chosen to. The guide (Task 20) must say so out loud.

### Decision 2: source attribution is designed in now, not retrofitted

The spec requires spans that name both the template and the filler, so an error in generated code says which one is responsible. This is the most-cited complaint about Template Haskell, and it is far cheaper to design in than to add later.

`SourceLocation` (`lib/types/base.ts`) gains an optional `origin?: { kind: "template" | "filler"; name: string }`. `fill` stamps `{ kind: "filler", name: hole.name }` onto every node it grafts or lifts. Template nodes keep their existing spans untouched, so nothing changes for ordinary compilation. Task 10 does the stamping; every error message thereafter can say "in the fill for `#text`".

### Decision 3: "bindings are local to the hole" is a checking rule, not runtime isolation

The previous draft promised that a `statements` hole is a block whose declarations are invisible afterwards, and implemented nothing. Real isolation would need every filler binder renamed unconditionally, which contradicts selective renaming and would make all generated code unreadable. Agency also has no anonymous block to wrap statements in.

The rule is therefore a **template-checking** rule, and it is enforced by construction: when the template is checked, the checker cannot see what a hole will introduce, so template code after a hole that references a filler-introduced name fails to resolve *at template-check time*. Runtime leakage — a filler's `const inner` being technically in scope in the completed program — is accepted and documented. Collisions are still handled, by hygiene.

Task 16 tests the rule that actually holds. Do not write a test asserting isolation that does not exist.

---

## Global Constraints

- Hole sigil `#`; splice `#...`; quoted names `#"name"` permitting any character except whitespace and `"`.
- Sorts are exactly `expr`, `statements`, `identifier`, `decl`. No `type` sort.
- Templates come from `.agency` files. `` code`...` `` literals are deferred to v2 — do not implement them.
- Effect declarations on holes, and lazy or interrupt-driven holes, are out of scope. The `Hole` node must stay shaped so lazy holes can be added later.
- Nested templates are rejected.
- Hygiene uses reserved identifier prefix `__hyg`. Renamed names must be legal Agency identifiers: letter or `_`, then `varNameChar` (`lib/parsers/parsers.ts:184-186`, `:842-849`).
- **Use `walkNodesArray` (`lib/utils/node.ts:570`) for AST traversal.** `lib/stdlib/agency.ts:262` calls it the single source for AST walking. Do not hand-roll recursive walkers. It also carries `scopes`, which several tasks need.
- **Define the legal-identifier regex once**, next to `varNameChar` in `lib/parsers/parsers.ts`, and import it. Do not redefine it in the generator and again in fill.
- No dynamic imports. Objects over maps, arrays over sets, `type` over `interface`.
- Do not edit `CHANGELOG.md`.
- Push logic into `lib/runtime/`, not generated code.

---

## File Structure

**New files**

| File | Responsibility |
| --- | --- |
| `lib/types/hole.ts` | `Hole` node and `HoleSort` |
| `lib/runtime/template/holes.ts` | Finding holes (thin wrapper over `walkNodesArray`) |
| `lib/runtime/template/literals.ts` | Typed constructors for literal AST nodes |
| `lib/runtime/template/lift.ts` | Plain runtime value → literal node |
| `lib/runtime/template/fill.ts` | Substitution, sort and kind checking, filler stamping |
| `lib/runtime/template/hygiene.ts` | Free names, binders, `computeRenames`, renaming |
| `lib/runtime/template/*.test.ts` | Unit tests, co-located |
| `lib/stdlib/template.ts` | `_loadTemplate` / `_fill` / `_holesOf` / `_parseExpr` / `_parseStatements` / `_toSource` |
| `lib/stdlib/template.test.ts` | Wrapper tests |

**Modified files**

| File | Change |
| --- | --- |
| `lib/types.ts` | Export `Hole`; add to the `AgencyNode` union (`:317-371`) |
| `lib/types/base.ts` | `SourceLocation.origin?` |
| `lib/parsers/parsers.ts` | Hole parsing; export `LEGAL_IDENTIFIER`; **remove** the `#` description parser (`:1224-1242`) and its wiring (`:1270`, `:1359`) |
| `lib/backends/agencyGenerator.ts` | Print holes |
| `lib/backends/typescriptBuilder.ts` | Reject holes in `processNode` |
| `lib/typeChecker/diagnostics.ts` | `AG8` category and codes |
| `lib/typeChecker/definiteReturns.ts` | Hole exemption |
| `stdlib/agency.agency` | `Code` type; `loadTemplate`, `fill`, `holesOf`, `toSource`, `parseExpr`, `parseStatements` |
| `docs/site/guide/llm.md:52-53` | Migrate off `#` |
| `tests/agency/validation/jsonSchemaWithDescription.agency`, `tests/agency/typeHints/unionAndDescriptions.agency` | Migrate off `#` |
| `lib/linter/` | Hole awareness (note: `lib/linter/`, not `lib/lint/`) |

---

## Task 1: Free the sigil

`#` currently introduces an object property description (`lib/parsers/parsers.ts:1224-1242`). Nothing can use the character until that is gone.

The replacement is verified: `@jsonSchema({ description: ... })` on a property emits the same schema, and `tests/agency/validation/jsonSchemaPropertyDescription.agency` already proves it.

**Files:** `tests/agency/validation/jsonSchemaWithDescription.agency`, `tests/agency/typeHints/unionAndDescriptions.agency`, `docs/site/guide/llm.md`, `lib/parsers/parsers.ts`, new `lib/parsers/hashRemoved.test.ts`

**Interfaces:** Produces a grammar in which `#` is unused.

- [ ] **Step 1: Confirm the replacement works today**

Run: `pnpm run a test tests/agency/validation/jsonSchemaPropertyDescription.test.json` → `1/1 tests passed`

- [ ] **Step 2: Find every user of the syntax**

Run: `grep -rn ':\s*[A-Za-z\[\]<>|"]\+\s\+#' docs/ tests/ stdlib/ lib/ --include=*.agency --include=*.md`

Known: the two test files, and `docs/site/guide/llm.md:52-53`. Treat the grep output as authoritative over this list — migrate everything it finds.

- [ ] **Step 3: Migrate `jsonSchemaWithDescription.agency`**

```
@jsonSchema({ format: "email" })
type Email = string

type User = {
  @jsonSchema({ description: "primary contact address" })
  contact: Email
}

node main() {
  const s = schema(User)
  const js = s.toJSONSchema()
  return js.properties.contact.format + "|" + js.properties.contact.description
}
```

The `.test.json` expectation is unchanged.

Run: `pnpm run a test tests/agency/validation/jsonSchemaWithDescription.test.json` → passes.

- [ ] **Step 4: Migrate `unionAndDescriptions.agency`**

```
type Sentiment = {
  @jsonSchema({ description: "The overall sentiment" })
  sentiment: "positive" | "negative" | "neutral",
  @jsonSchema({ description: "A confidence score from 0 to 100" })
  confidence: number
}
```

Note the comma. The `#` form ran to end-of-line and did not need one.

Run: `pnpm run a test tests/agency/typeHints/unionAndDescriptions.test.json` → passes.

- [ ] **Step 5: Migrate `docs/site/guide/llm.md:52-53`**

```ts
type Response = {
  @jsonSchema({ description: "the capital city of the country" })
  capital: string,
  @jsonSchema({ description: "the population of the capital city" })
  population: number
}
```

- [ ] **Step 6: Commit the migrations separately**

```bash
git add tests/ docs/site/guide/llm.md
git commit -m "test,docs: migrate # property descriptions to @jsonSchema"
```

Separate commit so a bad parser removal can be reverted without losing migrations.

- [ ] **Step 7: Write the permanent regression test**

The previous draft verified this with a scratch file and deleted the evidence. Create `lib/parsers/hashRemoved.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

describe("# is no longer a property description", () => {
  it("rejects a # description in a record type", () => {
    const result = parseAgency(`type A = { x: number # a description }\n`, {}, false, false);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `pnpm test:run lib/parsers/hashRemoved.test.ts` → FAIL (the syntax still parses).

- [ ] **Step 9: Remove the parser**

Delete `objectPropertyDescriptionParser` and `objectPropertyWithDescriptionParser` (`lib/parsers/parsers.ts:1224-1242`) and their wiring at `:1270` and `:1359`. Read the surrounding `or(...)` alternations before deleting so the rest stays intact.

- [ ] **Step 10: Run parser tests**

Run: `pnpm test:run lib/parsers/ 2>&1 | tee /tmp/parsers.log` → all pass. Delete any test asserting on `#` descriptions.

- [ ] **Step 11: Commit**

```bash
git add lib/parsers/
git commit -m "feat: remove deprecated # property-description syntax"
```

---

## Task 2: The Hole node and expression-position parsing

The node carries `sort` and `splice` from the start even though this task only produces `sort: "expr"`, so later tasks add parser cases rather than reshaping the node.

**Files:** create `lib/types/hole.ts`, `lib/parsers/hole.test.ts`; modify `lib/types.ts`, `lib/parsers/parsers.ts`

**Interfaces produced:**
- `type HoleSort = "expr" | "statements" | "identifier" | "decl"`
- `type Hole = { type: "hole"; name: string; sort: HoleSort; splice: boolean; typeAnnotation?: VariableType; loc: SourceLocation }`
- `holeParser: Parser<Hole>`, `LEGAL_IDENTIFIER: RegExp` — both exported from `lib/parsers/parsers.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/parsers/hole.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { holeParser } from "./parsers.js";

describe("holeParser", () => {
  it("parses a bare hole", () => {
    const r = holeParser("#prompt");
    expect(r.success).toBe(true);
    expect(r.result).toMatchObject({ type: "hole", name: "prompt", sort: "expr", splice: false });
  });

  it("parses a type annotation", () => {
    const r = holeParser("#prompt: string");
    expect(r.result).toMatchObject({ typeAnnotation: { type: "primitiveType", value: "string" } });
  });

  it("parses a compound type annotation", () => {
    expect(holeParser("#items: string[] | null").success).toBe(true);
  });

  it("rejects a space after the sigil", () => {
    expect(holeParser("# prompt").success).toBe(false);
  });

  it("rejects a hole with no name", () => {
    expect(holeParser("#").success).toBe(false);
  });

  it("rejects a name starting with a digit", () => {
    expect(holeParser("#123").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test:run lib/parsers/hole.test.ts` → FAIL, `holeParser` not exported.

- [ ] **Step 3: Define the node**

Create `lib/types/hole.ts`:

```typescript
import type { SourceLocation } from "./base.js";
import type { VariableType } from "./typeHints.js";

/** The syntactic category of thing that can fill a hole. Determined by the
 *  hole's position; never written by the user. */
export type HoleSort = "expr" | "statements" | "identifier" | "decl";

/** A gap in a template. A program containing one cannot be compiled or run. */
export type Hole = {
  type: "hole";
  name: string;
  sort: HoleSort;
  /** True for `#...name`, which expands to a sequence. */
  splice: boolean;
  typeAnnotation?: VariableType;
  loc: SourceLocation;
};
```

Add `export type { Hole, HoleSort } from "./types/hole.js";` to `lib/types.ts` and `| Hole` to the `AgencyNode` union (ends at `:371`).

- [ ] **Step 4: Export the shared identifier regex**

In `lib/parsers/parsers.ts`, immediately after `varNameChar` (`:184-186`):

```typescript
/** The identifier grammar as a regex: the leading `letter | "_"` of
 *  variableNameParser, then varNameChar. Single source — the generator and
 *  the template filler both import this rather than restating it. */
export const LEGAL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
```

- [ ] **Step 5: Write the parser**

Add near `variableNameParser` (`:842`). No `optionalSpaces` between `#` and the name — that is what makes `# prompt` fail:

```typescript
export const holeParser: Parser<Hole> = label(
  "a hole",
  memo("holeParser", (input: string) => {
    const parser = seqC(
      char("#"),
      capture(variableNameParser, "name"),
      optional(seqC(optionalSpaces, char(":"), optionalSpaces, capture(typeHintParser, "typeAnnotation"))),
    );
    const result = parser(input);
    if (!result.success) return result;
    return success(
      {
        type: "hole" as const,
        name: result.captures.name.value,
        sort: "expr" as const,
        splice: false,
        typeAnnotation: result.captures.typeAnnotation,
        loc: locOf(input, result.rest),
      },
      result.rest,
    );
  }),
);
```

Copy `loc` construction and capture reading from the nearest neighbouring parser; the helpers vary and the neighbour is more reliable than this sketch.

- [ ] **Step 6: Wire into expression parsing — both alternations**

Add `holeParser` to the top-level expression `or(...)`, before `literalParser`.

**Then check the binary-operator operand parser.** The binop parser does precedence climbing with its own operand parsing (`docs/dev/binop-parser.md`), so wiring the expression alternation may not make `#a + 1` parse. Read `lib/parsers/parsers.ts:2925-2945` and the operand parser it calls, and wire `holeParser` there too if it is separate.

- [ ] **Step 7: Add operand-position tests**

Append to `lib/parsers/hole.test.ts`:

```typescript
import { parseAgency } from "../parser.js";

function parses(source: string): boolean {
  return parseAgency(source, {}, false, false).success;
}

describe("holes in operand positions", () => {
  it("parses on the left of a binary operator", () => {
    expect(parses(`node main() {\n  const x = #a + 1\n}\n`)).toBe(true);
  });
  it("parses inside a condition", () => {
    expect(parses(`node main() {\n  if (#cond) {\n    return 1\n  }\n}\n`)).toBe(true);
  });
  it("parses as a call argument", () => {
    expect(parses(`node main() {\n  f(#arg)\n}\n`)).toBe(true);
  });
  it("parses as a named-argument value", () => {
    // guard(maxTime: #minutes) — the guard-template composition depends on this.
    expect(parses(`node main() {\n  guard(maxTime: #minutes) {\n    print(1)\n  }\n}\n`)).toBe(true);
  });
});
```

- [ ] **Step 8: Run tests**

Run: `pnpm test:run lib/parsers/hole.test.ts` → PASS, all nine.

- [ ] **Step 9: Commit**

```bash
git add lib/types/hole.ts lib/types.ts lib/parsers/parsers.ts lib/parsers/hole.test.ts
git commit -m "feat: Hole AST node and expression-position parsing"
```

---

## Task 3: Formatter round-trip

The round trip is load-bearing: Task 18 makes printed source the serialization format for `Code`. Establishing it now means every later parser position gets a round-trip test as it lands.

**Files:** modify `lib/backends/agencyGenerator.ts`; create `lib/backends/agencyGenerator.hole.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { _parseAST } from "../stdlib/agency.js";
import { generateAgency } from "./agencyGenerator.js";

export function roundTrip(source: string): string {
  return generateAgency(_parseAST(source));
}

describe("generateAgency: holes", () => {
  it("prints a bare hole", () => {
    expect(roundTrip(`node main() {\n  const x = #prompt\n}\n`)).toContain("#prompt");
  });
  it("prints an annotated hole", () => {
    expect(roundTrip(`node main() {\n  const x = #p: string\n}\n`)).toContain("#p: string");
  });
  it("prints a compound annotation", () => {
    expect(roundTrip(`node main() {\n  const x = #p: string[] | null\n}\n`)).toContain("#p: string[] | null");
  });
  it("is stable across two round trips", () => {
    const once = roundTrip(`node main() {\n  const x = #prompt\n}\n`);
    expect(roundTrip(once)).toBe(once);
  });
});
```

The two-round-trip test catches generators that print something parseable but different.

- [ ] **Step 2: Run to confirm failure** → FAIL, no `hole` case.

- [ ] **Step 3: Add the generator case**

In the dispatch switch (cases start around `:442`) add `case "hole": return formatHole(node);` and:

```typescript
import { LEGAL_IDENTIFIER } from "../parsers/parsers.js";

function formatHole(node: Hole): string {
  const sigil = node.splice ? "#..." : "#";
  const name = LEGAL_IDENTIFIER.test(node.name) ? node.name : `"${node.name}"`;
  const annotation = node.typeAnnotation ? `: ${formatTypeHint(node.typeAnnotation)}` : "";
  return `${sigil}${name}${annotation}`;
}
```

Use the same type-formatting helper the neighbouring cases use; do not add a second one.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.hole.test.ts
git commit -m "feat: format holes so templates round-trip"
```

---

## Task 4: Statement-position holes and the tie-break

A hole alone on a line sits in expression-statement position, which is both a legal statement and a legal expression. **Rule: a bare hole occupying an entire statement has sort `statements`; a hole is `expr` only inside a larger expression.**

**Files:** modify `lib/parsers/parsers.ts`, `lib/parsers/hole.test.ts`, `lib/backends/agencyGenerator.hole.test.ts`

- [ ] **Step 1: Write the failing tests**

Use `walkNodesArray` rather than a hand-rolled walker:

```typescript
import { walkNodesArray } from "../utils/node.js";

function firstHole(source: string): any {
  const ast = parseAgency(source, {}, false, false);
  if (!ast.success) throw new Error(ast.message);
  return walkNodesArray(ast.result.nodes)
    .map((visit) => visit.node)
    .find((node) => node.type === "hole");
}

describe("hole sort by position", () => {
  it("bare hole on its own line is a statements hole", () => {
    expect(firstHole(`node main() {\n  #setup\n}\n`).sort).toBe("statements");
  });
  it("hole in a call argument is an expr hole", () => {
    expect(firstHole(`node main() {\n  f(#setup)\n}\n`).sort).toBe("expr");
  });
  it("hole on the right of an assignment is an expr hole", () => {
    expect(firstHole(`node main() {\n  const x = #setup\n}\n`).sort).toBe("expr");
  });
});
```

- [ ] **Step 2: Run to confirm failure** → the first case FAILS with `"expr"`.

- [ ] **Step 3: Add the parser**

```typescript
export const statementHoleParser: Parser<Hole> = memo(
  "statementHoleParser",
  map(holeParser, (hole) => ({ ...hole, sort: "statements" as const })),
);
```

- [ ] **Step 4: Wire it ahead of expression statements**

Add to the statement alternation **before** the alternative that parses a bare expression as a statement. Order is the tie-break. (The parser-ordering exemption in `docs/dev/anti-patterns.md` covers this; it is deliberate, so say so in a comment.)

- [ ] **Step 5: Run tests** → PASS.

- [ ] **Step 6: Add the round-trip test**

```typescript
it("round-trips a statement hole", () => {
  const once = roundTrip(`node main() {\n  #setup\n}\n`);
  expect(once).toContain("#setup");
  expect(roundTrip(once)).toBe(once);
});
```

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/ lib/backends/agencyGenerator.hole.test.ts
git commit -m "feat: statement-position holes with position-based sort tie-break"
```

---

## Task 5: Identifier and declaration holes

Generating `def #name()` produces a function whose name comes from data; no expression hole can do that, because a name is not a value. `decl` covers function, node, and type declarations **and import statements**, since one import per selected tool is a primary use case. It excludes bare top-level statements, `static` blocks, and top-level callbacks, each of which has initialisation ordering a generated program should not reach into.

**Files:** modify `lib/parsers/parsers.ts`, `lib/parsers/hole.test.ts`, `lib/backends/agencyGenerator.hole.test.ts`

- [ ] **Step 1: Check what an import specifier actually holds**

Before writing anything, run `pnpm run ast` on a file containing `import std::fs { read }` and read the `importedNames` shape. It may hold plain strings or `{ name, alias }` records rather than nodes. **Task 12 replaces an identifier hole with a `variableName` node, so if specifiers are not nodes, the identifier-hole fill for this position needs a different replacement shape.** Write down what you find; Task 12 Step 3 depends on it.

Also check whether import statements carry `loc` — the lint work found they historically did not, and the round-trip tests may trip on it.

- [ ] **Step 2: Write the failing tests**

```typescript
it("hole in a def name is an identifier hole", () => {
  expect(firstHole(`def #name(): number {\n  return 1\n}\n`).sort).toBe("identifier");
});
it("hole in a node name is an identifier hole", () => {
  expect(firstHole(`node #n() {\n  return 1\n}\n`).sort).toBe("identifier");
});
it("hole in an import specifier is an identifier hole", () => {
  expect(firstHole(`import std::fs { #tool }\n`).sort).toBe("identifier");
});
it("hole at top level is a decl hole", () => {
  expect(firstHole(`#helpers\n\nnode main() {\n  return 1\n}\n`).sort).toBe("decl");
});
```

If these prove order-sensitive — `firstHole` returns whichever alternation won — split them into separate single-hole sources rather than fighting the walk order.

- [ ] **Step 3: Add the parsers and wire at four sites**

```typescript
export const identifierHoleParser: Parser<Hole> = memo(
  "identifierHoleParser",
  map(holeParser, (hole) => ({ ...hole, sort: "identifier" as const })),
);
export const declHoleParser: Parser<Hole> = memo(
  "declHoleParser",
  map(holeParser, (hole) => ({ ...hole, sort: "decl" as const })),
);
```

Wire `identifierHoleParser` into function-definition names, node-definition names, and the import-specifier list. Wire `declHoleParser` into the top-level program-body alternation **only** — not block bodies, which is what keeps `decl` out of the excluded positions.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Add round-trip tests for all three positions**

```typescript
for (const source of [
  `def #name(): number {\n  return 1\n}\n`,
  `node #n() {\n  return 1\n}\n`,
  `import std::fs { #tool }\n`,
]) {
  it(`round-trips: ${source.split("\n")[0]}`, () => {
    const once = roundTrip(source);
    expect(roundTrip(once)).toBe(once);
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/ lib/backends/agencyGenerator.hole.test.ts
git commit -m "feat: identifier-position and declaration-position holes"
```

---

## Task 6: Splices and quoted names

`#...items` expands to a sequence. `#"hi-there"` allows names that are not legal identifiers, which matters because hole names often come from schema field names.

**The quotes are around the hole's name and nothing else.** `#"field-name"` is an ordinary hole whose name contains a hyphen. Quoting changes neither sort nor type, and specifically does not relax what may fill an `identifier` hole — the filler still becomes a name in the generated program, while the hole's name never appears there.

**Splices are only legal where a sequence makes sense:** statement position, top-level declaration position, and argument lists. A splice anywhere else is a parse error. Without this rule `const x = #...items` parses and then behaves unpredictably at fill time.

**Files:** modify `lib/parsers/parsers.ts`, `lib/parsers/hole.test.ts`, `lib/backends/agencyGenerator.hole.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe("splices and quoted names", () => {
  it("parses a splice", () => {
    expect(holeParser("#...items").result).toMatchObject({ name: "items", splice: true });
  });
  it("parses a quoted name", () => {
    expect(holeParser(`#"hi-there"`).result).toMatchObject({ name: "hi-there", splice: false });
  });
  it("parses a quoted splice", () => {
    expect(holeParser(`#..."tool-imports"`).result).toMatchObject({ name: "tool-imports", splice: true });
  });
  it("rejects a quoted name containing a space", () => {
    expect(holeParser(`#"hi there"`).success).toBe(false);
  });
  it("rejects an empty quoted name", () => {
    expect(holeParser(`#""`).success).toBe(false);
  });
  it("rejects a splice with no name", () => {
    expect(holeParser("#...").success).toBe(false);
  });
  it("rejects a splice in expression position", () => {
    expect(parses(`node main() {\n  const x = #...items\n}\n`)).toBe(false);
  });
  it("allows a splice in statement position", () => {
    expect(parses(`node main() {\n  #...steps\n}\n`)).toBe(true);
  });
  it("allows a splice in an argument list", () => {
    expect(parses(`node main() {\n  f(#...args)\n}\n`)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure** → the nine new cases FAIL.

- [ ] **Step 3: Extend `holeParser`**

After `char("#")`, optionally consume `...` setting `splice`; then take either `variableNameParser` or a quoted name of one-or-more characters that are neither whitespace nor `"`. Use an existing tarsec combinator for the character class — check the imports at the top of `lib/parsers/parsers.ts` rather than adding a dependency.

- [ ] **Step 4: Restrict splice by position**

The base `holeParser` accepts `splice`; the position-specific wrappers reject it where a sequence is meaningless. In the expression alternation, wrap with a parser that fails when `splice` is true, and leave `statementHoleParser` and `declHoleParser` permissive.

**Argument lists need their own wiring.** Argument lists parse their elements *via* the expression parser, so the splice-rejecting wrapper above would swallow `f(#...args)` too. Add a splice-permitting hole alternative to the argument-list parser itself, ordered before the general expression parse of an argument. If the `f(#...args)` test fails after this step, this ordering is the first place to look.

- [ ] **Step 5: Run tests** → PASS, all fifteen.

- [ ] **Step 6: Add round-trip tests**

```typescript
it("round-trips a splice", () => {
  const once = roundTrip(`node main() {\n  #...steps\n}\n`);
  expect(once).toContain("#...steps");
  expect(roundTrip(once)).toBe(once);
});
it("round-trips a quoted name, keeping the quotes", () => {
  const once = roundTrip(`node main() {\n  const x = #"hi-there"\n}\n`);
  expect(once).toContain(`#"hi-there"`);
  expect(roundTrip(once)).toBe(once);
});
```

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/ lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.hole.test.ts
git commit -m "feat: splice holes and quoted hole names"
```

---

## Task 7: Pipeline tolerance and AG8001

A hole flows through `SymbolTable.build`, `buildCompilationUnit`, and `TypescriptPreprocessor` before reaching `TypeScriptBuilder`. If any of those throws on an unknown node kind, the refusal surfaces as the wrong error with no indication of which stage to fix. Each stage gets its own test.

**The test format.** The runner's `expectedCompileError` (merged, #662) expresses "this file fails to compile, and the failure says X": a file-level field in `.test.json`, substring-matched against the compile subprocess's output, with the fixture excluded from the precompile pass. Working examples live at `tests/agency/expectedCompileError/` — note the dir-local `agency.json` there, which the AG8001 fixture will also need if the refusal path depends on config. Use **both** levels here: vitest tests against `compileSource` for the fast, per-stage assertions, plus one `.test.json` fixture (`tests/agency/templates/unfilledHoles.test.json` with `"expectedCompileError": "AG8001"`) proving the user-level refusal end to end.

**Where the code actually lives on an error.** Do not assume `toThrow(/AG8001/)` will match: `diagnostic()` builds errors with `code` and `message` as *separate fields* (`lib/typeChecker/diagnostics.ts:672-687`), and the registry templates contain no codes — the two are only joined by `formatErrors` at print time. `compileSource` (`lib/compiler/compile.ts:96`) returns a `CompileResult` rather than throwing, so assert on the result's error entries and their `code` fields, not on exception text.

**Files:** modify `lib/typeChecker/diagnostics.ts`, `lib/backends/typescriptBuilder.ts`; create `lib/backends/holeRefusal.test.ts`

- [ ] **Step 1: Add the AG8 category**

In `lib/typeChecker/diagnostics.ts`, append to `DIAGNOSTIC_CATEGORIES` (ends `:598`):

```typescript
{ prefix: "AG8", slug: "templates", title: "Code templates and holes" },
```

`AG1`–`AG7` are taken; `AG8` is free. The registry is append-only.

- [ ] **Step 2: Add the diagnostics**

```typescript
unfilledHoles: {
  code: "AG8001",
  severity: "error",
  message: "This file is a template with unfilled holes ({names}) and cannot be run directly. Load it with `loadTemplate` and fill it first.",
},
holeNeedsTypeAnnotation: {
  code: "AG8002",
  severity: "error",
  message: "The hole `#{name}` is in a position that gives it no expected type. Annotate it, for example `#{name}: string`.",
},
```

`{names}` is plural, so the check must **collect every hole before throwing**, not throw on the first one it meets. That means a pre-pass over the program, not a `processNode` case that throws — see Step 4.

- [ ] **Step 3: Write the failing tests**

Create `lib/backends/holeRefusal.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { compileSource } from "../compiler/compile.js";

const oneHole = `node main(): string {\n  const p: string = #text\n  return p\n}\n`;
const twoHoles = `node main(): string {\n  const a: string = #x\n  const b: string = #y\n  return a + b\n}\n`;

describe("a program with holes refuses to compile", () => {
  it("fails with AG8001", () => {
    const result = compileSource(oneHole, options);
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("AG8001");
  });
  it("names the unfilled hole", () => {
    const result = compileSource(oneHole, options);
    expect(result.errors.map((error) => error.message).join("\n")).toContain("#text");
  });
  it("names every unfilled hole, not just the first", () => {
    const result = compileSource(twoHoles, options);
    const messages = result.errors.map((error) => error.message).join("\n");
    expect(messages).toContain("#x");
    expect(messages).toContain("#y");
  });
});
```

Check `compileSource`'s real result shape and options in `lib/compiler/compile.ts:96` before writing these — the field names above (`success`, `errors`, `code`, `message`) are a sketch to adjust, but the principle is fixed: assert codes against the `code` field, never against message text (see the paragraph above).

- [ ] **Step 4: Add the pre-pass**

Before codegen, collect holes with `walkNodesArray` and raise `AG8001` naming all of them. Add a `case "hole":` in `processNode` too, throwing an internal error saying the pre-pass should have caught this — a hole reaching codegen is a bug in the pre-pass, not a user error.

- [ ] **Step 4b: Add the execution fixture**

Create `tests/agency/templates/unfilledHoles.agency`:

```
node main(): string {
  const prompt: string = #text
  return prompt
}
```

and `tests/agency/templates/unfilledHoles.test.json`:

```json
{
  "expectedCompileError": "AG8001",
  "description": "A template with unfilled holes refuses to compile and names the hole"
}
```

Copy the dir-local `agency.json` pattern from `tests/agency/expectedCompileError/` if the diagnostic only surfaces under a config flag. Run: `pnpm run a test tests/agency/templates/unfilledHoles.test.json` → 1 passing.

- [ ] **Step 5: Add per-stage tolerance tests**

```typescript
describe("pipeline stages tolerate holes", () => {
  it("SymbolTable.build does not throw on a hole", () => { /* build a symbol table over oneHole */ });
  it("buildCompilationUnit does not throw on a hole", () => { /* ... */ });
  it("TypescriptPreprocessor does not throw on a hole", () => { /* ... */ });
});
```

Fill these in against the real signatures. Each stage must either tolerate a hole or produce its own named diagnostic; a raw crash is a failure.

- [ ] **Step 6: Run tests** → PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/typeChecker/diagnostics.ts lib/backends/
git commit -m "feat: AG8001 — a program with unfilled holes refuses to compile"
```

---

## Task 8: The `Code` type and fragment parsing

See Decision 1. `Code` extends the existing `AST` with a fragment kind, because a bare expression is not a parseable program and an `expr` hole must be fillable with `Code`.

**Files:** create `lib/stdlib/template.ts`, `lib/stdlib/template.test.ts`; modify `stdlib/agency.agency`, `lib/parsers/parsers.ts` (export the expression and statement-list entry points if not already exported)

**Interfaces produced:**
- `_parseExpr(source: string): Code` — `kind: "expr"`, exactly one node
- `_parseStatements(source: string): Code` — `kind: "statements"`
- `_toSource(code: Code): string`
- Agency: `type Code`, `parseExpr`, `parseStatements`, `toSource`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { _parseExpr, _parseStatements, _toSource } from "./template.js";

describe("fragment parsing", () => {
  it("parses a bare expression, which is not a valid program", () => {
    const code = _parseExpr("42");
    expect(code.kind).toBe("expr");
    expect(code.nodes).toHaveLength(1);
  });
  it("parses a call expression", () => {
    expect(_parseExpr("getPrompt()").kind).toBe("expr");
  });
  it("parses a binary expression", () => {
    expect(_parseExpr("a + b").kind).toBe("expr");
  });
  it("rejects a statement passed to parseExpr", () => {
    expect(() => _parseExpr("const x = 1")).toThrow();
  });
  it("parses a statement list", () => {
    const code = _parseStatements("const x = 1\nprint(x)");
    expect(code.kind).toBe("statements");
    expect(code.nodes.length).toBeGreaterThan(1);
  });
  it("round-trips a fragment through toSource", () => {
    expect(_toSource(_parseExpr("a + b")).trim()).toBe("a + b");
  });
});
```

- [ ] **Step 2: Run to confirm failure** → module does not exist.

- [ ] **Step 3: Export the entry points from the parser**

`lib/parsers/parsers.ts` already has an expression parser and a statement parser used inside block bodies. Export them if they are not exported. Do **not** write new grammar — reuse what block-body parsing uses, or the fragment grammar will drift from the real one.

- [ ] **Step 4: Write the wrappers**

```typescript
import type { AgencyNode } from "../types.js";

export type Code = {
  type: "agencyProgram";
  kind: "program" | "statements" | "expr";
  nodes: AgencyNode[];
  docComment?: unknown;
};

export function _parseExpr(source: string): Code {
  const result = expressionParser(source.trim());
  if (!result.success || result.rest.trim() !== "") {
    throw new Error(`Not a single Agency expression: ${source}`);
  }
  return { type: "agencyProgram", kind: "expr", nodes: [result.result] };
}
```

The `result.rest` check is what makes `_parseExpr("const x = 1")` fail rather than silently parsing a prefix.

- [ ] **Step 5: Run tests** → PASS.

- [ ] **Step 6: Expose to Agency**

In `stdlib/agency.agency`, define `Code` alongside the existing `AST` (`:420-424`) and note in a comment that `Code` is `AST` plus a fragment kind. Export `parseExpr`, `parseStatements`, `toSource` with terse docstrings — they become tool descriptions.

- [ ] **Step 7: `make`** → builds clean. (Not `pnpm run build`, which skips stdlib.)

- [ ] **Step 8: Commit**

```bash
git add lib/stdlib/template.ts lib/stdlib/template.test.ts lib/parsers/parsers.ts stdlib/agency.agency
git commit -m "feat: Code type with fragment kinds and fragment parsing"
```

---

## Task 9: `loadTemplate` and `holesOf`

**Files:** create `lib/runtime/template/holes.ts`; modify `lib/stdlib/template.ts`, `lib/stdlib/template.test.ts`, `stdlib/agency.agency`

**`holesOf` returns structured entries, not bare names.** The primary consumer filling holes is a model, and a model needs to know what each hole accepts — its sort (can this take a string, or must it be an identifier?) and its type. With names alone that knowledge lives in prose in a prompt. The shape:

```typescript
export type HoleInfo = {
  name: string;
  sort: HoleSort;
  splice: boolean;
  /** The hole's printed type ("number", "string[] | null"), or null when no
   *  type applies (statements/decl/identifier holes) or none is known yet.
   *  This task fills it from the hole's own annotation only; Task 15 adds
   *  position-inferred types. */
  type: string | null;
};
```

Print `type` with the same formatter the generator uses (`formatTypeHint`) so the strings match what a user would write. One entry per name, first occurrence wins — filling a name fills every occurrence, so `holesOf` reports names, not occurrences.

- [ ] **Step 1: Write the failing tests**

Cover the success path, the empty case, deduplication, and both error paths:

```typescript
it("lists holes in source order with sort, splice, and annotated type", () => {
  // template body: `#setup` then `const x = #value: number`
  expect(_holesOf(code)).toEqual([
    { name: "setup", sort: "statements", splice: false, type: null },
    { name: "value", sort: "expr", splice: false, type: "number" },
  ]);
});
it("returns an empty list when there are none", () => { /* ... */ });
it("lists a duplicated hole name once, first occurrence winning", () => { /* two #x → one entry */ });
it("fails on a file that does not parse", () => { /* expect throw */ });
it("fails on a file that does not exist", () => { /* expect throw */ });
```

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Write the hole finder over `walkNodesArray`**

```typescript
import { walkNodesArray } from "../../utils/node.js";
import type { Hole } from "../../types.js";
import type { Code } from "../../stdlib/template.js";

/** Every hole in the tree, in source order, including duplicates.
 *  Built on walkNodesArray (`lib/utils/node.ts:570`), the single source for
 *  AST walking — see the comment at `lib/stdlib/agency.ts:262`. */
export function findHoles(code: Code): Hole[] {
  return walkNodesArray(code.nodes)
    .map((visit) => visit.node)
    .filter((node): node is Hole => node.type === "hole");
}

/** Distinct hole names, in first-appearance order. Internal — fill's
 *  arity checks need only names; the public surface is holeInfos. */
export function holeNames(code: Code): string[] {
  const all = findHoles(code).map((hole) => hole.name);
  return all.filter((name, index) => all.indexOf(name) === index);
}

/** One HoleInfo per distinct name, first occurrence winning. */
export function holeInfos(code: Code): HoleInfo[] {
  const names = holeNames(code);
  return names.map((name) => {
    const hole = findHoles(code).find((candidate) => candidate.name === name) as Hole;
    return {
      name,
      sort: hole.sort,
      splice: hole.splice,
      type: hole.typeAnnotation ? formatTypeHint(hole.typeAnnotation) : null,
    };
  });
}
```

Note `holeNames` uses a filter-on-first-index rather than an accumulate-and-push loop.

**One thing to check:** a hole has no children worth visiting, and descending into one is how nested templates would become representable. If `walkNodesArray` supports pruning, prune at holes. If it does not, that is acceptable here (holes have no child nodes), but say so in a comment so nobody adds one later.

- [ ] **Step 4: Write the wrappers**

```typescript
export function _loadTemplate(dir: string, filename: string): Code {
  const target = resolveInSandbox(dir, filename, { mustExist: true });
  const program = _parseAST(readFileSync(target, "utf-8"));
  return { ...program, kind: "program" };
}
export function _holesOf(code: Code): HoleInfo[] {
  return holeInfos(code);
}
```

Export `resolveInSandbox` from `lib/stdlib/agency.ts` rather than reimplementing path resolution — sandbox containment, symlinks, and `..` rules all live there.

- [ ] **Step 5: Run tests** → PASS.

- [ ] **Step 6: Expose to Agency**

Follow `writeAST` (`stdlib/agency.agency:438`), including its double-`return interrupt` idiom:

```
export def loadTemplate(dir: string, filename: string): Result<Code> {
  """
  Load an Agency file containing holes as a template.

  @param dir - The sandbox directory
  @param filename - The template file, resolved relative to dir
  """
  return interrupt std::read("Can I read this template?", {
    dir: dir,
    filename: filename
  })
  return try _loadTemplate(dir, filename)
}

export type HoleInfo = {
  name: string,
  sort: "expr" | "statements" | "identifier" | "decl",
  splice: boolean,
  type: string | null
}

export idempotent def holesOf(template: Code): HoleInfo[] {
  """
  The unfilled holes in a template, in the order they appear. Each entry has the hole's name, its sort (what category of thing fills it), whether it is a splice, and its type when one is known.

  @param template - A template loaded with loadTemplate
  """
  return _holesOf(template)
}
```

Reading raises `std::read`, matching every other read in the module, so the same file policy governs it.

- [ ] **Step 7: `make`** → builds clean.

- [ ] **Step 8: Commit**

```bash
git add lib/runtime/template/holes.ts lib/stdlib/template.ts lib/stdlib/template.test.ts stdlib/agency.agency
git commit -m "feat: loadTemplate and holesOf"
```

---

## Task 10: `fill` and the lifting rule

**This is the security-critical task.**

- Plain values lift to literal nodes and are **never** parsed.
- `Code` values graft as trees, with fragment kind checked against hole sort.
- Nothing is ever parsed as Agency source.

**Fill order composes both ways — this is the feature's core workflow, so protect it.** A partially filled template is an ordinary `Code` value, and grafting it into another template carries its remaining holes along: the walk sees them, `holesOf` reports them, and a later `fill` on the combined value completes them. Build the shape first, parameterize last — wrap a body in a guard while `#minutes` is still open, graft the guarded block into a main node, and fill `#minutes` at the end. Nothing implements this specially; it falls out of holes being real nodes that survive grafting. But because it is the workflow this feature exists for, it gets its own test (Step 1) so no future change — a "reject Code containing holes" guard added in the name of safety, say — can quietly kill it. Note the corollary: "nested templates are rejected" means a hole *inside* a hole, not holey code grafted into a template; and since filling a name fills every occurrence, a grafted hole sharing a name with an outer hole is filled together with it, deliberately.

**Files:** create `lib/runtime/template/literals.ts`, `lib/runtime/template/lift.ts`, `lib/runtime/template/fill.ts`, `lib/runtime/template/fill.test.ts`; modify `lib/types/base.ts`, `lib/stdlib/template.ts`, `stdlib/agency.agency`

- [ ] **Step 1: Write the failing tests, injection first**

The tests need a from-string loader that no other task builds. Add it to `lib/stdlib/template.ts` in this step — it is three lines, and every later test file uses it:

```typescript
export function _loadTemplateFromString(source: string): Code {
  return { ..._parseAST(source), kind: "program" };
}
```

```typescript
function fillAndPrint(source: string, values: Record<string, unknown>): string {
  return _toSource(fillHoles(_loadTemplateFromString(source), values));
}

describe("fillHoles: lifting", () => {
  it("lifts a string filler to a string literal, never parsing it", () => {
    const out = fillAndPrint(`node main() {\n  const x = #v\n}\n`, { v: `readFile("/etc/passwd")` });
    expect(out).toContain(`"readFile(\\"/etc/passwd\\")"`);
    expect(out).not.toMatch(/=\s*readFile\(/);
  });

  // These must distinguish a value from its string form. `toContain("42")`
  // passes whether 42 was lifted to a number literal or wrongly to "42".
  it("lifts a number as a number, not a string", () => {
    const out = fillAndPrint(`node main() {\n  const x = #v\n}\n`, { v: 42 });
    expect(out).toContain("= 42");
    expect(out).not.toContain(`"42"`);
  });
  it("lifts a boolean as a boolean", () => {
    const out = fillAndPrint(`node main() {\n  const x = #v\n}\n`, { v: true });
    expect(out).toContain("= true");
    expect(out).not.toContain(`"true"`);
  });
  it("lifts an array of numbers, not of strings", () => {
    const out = fillAndPrint(`node main() {\n  const x = #v\n}\n`, { v: [1, 2] });
    expect(out).toContain("[1, 2]");
    expect(out).not.toContain(`"1"`);
  });

  it("fills every occurrence of a repeated name", () => { /* two #v, expect two 7s */ });
  it("rejects a value for a hole that does not exist", () => { /* expect throw naming it */ });
  it("allows a partial fill, leaving other holes in place", () => { /* expect "#y" in output */ });
  it("composes: filling the result of a partial fill empties the holes", () => {
    const once = fillHoles(template, { x: 1 });
    expect(holeNames(fillHoles(once, { y: 2 }))).toEqual([]);
  });
});

describe("fillHoles: holey Code grafts and completes later", () => {
  // The motivating workflow: build the shape first, parameterize last.
  // Uses the guard/main templates from the design discussion verbatim.
  it("grafts a partially filled template and fills its holes afterward", () => {
    const guardTpl = _loadTemplateFromString(`guard(maxTime: #minutes) {\n  #body\n}\n`);
    const mainTpl = _loadTemplateFromString(`node main() {\n  #body\n}\n`);

    const body = _parseStatements(`print("fetching news")`);
    const guarded = fillHoles(guardTpl, { body: body });     // #minutes still open
    const program = fillHoles(mainTpl, { body: guarded });   // grafting holey Code is legal

    // The grafted hole is visible on the combined value...
    expect(holeInfos(program)).toMatchObject([{ name: "minutes", sort: "expr" }]);

    // ...and a later fill completes it.
    const done = fillHoles(program, { minutes: 120000 });
    expect(holeInfos(done)).toEqual([]);
    const out = _toSource(done);
    expect(out).toContain("guard(maxTime: 120000)");
    expect(out).toContain(`print("fetching news")`);
  });
});

describe("fillHoles: fragment kinds", () => {
  it("grafts an expr fragment into an expr hole", () => { /* _parseExpr("a + b") */ });
  it("grafts a statements fragment into a statements hole", () => { /* ... */ });
  it("rejects an expr fragment in a statements hole", () => { /* expect throw */ });
  it("rejects a statements fragment in an expr hole", () => { /* expect throw */ });
});
```

The first test's negative assertion is the real check — it fails if anyone makes fill parse its input.

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Add filler origin to `SourceLocation`**

Per Decision 2, in `lib/types/base.ts`:

```typescript
export type SourceLocation = {
  // ... existing fields ...
  /** Set by template filling so an error in generated code can name whether
   *  the template author or the filler is responsible. */
  origin?: { kind: "template" | "filler"; name: string };
};
```

- [ ] **Step 4: Write typed literal constructors**

Create `lib/runtime/template/literals.ts`. This exists so the literal node shapes have **one** owner rather than being hand-assembled with `as unknown as AgencyNode` casts scattered through the lifter:

```typescript
export function stringLiteral(value: string, loc: SourceLocation): Literal { ... }
export function numberLiteral(value: number, loc: SourceLocation): Literal { ... }
export function booleanLiteral(value: boolean, loc: SourceLocation): Literal { ... }
export function nullLiteral(loc: SourceLocation): Literal { ... }
export function arrayLiteral(items: AgencyNode[], loc: SourceLocation): AgencyArray { ... }
export function objectLiteral(entries: { key: string; value: AgencyNode }[], loc: SourceLocation): AgencyObject { ... }
export function identifierNode(name: string, loc: SourceLocation): VariableNameLiteral { ... }
```

**Confirm every shape with `pnpm run ast`** on a file containing the corresponding literal. Only the string shape is known (`segments: [{ type: "text", value }]`, `delimiter: '"'`, per `lib/parsers/literals.test.ts`). If the real types in `lib/types/` are precise enough, these functions should typecheck without casts; if a cast is genuinely needed, one cast in one file beats six spread across the lifter.

- [ ] **Step 5: Write the lifter**

```typescript
/** Turn a plain runtime value into a literal AST node.
 *  MUST NEVER PARSE. A string becomes a string literal containing exactly
 *  those characters — this is what stops a filler injecting code. */
export function liftValue(value: unknown, loc: SourceLocation): AgencyNode {
  if (value === null || value === undefined) return nullLiteral(loc);
  if (typeof value === "string") return stringLiteral(value, loc);
  if (typeof value === "number") return numberLiteral(value, loc);
  if (typeof value === "boolean") return booleanLiteral(value, loc);
  if (Array.isArray(value)) return arrayLiteral(value.map((item) => liftValue(item, loc)), loc);
  if (typeof value === "object") {
    return objectLiteral(
      Object.keys(value as object).map((key) => ({
        key,
        value: liftValue((value as Record<string, unknown>)[key], loc),
      })),
      loc,
    );
  }
  throw new Error(`Cannot lift a value of type ${typeof value} into a template.`);
}
```

- [ ] **Step 6: Write `fillHoles`**

```typescript
export function fillHoles(code: Code, values: Record<string, unknown>): Code {
  const present = holeNames(code);
  for (const name of Object.keys(values)) {
    if (!present.includes(name)) {
      throw new Error(
        `\`${name}\` is not a hole in this template. Its holes are: ${present.join(", ") || "(none)"}.`,
      );
    }
  }
  return { ...code, nodes: substituteNodes(code.nodes, values) };
}
```

`substituteNodes` maps over a node array, replacing holes and spreading splice results into the surrounding sequence. `nodesFor(hole, value)` returns the nodes for one fill:

```typescript
function nodesFor(hole: Hole, value: unknown): AgencyNode[] {
  const loc = { ...hole.loc, origin: { kind: "filler" as const, name: hole.name } };
  if (isCode(value)) {
    assertKindMatchesSort(value as Code, hole);
    return (value as Code).nodes;
  }
  return [liftValue(value, loc)];
}
```

`assertKindMatchesSort` maps `expr` sort to `expr` kind, `statements` sort to `statements` or `program` kind, and `decl` sort to `program` kind, throwing a message naming both otherwise.

**A missing `kind` means `"program"`.** The `parseAST` escape hatch (Decision 1) hands `fill` an old-shape `AST` value with no `kind` field, so `assertKindMatchesSort` must not treat `undefined` as a mystery: normalize it to `"program"`, which is what `parseAST` semantically returns. Add a test — fill a `statements` hole with the result of `_parseAST("const x = 1")` (no `kind`) and expect it to graft, and fill an `expr` hole with the same value and expect the kind-mismatch error naming `program`.

- [ ] **Step 7: Run tests** → PASS. **If the injection test fails, stop.** Everything downstream depends on it.

- [ ] **Step 8: Expose to Agency**

```
export idempotent def fill(template: Code, values: Record<string, Json | Code>): Result<Code> {
  """
  Fill holes in a template. Plain values become literals; Code values are grafted. Filling some holes returns a template with the rest still in it.

  @param template - A template loaded with loadTemplate
  @param values - A record mapping hole names to values
  """
  return try _fill(template, values)
}
```

The value type must admit `Code`. `Json` alone contradicts the grafting case — check how `Record<string, X | Y>` is spelled in this language before writing it, and if union value types are not supported in a record type, use the widest type that admits both and say why in a comment.

- [ ] **Step 9: `make`, then commit**

```bash
git add lib/types/base.ts lib/runtime/template/ lib/stdlib/template.ts stdlib/agency.agency
git commit -m "feat: fill with the lifting rule — fillers are never parsed"
```

---

## Task 11: The string-escaping battery

**Why this is its own task.** The security property is not just "the filler becomes a literal in the AST". It is that the filler **stays inert through print → re-parse in the subprocess**, and that depends entirely on the generator's string escaping.

Agency strings have interpolation (`${...}`, per `lib/parsers/literals.test.ts:19-24`). `liftValue` builds `segments: [{ type: "text", value }]`. If the generator prints a text segment containing `${` without escaping it, a filler like `"${ readFile(\"x\") }"` re-parses in the subprocess as an **interpolation** — code execution through the door the lifting rule locked. This is the same tier of importance as the Task 10 injection test.

**Files:** create `lib/runtime/template/escaping.test.ts`

- [ ] **Step 1: Write the battery**

```typescript
const nasty = [
  `${"${"} readFile("x") }`,   // interpolation opener
  `plain "quotes" inside`,
  `back\\slash`,
  `newline\nin the middle`,
  `unicode   null`,
  `#notAHole`,
  "`backtick`",
  `\${nested \${deeper}}`,
];

describe("filler strings survive print and re-parse unchanged", () => {
  for (const value of nasty) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      const filled = fillHoles(templateWithOneExprHole, { v: value });
      const printed = _toSource(filled);
      const reparsed = _parseAST(printed);
      expect(stringLiteralValueOf(reparsed)).toBe(value);
    });
  }
});
```

Write `stringLiteralValueOf` to dig out the literal's value from the re-parsed AST and assert it equals the original **exactly**. A test that only checks the program still parses is not enough — a mangled-but-parseable string is exactly the bug.

- [ ] **Step 2: Run it.** These may all already pass: the generator's escaping (`lib/backends/agencyGenerator.ts:95-120`) already handles `\\`, `\n`, `\t`, `\r`, `\0`, and escapes `$` precisely when followed by `{` — the comment there explains the bare-`$` case. If everything passes, do not go hunting for a bug; commit the battery as regression coverage and move on. It earns its keep by failing the moment anyone touches that escaping code.

- [ ] **Step 3: Fix the generator's text-segment escaping — only if Step 2 found failures**

Extend the escaping at `lib/backends/agencyGenerator.ts:95-120` for whichever cases failed. Changing the `$` handling affects every string the formatter prints, not just filled ones, so run the full formatter test file after any change here.

- [ ] **Step 4: Run tests** → PASS for every case.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/template/escaping.test.ts lib/backends/agencyGenerator.ts
git commit -m "test: filler strings stay inert through print and re-parse"
```

---

## Task 12: Identifier-hole validation

The one exception to the lifting rule, and therefore the only place an injection can happen. An identifier hole takes a plain string and uses it as a **name**.

Three things must be rejected: strings that are not legal identifiers, **reserved words**, and the **hygiene prefix**.

**Files:** modify `lib/runtime/template/fill.ts`, `lib/runtime/template/fill.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
const template = `import std::fs { #tool }\n\nnode main() {\n  return 1\n}\n`;

it("accepts a legal identifier", () => { expect(fillAndPrint(template, { tool: "readFile" })).toContain("readFile"); });
it("accepts a leading underscore", () => { expect(fillAndPrint(template, { tool: "_hidden" })).toContain("_hidden"); });
it("rejects an injection attempt", () => {
  expect(() => fillHoles(t, { tool: "x } import evil" })).toThrow(/not a legal identifier/);
});
it("rejects a leading digit", () => { expect(() => fillHoles(t, { tool: "1st" })).toThrow(/not a legal identifier/); });
it("rejects a non-string", () => { expect(() => fillHoles(t, { tool: 42 })).toThrow(/not a legal identifier/); });
it("rejects a reserved word", () => { expect(() => fillHoles(t, { tool: "if" })).toThrow(/reserved word/); });
it("rejects the hygiene prefix", () => { expect(() => fillHoles(t, { tool: "__hyg1_x" })).toThrow(/reserved/); });
```

Without the reserved-word check, `fill(t, { name: "if" })` produces `def if()`, which explodes at re-parse in the subprocess with an error far from its cause.

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Add validation**

```typescript
import { LEGAL_IDENTIFIER } from "../../parsers/parsers.js";
import { RESERVED_PREFIX } from "./hygiene.js";

function identifierNodeFor(hole: Hole, value: unknown): AgencyNode {
  if (typeof value !== "string" || !LEGAL_IDENTIFIER.test(value)) {
    throw new Error(`\`${String(value)}\` is not a legal identifier, so it cannot fill \`#${hole.name}\`.`);
  }
  if (RESERVED_WORDS.includes(value)) {
    throw new Error(`\`${value}\` is a reserved word, so it cannot fill \`#${hole.name}\`.`);
  }
  if (value.startsWith(RESERVED_PREFIX)) {
    throw new Error(`\`${value}\` uses the reserved prefix \`${RESERVED_PREFIX}\`, so it cannot fill \`#${hole.name}\`.`);
  }
  return identifierNode(value, { ...hole.loc, origin: { kind: "filler", name: hole.name } });
}
```

Find the existing keyword list rather than writing a new one — the parse error in Task 1 Step 8 listed the keywords, and the linter or checker almost certainly has the array already. Import it.

Branch to this at the top of `nodesFor` when `hole.sort === "identifier"`. **Use the specifier shape you recorded in Task 5 Step 1** — if import specifiers hold plain strings rather than nodes, return the right shape for that position instead of `identifierNode`.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/template/fill.ts lib/runtime/template/fill.test.ts
git commit -m "feat: validate identifier fillers — grammar, reserved words, hygiene prefix"
```

---

## Task 13: Filling splices

Splice *parsing* is tested in Task 6; nothing yet calls `fill` on a `#...items` hole. Since "one import per selected tool" is the headline use case, this is the feature's main scenario with no fill-time coverage at all.

**Files:** modify `lib/runtime/template/fill.ts`, `lib/runtime/template/fill.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe("filling splices", () => {
  const tpl = `#...imports\n\nnode main() {\n  return 1\n}\n`;

  it("expands to as many items as the array has", () => {
    const filled = fillHoles(load(tpl), {
      imports: ["readFile", "grep"].map((name) =>
        fillHoles(load(`import std::fs { #tool }\n`), { tool: name }),
      ),
    });
    const out = _toSource(filled);
    expect(out).toContain("readFile");
    expect(out).toContain("grep");
    expect(out.match(/^import /gm)?.length).toBe(2);
  });

  it("expands an empty array to nothing", () => {
    const out = _toSource(fillHoles(load(tpl), { imports: [] }));
    expect(out).not.toContain("import");
  });

  it("rejects a non-array for a splice", () => {
    expect(() => fillHoles(load(tpl), { imports: "readFile" })).toThrow(/needs an array/);
  });

  it("splices statements into a statement list", () => {
    const out = _toSource(fillHoles(load(`node main() {\n  #...steps\n}\n`), {
      steps: [_parseStatements("print(1)"), _parseStatements("print(2)")],
    }));
    expect(out).toContain("print(1)");
    expect(out).toContain("print(2)");
  });

  it("splices into an argument list", () => {
    const out = _toSource(fillHoles(load(`node main() {\n  f(#...args)\n}\n`), {
      args: [_parseExpr("1"), _parseExpr("2")],
    }));
    expect(out).toContain("f(1, 2)");
  });
});
```

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Implement the splice branch**

In `nodesFor`'s caller, when `hole.splice` is true, require an array and flat-map each element through `nodesFor`. The array branch of `substituteNodes` spreads the results into the surrounding sequence rather than nesting them.

- [ ] **Step 4: Run tests** → PASS. Pay attention to the argument-list case; if the generator prints `f(1, 2)` differently, match its real output rather than loosening the assertion.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/template/
git commit -m "feat: fill splice holes"
```

---

## Task 14: Hygiene

**The bug.** Given:

```
node main() {
  const tmp = getApiKey()
  const result = #userExpr
  print(result)
}
```

filling `#userExpr` with an expression mentioning `tmp` would, under plain substitution, silently read the API key.

**What collides with what.** Two drafts of this plan got this wrong in two different ways, so read carefully. Capture happens when a filler's **free name** — a name it uses but does not bind — lands on a template **binder**. Comparing binders to binders misses that, because `tmp` used as an expression binds nothing. But the binder-to-binder comparison the first draft used was also catching something real that must not be lost: a filler *declaring* a name the template already declares produces a duplicate declaration in the completed program. There are three collision sets, and all of them are computed against the binders **visible at the hole's position** — not every binder in the file:

1. binders visible at the hole ∩ the filler's free names → rename the **template's** binder (the filler meant something else by that name)
2. the filler's binders ∩ binders visible at the hole → rename the **filler's** binder (the template keeps its spelling; the filler owns the noise)
3. the same name bound by more than one filler grafted into the same scope → rename each filler's binder to a **distinct** fresh name

**Scope-awareness is not optional, and a flat rename map cannot express it.** "Visible at the hole" means the hole's enclosing scope chain, which `walkNodesArray` yields as `scopes`. A `tmp` bound in `def a` does not collide with a hole in `def b`, and — the other direction — a rename of `def b`'s `tmp` must not touch `def a`'s. A `Record<string, string>` applied to the whole template cannot make that distinction: the scope has to be part of the rename itself. Each template-side rename therefore carries the scope it applies in, and `applyRenames` walks with scopes and rewrites a name only inside that scope's subtree (stopping at any inner scope that rebinds the same name, which shadows it). Filler-side renames stay flat maps — a filler is one fragment grafted into one place, so its whole tree is the scope.

**Renames apply to the thing that owns the name.** Cases 2 and 3 rename within each filler, before grafting. Case 1 renames within the template, inside the affected scope only.

**Why the names look like they do.** Identifiers are ASCII only (`lib/parsers/parsers.ts:184-186`, `:842-849`), so `tmp·1` — the obvious untypeable choice — fails to lex, breaking every renamed program at re-parse. The scheme is `__hyg<n>_<original>`, plus `fill` rejecting inputs that already use the prefix, which restores impossibility-by-construction.

**Files:** create `lib/runtime/template/hygiene.ts`, `lib/runtime/template/hygiene.test.ts`; modify `lib/runtime/template/fill.ts`

**Interfaces produced:**
- `RESERVED_PREFIX = "__hyg"`
- `bindersOf(code: Code): string[]` — all binders in a fragment (used for filler sides, where the fragment is the scope)
- `freeNamesOf(code: Code): string[]` — `variableName` uses not bound within the fragment
- `type ScopedRename = { scopeNode: AgencyNode; from: string; to: string }` — `scopeNode` is the node that owns the scope the rename applies in (the enclosing `def`/`node`/block), taken from `walkNodesArray`'s `scopes`
- `computeRenames(template: Code, fillers: Record<string, Code>): { template: ScopedRename[]; fillers: Record<string, Record<string, string>> }`
- `applyScopedRenames(code: Code, renames: ScopedRename[]): Code` — rewrites `from` only within `scopeNode`'s subtree, stopping at inner scopes that rebind `from`
- `applyRenames(code: Code, renames: Record<string, string>): Code` — flat version, for fillers
- `assertNoReservedPrefix(code: Code, what: string): void`

- [ ] **Step 1: Write the failing tests**

```typescript
describe("hygiene", () => {
  const capture = `node main() {\n  const tmp = getApiKey()\n  const result = #userExpr\n  print(result)\n}\n`;

  it("renames the template binder when a filler uses that name", () => {
    const out = fillAndPrint(capture, { userExpr: _parseExpr("tmp") });
    expect(out).toContain("__hyg");
    expect(out).not.toMatch(/const tmp = getApiKey/);
  });

  it("leaves non-colliding names alone", () => {
    const out = fillAndPrint(capture, { userExpr: _parseExpr("42") });
    expect(out).toContain("const tmp = getApiKey()");
    expect(out).not.toContain("__hyg");
  });

  it("gives two colliding fillers distinct fresh names", () => {
    const out = fillAndPrint(`node main() {\n  #setup\n  #cleanup\n}\n`, {
      setup: _parseStatements("const tmp = 1"),
      cleanup: _parseStatements("const tmp = 2"),
    });
    const names = [...out.matchAll(/const (\w+)\b/g)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);   // distinct — not both __hyg1_tmp
  });

  it("renames when a filler collides with a function parameter", () => {
    const out = fillAndPrint(`def f(tmp: number): number {\n  return #e\n}\n`, {
      e: _parseExpr("tmp"),
    });
    expect(out).toContain("__hyg");
  });

  it("renames when a filler collides with a for-loop binder", () => {
    const out = fillAndPrint(`node main() {\n  for item in xs {\n    print(#e)\n  }\n}\n`, {
      e: _parseExpr("item"),
    });
    expect(out).toContain("__hyg");
  });

  it("renames a filler binder that redeclares a template binder", () => {
    const source = `node main() {\n  const tmp = getApiKey()\n  #setup\n  print(tmp)\n}\n`;
    const out = fillAndPrint(source, { setup: _parseStatements("const tmp = 99") });
    // The template keeps its spelling; the filler's duplicate is renamed.
    expect(out).toContain("const tmp = getApiKey()");
    expect(out).toMatch(/const __hyg\d+_tmp = 99/);
    expect(out).toContain("print(tmp)");
  });

  it("does not rename an unrelated same-named binder in another function", () => {
    const source = `def a(): number {\n  const tmp = 1\n  return tmp\n}\n\ndef b(): number {\n  const tmp = 2\n  return #e\n}\n`;
    const out = fillAndPrint(source, { e: _parseExpr("tmp") });
    // Both directions, so this cannot pass vacuously: `def a` is untouched
    // AND `def b`'s binder actually got renamed.
    expect(out).toContain("const tmp = 1");
    expect(out).toContain("return tmp");
    expect(out).not.toMatch(/const tmp = 2/);
    expect(out).toMatch(/const __hyg\d+_tmp = 2/);
  });

  it("produces names that re-parse", () => {
    const out = fillAndPrint(capture, { userExpr: _parseExpr("tmp") });
    expect(() => _parseAST(out)).not.toThrow();
  });

  it("rejects a template using the reserved prefix", () => { /* expect throw /reserved/ */ });
  it("rejects a filler using the reserved prefix", () => { /* expect throw /reserved/ */ });
});
```

The parameter and for-loop tests are what the previous draft's self-review admitted were missing and then did not add. The "does not rename an unrelated binder" test pins scope awareness — `walkNodesArray` carries `scopes`, so use them rather than renaming every matching name in the file.

The re-parse test is what would have caught the `tmp·1` mistake. Keep it.

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Write `bindersOf` and `freeNamesOf` over `walkNodesArray`**

`bindersOf` must cover **assignments, function and node parameters, and for-loop binders** — read `lib/types/assignment.ts`, `lib/types/function.ts`, and `lib/types/forLoop.ts` for the field names. `freeNamesOf` collects `variableName` uses that are not bound within the fragment itself.

Both are filters over `walkNodesArray`, not bespoke recursions.

- [ ] **Step 4: Write `computeRenames` as a declarative, scope-aware function**

This is a named function with a contract, in `hygiene.ts`, not inline mechanism at the top of `fillHoles`. The shape below is the contract; the walk details follow whatever `walkNodesArray`'s `scopes` actually provide:

```typescript
export function computeRenames(
  template: Code,
  fillers: Record<string, Code>,
): { template: ScopedRename[]; fillers: Record<string, Record<string, string>> } {
  let counter = 0;
  const fresh = (name: string): string => `${RESERVED_PREFIX}${(counter += 1)}_${name}`;

  // One walk of the template, collecting each hole that has a filler
  // together with the binders visible at its position. `visit.scopes` is
  // the enclosing scope chain; `visibleBinders` reads binder names out of
  // it, innermost last. This is the per-hole context every collision set
  // is computed against — never bindersOf(template), which is the whole
  // file and was this plan's previous mistake.
  const holeSites = walkNodesArray(template.nodes)
    .filter((visit) => visit.node.type === "hole" && visit.node.name in fillers)
    .map((visit) => ({
      hole: visit.node as Hole,
      filler: fillers[(visit.node as Hole).name],
      visible: visibleBinders(visit.scopes),   // { name, scopeNode }[]
    }));

  // Case 1: a filler's free name lands on a binder visible at its hole →
  // rename the template's binder, within its own scope only.
  const templateRenames: ScopedRename[] = holeSites.flatMap((site) =>
    site.visible
      .filter((binder) => freeNamesOf(site.filler).includes(binder.name))
      .map((binder) => ({ scopeNode: binder.scopeNode, from: binder.name, to: fresh(binder.name) })),
  );

  // Case 2: a filler declares a name already bound at its hole → rename
  // the filler's binder. Case 3: two fillers grafted into the same scope
  // bind the same name → each gets its own fresh name (the maps are
  // per-filler, so distinctness falls out of `fresh`).
  const fillerRenames = Object.fromEntries(
    holeSites.map((site) => {
      const visibleNames = site.visible.map((binder) => binder.name);
      const grafted = siblingsBinding(holeSites, site);   // names bound by other fillers in the same scope
      const clashing = bindersOf(site.filler).filter(
        (name) => visibleNames.includes(name) || grafted.includes(name),
      );
      return [site.hole.name, Object.fromEntries(clashing.map((name) => [name, fresh(name)]))];
    }),
  );

  return { template: dedupeByScopeAndName(templateRenames), fillers: fillerRenames };
}
```

`visibleBinders`, `siblingsBinding`, and `dedupeByScopeAndName` are small helpers in the same file — write them against the real `Scope` shape (`lib/utils/node.ts:401-404` shows scopes threading through the walk). Two properties are non-negotiable and each has a test above: a rename never leaks outside its scope (the `def a`/`def b` test), and two fillers never share a fresh name (the distinctness test).

`applyScopedRenames` is the same walk in reverse: rewrite occurrences of `from` only while inside `scopeNode`'s subtree, and stop descending the moment an inner scope rebinds `from` — the inner binding shadows, and renaming under it would change unrelated code.

- [ ] **Step 5: Wire into `fillHoles`**

One declarative sequence: assert no reserved prefix, compute renames, apply the scoped renames to the template and each filler's flat map to that filler, then substitute.

- [ ] **Step 6: Run tests** → PASS, all eleven.

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/template/hygiene.ts lib/runtime/template/hygiene.test.ts lib/runtime/template/fill.ts
git commit -m "feat: hygienic renaming — template binders vs filler free names"
```

---

## Task 15: Template checking — AG8002 and names after a hole

Two checker rules. `AG8002` fires when a hole has neither an expected type from its position nor an annotation. And per Decision 3, template code after a hole that references a filler-introduced name fails to resolve at template-check time — which is automatic, since the checker cannot see into a hole, but needs a test to pin it.

**Files:** modify `lib/typeChecker/` (expression checking), `lib/typeChecker/definiteReturns.ts`; create `lib/typeChecker/holes.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
it("AG8002 when a hole has no expected type and no annotation", () => {
  expect(check(`node main() {\n  const x = #mystery\n  return x\n}\n`)).toContain("AG8002");
});
it("no AG8002 when the position supplies a type", () => {
  expect(check(`node main() {\n  const x: string = #m\n  return x\n}\n`)).not.toContain("AG8002");
});
it("no AG8002 when the hole is annotated", () => {
  expect(check(`node main() {\n  const x = #m: string\n  return x\n}\n`)).not.toContain("AG8002");
});
it("a name only a filler could introduce does not resolve in the template", () => {
  expect(check(`node main() {\n  #setup\n  print(inner)\n}\n`)).toMatch(/inner/);
});
```

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Check holes in the expression path**

When the checker reaches a `hole` in checking mode, record the expected type. When it has neither an expected type nor a `typeAnnotation`, push `AG8002`.

**Do not store the expected type on the node.** The previous draft did, claiming it would travel through printing — false, since `formatHole` prints sigil, name, and annotation only, so a checkpointed and re-parsed template would lose every one. Keep it in a side table keyed by hole identity for the duration of the check, and **recompute by re-running the template check whenever a `Code` value is loaded or deserialized**. Task 17 depends on that recomputation.

**Feed the side table into `holeInfos`.** Task 9's `HoleInfo.type` covers annotated holes only; this task upgrades it: `type` is the hole's annotation if present, otherwise the position-inferred expected type from the side table, printed with the same `formatTypeHint`. That is what makes `holesOf` useful to a model — `const prompt: string = #text` reports `{ name: "text", type: "string" }` with no annotation written. Add the test:

```typescript
it("holesOf reports a position-inferred type", () => {
  const code = loadFromString(`node main() {\n  const prompt: string = #text\n  return prompt\n}\n`);
  expect(holeInfos(code)).toEqual([
    { name: "text", sort: "expr", splice: false, type: "string" },
  ]);
});
```

- [ ] **Step 4: Exempt hole-containing functions from definite returns**

In `lib/typeChecker/definiteReturns.ts`, before reporting, skip functions whose body contains a `statements` hole.

Note this check **ships at `warn`** (`lib/typeChecker/definiteReturns.ts:31,37`), so it will not fail a run at default config. Test it by setting `typechecker.definiteReturns` to `"error"` in the test's config, with a template whose **only** `return` is inside a hole:

```
node main(): number {
  #body
}
```

A fixture with an explicit `return` alongside the hole tests nothing.

- [ ] **Step 5: Add an AG8002 execution fixture**

Same pattern as Task 7 Step 4b: `tests/agency/templates/unannotatedHole.agency` containing `const x = #mystery` in a node, with a `.test.json` of `{ "expectedCompileError": "AG8002" }`.

- [ ] **Step 6: Run tests** → PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/typeChecker/ tests/agency/templates/
git commit -m "feat: AG8002 and the definite-return exemption for holes"
```

---

## Task 16: Fill-time type checking

An `expr` hole takes its type from its position; a `Code` filler's type must match. The environment is the **module scope of the completed program** — imports, top-level declarations, prelude — which the template owns and which is therefore knowable at fill time.

**Be honest about the guarantee.** This is fill-time *validation*, not Template Haskell's compile-time impossibility. A completed program can still fail its full check at `run` time. Do not try to make it stronger.

**Files:** modify `lib/runtime/template/fill.ts`, `lib/runtime/template/fill.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
const t = `node main() {\n  const prompt: string = #text\n  return prompt\n}\n`;
it("accepts a Code filler of the right type", () => { expect(fillAndPrint(t, { text: _parseExpr(`"hello"`) })).toContain(`"hello"`); });
it("rejects a Code filler of the wrong type", () => { expect(() => fillHoles(load(t), { text: _parseExpr("42") })).toThrow(/string/); });
it("accepts a plain string", () => { expect(fillAndPrint(t, { text: "hello" })).toContain(`"hello"`); });
it("rejects a plain number for a string hole", () => { expect(() => fillHoles(load(t), { text: 42 })).toThrow(/string/); });
it("names the hole in the error", () => { expect(() => fillHoles(load(t), { text: 42 })).toThrow(/#text/); });
```

- [ ] **Step 2: Run to confirm failure.**

- [ ] **Step 3: Implement**

Recompute expected types by running the template check on load (per Task 15 Step 3). In `nodesFor`, compare the filler's type against the expected type using the checker's existing assignability entry point (`lib/typeChecker/assignability.ts`). For a lifted plain value the type is immediate from its JavaScript type; for a `Code` filler, check the fragment in the module scope above. Include the hole name and both types in the message, using the `origin` stamp from Decision 2.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/template/
git commit -m "feat: fill-time type checking against the completed program's module scope"
```

---

## Task 17: Serialization — verify before building

**Check whether there is a problem before solving one.** A `Code` value is a plain JSON-serializable object with no class instances or functions, and `parseAST` results are already held across interrupts today. The state stack's registered-serializer machinery exists for values JSON cannot carry. **This task may collapse to keeping a test.**

**Files:** create `tests/agency/templates/codeAcrossCheckpoint.agency`, its template fixture, and `.test.json`; possibly modify `lib/runtime/`

- [ ] **Step 1: Write the test and run it first**

Hold a `Code` value across an interrupt so the state stack must serialize it. Assert on the **filled program's printed content**, not just `holesOf(...).length` — a hole count of zero is satisfied by a destroyed value whose walk finds nothing:

```
node main(): string {
  const tpl = loadTemplate(__dirname, "codeAcrossCheckpointTemplate.agency")
  const answer = input("continue?")
  const filled = fill(tpl, { value: 42 })
  return toSource(filled)
}
```

Expect the output to contain `const v: number = 42`. Read `docs/misc/TESTING.md` for supplying input to an interrupting node.

Run: `pnpm run a test tests/agency/templates/codeAcrossCheckpoint.test.json`

- [ ] **Step 2: Branch on the result**

**If it passes**, the task is done — commit the test as a regression guard and skip Steps 3 and 4. Do not build a serializer for a failure that does not reproduce.

**If it fails**, register a serializer following `docs/misc/stateStack.md`, using `generateAgency` to serialize and `_parseAST` to deserialize — the canonical paths (`lib/stdlib/agency.ts:192-232`), not a third representation. This works only because holes are in the real grammar, so a template prints with holes intact and re-parses to the same tree. Deserialization must also re-run the template check to recover expected types (Task 15 Step 3).

- [ ] **Step 3: Add a formatter-level test for a filled program**

```typescript
it("a filled template prints and re-parses identically", () => {
  const filled = fillHoles(load(`node main() {\n  const x = #v\n}\n`), { v: 1 });
  const once = _toSource(filled);
  expect(_toSource(_parseAST(once))).toBe(once);
});
```

- [ ] **Step 4: Commit**

```bash
git add tests/agency/templates/ lib/runtime/ lib/backends/agencyGenerator.hole.test.ts
git commit -m "test: Code values survive checkpoints"
```

---

## Task 18: End-to-end — injection, handler governance, and composition

Three properties, one task, because they share fixtures.

**Files:** `tests/agency/templates/generatedProgram*.agency`, `tests/agency/templates/composeGuarded*.agency`, `.test.json`

- [ ] **Step 1: The injection test**

Template:

```
export node main(): string {
  const label: string = #label
  return "generated:" + label
}
```

Driver — note `runCode(source)`, not `run(source, "main")`; `run` takes a `CompiledProgram` (`stdlib/agency.agency:108-110`) while `runCode` takes source (`:308`). `runCode` returns a `Result`, so unwrap it or the exact-match expectation fails:

```
node main(): string {
  const tpl = loadTemplate(__dirname, "generatedProgramTemplate.agency")
  const filled = fill(tpl, { label: "readFile(\"/etc/passwd\")" })
  const result = runCode(toSource(filled))
  return result!
}
```

Expected output: `"generated:readFile(\"/etc/passwd\")"` — the label as **data**. If the generated program instead attempts a read, the lifting rule is broken.

Check the `Result` unwrapping idiom against a neighbouring test before writing `result!`.

- [ ] **Step 2: The handler-governance test**

This is the one the feature's premise rests on, and the previous draft's filename promised it without testing it. The generated program must attempt a **guarded action**, and the parent must have a `handle` block that sees it.

**The template must not put an identifier hole in call-callee position.** An earlier draft wrote `return #tool("/etc/passwd")` — but Task 5 wires identifier holes into exactly three sites (def names, node names, import specifiers), and a callee is none of them. There, `#tool` is at best an `expr`-sort hole, so the fill would lift `"readFile"` to a *string literal* and produce `return "readFile"("/etc/passwd")`. Instead, the body takes an annotated `expr` hole and the driver builds the call with `parseExpr` — the documented author-chooses-to-parse path from Decision 1, which also makes this fixture exercise identifier fill, `Code` grafting, and handler governance in one go:

Template:

```
import std::fs { #tool }

export node main(): string {
  return #call: string
}
```

Driver: one `fill` call supplies both holes —

```
const filled = fill(tpl, {
  tool: "readFile",
  call: parseExpr("readFile(\"/etc/passwd\")")
})
```

— then run `runCode(toSource(filled))` under a parent `handle` block that rejects the read, and assert the handler fired and the child was refused. Check `readFile`'s actual name and return type in `stdlib/fs.agency` before writing the fixture, and adjust the annotation to match.

One ordering note for Task 16's checker: the `call` fragment mentions `readFile`, which only exists in the completed program's module scope *after* the `tool` identifier fill is applied. Fill-time checking of expression fragments must therefore run against the module scope with identifier and decl fills already in place — both holes are supplied in the same `fill` call, so the implementation has everything it needs; it just must apply the fills in that order before checking.

Handlers are safety infrastructure. If this test is hard to write, that is a signal worth escalating rather than skipping.

- [ ] **Step 3: The composition test — build the shape first, parameterize last**

This is the workflow the feature exists for, proven at the user level: two template files, composed while one hole is still open, filled at the end, run in a subprocess. The unit test in Task 10 guards the runtime machinery; this fixture guards the full `loadTemplate → fill → graft → fill → runCode` path a user actually types.

`tests/agency/templates/composeGuardedMain.agency` (template): `node main() {\n  #body\n}`
`tests/agency/templates/composeGuardedGuard.agency` (template): `guard(maxTime: #minutes) {\n  #body\n}` — verified: a bare `guard` block parses at top level, so this loads as an ordinary template.

Driver:

```
node main(): string {
  const guardTpl = loadTemplate(__dirname, "composeGuardedGuard.agency") with approve
  const mainTpl = loadTemplate(__dirname, "composeGuardedMain.agency") with approve

  const guarded = fill(guardTpl!, { body: parseStatements("return \"news-ok\"")! })!
  const program = fill(mainTpl!, { body: guarded })!

  // The grafted #minutes hole is still open on the composed program.
  const remaining = holesOf(program)
  if (remaining.length != 1) {
    return "wrong hole count"
  }

  const done = fill(program, { minutes: 120000 })!
  return runCode(toSource(done)) with approve
}
```

Expected output: `"news-ok"`, with a second assertion path implied by the hole count check — the test fails both if the grafted hole is lost (count 0) and if composition is rejected outright. Check the `parseStatements` unwrap and `with approve` placement against neighbouring fixtures before finalizing; the `return` inside the guard block relies on control-flow transparency (Decision 3's companion rule), which makes this fixture double as coverage for that.

- [ ] **Step 4: Run all three** → PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/templates/
git commit -m "test: end-to-end injection, handler governance, and compose-then-parameterize"
```

---

## Task 19: LSP, linter, and documentation

**Files:** `lib/lsp/`, `lib/linter/` (note: `lib/linter/`, not `lib/lint/`), `docs/site/guide/templates.md`

- [ ] **Step 1: Check what the LSP does with a template today** — expect spurious errors.

- [ ] **Step 2: Tune LSP diagnostics.** `AG8001` must not fire in the editor; it is a run-time refusal, not an editing error. `AG8002` **should** fire — an unannotated hole is a real mistake the author wants to see.

- [ ] **Step 3: Make the linter hole-aware.** Confirm no unused-variable or similar findings are caused by holes. Add a lint test using a template file.

- [ ] **Step 4: Write `docs/site/guide/templates.md`**

Cover: what a template is and why you would want one; the four sorts with an example of each; quoted names; splices; **the lifting rule stated plainly**, with the `readFile("/etc/passwd")` example showing it becomes a string; **the `parseAST` escape hatch** — that `fill(t, { v: parseAST(modelOutput) })` deliberately allows code in, and that a template author who does this has chosen to; hygiene with the API-key example and the error you get; and that a template file cannot be run directly.

Follow `docs/dev/general-writing-tips.md`: readable prose, terms defined inline, examples with real data, few emdashes.

- [ ] **Step 5: `make doc`** → `docs/site/stdlib/agency.md` picks up the new functions from their docstrings. Plain `make` leaves those pages stale, which is why this is separate.

- [ ] **Step 6: Commit**

```bash
git add lib/lsp/ lib/linter/ docs/
git commit -m "feat: LSP and linter awareness for holes, plus the templates guide"
```

---

## Self-review notes

**What changed from the previous draft, and why.** Four blocking defects were found in review and are fixed here: there was no way to make an expression-sized `Code` value (fixed by Decision 1 and Task 8, after verifying that `42` alone does not parse); hygiene compared binders to binders and renamed only the template, so it could not pass its own tests (fixed by Task 14); "bindings are local to the hole" was promised and never implemented (fixed by Decision 3, which states the rule that actually holds); and the `.test.json` runner cannot express an expected compile error, since `TestCase` at `lib/cli/test.ts:36-46` has no such field (fixed by making Task 7 vitest tests; a separate runner extension is specced at `docs/superpowers/specs/2026-07-23-test-runner-expected-compile-error.md`).

**Changed again after the second review.** Three more defects, all in the rewrite itself: hygiene's `computeRenames` returned flat name→name maps, which cannot express "rename `tmp` in `def b` but not `def a`" — the scope-blind sketch failed its own scope-awareness test (fixed: `ScopedRename` carries the scope it applies in, and all collision sets are computed against binders visible at the hole, not `bindersOf(template)`). The binder-vs-binder collision the first draft's broken comparison was accidentally covering — a filler *redeclaring* a template binder — fell out of the rewrite entirely (fixed: collision case 2, with its own test). And Task 18's handler-governance template put an identifier hole in call-callee position, which Task 5 never wires (fixed: the body takes an `expr` hole and the driver builds the call with `parseExpr`). Smaller fixes from the same review: `assertKindMatchesSort` treats a missing `kind` as `"program"` with tests; `_loadTemplateFromString` is now built in Task 10 Step 1; Task 6 says where the argument-list splice wiring goes; Task 11 no longer predicts escaping failures that the generator's existing `${`-escaping likely prevents; Task 7 asserts diagnostic codes against the `code` field, since codes are not in message text (`lib/typeChecker/diagnostics.ts:672-687`).

**Verified across both revisions:** bare expressions do not parse at top level; `TestCase` has no `expectedError`; `walkNodesArray` is at `lib/utils/node.ts:570` and its walk carries `scopes` (`:401-404`); `definiteReturns` ships at `warn` (`lib/typeChecker/definiteReturns.ts:37`); the linter is at `lib/linter/`; `docs/site/guide/llm.md:52-53` uses the removed syntax; `type AST` exists at `stdlib/agency.agency:420-424`; `compileSource` returns a result rather than throwing (`lib/compiler/compile.ts:96`); an `undefinedVariable` diagnostic exists for Task 15's name-resolution test (`lib/typeChecker/diagnostics.ts:470-473`); the generator escapes `$` exactly when followed by `{` (`lib/backends/agencyGenerator.ts:95-120`).

**Remaining risks, stated rather than hidden:**

1. **Task 5 Step 1 is a genuine unknown.** If import specifiers hold plain strings rather than nodes, Task 12's identifier fill needs a different replacement shape for that position. Do the investigation before writing either task.
2. **Task 11's escaping fix may be larger than one step.** If the generator's `$` handling escapes every dollar sign rather than the interpolation opener, changing it affects every string the formatter prints, not just filled ones. Check what existing tests say before changing it.
3. **Task 16's fill-time checking needs a checker entry point that accepts a fragment plus a module scope.** Whether one exists in a usable shape is unverified. If it does not, that is a task of its own and should be split out rather than absorbed.
4. **The `fill` values type** needs a record admitting `Json | Code`. Whether this language supports a union as a record value type is unverified; Task 10 Step 8 says to check and to document the fallback.

---

## Capture: what actually shipped (#665, merged 2026-07-24)

Written after the fact, per the dev loop's capture step. The plan above was executed task-by-task; these are the places reality differed, so the plan is not misread as a description of the code. The maintained internals doc is `packages/agency-lang/docs/dev/template-agency.md` — read that for how things work; read this for how the plan drifted.

**Corrections the code forced:**

- **Import syntax.** The plan wrote `import std::fs { #tool }` throughout; the real grammar is `import { #tool } from "std::fs"`. Every fixture uses the real form.
- **Identifier holes hold strings, not nodes.** Declaration names and import specifiers are plain `string` fields in the AST, so Task 12's `identifierNode` replacement never happened. Instead: the three fields widened to `string | Hole`, identifier fills produce validated plain strings, and a total `declaredName()` accessor (prints `#name` for holes) kept ~90 existing call sites working.
- **Layering.** Hole queries went to `lib/utils/holes.ts` (builder, checker, and runtime all need them); `Code` went to `lib/runtime/template/code.ts` to break a stdlib/runtime import cycle. `RESERVED_WORDS` had to be created — no keyword list existed anywhere.
- **Task 17 (serialization) collapsed to its Step 1 test**, exactly as the verify-first framing predicted: `Code` is plain JSON data and crosses checkpoints unchanged. No serializer was built.
- **Task 18's guard fixture reshaped.** A `return` inside `guard { }` yields the guard's VALUE — it does not escape to the enclosing node — so the composition fixture grafts a `def` through a decl hole instead. The guard's named argument is `time:`, not `maxTime:`.
- **Fill-time type checking shipped primitive-only** (plan risk 3 confirmed: no fragment-vs-module-scope checker entry point exists). AG8002 recognizes the untyped-assignment position only.

**Bugs found by the plan's own tests during execution:**

- `hole` had to be registered in `expressionSlots.ts` — the #659 completeness tripwire rejected the unregistered kind, as designed.
- The statement-hole boundary check had to accept `BLANK_LINE_SENTINEL`, not just `\n`.
- Three `walkNodes` descent gaps, each a silent hygiene hole: guardBlock head arguments (caught by the compose fixture), `tryExpression` (caught by the hole-position battery on its first run), and `isExpression` operands (caught in review). The battery in `hole.test.ts` is the standing tripwire.

**Redesigns from PR review (#665, two rounds):**

- **Object keys were an injection vector**: the AST stores keys in SOURCE form (escapes intact), so escaping was added in the `objectLiteral` constructor — NOT in `addQuotesToKey`, which would double-escape every parser-sourced key. The escaping battery grew a key-side mirror.
- **The reject-any-`__hyg`-input rule was replaced by counter seeding** (`maxHygieneIndex`): rejection cannot tell renamer-produced names from caller-supplied ones, so a second fill rejected the first fill's own renames — breaking the compose workflow this feature exists for. Identifier fillers (plain strings the seed scan cannot see) keep the rejection.
- Splices in name positions became parse errors (they were silently dropped); the decl-name capture lost its raw fallback for `#`-initial input.
- `liftValue` rejects `__proto__` keys and non-finite numbers; every dictionary keyed by user-controlled names is null-prototype with `Object.hasOwn` checks.
- Per-graft `bindersOf`/`freeNamesOf` are hoisted onto `GraftSite` (the collision loops were O(n²) with the non-colliding common case as the worst case).
- `stampOrigin` recurses (attribution was top-level-only); origin is plumbed but nothing user-facing reads it yet.
- The feature is named **Template Agency** in the guide and nav.

**Test-format note:** the AG8001/AG8002 execution fixtures use `expectedCompileError` (#662), which landed mid-plan; Task 7's vitest tests assert diagnostic codes against the report's `code` field, never thrown message text (codes and messages are separate fields joined only by `formatErrors`).
