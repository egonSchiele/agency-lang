# Compile-time Splices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `$( ... )` to Agency, which runs a generator function during compilation and pastes the `Code` value it returns into the file being compiled.

**Architecture:** A new `Splice` AST node parses in both declaration and expression position. A new expansion pass runs between parse and symbol-table construction: for each splice it checks the generator is eligible (imported from another file, effect-free, deterministic, and reachable only through Agency code), runs it in a subprocess via the existing `run` machinery, and grafts the returned nodes into the AST. Because `SymbolTable.build` reads from disk rather than from the AST, the pass writes expanded source back to the temp file while keeping the origin-stamped AST in memory for typecheck and codegen.

**Tech Stack:** TypeScript, tarsec parser combinators, vitest, existing Agency compile/run pipeline.

## Global Constraints

- **No dynamic imports.** Use static imports only.
- **Objects not maps, arrays not sets, types not interfaces.** House style, enforced by the structural linter (`pnpm run lint:structure`).
- **Dictionaries keyed by user-controlled strings must be null-prototype**, membership tested with `Object.hasOwn`. Splice names and generator names are user-controlled.
- **Never inline validators cross-module.**
- **Save test output to a file.** Tests here are slow and expensive; never re-run just to see what failed.
- **Do not run the full agency test suite locally.** Run specific fixtures only; CI runs the rest.
- **Diagnostic codes are append-only.** Splices use AG8003–AG8010. `diagnosticExplanations.ts` is exhaustive by type, so a code without prose fails the build.
- **Run `make` (not `pnpm run build`) after changing any stdlib file.**
- Commit messages and PR bodies go in a **file** passed to git, never inline on the command line.

## Decisions carried in from the spec

Read `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-24-compile-time-splices-design.md` before starting. The four rules:

1. `$( expr )` goes anywhere a declaration or an expression goes.
2. The generator must be imported from another file.
3. The generator's transitive effect list must be empty, it must not reach `llm()`/clock/randomness, and its transitive import graph may contain only `std::` imports and relative `.agency` files.
4. The returned `Code` value is pasted in and compiled as part of the file.

Four open questions the spec left for this plan, now settled:

- **Nested splices:** forbidden in v1 (AG8009). Additive to relax.
- **Legal argument expressions:** literals, code literals, and references to imported names only (AG8005 covers same-file references).
- **Detecting nondeterminism:** an internal marker riding `analyzeInterruptsFromScopes`. Task 5 begins by reading that function, because the approach is unverified.
- **Diagnostic codes:** AG8003–AG8010, assigned in Task 3.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `lib/types/splice.ts` | The `Splice` node type |
| `lib/parsers/splice.test.ts` | Parser tests for both positions |
| `lib/compiler/splice/eligibility.ts` | Is this generator allowed to run? Import graph, effects, determinism |
| `lib/compiler/splice/eligibility.test.ts` | Eligibility tests |
| `lib/compiler/splice/runGenerator.ts` | Synthesize a program, run it, return the `Code` value |
| `lib/compiler/splice/runGenerator.test.ts` | Generator execution tests |
| `lib/compiler/splice/expand.ts` | The expansion pass: find splices, run generators, graft results |
| `lib/compiler/splice/expand.test.ts` | Expansion tests |
| `tests/agency/splices/*.agency` + `.test.json` | End-to-end fixtures |

**Modified:**

| File | Change |
| --- | --- |
| `lib/types.ts` | Add `Splice` to the `AgencyNode` and `Expression` unions and to `EXPRESSION_NODE_TYPES` |
| `lib/parsers/parsers.ts` | `spliceParser`; wire into `baseAtom` |
| `lib/parser.ts` | Wire `spliceParser` into the top-level alternation |
| `lib/utils/expressionSlots.ts` | Register `splice` |
| `lib/utils/identifierSlots.ts` | Register `splice` |
| `lib/utils/bodySlots.ts` | Comment recording deliberate absence |
| `lib/backends/agencyGenerator.ts` | Format a splice so it round-trips |
| `lib/typeChecker/diagnostics.ts` | AG8003–AG8010 |
| `lib/cli/diagnosticsDocs.ts` | Explain prose for each new code |
| `lib/compiler/compile.ts` | Call the expansion pass between parse and `SymbolTable.build` |

The `lib/compiler/splice/` directory keeps the four concerns separate: deciding whether to run, running, expanding, and the node itself. Each is independently testable, and only `expand.ts` touches the pipeline.

---

### Task 1: The `Splice` AST node and its parser

**Files:**
- Create: `lib/types/splice.ts`
- Modify: `lib/types.ts` (union members and `EXPRESSION_NODE_TYPES`)
- Modify: `lib/parsers/parsers.ts` (`spliceParser`, `baseAtom` wiring)
- Modify: `lib/parser.ts` (top-level alternation)
- Modify: `lib/utils/expressionSlots.ts`, `lib/utils/identifierSlots.ts`, `lib/utils/bodySlots.ts`
- Test: `lib/parsers/splice.test.ts`

**Interfaces:**
- Produces: `type Splice = BaseNode & { type: "splice"; expression: Expression; position: "decl" | "expr" }` and `export const spliceParser: Parser<Splice>`.

**Background you need.** `CodeLiteral` (`lib/types/codeLiteral.ts`) is the closest precedent, and its parser is far harder than this one. A code literal needs an end-scan grammar because its body is arbitrary text and `|]` must not terminate early. A splice does not: its content is a single Agency **expression**, so `exprParser` already knows exactly where it ends. Use `exprParser` then expect `)`. Do not build an end-scan.

The `position` field mirrors `Hole.sort`: derived from which parser matched, never written by the user.

Read `docs/dev/template-agency.md` section "Code literals" for the leaf-ness levers. A splice is **not** a leaf: its `expression` is a real host expression that the walker must descend into, because Task 4 needs to see which names it references. This is the opposite of `codeLiteral`, so do not copy its registrations blindly.

- [ ] **Step 1: Write the failing parser tests**

