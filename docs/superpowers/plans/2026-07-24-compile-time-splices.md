# Compile-time Splices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `$( ... )` to Agency, which runs a generator function during compilation and pastes the `Code` value it returns into the file being compiled.

**Architecture:** A new `Splice` AST node parses in both declaration and expression position. Expansion runs inside `SymbolTable.build`, immediately before `classifySymbols`, so generated declarations are visible both in their own file and to any file that imports them. Because that call site is hot — twelve non-test callers including the LSP on every keystroke — expansion is a cached pure function of the splice expression plus the generator module's content, which Rule 3's determinism requirement is what licenses. Generators run in a **synchronous** child process, because the whole compile pipeline is synchronous and the existing `_run` is not.

**Tech Stack:** TypeScript, tarsec parser combinators, vitest, existing Agency compile pipeline.

> **Revision note.** This plan was rewritten after review (`2026-07-24-compile-time-splices-REVIEW.md`). Four blocking findings were verified and fixed: expansion was wired into the sandbox-only path, generator execution was assumed synchronous when `_run` is async, the effect check was fail-open for relative imports, and generated declarations were invisible across files. The owner chose to expand during symbol-table construction so generated declarations can be exported.

## Global Constraints

- **No dynamic imports.** Static imports only.
- **Objects not maps, arrays not sets, types not interfaces** — except where you are editing a file that already uses the other, in which case follow the file.
- **Dictionaries keyed by user-controlled strings must be null-prototype**, membership via `Object.hasOwn`. Splice names, generator names, and cache keys are all user-controlled.
- **No one-line `if` statements.** Braces always. This is in the anti-patterns catalog and the previous draft of this plan violated it in sample code.
- **No single-character variable names** in non-test code.
- **Use `safeDeleteDirectory`, never `fs.rmSync`.** Test temp dirs go under the project's `.agency-tmp/`, not `os.tmpdir()`, because `safeDeleteDirectory` has a project-containment check that rejects anything outside the project. See `lib/compiler/typecheck.ts:60-62`, which explains exactly this.
- **Save test output to a file.** Tests here are slow; never re-run just to see what failed.
- **Do not run the full agency test suite locally.** Run specific fixtures; CI runs the rest.
- **Diagnostic codes are append-only.** Splices use AG8003–AG8011. `diagnosticExplanations.ts` is exhaustive by type, so a code without prose fails the build.
- **Run `make` (not `pnpm run build`) after changing any stdlib file.** Run `make doc` if you change a docstring.
- Commit messages and PR bodies go in a **file** passed to git, never inline.

## One failure shape, used everywhere

The previous draft invented three conventions for one idea. There is now one. Define it in Task 0 and use it in every later task:

```ts
/** Every way a splice can fail, from eligibility through execution to
 *  grafting. Named for what it is — a diagnostic — not for eligibility,
 *  because it also carries runtime failures (AG8008) and post-graft name
 *  errors (AG8010). */
export type SpliceDiagnostic = {
  diagnostic: DiagnosticName;
  params: Record<string, string>;
  loc: SourceLocation;
};

/** Checks return null on success. Producers return a discriminated union. */
export type SpliceResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostic: SpliceDiagnostic };
```

## Decisions carried in from the spec

Read `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-24-compile-time-splices-design.md` first. The four rules:

1. `$( expr )` goes anywhere a declaration or an expression goes.
2. The generator must be imported from another file.
3. The generator's transitive effect list must be empty, it must not reach `llm()`/clock/randomness, and its transitive import graph may contain only `std::` imports and relative `.agency` files.
4. The returned `Code` value is pasted in and compiled as part of the file.

Settled since the spec:

- **Generated declarations may be exported** (owner decision, 2026-07-24). This is why expansion runs inside `SymbolTable.build`.
- **The spec's "caching needs nothing new" section is now obsolete.** It assumed expansion sat inside the manifest-guarded per-file compile. It does not. A cache is mandatory; Task 7 builds it.
- **Nested splices:** forbidden (AG8009), enforced by a flag threaded into the generator's own compile.
- **Splice arguments:** literals, code literals, and imported names only. Its own code, AG8011.
- **Splices inside code literals:** a splice inside `[| ... |]` is ordinary template text belonging to the generated program. The expansion pass does not descend into a code literal. Pinned by a parser test in Task 1.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `lib/types/splice.ts` | The `Splice` node type |
| `lib/parsers/splice.test.ts` | Parser tests, both positions |
| `lib/compiler/splice/types.ts` | `SpliceDiagnostic`, `SpliceResult` |
| `lib/compiler/splice/eligibility.ts` | May this generator run? Imports, effects, determinism |
| `lib/compiler/splice/runGenerator.ts` | Run one generator, synchronously, return its `Code` |
| `lib/compiler/splice/cache.ts` | Memoize generator output by expression + module content |
| `lib/preprocessors/expandSplices.ts` | The pass itself |
| `tests/agency/splices/*` | End-to-end fixtures |

Each of those gets a co-located `.test.ts`.

`expandSplices.ts` lives in `lib/preprocessors/` alongside `liftCallbacks.ts` and `resolveReExports.ts`, which run in the same pipeline slot and are the pattern to follow. The checks stay under `lib/compiler/splice/` because they are policy, not transformation, and they change for different reasons.

**Modified:**

| File | Change |
| --- | --- |
| `lib/types.ts` | `Splice` into the `AgencyNode` and `Expression` unions and `EXPRESSION_NODE_TYPES` |
| `lib/parsers/parsers.ts` | `spliceParser`, wired into `baseAtom` |
| `lib/parser.ts` | `topLevelSpliceParser` into the top-level alternation |
| `lib/utils/expressionSlots.ts` | Register `splice` **with a real expression slot** |
| `lib/utils/identifierSlots.ts` | `splice: none` |
| `lib/utils/bodySlots.ts` | Deliberate-absence comment |
| `lib/backends/agencyGenerator.ts` | Print a splice |
| `lib/typeChecker/diagnostics.ts` | AG8003–AG8011 |
| `lib/cli/diagnosticsDocs.ts` | Explain prose |
| `lib/symbolTable.ts:180` | Call the expansion pass before `classifySymbols` |
| `lib/compiler/typecheck.ts` | A path-taking effects entry point |
| `lib/compiler/compileClosure.ts` | Export `agencyImportTarget` |