Create `lib/parsers/splice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { findNodesOfType } from "../utils/walkNodes.js";
import type { Splice } from "../types.js";

function parseTemplate(source: string) {
  const result = parseAgency(source, {}, false, false);
  if (!result.success) throw new Error(result.message ?? "parse failed");
  return result.result;
}

function firstSplice(source: string): Splice {
  const found = findNodesOfType(parseTemplate(source).nodes, "splice");
  expect(found.length).toBeGreaterThan(0);
  return found[0] as Splice;
}

describe("splice parsing", () => {
  it("parses a splice in declaration position", () => {
    const s = firstSplice(`$( makeGetters(["a"]) )\n\nnode main() {\n  return 1\n}\n`);
    expect(s.position).toBe("decl");
    expect(s.expression.type).toBe("functionCall");
  });

  it("parses a splice in expression position", () => {
    const s = firstSplice(`node main() {\n  const x = $( buildTable(3) )\n  return x\n}\n`);
    expect(s.position).toBe("expr");
    expect(s.expression.type).toBe("functionCall");
  });

  it("parses a splice whose argument is a code literal", () => {
    const s = firstSplice(`$( wrap([| def f(): number { return 1 } |]) )\n`);
    expect(s.position).toBe("decl");
  });

  it("parses nested parentheses in the spliced expression", () => {
    const s = firstSplice(`node main() {\n  const x = $( f(g(1), h(2)) )\n  return x\n}\n`);
    expect(s.expression.type).toBe("functionCall");
  });

  it("rejects an empty splice", () => {
    const result = parseAgency(`$( )\n`, {}, false, false);
    expect(result.success).toBe(false);
  });

  it("leaves a dollar-paren inside a string alone", () => {
    const found = findNodesOfType(
      parseTemplate(`node main() {\n  return "cost: $( 5 )"\n}\n`).nodes,
      "splice",
    );
    expect(found).toEqual([]);
  });
});
```

If `findNodesOfType` does not exist under that name, read `lib/utils/holes.ts` — it filters over `walkNodesArray` — and use the same construction inline rather than inventing a helper.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test:run lib/parsers/splice.test.ts 2>&1 | tee /tmp/splice-parse-1.log
```

Expected: FAIL, because `"splice"` is not a known node type.

- [ ] **Step 3: Define the node type**

Create `lib/types/splice.ts`:

```ts
import { BaseNode } from "./base.js";
import type { Expression } from "../types.js";

/** A compile-time splice: `$( generatorCall(...) )`. The expression is
 *  evaluated DURING compilation and the `Code` value it returns is
 *  grafted in at this position. Unlike `CodeLiteral`, a splice is NOT a
 *  host-side leaf — `expression` is ordinary host code and the walker
 *  must descend into it, because the eligibility check needs to see
 *  which names it references. Every splice is removed by the expansion
 *  pass before codegen; reaching codegen with one is an internal error. */
export type Splice = BaseNode & {
  type: "splice";
  expression: Expression;
  /** Derived from which parser matched, never written by the user. */
  position: "decl" | "expr";
};
```

- [ ] **Step 4: Register the type in `lib/types.ts`**

Mirror how `CodeLiteral` is registered at lines 46, 68, 121, 152, and 385. Add `Splice` to the same five places: the import, the re-export, the `Expression` union, `EXPRESSION_NODE_TYPES` (add the string `"splice"`), and the `AgencyNode` union.

- [ ] **Step 5: Write the parser**

In `lib/parsers/parsers.ts`, next to `codeLiteralParser` (around line 3134):

```ts
const SPLICE_OPEN = "$(";

const spliceRest: Parser<Splice> = (input: string) => {
  const inner = seq(
    optionalSpaces,
    capture(lazy(() => exprParser), "expression"),
    optionalSpaces,
    str(")"),
  )(input);
  if (!inner.success) {
    return failure(`splice: ${inner.error}`, input);
  }
  return {
    success: true,
    result: {
      type: "splice",
      expression: inner.result.expression,
      position: "expr",
    },
    rest: inner.rest,
  };
};

/** Committed after `$(`, following codeLiteralParser: once the opener is
 *  seen no fallback may reinterpret the text, so failures inside win
 *  error reporting instead of degrading to a generic grammar message. */
export const spliceParser: Parser<Splice> = withLoc(
  committed(str(SPLICE_OPEN), spliceRest),
);

/** Top-level form. Reuses spliceParser and rewrites the position, the
 *  same way topLevelHoleParser rewrites a hole's sort. */
export const topLevelSpliceParser: Parser<Splice> = map(
  lazy(() => spliceParser),
  (s) => ({ ...s, position: "decl" as const }),
);
```

Match the exact `seq`/`capture`/`failure` spellings used by the neighbouring parsers in that file; the shapes above are illustrative of structure, not of tarsec's exact API surface.

- [ ] **Step 6: Wire the parser into both positions**

In `lib/parsers/parsers.ts`, add to `baseAtom` (line 3138). Place it immediately after `exprHoleParser`, with this comment:

```ts
  // `$(` cannot start any other expression, so this is a cheap early
  // exit like the hole parser above it. Being a baseAtom alternative
  // covers every expression position at once.
  lazy(() => spliceParser),
```

In `lib/parser.ts`, add `topLevelSpliceParser` to the top-level alternation directly after `topLevelHoleParser` (line 99), with a comment noting that the expression form is reached through `baseAtom` and this entry exists only to stamp `position: "decl"`.

- [ ] **Step 7: Register in the tripwire tables**

Three tables fail the build or a completeness test if a new node kind is missing:

- `lib/utils/expressionSlots.ts` — a splice **has** one expression slot, `expression`. Do NOT add it to the leaf table alongside `codeLiteral: true`; add a real slot entry so the walker descends. Read the file's switch and follow the shape used by a single-expression node such as `tryExpression`.
- `lib/utils/identifierSlots.ts:217` — add `splice: none`. A splice declares no identifiers of its own.
- `lib/utils/bodySlots.ts` — a splice has no body slots. Add a comment recording the deliberate absence, mirroring the `codeLiteral` comment at line 233.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
pnpm test:run lib/parsers/splice.test.ts 2>&1 | tee /tmp/splice-parse-2.log
```

Expected: PASS. Then run the walker completeness invariants, which will fail loudly if Step 7 was incomplete:

```bash
pnpm test:run lib/utils/expressionSlots.test.ts 2>&1 | tee /tmp/splice-slots.log
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/types/splice.ts lib/types.ts lib/parsers/parsers.ts lib/parsers/splice.test.ts lib/parser.ts lib/utils/expressionSlots.ts lib/utils/identifierSlots.ts lib/utils/bodySlots.ts
git commit -F /tmp/commit-splice-1.txt
```