---

### Task 0: Spike the generator execution mechanism

**Files:**
- Create: `lib/compiler/splice/types.ts`
- Create: `lib/compiler/splice/spike.md` (delete before the PR)

**Why this is Task 0.** `runGenerator` must be synchronous. `compileEntry` (`lib/compiler/buildSession.ts`) and `SymbolTable.build` are both synchronous, and `SymbolTable.build` is called from twelve places. The obvious delegate is not available: `_run` is `export async function _run(...)` (`lib/runtime/ipc.ts:1296`) and returns a Promise because it forks a child.

Making the compile pipeline async would reach `compileSource`, `BuildSession`, the CLI, the LSP, `runCheckerPipeline`, and all twelve `SymbolTable.build` callers. That is a far larger change than this feature and is out of scope.

So the answer is almost certainly a synchronous child process. But "almost certainly" is why this is a spike and not a task: if it does not work, every interface below changes shape.

- [ ] **Step 1: Define the shared failure types**

Create `lib/compiler/splice/types.ts` with `SpliceDiagnostic` and `SpliceResult<T>` exactly as given in the "One failure shape" section above. Every later task imports from here.

- [ ] **Step 2: Prove a Code value round-trips through a synchronous child process**

Write a throwaway script that:

1. writes a trivial generator module to `.agency-tmp/`, exporting `def g(): Code { return [| def greet(): string { return "hi" } |] }`
2. writes a runner module importing it and returning `g()`
3. compiles the runner with the existing compile path
4. executes the compiled JavaScript with `execFileSync` or `spawnSync`, capturing stdout
5. parses the result and asserts `isCode` accepts it

Record in `spike.md`: which function compiled it, how the value came back across the process boundary, whether `timeout` on `spawnSync` reliably kills a runaway child, and how to cap memory (likely `--max-old-space-size` in `execArgv`).

- [ ] **Step 3: Decide and write it down**

In `spike.md`, state the chosen mechanism and the exact signature `runGenerator` will have. If synchronous execution proves impossible, **stop and escalate** rather than proceeding — Tasks 6 and 7 are unbuildable without it, and the fallback (an async pipeline) is a different project.

- [ ] **Step 4: Commit the types only**

```bash
git add lib/compiler/splice/types.ts
git commit -F /tmp/commit-splice-0.txt
```

Subject: `Splices: shared diagnostic types`. Keep `spike.md` out of the commit or delete it first.

---

### Task 1: The `Splice` AST node and its parser

**Files:**
- Create: `lib/types/splice.ts`, `lib/parsers/splice.test.ts`
- Modify: `lib/types.ts`, `lib/parsers/parsers.ts`, `lib/parser.ts`, `lib/utils/expressionSlots.ts`, `lib/utils/identifierSlots.ts`, `lib/utils/bodySlots.ts`

**Interfaces:**
- Produces: `type Splice = BaseNode & { type: "splice"; expression: Expression; position: "decl" | "expr" }`, `spliceParser`, `topLevelSpliceParser`.

**Background.** `CodeLiteral` (`lib/types/codeLiteral.ts`) is the nearest precedent but its parser is much harder than this one. A code literal needs an end-scan grammar because its body is arbitrary text. A splice's content is a single Agency **expression**, so `exprParser` already knows where it ends. Use `exprParser`, then expect `)`. Do not build an end-scan.

**A splice is NOT a walker leaf.** This is the one thing in this task that later tasks depend on and that is easy to get wrong. `codeLiteral` is a leaf because its body belongs to the generated program. A splice's `expression` is ordinary host code, and Tasks 4, 7, and 8 all need the walker to descend into it. Do not copy `codeLiteral`'s registrations.

The `position` field mirrors `Hole.sort`: derived from which parser matched, never written by the user.

**Statement position.** A bare `$( makeGreeters(names) )` on its own line inside a node body parses through `baseAtom` as an expression splice and will then be required to produce an `expr` fragment. That is almost certainly not what someone writing it means. The v1 rule: this is legal and means an expression splice, exactly as the parse implies. Pinned by a test so the behavior is deliberate rather than accidental.

- [ ] **Step 1: Write the failing parser tests**