Write the message to `/tmp/commit-splice-1.txt` first. Subject: `Splices: the Splice AST node and its parser`.

---

### Task 2: Formatter support and the round-trip gate

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Test: `lib/backends/agencyGenerator.splice.test.ts` (create)

**Interfaces:**
- Consumes: `Splice` from Task 1.
- Produces: nothing new; makes the existing round-trip gate pass.

**Background.** `lib/backends/agencyGenerator.roundtrip.test.ts` runs the whole corpus through print → re-parse and asserts structural identity plus print idempotence. A node type the formatter cannot print will fail that gate as soon as any fixture contains one. Handle formatting now rather than discovering it in Task 9.

The formatter has a `codeLiteral` case at `lib/backends/agencyGenerator.ts:589`. Read it for the surrounding conventions before adding yours.

- [ ] **Step 1: Write the failing round-trip test**

Create `lib/backends/agencyGenerator.splice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { generateAgency } from "./agencyGenerator.js";

function roundTrip(source: string): string {
  const parsed = parseAgency(source, {}, false, false);
  if (!parsed.success) throw new Error(parsed.message ?? "parse failed");
  return generateAgency(parsed.result);
}

describe("formatting splices", () => {
  it("prints a declaration splice", () => {
    const out = roundTrip(`$( makeGetters(["a", "b"]) )\n`);
    expect(out).toContain(`$( makeGetters(["a", "b"]) )`);
  });

  it("prints an expression splice", () => {
    const out = roundTrip(`node main() {\n  const x = $( build(3) )\n  return x\n}\n`);
    expect(out).toContain(`$( build(3) )`);
  });

  it("is idempotent", () => {
    const once = roundTrip(`$( makeGetters(["a"]) )\n`);
    const twice = roundTrip(once);
    expect(twice).toBe(once);
  });
});
```

Confirm the real export name of the printer entry point before running; if it is not `generateAgency`, read the top of `lib/backends/agencyGenerator.ts` and use the actual name.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test:run lib/backends/agencyGenerator.splice.test.ts 2>&1 | tee /tmp/splice-fmt-1.log
```

Expected: FAIL, with an unhandled node type.

- [ ] **Step 3: Add the formatter case**

In `lib/backends/agencyGenerator.ts`, beside the `codeLiteral` case:

```ts
      case "splice":
        // Spaces inside the parens are the canonical form: `$( f(x) )`.
        // The expression prints through the ordinary expression printer,
        // so nested calls and code-literal arguments format normally.
        return `$( ${formatExpression(node.expression)} )`;
```

Use whatever the surrounding cases call to print a nested expression; `formatExpression` is a placeholder for that real function name.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm test:run lib/backends/agencyGenerator.splice.test.ts 2>&1 | tee /tmp/splice-fmt-2.log
```

Expected: PASS.

- [ ] **Step 5: Run the round-trip gate**

```bash
pnpm test:run lib/backends/agencyGenerator.roundtrip.test.ts 2>&1 | tee /tmp/splice-roundtrip.log
```

Expected: PASS, unchanged from before this task.

- [ ] **Step 6: Commit**

```bash
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.splice.test.ts
git commit -F /tmp/commit-splice-2.txt
```

Subject: `Splices: formatter support so splices round-trip`.

---

### Task 3: Diagnostic codes AG8003–AG8010

**Files:**
- Modify: `lib/typeChecker/diagnostics.ts`
- Modify: `lib/cli/diagnosticsDocs.ts`
- Test: `lib/typeChecker/diagnosticExplanations.test.ts` (existing; it enforces exhaustiveness)

**Interfaces:**
- Produces: eight `DiagnosticName` keys that every later task refers to by name.

**Background.** `DIAGNOSTICS` in `lib/typeChecker/diagnostics.ts` maps a name to `{ code, severity, message }`. The template entries `unfilledHoles` (AG8001) and `holeNeedsTypeAnnotation` (AG8002) are at lines 581-591; read them for the message conventions, especially `{name}`-style placeholders. Codes are append-only. Explanations are exhaustive by type, so adding a code without prose in `lib/cli/diagnosticsDocs.ts` is a compile error, which is the forcing function keeping them in sync.

Doing this before the checks that raise them means later tasks never invent a code inline.

- [ ] **Step 1: Add the diagnostic entries**

In `lib/typeChecker/diagnostics.ts`, after `holeNeedsTypeAnnotation`:

```ts
  spliceGeneratorHasEffects: {
    code: "AG8003",
    severity: "error",
    message:
      "The generator `{name}` raises {effects} and cannot run at compile time. Compile-time generators must be effect-free.",
  },
  spliceGeneratorNondeterministic: {
    code: "AG8004",
    severity: "error",
    message:
      "The generator `{name}` reaches {source}, so it could produce different code on different builds. Compile-time generators must be deterministic.",
  },
  spliceGeneratorNotImported: {
    code: "AG8005",
    severity: "error",
    message:
      "`{name}` must be imported from another file to be used in a splice. A generator cannot be defined in the file that splices it, because it has to be compiled first.",
  },
  spliceGeneratorReachesNonAgency: {
    code: "AG8006",
    severity: "error",
    message:
      "The generator `{name}` reaches non-Agency code through `{importPath}`. Compile-time generators may import only `std::` modules and relative `.agency` files, because JavaScript and TypeScript raise no effects and cannot be checked.",
  },
  spliceFragmentKindMismatch: {
    code: "AG8007",
    severity: "error",
    message:
      "The generator `{name}` returned a `{actual}` fragment, but this splice is in {position} position and needs a `{expected}` fragment.",
  },
  spliceGeneratorFailed: {
    code: "AG8008",
    severity: "error",
    message: "The generator `{name}` failed while running: {reason}",
  },
  spliceNested: {
    code: "AG8009",
    severity: "error",
    message:
      "A generator module cannot itself contain a splice. Move the inner generation into a separate module.",
  },
  spliceReferencesOuterName: {
    code: "AG8010",
    severity: "error",
    message:
      "Generated code refers to `{name}`, which it neither declares nor imports. Generated code may use only names it declares itself and names it imports.",
  },
```

- [ ] **Step 2: Run the exhaustiveness test to verify it fails**

```bash
pnpm test:run lib/typeChecker/diagnosticExplanations.test.ts 2>&1 | tee /tmp/splice-diag-1.log
```

Expected: FAIL or a TypeScript compile error naming the eight codes with no explanation prose.