Create `lib/parsers/splice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAgency } from "../parser.js";
import { walkNodesArray } from "../utils/walkNodes.js";
import type { AgencyNode, Splice } from "../types.js";

function parseTemplate(source: string) {
  const result = parseAgency(source, {}, false, false);
  if (!result.success) {
    throw new Error(result.message ?? "parse failed");
  }
  return result.result;
}

/** Mirrors how lib/utils/holes.ts filters over walkNodesArray. There is
 *  no findNodesOfType helper in this codebase. */
function nodesOfType(nodes: AgencyNode[], type: string): AgencyNode[] {
  const found: AgencyNode[] = [];
  for (const { node } of walkNodesArray(nodes)) {
    if (node.type === type) {
      found.push(node);
    }
  }
  return found;
}

function splicesIn(source: string): Splice[] {
  return nodesOfType(parseTemplate(source).nodes, "splice") as Splice[];
}

describe("splice parsing", () => {
  it("parses a splice in declaration position", () => {
    const [splice] = splicesIn(`$( makeGetters(["a"]) )\n\nnode main() {\n  return 1\n}\n`);
    expect(splice.position).toBe("decl");
    expect(splice.expression.type).toBe("functionCall");
  });

  it("parses a splice in expression position", () => {
    const [splice] = splicesIn(`node main() {\n  const x = $( buildTable(3) )\n  return x\n}\n`);
    expect(splice.position).toBe("expr");
  });

  it("treats a top-level const assignment as an expression splice", () => {
    // Reaches the splice through baseAtom, not topLevelSpliceParser.
    const [splice] = splicesIn(`const routes = $( build() )\n`);
    expect(splice.position).toBe("expr");
  });

  it("treats a bare splice inside a node body as an expression splice", () => {
    const [splice] = splicesIn(`node main() {\n  $( makeThings() )\n  return 1\n}\n`);
    expect(splice.position).toBe("expr");
  });

  it("parses a splice whose argument is a code literal", () => {
    const [splice] = splicesIn(`$( wrap([| def f(): number { return 1 } |]) )\n`);
    expect(splice.position).toBe("decl");
  });

  it("parses nested parentheses in the spliced expression", () => {
    const [splice] = splicesIn(`node main() {\n  const x = $( f(g(1), h(2)) )\n  return x\n}\n`);
    expect(splice.expression.type).toBe("functionCall");
  });

  it("finds two splices in one file", () => {
    // Multiple splices are the normal case for the motivating use, and
    // they are where grafting breaks: a decl splice spreads N nodes and
    // shifts the index of every splice after it.
    const found = splicesIn(`$( first() )\n\n$( second() )\n\nnode main() {\n  return 1\n}\n`);
    expect(found).toHaveLength(2);
  });

  it("populates loc, which error attribution depends on", () => {
    const [splice] = splicesIn(`$( makeGetters(["a"]) )\n`);
    expect(splice.loc).toBeDefined();
    expect(typeof splice.loc.line).toBe("number");
  });

  it("rejects an empty splice", () => {
    expect(parseAgency(`$( )\n`, {}, false, false).success).toBe(false);
  });

  it("leaves a dollar-paren inside a string alone", () => {
    expect(splicesIn(`node main() {\n  return "cost: $( 5 )"\n}\n`)).toEqual([]);
  });

  it("does not treat a splice inside a code literal as a host splice", () => {
    // A splice inside [| |] is template text belonging to the generated
    // program. codeLiteral is a walker leaf, so the host walk must not
    // yield it.
    expect(splicesIn(`const tpl = [| $( f() ) |]\n`)).toEqual([]);
  });

  it("descends into the spliced expression", () => {
    // THE leaf-ness test. Every other test above finds the splice
    // through its PARENT's slot and passes identically whether the
    // splice is a leaf or not. Tasks 4, 7, and 8 all need the walker to
    // see inside. This fails immediately on a `splice: true` leaf ruling.
    const calls = nodesOfType(parseTemplate(`$( f(g(1)) )\n`).nodes, "functionCall");
    const names = calls.map((call) => JSON.stringify(call));
    expect(names.join(" ")).toContain("g");
  });
});
```

Tighten the last test's assertion once you know the `functionCall` shape; assert on the callee name field rather than stringified JSON.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/parsers/splice.test.ts 2>&1 | tee /tmp/splice-parse-1.log
```

Expected: FAIL — `"splice"` is not a known node type.

- [ ] **Step 3: Define the node type**

Create `lib/types/splice.ts`:

```ts
import { BaseNode } from "./base.js";
import type { Expression } from "../types.js";

/** A compile-time splice: `$( generatorCall(...) )`. The expression is
 *  evaluated DURING compilation and the `Code` value it returns is
 *  grafted in at this position.
 *
 *  Unlike `CodeLiteral`, a splice is NOT a host-side leaf. `expression`
 *  is ordinary host code and the walker MUST descend into it: the
 *  eligibility check reads the names it references, and the expansion
 *  pass reads its callee. Registering it as a leaf compiles fine and
 *  fails much later as a check that mysteriously sees nothing.
 *
 *  Every splice is removed by the expansion pass before codegen;
 *  reaching codegen with one is an internal error. */
export type Splice = BaseNode & {
  type: "splice";
  expression: Expression;
  /** Derived from which parser matched, never written by the user. */
  position: "decl" | "expr";
};
```

- [ ] **Step 4: Register the type in `lib/types.ts`**

`CodeLiteral` is registered at lines 46, 68, 121, 152, and 385. Add `Splice` to the same five: the import, the re-export, the `Expression` union, `EXPRESSION_NODE_TYPES` (the string `"splice"`), and the `AgencyNode` union.

- [ ] **Step 5: Write the parser**

In `lib/parsers/parsers.ts`, beside `codeLiteralParser` (around line 3134). Read the neighbouring parsers for tarsec's exact combinator spellings before writing; the structure below is what to build, not a literal transcription of the API.

Build `spliceParser` as `withLoc(committed(str("$("), rest))`, where `rest` runs optional spaces, captures `exprParser`, runs optional spaces, and requires `")"`. Committing after `$(` follows `codeLiteralParser` and means a failure inside wins error reporting rather than degrading to a generic grammar message.

Then `topLevelSpliceParser` maps over `spliceParser` and rewrites `position` to `"decl"`, the same way `topLevelHoleParser` rewrites a hole's sort.

- [ ] **Step 6: Wire into both positions**

In `baseAtom` (line 3138), immediately after `exprHoleParser`:

```ts
  // `$(` cannot start any other expression, so this is a cheap early
  // exit like the hole parser above. Being a baseAtom alternative covers
  // every expression position at once.
  lazy(() => spliceParser),
```

In `lib/parser.ts`, add `topLevelSpliceParser` directly after `topLevelHoleParser` (line 99), commenting that the expression form arrives via `baseAtom` and this entry exists only to stamp `position: "decl"`.

- [ ] **Step 7: Register in the three tables**

- `lib/utils/expressionSlots.ts` — a splice **has** one expression slot, `expression`. Do **not** add `splice: true` beside `codeLiteral: true`; that is the leaf table. Follow a single-expression node such as `tryExpression`.
- `lib/utils/identifierSlots.ts:217` — `splice: none`.
- `lib/utils/bodySlots.ts` — no body slots; add a comment recording the deliberate absence, mirroring the `codeLiteral` comment at line 233.

- [ ] **Step 8: Run to verify they pass**

```bash
pnpm test:run lib/parsers/splice.test.ts 2>&1 | tee /tmp/splice-parse-2.log
pnpm test:run lib/utils/expressionSlots.test.ts 2>&1 | tee /tmp/splice-slots.log
```

Expected: both PASS. Note the slot completeness test at `expressionSlots.test.ts:143` asserts each kind is "enumerated **or** explicitly empty, never both" — it passes on a wrong leaf ruling. The descend test from Step 1 is what actually catches that.

- [ ] **Step 9: Commit**

```bash
git add lib/types/splice.ts lib/types.ts lib/parsers/parsers.ts lib/parsers/splice.test.ts lib/parser.ts lib/utils/expressionSlots.ts lib/utils/identifierSlots.ts lib/utils/bodySlots.ts
git commit -F /tmp/commit-splice-1.txt
```

Subject: `Splices: the Splice AST node and its parser`.

---

### Task 2: Formatter support and print fidelity

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Create: `lib/backends/agencyGenerator.splice.test.ts`

**Background.** `generateAgency` is at `lib/backends/agencyGenerator.ts:1990` and `generateExpression` — the nested-expression printer — at `:2008`. Use those names; do not invent `formatExpression`.

The previous draft asserted only `toContain` on printed substrings. Substring presence is not fidelity. What later tasks need is that print → re-parse gives back the same tree, so assert that directly here rather than deferring to the corpus gate, which contains no splice-bearing file until Task 9.

- [ ] **Step 1: Write the failing tests**

Cover: a declaration splice prints and re-parses to a structurally equal program; the same for an expression splice; printing is idempotent; a splice whose argument is a **multi-line code literal** round-trips, since that is where a printer is most likely to mangle something and Task 9's `builtWithFill` fixture depends on it.

Write the round-trip assertion as parse → print → re-parse → `toEqual` on the two programs, not as a substring check.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/backends/agencyGenerator.splice.test.ts 2>&1 | tee /tmp/splice-fmt-1.log
```

Expected: FAIL, unhandled node type.

- [ ] **Step 3: Add the formatter case**

Beside the `codeLiteral` case at `lib/backends/agencyGenerator.ts:589`:

```ts
      case "splice":
        // Spaces inside the parens are the canonical form: `$( f(x) )`.
        return `$( ${this.generateExpression(node.expression)} )`;
```

Match how neighbouring cases call the nested printer; it may be a method or a free function.

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm test:run lib/backends/agencyGenerator.splice.test.ts 2>&1 | tee /tmp/splice-fmt-2.log
pnpm test:run lib/backends/agencyGenerator.roundtrip.test.ts 2>&1 | tee /tmp/splice-roundtrip.log
```

Expected: both PASS.

- [ ] **Step 5: Commit**

Subject: `Splices: formatter support and print fidelity`.

---

### Task 3: Diagnostic codes AG8003–AG8011

**Files:**
- Modify: `lib/typeChecker/diagnostics.ts`, `lib/cli/diagnosticsDocs.ts`
- Test: `lib/typeChecker/diagnosticExplanations.test.ts`, plus a new placeholder test

**Background.** `DIAGNOSTICS` maps a name to `{ code, severity, message }`. `unfilledHoles` (AG8001) and `holeNeedsTypeAnnotation` (AG8002) at lines 581-591 are the shape to follow. Explanations are exhaustive by type, so a code without prose is a compile error.

Doing this before the checks that raise them means no later task invents a code inline.

- [ ] **Step 1: Add the entries**

After `holeNeedsTypeAnnotation`, add nine: `spliceGeneratorHasEffects` (AG8003), `spliceGeneratorNondeterministic` (AG8004), `spliceGeneratorNotImported` (AG8005), `spliceGeneratorReachesNonAgency` (AG8006), `spliceFragmentKindMismatch` (AG8007), `spliceGeneratorFailed` (AG8008), `spliceNested` (AG8009), `spliceReferencesOuterName` (AG8010), `spliceArgumentNotAvailable` (AG8011).

AG8011 is new since the review: the previous draft made AG8005 cover both "generator is not imported" and "splice argument references a host-file name", which are different mistakes and cannot share explain prose. AG8011's message is about arguments:

```ts
  spliceArgumentNotAvailable: {
    code: "AG8011",
    severity: "error",
    message:
      "The splice argument `{name}` is declared in this file, so it does not exist yet when the generator runs. Splice arguments may be literals, code literals, or imported names.",
  },
```

For AG8006, pass the **generator's name** as `{name}`, not a filename. The previous draft passed `path.basename(entryPath)`, so the message promised a function and showed a file.

- [ ] **Step 2: Run the exhaustiveness test to verify it fails**

```bash
pnpm test:run lib/typeChecker/diagnosticExplanations.test.ts 2>&1 | tee /tmp/splice-diag-1.log
```

Expected: FAIL or a TypeScript error naming the nine codes.

- [ ] **Step 3: Add explanation prose**

One entry per code in `lib/cli/diagnosticsDocs.ts`. Read an existing AG8xxx entry for the house register. Each says what happened, why the rule exists, and what to do. For AG8003:

> A compile-time generator ran, or would have run, code that raises an interrupt effect — reading a file, writing one, hitting the network.
>
> Compilation refuses to run effectful code. Unlike a normal program run, no handlers are installed while compiling, so there is nothing to approve or reject an effect against, and a build that quietly touched the filesystem would be a surprise.
>
> Move the effectful work out of the generator. If it needs data from a file, read the file at run time instead, or pass the data in as a plain argument to the splice.

- [ ] **Step 4: Add a placeholder-rendering test**

Every message uses `{name}`, `{effects}`, `{importPath}`, `{actual}`, `{expected}`, `{position}`, or `{reason}`. If a check supplies `params: { effect }` where the message wants `effects`, the user sees a literal `{effects}` and every other test in this plan still passes, because Task 9's fixtures assert the `code` field.

Write one test that loops the nine diagnostics, renders each with the params its raiser actually supplies, and asserts the rendered string contains no `{`.

- [ ] **Step 5: Run to verify they pass**

```bash
pnpm test:run lib/typeChecker/diagnosticExplanations.test.ts 2>&1 | tee /tmp/splice-diag-2.log
pnpm run agency explain AG8003 2>&1 | tee /tmp/splice-explain.log
```

Expected: PASS, and the prose from Step 3. The `explain` call is a smoke check, not coverage.

- [ ] **Step 6: Commit**

Subject: `Splices: diagnostic codes AG8003-AG8011`.

---

### Task 4: Generator eligibility — the import graph

**Files:**
- Create: `lib/compiler/splice/eligibility.ts` and its test
- Modify: `lib/compiler/compileClosure.ts` (export `agencyImportTarget`)

**Interfaces:**
- Consumes: `SpliceDiagnostic` from Task 0; AG8005, AG8006 from Task 3.
- Produces:

```ts
export function checkImportGraph(entryPath: string, config: AgencyConfig): SpliceDiagnostic | null;

/** Which module supplies this generator, and under what name. Returns
 *  the alias-resolved original name so runGenerator can print exactly
 *  one import line. */
export function resolveGeneratorModule(
  program: AgencyProgram,
  localName: string,
  hostPath: string,
): SpliceResult<{ modulePath: string; exportedName: string }>;
```

**Background — this check carries the whole safety argument.** TypeScript raises no interrupts, and a plain JS/TS package "passes through untouched" when imported (`docs/dev/pkg-imports.md:14`). If a generator reaches `zod`, the effect check in Task 5 means nothing.

**Reuse the existing edge extractor.** `lib/compiler/compileClosure.ts:283` has `agencyImportTarget`, and its neighbour carries a doc comment written as a warning against exactly what a hand-rolled scan does: it recognizes `importStatement`, `importNodeStatement`, **and** `exportFromStatement`, and an import-only scan lets `export { x } from "pkg::…"` escape. A hand-rolled version here has that bug with a worse consequence — a generator with `export { z } from "zod"` would pass eligibility and reach JavaScript at compile time.

`agencyImportTarget` is module-private, and `loadModule` beside it says it is "kept inside `compileClosure.ts` until a second caller appears". Splices are that second caller; exporting it is the intended move.

Do **not** use the exported plural `agencyImportTargets`. It filters out `std::`, `pkg::`, and non-Agency targets before returning — precisely the edges this check must see.

**Keep the rule declarative.** The previous draft handed the worker a hand-written breadth-first search with a mutable queue, burying the actual rule three levels deep. The rule is one line:

```ts
const isAllowedEdge = (specifier: string): boolean =>
  specifier.startsWith("std::") || isRelativeAgencyPath(specifier);
```

The walk that produces edges and the rule that judges them are separate things that change for different reasons. Structure it that way.

- [ ] **Step 1: Write the failing tests**

Temp dirs go under `.agency-tmp/` and are cleaned with `safeDeleteDirectory`, per Global Constraints.

Cases:

1. generator importing only `std::` → allowed
2. generator importing a relative `.agency` file → allowed
3. generator importing a JS/TS package directly → AG8006, `params.importPath === "zod"`
4. **a JS/TS package reached one level down** — `gen.agency` imports `./helper.agency`, which imports `zod`. The check must be transitive. **Do not drop this test.**
5. **a re-export edge** — `export { z } from "zod"` inside the generator. This is the case `compileClosure.ts`'s own doc comment warns about, and it is the one a hand-rolled scan misses.
6. the `import node` form, which `agencyImportTarget` also recognizes
7. `pkg::` → AG8006
8. an import cycle terminates. **Give this test an explicit vitest timeout.** Without a visited set it does not go red, it hangs, and a hanging test teaches nobody anything.
9. an import that does not resolve produces a diagnostic, not a crash

Then for `resolveGeneratorModule`: a direct import resolves; a generator defined in the host file → AG8005; a name imported nowhere → AG8005; an **aliased** import (`import { makeGetters as gen }`) resolves to the original name; a generator reached through a **re-export chain** resolves, since `resolveReExports` exists because those are common.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test:run lib/compiler/splice/eligibility.test.ts 2>&1 | tee /tmp/splice-elig-1.log
```

- [ ] **Step 3: Implement**

Export `agencyImportTarget` from `compileClosure.ts`. Build the closure of the generator's module using it, then apply `isAllowedEdge` to find the first offending specifier. Whatever walk you use must visit each file once, and the cycle test is what forces that.

`resolveGeneratorModule` reads the host program's import nodes for one binding `localName`, resolves the module path against `hostPath`, and returns the original exported name so aliases work.

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm test:run lib/compiler/splice/eligibility.test.ts 2>&1 | tee /tmp/splice-elig-2.log
```

- [ ] **Step 5: Commit**

Subject: `Splices: transitive import-graph check via the shared edge extractor`.

---

### Task 5: Generator eligibility — effects and determinism

**Files:**
- Modify: `lib/compiler/splice/eligibility.ts` and its test
- Modify: `lib/compiler/typecheck.ts` (path-taking effects entry point)

**Interfaces:**
- Consumes: AG8003, AG8004.
- Produces:

```ts
export function checkEffects(generatorPath: string, name: string): SpliceDiagnostic | null;
export function checkDeterminism(generatorPath: string, name: string): SpliceDiagnostic | null;

/** Composes Tasks 4 and 5 so the expansion pass never names individual
 *  rules. Adding a rule later is a list entry, not a pass edit. */
export function checkGeneratorEligible(
  generatorPath: string,
  name: string,
  config: AgencyConfig,
): SpliceDiagnostic | null;
```

**Background — the fail-open bug this task exists to avoid.** The previous draft had `checkEffects(source, name)` calling `getEffectsFromSource(source)`. That function passes `undefined` as `sourcePath` (`lib/compiler/typecheck.ts:163`), and `withSourcePath` then writes the source to a fresh temp dir (`:58-67`). Relative imports resolve against the temp dir, which is empty. The stdlib docs for the neighbouring function say it outright: "Relative imports (./foo.agency) cannot be resolved from a source string."

So a generator whose effectful work lives in `./helper.agency` reports an **empty** effect list and passes. The generator then runs and reads the file. This is worse than the transitive-import hole because the generator contains no suspicious import at all.

The fix: `runCheckerPipeline` already takes a `sourcePath` and short-circuits the temp file when given one (`typecheck.ts:59`). Add a path-taking variant of `getEffectsFromSource`; `_typecheckFile` at `lib/stdlib/agency.ts:432` is the precedent for a file-based sibling of a string-based checker. Both checks take a **path**, never a source string.

**A trap that will otherwise cost an afternoon:** `getEffectsFromSource` reports only **exported** callables (`typecheck.ts:167`). The transitive tests below deliberately use a non-exported helper, which is the right test, but you need to know about the filter before you start.

- [ ] **Step 1: Read the propagation code and decide the determinism approach**

Read `analyzeInterruptsFromScopes` (`lib/typeChecker/index.ts:300`) and whatever it populates. Answer in a comment at the top of your implementation: can a non-interrupt marker ride this propagation, or does determinism need its own transitive walk? Write the simpler thing if the marker does not fit. **This approach is unverified; do not force it.**

Also find the real entry points for the clock and randomness by reading `stdlib/date.agency` and `stdlib/math.agency`. `llm()` is a language builtin.

- [ ] **Step 2: Write the failing tests**

For `checkEffects`: a pure generator is allowed; one that calls `read` is refused with AG8003; one with a bare `interrupt(...)` is refused via the `"unknown"` sentinel; and — **do not drop this** — **a generator whose relative helper calls `read` is refused.** That last is the fail-open case and it is the most important test in the task.

For `checkDeterminism`: a pure generator is allowed; one calling `llm()` is refused; one reaching `llm()` through a non-exported helper is refused; **one whose relative helper calls `llm()` is refused**; one using the clock is refused; one using randomness is refused.

And a **negative control**, which the previous draft lacked entirely: a generator calling an ordinary pure stdlib function must be **allowed**. Without it, an implementation that flags every stdlib call passes every other test in the task.

Do not assert on the exact spelling of effect names (`"std::read"` versus `"read"`) until you have confirmed the format; check first rather than loosening the assertion later.

- [ ] **Step 3: Run to verify they fail**

```bash
pnpm test:run lib/compiler/splice/eligibility.test.ts 2>&1 | tee /tmp/splice-effects-1.log
```

- [ ] **Step 4: Implement**

Add the path-taking effects function to `typecheck.ts`. Write both checks against it. Compose all three checks into `checkGeneratorEligible` as an ordered array of `(context) => SpliceDiagnostic | null` applied by a single `.find()`, so the expansion pass never names an individual rule.

- [ ] **Step 5: Run to verify they pass**

```bash
pnpm test:run lib/compiler/splice/eligibility.test.ts 2>&1 | tee /tmp/splice-effects-2.log
```

Expected: PASS, including every Task 4 test.

- [ ] **Step 6: Commit**

Subject: `Splices: path-based effect and determinism checks`.

---

### Task 6: Running a generator

**Files:**
- Create: `lib/compiler/splice/runGenerator.ts` and its test

**Interfaces:**
- Consumes: Task 0's mechanism and signature; AG8008.
- Produces:

```ts
export function runGenerator(
  splice: Splice,
  generator: { modulePath: string; exportedName: string },
  cwd: string,
): SpliceResult<Code>;
```

**Background.** Take the **resolved module path and exported name**, not the host's import lines. The previous draft passed `importsFromHost`, a blob of source text, which is a leaky interface and a correctness bug: it drags along every other import the host has, including the npm and `pkg::` imports Task 4 just banned, and trips the test-import denial in `resolveImports` if the host uses `import test`.

Emit exactly one import line, reconstructed from what `resolveGeneratorModule` returned.

Thread a **generator flag** into this compile. A splice inside a generator module is AG8009, and the only place that can be detected is here, where the generator is compiled — `expandSplices` has no way to know a file is a generator, since from its own point of view it is an ordinary compile.

Limits: 30 seconds wall clock and 512mb, both named constants.

- [ ] **Step 1: Write the failing tests**

Cover: a generator returning a `program` fragment; one returning an `expr` fragment; one that throws → AG8008; one that loops forever → a failure, **with a 60-second vitest timeout** so a broken limit fails rather than wedging CI; one exceeding the memory limit; one returning a non-`Code` value such as a number; one returning `{ type: "agencyProgram" }` with a malformed `nodes` field, which is exactly what the `Array.isArray` half of `isCode` exists for; and one whose splice expression contains a **code literal**, since this task synthesizes source by printing the expression and printing a code literal is the likeliest thing to go wrong.

Also: a generator module that itself contains a splice → AG8009. This test belongs **here**, where the flag is set, not in the expansion tests.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

Follow Task 0's `spike.md`. Print the splice expression with `generateExpression` so what runs is exactly what the user wrote. Validate the returned value with `isCode` before trusting it — read `lib/runtime/template/code.ts` for why the array check is load-bearing.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

Subject: `Splices: run a generator in a synchronous child process`.

---

### Task 7: The expansion pass, its cache, and symbol-table wiring

**Files:**
- Create: `lib/preprocessors/expandSplices.ts`, `lib/compiler/splice/cache.ts`, and their tests
- Modify: `lib/symbolTable.ts:180`

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 6.
- Produces:

```ts
export function expandSplices(
  program: AgencyProgram,
  hostPath: string,
  config: AgencyConfig,
): SpliceResult<AgencyProgram>;
```

Note what is **absent**: no `source` field. The previous draft returned printed source with an obligation on the caller to write it to disk, which was a leaked pipeline quirk, rewrote the user's file in the `buildSession` path, and destroyed every source position below the splice. Expansion is now AST-in, AST-out.

**Where this runs, and why.** `SymbolTable.build` walks the filesystem parsing each file to record what it declares. At `lib/symbolTable.ts:180-181`:

```ts
      const program = parseResult.result;
      parsed[absPath] = { symbols: classifySymbols(program), program };
```

Expansion goes between those two lines. `classifySymbols` is what records a file's declarations, so expanding first makes generated declarations visible **both** in their own file and to every file that imports it — which is the owner's requirement that generated declarations be exportable.

The compile paths still parse independently, so each also calls `expandSplices`. That is safe and cheap because expansion is cached and deterministic: Rule 3 is what guarantees the symbol-table walk and the compile walk cannot disagree.

**The cache is mandatory, not an optimization.** `SymbolTable.build` has twelve non-test callers, including `lib/lsp/server.ts:130`, and `onDidChangeContent` fires on every edit (`server.ts:164`). Also `lib/mcp/tools.ts:54`, `lib/cli/policy.ts:48`, `lib/cli/bundle.ts`, `lib/cli/pack.ts`, `lib/serve/metadata.ts:35`, `lib/optimize/targets.ts:156`, `lib/analysis/interrupts.ts:87`. Without a cache, every one of those forks a child process per splice, on every keystroke in the editor's case.

The spec's "caching needs nothing new" section is obsolete; it assumed expansion sat inside the manifest-guarded per-file compile.

Cache key: the printed splice expression plus a content hash of the generator module's transitive closure. Determinism is what makes that key sound.

**Cycle guard.** Compiling a generator builds its own symbol table, which walks files, which may reach a file with a splice. Track an in-progress set and refuse re-entry for a file already being expanded.

- [ ] **Step 1: Write the failing cache tests**

A second call with the same expression and unchanged generator does not re-run the generator (spy on the runner). Changing the generator's content invalidates. Changing the splice expression invalidates. A change in a **transitively imported** helper of the generator invalidates.

- [ ] **Step 2: Write the failing expansion tests**

1. a declaration splice is replaced by the generator's declarations
2. an expression splice is replaced by one expression
3. **two splices in one file both expand correctly** — a decl splice spreads N nodes and shifts the index of every splice after it, which is where naive grafting breaks
4. a `program` fragment into expression position → AG8007
5. a splice argument referencing a host-file constant → AG8011
6. a literal argument and a code-literal argument are both allowed — without this, an over-strict implementation rejects every useful splice and still passes case 5
7. **a file with no splices comes back identical** — assert identity explicitly
8. a splice inside a code literal is left alone
9. **`loc.origin` is present on grafted nodes.** This is the feature's distinguishing claim over `runCode` and the spec asks for it by name.
10. re-entry on the same file is refused rather than looping

- [ ] **Step 3: Run to verify they fail**

- [ ] **Step 4: Implement**

Structure the pass as: an ordered list of checks with the uniform shape `(context) => SpliceDiagnostic | null`, applied by one `.find()`, then a separate `graft` step that assumes eligibility passed. Policy and mechanics change for different reasons and should not interleave.

The checks, in order: argument availability (AG8011), `resolveGeneratorModule` (AG8005), `checkGeneratorEligible` (AG8003/4/6), then run, then fragment kind (AG8007).

For argument availability, `freeNamesOf` in `lib/runtime/template/hygiene.ts` computes what you need; a free name that is neither imported nor a builtin is AG8011.

For fragment kind, reuse `assertKindMatchesSort` from `lib/runtime/template/fill.ts` rather than restating the rule.

For grafting and origin stamping: **extract the shared helpers out of `fill.ts` and call them from both places.** The previous draft said to "mirror" `fill`'s substitution modes and stamp origins "the way `fill` does", which is duplication with a friendly name, and origin stamping is exactly the detail that drifts once there are two copies. Task 8's reuse of `freeNamesOf` while explicitly declining the rename planner is the model.

- [ ] **Step 5: Wire into `SymbolTable.build`**

At `lib/symbolTable.ts:180`, expand before `classifySymbols`. A failure here must not abort the crawl — symbol discovery is deliberately best-effort, as the comment at `:183-188` explains for unresolvable imports. Record the diagnostic and continue.

- [ ] **Step 6: Wire into the compile paths**

The four places `liftCallbackBlocks` runs are the map: `lib/compiler/compile.ts:137`, `lib/compiler/buildSession.ts:470`, `lib/compiler/typecheck.ts:126`, `lib/analysis/interrupts.ts:106`. Expansion runs before each, since generated declarations must reach `buildCompilationUnit`. Check `lib/lsp/diagnostics.ts` for a fifth.

- [ ] **Step 7: Verify no behavior change without splices**

```bash
pnpm test:run lib/compiler/compile.test.ts 2>&1 | tee /tmp/splice-compile.log
pnpm test:run lib/symbolTable.test.ts 2>&1 | tee /tmp/splice-symtab.log
```

Expected: both PASS, unchanged.

- [ ] **Step 8: Commit**

Subject: `Splices: cached expansion pass wired into symbol-table construction`.

---

### Task 8: Generated code may not reach into the splice site

**Files:**
- Modify: `lib/preprocessors/expandSplices.ts` and its test

**Background.** Pasting code raises a capture question, worst in expression position: dropping a generated expression into a function body puts it next to locals, and a generated mention of `tmp` silently reads the local `tmp`.

The rule: generated code may reference only names it declares itself and names it imports. Anything else is AG8010.

`lib/runtime/template/hygiene.ts` is the **wrong tool** here. It renames to dodge collisions, and renaming would break declaration splices, whose whole point is that `greet` keeps its name. Reuse its `freeNamesOf` and `bindersOf`; do not reuse the rename planner.

This is a **checking** rule, not runtime isolation, exactly as for holes. A generated `const` shares the enclosing scope once pasted. What the rule prevents is a generator reaching *into* the splice site.

- [ ] **Step 1: Write the failing tests**

1. generated code referencing a local at the splice site → AG8010 naming it
2. generated code referencing a name it declares itself → allowed
3. generated code referencing a name **it** imports → allowed
4. generated code calling a builtin such as `print` → allowed. **Do not drop this**; without it an over-strict implementation passes every other case while rejecting every useful generator.
5. generated code referencing a name the **host** imported but the generator did not → refused. This is the subtle inverse of case 3, and an implementation checking against the wrong import list gets it backwards.
6. **duplicate top-level declarations are a loud failure.** The rationale for treating declaration splices as safe rests on a generated `const config` colliding with an existing one being a duplicate-declaration error. That claim is asserted in the spec and the plan and verified nowhere. If Agency is actually last-wins, the safety story for declaration splices is wrong and needs a real rule. Test it before relying on it.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

After a fragment returns and before grafting, compute free names, subtract what it declares, what it imports, and the builtins (`BUILTIN_VARIABLES`). Anything left is AG8010.

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Commit**

Subject: `Splices: generated code may not reference splice-site names`.

---

### Task 9: End-to-end fixtures and incremental rebuild

**Files:**
- Create: `tests/agency/splices/*.agency` and `.test.json`

**Background.** Read `docs/misc/TESTING.md` and copy a fixture pair from `tests/agency/templates/`. **No LLM calls.** Refusal fixtures use `expectedCompileError` (`lib/cli/expectedCompileError.ts`), which runs the compile in a child process.

- [ ] **Step 1: Happy-path fixtures**

1. `declarationSplice` — generator returns a program fragment declaring `greet`; main splices and calls it
2. `expressionSplice` — generator returns an expression fragment used in a `const`
3. `builtWithFill` — generator builds its result with a code literal plus `fill`, proving splices consume what Template Agency already produces
4. `exportedGeneratedDecl` — a generated `export def` imported and called from a **second file**. This is the owner's reason for expanding during symbol-table construction, and nothing else tests it.
5. `twoSplices` — two declaration splices in one file, both used

- [ ] **Step 2: Run them**

```bash
for f in tests/agency/splices/declarationSplice tests/agency/splices/expressionSplice tests/agency/splices/builtWithFill tests/agency/splices/exportedGeneratedDecl tests/agency/splices/twoSplices; do
  pnpm run agency test "$f.agency" 2>&1 | tee -a /tmp/splice-e2e.log
done
```

- [ ] **Step 3: Refusal fixtures**

One per code, asserting the **code** field rather than message text: AG8003 through AG8011, nine in total. The previous draft covered only AG8003–AG8007; a diagnostic with no test is one that may never fire.

For AG8003, use a **harmless** effect — reading a file that does not exist. If the check ever fails to fire, the fixture runs the generator for real, and one written with `write` or a shell command would do the damage it exists to prevent.

Fixture for AG8006 must be the **transitive** case: a generator importing a clean-looking local `.agency` file that itself imports a JS package. **This is the single most important test in the plan.** It is what decides whether the safety argument holds or is decorative.

- [ ] **Step 4: Error-attribution fixture**

Generated code that fails to compile must produce a message naming the generator. The spec asks for this by name, and it is the payoff for pasting an AST rather than printing and re-parsing.

- [ ] **Step 5: Incremental rebuild test**

Compile a project with a splice, edit the generator so it emits a different body, compile again, assert the output changed. Then compile again unchanged and assert the generator did **not** re-run.

This is the highest-value missing test from the previous draft. It is what would have caught the wrong-compile-path bug, and it is the only thing that exercises the cache under real conditions.

- [ ] **Step 6: Run everything and audit**

```bash
for f in tests/agency/splices/refuse*.agency; do
  pnpm run agency test "$f" 2>&1 | tee -a /tmp/splice-refuse.log
done
pnpm run lint:structure 2>&1 | tee /tmp/splice-lint.log
pnpm test:run lib/backends/agencyGenerator.roundtrip.test.ts 2>&1 | tee /tmp/splice-roundtrip-final.log
```

Then read `docs/dev/anti-patterns.md` and audit the whole diff against it. Required before the PR, not optional.

- [ ] **Step 7: Commit**

Subject: `Splices: end-to-end, refusal, attribution, and rebuild fixtures`.

---

## Documentation

Folded into the tasks that create the behavior, because docs written separately go stale.

- **Task 7** — a "Compile-time splices" section in `docs/site/guide/templates.md`. Lead with the difference from code literals: literals make code, splices install it. Use the today-versus-proposed pair from the spec's summary.
- **Task 9** — `docs/dev/splices.md`: why expansion lives in `SymbolTable.build`, the cache and why it is mandatory, the import restriction and why it carries the safety argument, and the cycle guard. Link from `CLAUDE.md`.
- **Task 9** — update the spec's caching section, which is now wrong.

## Open item: `combine`

The spec's motivating example ends with `return combine(out)`, turning `Code[]` into one fragment. **There is no `def combine` in `stdlib/` today.**

Decide before Task 9, because `builtWithFill` runs straight into it:

- **Add it** — `combine(codes: Code[]): Result<Code>` in `stdlib/agency.agency`, with a docstring, merge rules per kind pair (the spec left those open), a `PRELUDE_NAMES` entry if exported from `stdlib/index.agency`, and `make` afterwards.
- **Or exclude it** — state that v1 generators return a single fragment, and write the fixtures accordingly.

Adding it is the better answer, since the boilerplate loop is the feature's motivating shape, but it is a real task and should be sized as one rather than discovered mid-fixture.

## Notes for whoever executes this

**Known limitation, deliberately shipped.** Holes cannot appear in property-name position, so a generator cannot emit `p.#field`. Tracked as #678. Does not block anything here; do not work around it.

**Not in scope.** Introspection of any kind. No `reify`, no compiler-supplied module info, no seeing inside types. Generators take arguments. If a task starts to feel like it needs introspection, it has drifted.