- [ ] **Step 3: Add explanation prose**

In `lib/cli/diagnosticsDocs.ts`, add an entry per code. Read an existing AG8xxx entry first for the house shape. Each explanation should say what happened, why the rule exists, and what to do. For example, for AG8003:

> A compile-time generator ran, or would have run, code that raises an interrupt effect — reading a file, writing one, hitting the network, and so on.
>
> Compilation refuses to run effectful code. Unlike a normal program run, there are no handlers installed while compiling, so there is nothing to approve or reject an effect against, and a build that quietly touched the filesystem would be a surprise.
>
> Move the effectful work out of the generator. If the generator needs data from a file, read the file in your program at run time instead, or pass the data in as a plain argument to the splice.

Write the other seven in the same register.

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm test:run lib/typeChecker/diagnosticExplanations.test.ts 2>&1 | tee /tmp/splice-diag-2.log
```

Expected: PASS.

- [ ] **Step 5: Verify explain renders them**

```bash
pnpm run agency explain AG8003 2>&1 | tee /tmp/splice-explain.log
```

Expected: the prose from Step 3.

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker/diagnostics.ts lib/cli/diagnosticsDocs.ts
git commit -F /tmp/commit-splice-3.txt
```

Subject: `Splices: diagnostic codes AG8003-AG8010`.

---

### Task 4: The import-graph eligibility check

**Files:**
- Create: `lib/compiler/splice/eligibility.ts`
- Test: `lib/compiler/splice/eligibility.test.ts`

**Interfaces:**
- Consumes: AG8005, AG8006 from Task 3.
- Produces:

```ts
export type EligibilityFailure = { diagnostic: DiagnosticName; params: Record<string, string> };

/** Walk the generator module's transitive Agency import graph. Returns a
 *  failure if any edge leaves Agency code. */
export function checkImportGraph(entryPath: string, config: AgencyConfig): EligibilityFailure | null;

/** Find which module a splice's generator comes from. Returns the
 *  resolved absolute path, or AG8005 when the name is not imported —
 *  which covers both a generator defined in the host file and one that
 *  does not exist at all. Rule 2 lives here. */
export function resolveGeneratorModule(
  program: AgencyProgram,
  generatorName: string,
  hostPath: string,
): { path: string } | { failure: EligibilityFailure };
```

**Background.** This is the check that makes the whole safety argument hold, so it deserves care. TypeScript raises no interrupts, and there is a live path to it: a plain JS/TS package like `zod` "passes through untouched" when imported (`docs/dev/pkg-imports.md:14`). If a generator can reach `zod`, the effect check in Task 5 means nothing.

**Transitive is the operative word.** Checking only the generator's own file is not enough, because a local `.agency` file it imports could pull in `zod` one level down. The test for that case exists specifically to prove the check is not shallow.

Allowed edges: `std::` imports, and relative paths ending in `.agency`. Everything else fails, including `pkg::`, which is excluded from v1 because a package can itself reach JavaScript.

Before writing, read `lib/compiler/compileClosure.ts` — it already walks the import closure for the build manifest, and reusing its edge extraction is better than writing a second walker that can drift from it.

- [ ] **Step 1: Write the failing tests**

Create `lib/compiler/splice/eligibility.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkImportGraph } from "./eligibility.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "splice-elig-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, source: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, source, "utf-8");
  return p;
}

describe("checkImportGraph", () => {
  it("allows a generator importing only std::", () => {
    const gen = write("gen.agency", `import { fill } from "std::agency"\n\nexport def g(): number {\n  return 1\n}\n`);
    expect(checkImportGraph(gen, {})).toBeNull();
  });

  it("allows a generator importing a relative .agency file", () => {
    write("helper.agency", `export def h(): number {\n  return 2\n}\n`);
    const gen = write("gen.agency", `import { h } from "./helper.agency"\n\nexport def g(): number {\n  return h()\n}\n`);
    expect(checkImportGraph(gen, {})).toBeNull();
  });

  it("rejects a generator importing a JS/TS package directly", () => {
    const gen = write("gen.agency", `import { z } from "zod"\n\nexport def g(): number {\n  return 1\n}\n`);
    const failure = checkImportGraph(gen, {});
    expect(failure?.diagnostic).toBe("spliceGeneratorReachesNonAgency");
    expect(failure?.params.importPath).toBe("zod");
  });

  it("rejects a JS/TS package reached one level down", () => {
    // The check must be TRANSITIVE. gen.agency itself looks clean.
    write("helper.agency", `import { z } from "zod"\n\nexport def h(): number {\n  return 1\n}\n`);
    const gen = write("gen.agency", `import { h } from "./helper.agency"\n\nexport def g(): number {\n  return h()\n}\n`);
    const failure = checkImportGraph(gen, {});
    expect(failure?.diagnostic).toBe("spliceGeneratorReachesNonAgency");
    expect(failure?.params.importPath).toBe("zod");
  });

  it("rejects pkg:: imports in v1", () => {
    const gen = write("gen.agency", `import { t } from "pkg::toolbox"\n\nexport def g(): number {\n  return 1\n}\n`);
    expect(checkImportGraph(gen, {})?.diagnostic).toBe("spliceGeneratorReachesNonAgency");
  });

  it("terminates on an import cycle", () => {
    write("a.agency", `import { b } from "./b.agency"\n\nexport def a(): number {\n  return b()\n}\n`);
    const gen = write("b.agency", `import { a } from "./a.agency"\n\nexport def b(): number {\n  return 1\n}\n`);
    expect(checkImportGraph(gen, {})).toBeNull();
  });
});

describe("resolveGeneratorModule", () => {
  function hostProgram(source: string) {
    const parsed = parseAgency(source, {}, false, false);
    if (!parsed.success) throw new Error(parsed.message ?? "parse failed");
    return parsed.result;
  }

  it("resolves a generator imported from a relative file", () => {
    write("gen.agency", `export def g(): number {\n  return 1\n}\n`);
    const host = hostProgram(`import { g } from "./gen.agency"\n\n$( g() )\n`);
    const resolved = resolveGeneratorModule(host, "g", path.join(dir, "main.agency"));
    expect("path" in resolved && resolved.path).toContain("gen.agency");
  });

  it("rejects a generator defined in the host file", () => {
    const host = hostProgram(`def g(): number {\n  return 1\n}\n\n$( g() )\n`);
    const resolved = resolveGeneratorModule(host, "g", path.join(dir, "main.agency"));
    expect("failure" in resolved && resolved.failure.diagnostic).toBe("spliceGeneratorNotImported");
  });

  it("rejects a generator that is not imported at all", () => {
    const host = hostProgram(`$( nowhere() )\n`);
    const resolved = resolveGeneratorModule(host, "nowhere", path.join(dir, "main.agency"));
    expect("failure" in resolved && resolved.failure.diagnostic).toBe("spliceGeneratorNotImported");
  });
});
```

Add `import { parseAgency } from "../../parser.js"` to the test file's imports.

The second case is Rule 2 — the stage restriction — and it is the reason this function exists rather than being inlined into the expansion pass.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/compiler/splice/eligibility.test.ts 2>&1 | tee /tmp/splice-elig-1.log
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement both functions**

Create `lib/compiler/splice/eligibility.ts`. A breadth-first walk over the import graph, visiting each file once:

```ts
export function checkImportGraph(
  entryPath: string,
  config: AgencyConfig,
): EligibilityFailure | null {
  // Paths are user-controlled, so the visited dictionary is
  // null-prototype and membership is Object.hasOwn (house pattern, see
  // lib/optimize/registry.ts).
  const visited: Record<string, true> = Object.create(null);
  const queue: string[] = [entryPath];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const resolved = path.resolve(current);
    if (Object.hasOwn(visited, resolved)) continue;
    visited[resolved] = true;

    for (const specifier of importSpecifiersOf(resolved, config)) {
      // std:: is Agency and is verified as a whole elsewhere, so it is
      // allowed but not followed.
      if (specifier.startsWith("std::")) continue;

      // Relative .agency files are Agency code: allowed AND followed,
      // which is what makes this check transitive.
      if (isRelativeAgencyPath(specifier)) {
        queue.push(path.resolve(path.dirname(resolved), specifier));
        continue;
      }

      // Everything else leaves Agency: bare npm packages (which pass
      // through untouched, see docs/dev/pkg-imports.md:14) and pkg::,
      // which is Agency but can itself reach JavaScript.
      return {
        diagnostic: "spliceGeneratorReachesNonAgency",
        params: { name: path.basename(entryPath), importPath: specifier },
      };
    }
  }
  return null;
}
```

Write `importSpecifiersOf` and `isRelativeAgencyPath` as small local helpers. For the first, read `lib/compiler/compileClosure.ts` — it already extracts import edges for the build manifest, covering plain imports, node imports, and re-exports. Reuse its extraction rather than writing a second walker that can drift from it.

`resolveGeneratorModule` reads the host program's import nodes, finds the one whose specifier list contains `generatorName`, and resolves it against `hostPath`. No match means AG8005, which correctly covers both a same-file generator and a name that does not exist.

The cycle test is what forces the `visited` set, so do not skip it.

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm test:run lib/compiler/splice/eligibility.test.ts 2>&1 | tee /tmp/splice-elig-2.log
```

Expected: PASS, all nine.

- [ ] **Step 5: Commit**

```bash
git add lib/compiler/splice/eligibility.ts lib/compiler/splice/eligibility.test.ts
git commit -F /tmp/commit-splice-4.txt
```

Subject: `Splices: transitive import-graph check for generators`.

---

### Task 5: The effect and determinism checks

**Files:**
- Modify: `lib/compiler/splice/eligibility.ts`
- Modify: `lib/compiler/splice/eligibility.test.ts`
- Possibly modify: `lib/typeChecker/index.ts` and whatever `analyzeInterruptsFromScopes` lives in

**Interfaces:**
- Consumes: AG8003, AG8004 from Task 3; `getEffectsFromSource` from `lib/compiler/typecheck.ts:161`.
- Produces:

```ts
export function checkEffects(source: string, generatorName: string): EligibilityFailure | null;
export function checkDeterminism(source: string, generatorName: string): EligibilityFailure | null;
```

**Background.** The effect half is nearly free. `getEffectsFromSource` returns `Record<string, string[]>` mapping each exported callable to its transitive effect list, and `"unknown"` is the fail-closed sentinel for a bare `interrupt(...)`. A non-empty list is a refusal.

The determinism half needs new work and its approach is **unverified**, which is why Step 1 is research rather than code. `llm()` is a language builtin and raises no interrupt (`stdlib/llm.agency` contains zero `interrupt` sites), so it is invisible to the effect map. The spec's hypothesis is that `analyzeInterruptsFromScopes` (`lib/typeChecker/index.ts:300`) is a single chokepoint for transitive propagation, so an internal marker could ride it rather than needing a separate call-graph pass.

- [ ] **Step 1: Read the propagation code and decide the approach**

Read `analyzeInterruptsFromScopes` and the type it populates. Answer in a comment at the top of your implementation: can a non-interrupt marker ride this propagation, or does determinism need its own pass? If it needs its own pass, say so and write the simpler thing — a transitive walk over the call graph looking for `llm`, the clock, and randomness. Do not force the marker approach if the code does not support it.

Also determine the actual names to look for. `llm` is a builtin; find the clock and randomness entry points by reading `stdlib/date.agency` and `stdlib/math.agency`.

- [ ] **Step 2: Write the failing tests**

Append to `lib/compiler/splice/eligibility.test.ts`:

```ts
describe("checkEffects", () => {
  it("allows a pure generator", () => {
    const src = `export def g(): number {\n  return 1\n}\n`;
    expect(checkEffects(src, "g")).toBeNull();
  });

  it("rejects a generator that reads a file", () => {
    const src = `import { read } from "std::index"\n\nexport def g(): number {\n  const c = read("x.txt")\n  return 1\n}\n`;
    const failure = checkEffects(src, "g");
    expect(failure?.diagnostic).toBe("spliceGeneratorHasEffects");
    expect(failure?.params.effects).toContain("std::read");
  });

  it("rejects a generator with a bare interrupt via the unknown sentinel", () => {
    const src = `export def g(): number {\n  return interrupt someEffect("hi", {})\n}\n`;
    const failure = checkEffects(src, "g");
    expect(failure?.diagnostic).toBe("spliceGeneratorHasEffects");
    expect(failure?.params.effects).toContain("unknown");
  });
});

describe("checkDeterminism", () => {
  it("allows a pure generator", () => {
    expect(checkDeterminism(`export def g(): number {\n  return 1\n}\n`, "g")).toBeNull();
  });

  it("rejects a generator that calls llm()", () => {
    const src = `export def g(): string {\n  return llm("write something")\n}\n`;
    const failure = checkDeterminism(src, "g");
    expect(failure?.diagnostic).toBe("spliceGeneratorNondeterministic");
    expect(failure?.params.source).toContain("llm");
  });

  it("rejects a generator that reaches llm() through a helper", () => {
    const src = `def helper(): string {\n  return llm("x")\n}\n\nexport def g(): string {\n  return helper()\n}\n`;
    expect(checkDeterminism(src, "g")?.diagnostic).toBe("spliceGeneratorNondeterministic");
  });
});
```

The third determinism test is the one that proves the check is transitive rather than a single-file grep. Do not drop it.

- [ ] **Step 3: Run to verify they fail**

```bash
pnpm test:run lib/compiler/splice/eligibility.test.ts 2>&1 | tee /tmp/splice-effects-1.log
```

Expected: FAIL on the new describes only; the Task 4 tests still pass.

- [ ] **Step 4: Implement both checks**

`checkEffects` calls `getEffectsFromSource(source)`, looks up `generatorName`, and returns a failure when the list is non-empty, joining the effect names into `params.effects`.

`checkDeterminism` implements whatever Step 1 concluded.

- [ ] **Step 5: Run to verify they pass**

```bash
pnpm test:run lib/compiler/splice/eligibility.test.ts 2>&1 | tee /tmp/splice-effects-2.log
```

Expected: PASS, all tests including Task 4's.

- [ ] **Step 6: Commit**

```bash
git add lib/compiler/splice/eligibility.ts lib/compiler/splice/eligibility.test.ts
git commit -F /tmp/commit-splice-5.txt
```

Subject: `Splices: effect and determinism checks for generators`.

---

### Task 6: Running a generator

**Files:**
- Create: `lib/compiler/splice/runGenerator.ts`
- Test: `lib/compiler/splice/runGenerator.test.ts`

**Interfaces:**
- Consumes: AG8008 from Task 3; `Splice` from Task 1.
- Produces:

```ts
export type GeneratorResult =
  | { ok: true; code: Code }
  | { ok: false; failure: EligibilityFailure };

/** Build a one-node program that evaluates `splice.expression`, run it in
 *  a subprocess, and return the Code value it produced. */
export function runGenerator(
  splice: Splice,
  importsFromHost: string,
  cwd: string,
): GeneratorResult;
```

**Background.** The compiler evaluates a splice by synthesizing a tiny program and running it through the existing compile-and-run-in-a-subprocess path, the same one `runCode` uses (`stdlib/agency.agency:318-373`).

For `$( makeGetters(["name", "age"]) )` in a file that imports `makeGetters` from `./gen.agency`, the synthesized program is:

```ts
import { makeGetters } from "./gen.agency"

node __splice(): Code {
  return makeGetters(["name", "age"])
}
```

`importsFromHost` is the host file's import lines, carried over so the generator name resolves. Print the expression with the same formatter Task 2 used, so what runs is exactly what the user wrote.

Three properties make this fit. `Code` is plain JSON, so it crosses the IPC boundary with nothing new written. `run` already takes `wallClock` and `memory`, so a looping generator becomes a bounded error rather than a hung compiler. And the unhandled-interrupt backstop is already implemented on that path.

Set conservative limits: 30 seconds and 512mb. A generator is supposed to be a pure transformation and should not need more.

- [ ] **Step 1: Write the failing tests**

Create `lib/compiler/splice/runGenerator.test.ts` with four cases: a generator returning a program fragment (assert `kind === "program"` and that `nodes` is non-empty); a generator returning an expression fragment; a generator that throws, asserting `ok: false` and `spliceGeneratorFailed`; and a generator that loops forever, asserting it returns a failure rather than hanging (give the test a 60-second timeout so a regression fails rather than stalls CI).

Write real `.agency` generator files into a temp dir, as Task 4's tests do.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/compiler/splice/runGenerator.test.ts 2>&1 | tee /tmp/splice-run-1.log
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement `runGenerator`**

```ts
const GENERATOR_WALL_CLOCK_MS = 30_000;
const GENERATOR_MEMORY_BYTES = 512 * 1024 * 1024;

export function runGenerator(
  splice: Splice,
  importsFromHost: string,
  cwd: string,
): GeneratorResult {
  // Print the expression with the SAME formatter the file round-trips
  // through, so what runs is exactly what the user wrote.
  const call = formatExpressionForSplice(splice.expression);
  const source =
    `${importsFromHost}\n\n` +
    `node __splice() {\n  return ${call}\n}\n`;

  const outcome = compileAndRunInSubprocess(source, {
    node: "__splice",
    wallClock: GENERATOR_WALL_CLOCK_MS,
    memory: GENERATOR_MEMORY_BYTES,
    cwd,
  });

  if (!outcome.ok) {
    return {
      ok: false,
      failure: {
        diagnostic: "spliceGeneratorFailed",
        params: { name: call, reason: outcome.reason },
      },
    };
  }

  // isCode checks the type tag AND Array.isArray(nodes). The array half
  // is load-bearing: Code is a plain record an Agency caller can
  // hand-build, and without it a malformed value crashes in nodes.map
  // instead of failing here. See lib/runtime/template/code.ts.
  if (!isCode(outcome.value)) {
    return {
      ok: false,
      failure: {
        diagnostic: "spliceGeneratorFailed",
        params: { name: call, reason: "did not return a Code value" },
      },
    };
  }

  return { ok: true, code: outcome.value };
}
```

`compileAndRunInSubprocess` stands for the real entry point on the path `runCode` takes. Read `stdlib/agency.agency:318-373` and follow it into `lib/stdlib/agency.ts` to find the actual function and its option names before writing this; do not invent a wrapper if one already exists.

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm test:run lib/compiler/splice/runGenerator.test.ts 2>&1 | tee /tmp/splice-run-2.log
```

Expected: PASS, all four.

- [ ] **Step 5: Commit**

```bash
git add lib/compiler/splice/runGenerator.ts lib/compiler/splice/runGenerator.test.ts
git commit -F /tmp/commit-splice-6.txt
```

Subject: `Splices: run a generator in a subprocess and return its Code`.

---

### Task 7: The expansion pass and pipeline wiring

**Files:**
- Create: `lib/compiler/splice/expand.ts`
- Test: `lib/compiler/splice/expand.test.ts`
- Modify: `lib/compiler/compile.ts:107-125`

**Interfaces:**
- Consumes: everything from Tasks 1, 4, 5, 6.
- Produces:

```ts
export type ExpandResult =
  | { ok: true; program: AgencyProgram; source: string }
  | { ok: false; failure: EligibilityFailure };

/** Replace every splice in `program` with the nodes its generator
 *  returned. `source` is the expanded program printed back out, which
 *  the caller must write to the path SymbolTable.build will read. */
export function expandSplices(
  program: AgencyProgram,
  hostPath: string,
  config: AgencyConfig,
): ExpandResult;
```

**Background — the part that is easy to get wrong.** `compileSource` writes the source to a temp file at line 105 and `SymbolTable.build(syntheticPath, config)` at line 125 reads that file **from disk**, not from the parsed AST. The symbol table records the file's own declared symbols, which is how `getEffectsFromSource` can call `symbolTable.getFile(syntheticPath)`.

So generated declarations must reach disk, or `SymbolTable` will not know that `greet` exists and name resolution will fail on every call to it.

The pass therefore produces two things that must agree:

- the expanded **AST**, which keeps `loc.origin` stamps and flows on to `buildCompilationUnit` and the typechecker
- the expanded **source**, printed from that AST, which gets written over the temp file so `SymbolTable.build` sees the new names

Print → re-parse fidelity is what makes those two agree, and the whole-corpus round-trip gate is what guarantees it. This is also why Task 2 came first.

Expansion order: expand innermost-last. A splice's own expression may contain a code literal but may **not** contain another splice, and the generator module may not contain one either (AG8009). Check for that and refuse rather than recursing.

- [ ] **Step 1: Write the failing tests**

Create `lib/compiler/splice/expand.test.ts` covering:

1. a declaration splice replaced by the generator's declarations
2. an expression splice replaced by one expression
3. a generator returning a `program` fragment into expression position → `spliceFragmentKindMismatch`
4. a splice inside a generator module → `spliceNested`
5. a splice argument referencing a host-file constant → `spliceGeneratorNotImported`
6. a splice argument that is a literal, and one that is a code literal → both allowed
7. the returned `source` re-parses to a program structurally equal to the returned `program`

Case 7 is the guard on the two-outputs-must-agree invariant. Write it as an explicit assertion, not as a side effect of another test. Cases 5 and 6 together pin the argument rule: 6 is what stops an over-strict implementation from rejecting every useful splice.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/compiler/splice/expand.test.ts 2>&1 | tee /tmp/splice-expand-1.log
```

Expected: FAIL, module not found.

- [ ] **Step 3: Implement `expandSplices`**

Find splices via the walker. For each, in this order:

1. Reject if the splice sits inside a generator module (AG8009).
2. Read the callee name off `splice.expression` and call `resolveGeneratorModule` (AG8005 if it is not imported).
3. Check the splice expression's **arguments**. Their free names must all be imported names or builtins. A reference to something declared in the host file is AG8005, for the same staging reason: the host file is not compiled yet, so its values do not exist when the generator runs. Literals and code literals are always fine. `lib/runtime/template/hygiene.ts`'s `freeNamesOf` computes what you need.
4. Run `checkImportGraph`, `checkEffects`, and `checkDeterminism` against the resolved module.
5. Run it via `runGenerator`, passing the host file's import lines and the host's directory as `cwd`.
6. Check the returned fragment kind against the splice's `position` using the same admissibility rule `fill` applies. Read `assertKindMatchesSort` in `lib/runtime/template/fill.ts` and reuse it rather than restating the rule. Mismatch is AG8007.
7. Graft.

Grafting mirrors `fill`'s two substitution modes: a declaration splice **spreads** its nodes into the top-level array, an expression splice requires exactly one node. Stamp `loc.origin` on grafted nodes the way `fill` does, so error attribution survives.

Print the result with the Task 2 formatter to produce `source`.

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm test:run lib/compiler/splice/expand.test.ts 2>&1 | tee /tmp/splice-expand-2.log
```

Expected: PASS, all seven.

- [ ] **Step 5: Wire into the pipeline**

In `lib/compiler/compile.ts`, between the parse block ending at line 116 and the import-policy check at line 118:

```ts
    // 1a. Expand compile-time splices. Runs BEFORE SymbolTable.build,
    // because generated declarations introduce names the rest of the
    // file resolves against. The expanded source is written back over
    // the temp file since SymbolTable.build reads from disk, while the
    // expanded AST (which keeps loc.origin stamps) flows on from here.
    const expanded = expandSplices(program, syntheticPath, config);
    if (!expanded.ok) {
      return { success: false, errors: [formatDiagnostic(expanded.failure)] };
    }
    fs.writeFileSync(syntheticPath, expanded.source, "utf-8");
    const program: AgencyProgram = expanded.program;
```

Rename the existing `const program` at line 116 so this reads cleanly; do not shadow. Use the codebase's real diagnostic-formatting helper instead of `formatDiagnostic` — read how the AG8001 refusal surfaces through `compileSource`'s catch for the pattern.

- [ ] **Step 6: Verify no splices means no behavior change**

```bash
pnpm test:run lib/compiler/compile.test.ts 2>&1 | tee /tmp/splice-compile.log
```

Expected: PASS, unchanged. A file with no splices must take exactly the path it took before.

- [ ] **Step 7: Commit**

```bash
git add lib/compiler/splice/expand.ts lib/compiler/splice/expand.test.ts lib/compiler/compile.ts
git commit -F /tmp/commit-splice-7.txt
```

Subject: `Splices: expansion pass wired into the compile pipeline`.

---

### Task 8: Generated code may not reach into the splice site

**Files:**
- Modify: `lib/compiler/splice/expand.ts`
- Modify: `lib/compiler/splice/expand.test.ts`

**Interfaces:**
- Consumes: AG8010 from Task 3.

**Background.** Pasting code into a file raises a capture question, and it bites hardest in expression position. A declaration splice is mostly safe by accident: a generated top-level `const config` colliding with an existing one is a duplicate declaration, which is a loud correct failure. But pasting an **expression** into a function body drops it next to local variables, and if the generated expression mentions `tmp`, it silently reads the local `tmp`.

The rule: generated code may reference only names it declares itself and names it imports. Anything else is AG8010.

`lib/runtime/template/hygiene.ts` solves a related but different problem and is the **wrong tool here**. That machinery renames to dodge collisions. Renaming would break declaration splices, whose entire point is that `greet` keeps the name the generator gave it. This rule refuses where that one renames. Read `hygiene.ts` for its `freeNamesOf` and `bindersOf` helpers, which are directly reusable, but do not reuse its rename planner.

This is a **checking** rule, not runtime isolation, exactly as it is for holes. A generated `const` genuinely shares the enclosing scope once pasted. What the rule prevents is a generator reaching *into* the splice site, which is the direction the capture bug runs.

- [ ] **Step 1: Write the failing tests**

Append to `lib/compiler/splice/expand.test.ts`:

- generated code referencing a local at the splice site → `spliceReferencesOuterName` with `params.name` naming it
- generated code referencing a name it declares itself → allowed
- generated code referencing a name it imports → allowed
- generated code calling a builtin such as `print` → allowed (builtins are not splice-site names; confirm against `BUILTIN_VARIABLES`)

The fourth case is the one that catches an over-strict implementation, which would otherwise reject every useful generator. Do not drop it.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/compiler/splice/expand.test.ts 2>&1 | tee /tmp/splice-names-1.log
```

Expected: FAIL on the new cases only.

- [ ] **Step 3: Implement the check**

After a fragment comes back and before grafting, compute its free names, subtract the names it declares, the names it imports, and the builtins. Anything left is AG8010.

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm test:run lib/compiler/splice/expand.test.ts 2>&1 | tee /tmp/splice-names-2.log
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/compiler/splice/expand.ts lib/compiler/splice/expand.test.ts
git commit -F /tmp/commit-splice-8.txt
```

Subject: `Splices: generated code may not reference splice-site names`.

---

### Task 9: End-to-end execution fixtures

**Files:**
- Create: `tests/agency/splices/*.agency` and matching `.test.json`

**Background.** Read `docs/misc/TESTING.md` and copy the shape of an existing fixture pair from `tests/agency/templates/`. These need **no LLM calls**. Refusal fixtures use the `expectedCompileError` mode, which runs the compile in a child process; read how `tests/agency/templates/unfilledHoles.agency` and its `.test.json` are set up.

- [ ] **Step 1: Write the happy-path fixtures**

Three pairs:

1. `declarationSplice` — a generator module exporting a function that returns a program fragment declaring `greet`; a main module that splices it and calls `greet()`. Asserts the returned string.
2. `expressionSplice` — a generator returning an expression fragment; main uses it in a `const` and returns a value derived from it.
3. `builtWithFill` — a generator that builds its result with a code literal plus `fill`, proving splices consume what Template Agency already produces.

- [ ] **Step 2: Run them**

```bash
pnpm run agency test tests/agency/splices/declarationSplice.agency 2>&1 | tee /tmp/splice-e2e-1.log
pnpm run agency test tests/agency/splices/expressionSplice.agency 2>&1 | tee /tmp/splice-e2e-2.log
pnpm run agency test tests/agency/splices/builtWithFill.agency 2>&1 | tee /tmp/splice-e2e-3.log
```

Expected: PASS. Do not run the full suite.

- [ ] **Step 3: Write the refusal fixtures**

Six `expectedCompileError` pairs, one per rule, asserting the **code** field rather than message text:

1. generator raises an effect → AG8003
2. generator calls `llm()` → AG8004
3. generator defined in the same file → AG8005
4. generator imports a JS/TS package directly → AG8006
5. generator imports a local `.agency` file that imports a JS/TS package → AG8006 (the transitive case)
6. generator returns the wrong fragment kind → AG8007

Fixture 5 is the one that proves the import check is not shallow. It is the single most important test in this plan.

- [ ] **Step 4: Run the refusal fixtures**

```bash
for f in tests/agency/splices/refuse*.agency; do
  pnpm run agency test "$f" 2>&1 | tee -a /tmp/splice-refuse.log
done
```

Expected: all PASS, meaning each compile failed with the expected code.

- [ ] **Step 5: Run the structural linter and the round-trip gate**

```bash
pnpm run lint:structure 2>&1 | tee /tmp/splice-lint.log
pnpm test:run lib/backends/agencyGenerator.roundtrip.test.ts 2>&1 | tee /tmp/splice-roundtrip-final.log
```

Expected: both PASS. The round-trip gate now has splice-bearing fixtures in its corpus.

- [ ] **Step 6: Audit the diff against the anti-patterns doc**

Read `docs/dev/anti-patterns.md` and check the whole diff against it. This is required before opening a PR, not optional.

- [ ] **Step 7: Commit**

```bash
git add tests/agency/splices/
git commit -F /tmp/commit-splice-9.txt
```

Subject: `Splices: end-to-end execution and refusal fixtures`.

---

## Documentation

Not a separate task, because docs written apart from the code they describe go stale. Fold these into the tasks that create the behavior:

- **Task 7** — add a "Compile-time splices" section to `docs/site/guide/templates.md`. Lead with the difference from code literals: literals make code, splices install it. Use the today-versus-proposed pair from the spec's summary; it was written for a reader who has not read the TH literature.
- **Task 9** — create `docs/dev/splices.md` covering the pipeline position and why it must be there, the two-outputs-must-agree invariant, the import restriction and why it carries the safety argument, and the caching story. Link it from the deep-docs list in `CLAUDE.md`.

## Notes for whoever executes this

**What the spec says about caching, so nobody adds a cache.** There is no cache key to design. The generator arrives as an ordinary relative Agency import, and the manifest already records `deps` plus `depsHash` over transitive Agency imports (`docs/dev/incremental-builds.md:21`), so editing a generator invalidates its consumers for free. An unchanged file is skipped whole, so the splice never re-runs and its expansion is already in the emitted JavaScript. This works *because* of the determinism rule from Task 5: a generator that could call `llm()` would make caching silently wrong. The constraint that follows is already encoded in Task 7 — expansion must happen inside the per-file compile the manifest guards.

**Known limitation, deliberately shipped.** Holes cannot appear in property-name position, so a generator cannot emit `p.#field`. Tracked as #678. It does not block anything here because v1 generators take hand-supplied arguments, but do not try to work around it in this plan.

**Not in scope.** Introspection of any kind. No `reify`, no compiler-supplied module info, no seeing inside types. Generators take arguments. If a task starts to feel like it needs introspection, that is a signal the task has drifted.
