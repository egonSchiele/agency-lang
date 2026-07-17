# Partials Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model save drafts (`saveDraft` passed as an `llm()` tool, intercepted by the tool loop) and let a `finalize` block read the scope's saved draft (`finalize as draft { ... }`).

**Architecture:** Two independent features from one spec (`docs/superpowers/specs/2026-07-17-partials-ergonomics-design.md`). The finalize binder is a parser + checker + codegen change: the `__finalize` closure gains one parameter and `AbortedResult.withFinalize` passes the draft it already holds. The saveDraft tool is a runtime change in `runPrompt`'s tool loop (ordered interception, before concurrent dispatch) plus one codegen change that threads the enclosing def's declared return type to the call site as a zod schema.

**Tech Stack:** TypeScript, tarsec parser combinators, vitest, zod, the Agency fixture harness (`tests/agency/`).

## Global Constraints

- **Base branch:** must contain PR #574 (the `guard` construct). Every fixture below uses `guard(cost: ...) { ... }` syntax, which does not exist before #574. If #574 has merged, branch from `main`; otherwise stack on `guard-keyword`.
- All file paths below are relative to `packages/agency-lang/` unless they start with `docs/superpowers/`.
- Run `make` (repo root of the package) before running any Agency fixture — fixtures run against `dist/`, and a stale build produces confusing failures.
- Save every test run's output to a file (`2>&1 | tee "$TMPDIR/<name>.log"`). Never re-run a suite just to re-read its output.
- Do NOT run the full Agency suite locally. Run only the specific fixtures you create or touch. CI runs the rest.
- Never commit on main. Verify with `git branch --show-current` before every commit. Write commit messages to a file and use `git commit -F` (apostrophes break `-m`). End every commit message with the line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Codebase rules (docs/dev/coding-standards.md): no dynamic imports, objects over maps, arrays over sets, `type` over `interface`. Run `pnpm run lint:structure` before the final commit.
- The guide file `docs/site/guide/partial-results.md` is owner-authored. Do NOT edit it. Note needed doc updates in the PR description instead.

---

## Background: how the pieces fit (read this first)

**Drafts today.** `saveDraft(x)` in Agency code calls the stdlib def `saveDraft` (`stdlib/index.agency:140`), which calls `_saveDraft` → `StateStack.setSavedDraft` (`lib/runtime/state/stateStack.ts:975`). That method writes `callerFrame().savedDraft` — one frame below the top — because the saveDraft def's own frame sits on top when it runs, so one-below lands on the calling scope. When a guard trip aborts a scope, `AbortedResult.fromError` / `carryThrough` pick up that frame's `savedDraft` as the partial, and the guard returns it as a success.

**Finalize today.** A `finalize { ... }` block compiles into a `const __finalize = async (): Promise<any> => { ... }` closure (`lib/backends/typescriptBuilder/finalizeCodegen.ts:156`). Three stop sites run it through `AbortedResult.withFinalize(finalize, scopeName)` (`lib/runtime/abortedResult.ts:141`). At the moment `withFinalize` runs, `this.partial` already holds the scope's own saved draft (both `fromError` and `carryThrough` read the frame's slot before `withFinalize` is called). If the finalize throws, `withFinalize` returns `this` — the draft-carrying result — so the draft is the fallback. That is why the binder feature is small: **the value the binder should yield is already in `withFinalize`'s hands as `this.partialValueOrNull()`.** We pass it as an argument; nothing about salvage order moves.

**The tool loop today.** `llm()` compiles to a direct `runPrompt()` call (`typescriptBuilder.ts` `processLlmCall`). `runPrompt` pushes its OWN frame on entry (`setupFunction()` at `lib/runtime/prompt.ts:870` → `stateStack.getNewState()`, which pushes). So during the tool loop the stack is `[…, owner, runPrompt]` — the same shape as the def path's `[…, owner, saveDraft-def]` — and the existing `setSavedDraft` (which writes `callerFrame()`) lands on the owner in BOTH paths. This was mis-analyzed in spec review round 1 and corrected in the spec on 2026-07-17; the plan pins the frame math with a fixture (Task 7) rather than trusting the analysis. Tool calls in one round dispatch concurrently via `pr.parallel` (`prompt.ts:1519`); interception must happen BEFORE that dispatch, in the ordered iteration, so "last save wins" holds in call-list order.

**Tool definitions today.** Each tool is an `AgencyFunction` with readonly `name` and `module` fields and a `toolDefinition: { name, description, schema }` where `schema` is a zod schema (`lib/runtime/agencyFunction.ts:62`). The stdlib saveDraft's compiled identity is `name: "saveDraft", module: "stdlib/index.agency"` (verified in `stdlib/index.js`). `runPrompt` builds the provider tool list at `prompt.ts:915` by mapping `exposedFunctions` to their `toolDefinition`s — that map is where the synthesized saveDraft definition substitutes in.

**Schema threading.** The builder's `ScopeManager.returnType()` (`lib/backends/typescriptBuilder/scopeManager.ts:131`) returns the declared return type of the CURRENT scope but returns `undefined` for block scopes. The saveDraft schema wants the nearest enclosing FUNCTION or NODE's declared type (spec decision 3 + finding 3 honesty note), so Task 5 adds a variant that walks outward past blocks. `zodSchemaFor(t)` (`typescriptBuilder.ts:880`) renders a `VariableType` to a zod-source string — the same bridge `responseFormat` uses.

**The handler-param precedent for the binder.** An inline handler `with (i) { ... }` compiles its body with `i` as a plain arrow-function parameter, and references to `i` print as the bare identifier (verified in `tests/agency/guards/guard-concurrent-branches.js:205` — `async (i) => { ... i.effect ... }`). This works because `i` is never declared via `let`/`const`, so the preprocessor never scopes it to `__stack.locals`. The finalize binder uses the identical mechanism. The one hazard: if the binder name collides with a declared local, references would resolve to `__stack.locals.<name>` (the local) instead of the parameter — a silent miscompile. Task 2's checker rule (AG6037) makes that collision a compile error, which is what makes the codegen sound.

**Checker-side precedent.** `buildScopes` declares handler params into the function scope (`lib/typeChecker/scopes.ts:516`), and `refineInlineHandlerParams` (`lib/typeChecker/handlerParamTyping.ts`) re-types them in a pre-flow pass wired at `lib/typeChecker/index.ts:309`. The binder declaration pass (Task 2) is a sibling of that pass: same walk idiom, same wiring point, must also run before `buildFlowGraphs`.

**Fixture harness.** `tests/agency/guards/*.agency` + `.test.json` run without real LLM calls: `useTestLLMProvider: true` + `llmMocks` drive the `DeterministicClient`, which supports mocked tool calls with arguments (`{ "toolCalls": [{ "name": "saveDraft", "args": { "value": "x" } }] }`, `lib/runtime/deterministicClient.ts:42`) and reports synthetic cost, so a `guard(cost: 0.000001)` trips deterministically. Harness `interruptHandlers` support `action: "approve" | "reject" | "modify" | "resolve"` (`lib/cli/util.ts:162`) and ASSERT that the declared interrupts actually occur — never declare a handler for an interrupt that might not fire.

## File map

Part A — finalize binder:

| File | Change |
|---|---|
| `lib/types/finalizeBlock.ts` | `params: FunctionParameter[]` field (same shape as `BlockArgument.params`) |
| `lib/parsers/parsers.ts` | `finalizeBlockParser` accepts `()` and delegates the binder to the existing `asParser` |
| `lib/parsers/finalizeBinder.test.ts` | NEW — parser tests |
| `lib/backends/agencyGenerator.ts` | formatter prints the binder |
| `lib/backends/agencyGenerator.test.ts` | formatter tests (existing file) |
| `lib/typeChecker/finalizeBinder.ts` | NEW — binder declaration pass + collision check |
| `lib/typeChecker/finalizeBinder.test.ts` | NEW — checker tests |
| `lib/typeChecker/diagnostics.ts`, `diagnosticExplanations.ts` | AG6037 |
| `lib/typeChecker/index.ts` | wire the pass |
| `lib/runtime/abortedResult.ts` | `withFinalize` passes the draft |
| `lib/templates/backends/typescriptGenerator/finalizeClosure.mustache` | NEW — the closure emission as a typestache template |
| `lib/backends/typescriptBuilder/finalizeCodegen.ts` | closure gains the binder param, emission moves to the template |
| `lib/backends/finalizeBinderCodegen.test.ts` | NEW — codegen tests |
| `tests/agency/guards/finalize-binder-*.agency/.test.json` | NEW — 3 fixtures |

Part B — saveDraft as a tool:

| File | Change |
|---|---|
| `lib/backends/typescriptBuilder/scopeManager.ts` | `enclosingDeclaredReturnType()` |
| `lib/backends/typescriptBuilder.ts` | `processLlmCall` emits `draftSchema` |
| `lib/backends/draftSchemaCodegen.test.ts` | NEW — codegen tests |
| `lib/runtime/intrinsicTools.ts` | NEW — the intrinsic-tool registry (the extensibility seam) |
| `lib/runtime/saveDraftTool.ts` | NEW — the saveDraft intrinsic: recognition, definition, handler with validation |
| `lib/runtime/saveDraftTool.test.ts` | NEW — unit tests |
| `lib/runtime/prompt.ts` | ordered interception pass over the registry; `draftSchema` arg; tool-def substitution |
| `tests/agency/guards/savedraft-tool-*.agency/.test.json` | NEW — 6 fixtures |

---

### Task 1: Parser, AST, and formatter for the finalize binder

**Files:**
- Modify: `lib/types/finalizeBlock.ts`
- Modify: `lib/parsers/parsers.ts` (the `finalizeBlockParser` at ~line 4290)
- Modify: `lib/backends/agencyGenerator.ts:1673` (`processFinalizeBlock`)
- Test: `lib/parsers/finalizeBinder.test.ts` (new), `lib/backends/agencyGenerator.test.ts` (append)

**Interfaces:**
- Consumes: the EXISTING `asParser` (`lib/parsers/parsers.ts:3148`) and `FunctionParameter` — the same binder grammar and param type `fork(...) as item { }` blocks use. Do not hand-roll the `as` clause.
- Produces: `FinalizeBlock.params: FunctionParameter[]` — every later task reads this field; the binder is `params[0]`, and `params` is `[]` for the binder-less form. All four head forms parse: `finalize {`, `finalize() {`, `finalize as draft {`, `finalize() as draft {`. Because `asParser` also accepts `as (a, b)` and `as draft: Report`, those PARSE here; Task 2's checker constrains them (one binder max; an explicit type hint is honored). The formatter prints canonically without parens.

- [ ] **Step 1: Write the failing parser tests**

Create `lib/parsers/finalizeBinder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { finalizeBlockParser } from "./parsers.js";
import { parseAgency } from "../parser.js";

function parseFinalize(src: string) {
  const r = finalizeBlockParser(src);
  expect(r.success).toBe(true);
  if (!r.success) throw new Error(r.message);
  return r.result;
}

describe("finalizeBlockParser — binder head forms (via the shared asParser)", () => {
  it("parses the bare form with empty params", () => {
    const node = parseFinalize("finalize {\n  return 1\n}");
    expect(node.type).toBe("finalizeBlock");
    expect(node.params).toEqual([]);
  });

  it("parses empty parens with empty params", () => {
    const node = parseFinalize("finalize() {\n  return 1\n}");
    expect(node.params).toEqual([]);
  });

  it("parses `as name` into params[0]", () => {
    const node = parseFinalize("finalize as draft {\n  return draft\n}");
    expect(node.params).toHaveLength(1);
    expect(node.params[0].name).toBe("draft");
  });

  it("parses `() as name`", () => {
    const node = parseFinalize("finalize() as best {\n  return best\n}");
    expect(node.params[0].name).toBe("best");
  });

  it("binder name is the user's choice", () => {
    const node = parseFinalize("finalize as partialSoFar {\n  return partialSoFar\n}");
    expect(node.params[0].name).toBe("partialSoFar");
  });

  it("a typed binder parses (the shared grammar allows it; the checker rules on it)", () => {
    const node = parseFinalize("finalize as draft: string {\n  return draft\n}");
    expect(node.params[0].name).toBe("draft");
    expect(node.params[0].typeHint).toBeDefined();
  });

  it("multiple binders parse (rejected later by AG6038, not here)", () => {
    const node = parseFinalize("finalize as (a, b) {\n  return a\n}");
    expect(node.params).toHaveLength(2);
  });

  it("does not swallow an identifier like finalizer(...)", () => {
    const r = finalizeBlockParser("finalizer(1)");
    expect(r.success).toBe(false);
  });

  it("`as` with no name parses as the binder-less form (the shared grammar's no-param rule)", () => {
    // blockParamsParser treats `as {` as "as, then zero params" — the
    // documented no-param block form (`fork() as { }`). Reusing the
    // grammar means finalize inherits it; the formatter canonicalizes
    // the stray `as` away, exactly like guard's legacy-as migration.
    const node = parseFinalize("finalize as {\n  return 1\n}");
    expect(node.params).toEqual([]);
  });

  it("parses inside a full function body", () => {
    const r = parseAgency(
      "def f(): string {\n  return \"x\"\n\n  finalize as d {\n    return \"y\"\n  }\n}\n",
      {},
      false,
    );
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:run lib/parsers/finalizeBinder.test.ts 2>&1 | tee "$TMPDIR/finalize-parser.log"`
Expected: FAIL — `params` is `undefined` on the current node and the `as` forms do not parse. (The bare-form tests may already pass except for the `params` assertion.)

- [ ] **Step 3: Add the field to the AST type**

In `lib/types/finalizeBlock.ts`:

```ts
import type { FunctionParameter } from "../types.js";

export type FinalizeBlock = BaseNode & {
  type: "finalizeBlock";
  /** `finalize as <name>` binder, parsed by the same asParser blocks
   *  use — so this is the SAME field shape as BlockArgument.params.
   *  params[0] is the binder the scope's saved draft is yielded to;
   *  [] is the binder-less form. The grammar also admits multiple
   *  params and type hints; AG6038 (arity) and the binder-typing pass
   *  rule on those, not the parser. */
  params: FunctionParameter[];
  body: AgencyNode[];
};
```

(Adjust the `FunctionParameter` import path to wherever `BlockArgument` imports it from.) Then run `pnpm exec tsc --noEmit 2>&1 | tee "$TMPDIR/tsc-binder.log"` and fix every construction site the compiler flags by adding `params: []` (the parser rewrite in Step 4 covers the main one; any test or preprocessor that builds a literal `finalizeBlock` node needs the explicit field).

- [ ] **Step 4: Rewrite the parser**

Replace the existing `finalizeBlockParser` in `lib/parsers/parsers.ts` (keep its position and registration; it is already in the statement parser list). The binder clause is NOT hand-rolled: it is the existing `asParser` (`parsers.ts:3148`), the same combinator block arguments use, which yields `FunctionParameter[]` and `[]` when the clause is absent. Model the commit-at-`{` shape on `guardBlockParser`:

```ts
/** `finalize { ... }` — keyword block. Four head forms parse:
 *  `finalize {`, `finalize() {`, `finalize as name {`,
 *  `finalize() as name {`. The binder clause is the SAME asParser
 *  block arguments use, so the grammar (and its edge cases — `as {`
 *  means no params, parens and type hints are admitted) is shared,
 *  not duplicated; arity and typing are checker rules (AG6038, the
 *  binder-typing pass). Mirrors handleBlockParser's keyword handling:
 *  the word-boundary check keeps an identifier like `finalizer(...)`
 *  parsing as a call. */
export const finalizeBlockParser: Parser<FinalizeBlock> = withLoc(memo(
  "finalizeBlockParser",
  (input: string): ParserResult<FinalizeBlock> => {
    const pre = seqC(
      str("finalize"),
      not(varNameChar),
      optionalSpaces,
      // Optional empty parens: `finalize() { ... }`.
      optional(seqC(char("("), optionalSpaces, char(")"))),
      optionalSpaces,
      capture(asParser, "params"),
      optionalSpaces,
      char("{"),
    )(input);
    if (!pre.success) return pre as ParserResult<FinalizeBlock>;
    // Past the `{` we commit: a malformed body is an error here.
    const bodyR = parseError(
      "expected `}` to close finalize block body",
      optionalSpacesOrNewline,
      capture(lazy(() => bodyParser), "body"),
      optionalSpacesOrNewline,
      char("}"),
    )(pre.rest);
    if (!bodyR.success) return bodyR as ParserResult<FinalizeBlock>;
    return success(
      {
        type: "finalizeBlock",
        params: (pre.result as any).params,
        body: (bodyR.result as any).body,
      } as FinalizeBlock,
      bodyR.rest,
    );
  },
));
```

- [ ] **Step 5: Run the parser tests**

Run: `pnpm test:run lib/parsers/finalizeBinder.test.ts 2>&1 | tee "$TMPDIR/finalize-parser2.log"`
Expected: PASS.

- [ ] **Step 6: Write the failing formatter tests**

Append to `lib/backends/agencyGenerator.test.ts` (use the existing `gen` helper pattern from `agencyGenerator.guardBlock.test.ts` if this file lacks one):

```ts
describe("AgencyGenerator — finalize binder", () => {
  it("prints the canonical binder form without parens", () => {
    const out = gen(
      "def f(): string {\n  return \"x\"\n  finalize() as d {\n    return \"y\"\n  }\n}\nnode main() { return f() }\n",
    );
    expect(out).toContain("finalize as d {");
    expect(out).not.toContain("finalize()");
  });

  it("prints the binder-less form unchanged", () => {
    const out = gen(
      "def f(): string {\n  return \"x\"\n  finalize {\n    return \"y\"\n  }\n}\nnode main() { return f() }\n",
    );
    expect(out).toContain("finalize {");
  });

  it("canonicalizes a stray `as` with no binder away (fmt IS the migration, like guard)", () => {
    const out = gen(
      "def f(): string {\n  return \"x\"\n  finalize as {\n    return \"y\"\n  }\n}\nnode main() { return f() }\n",
    );
    expect(out).toContain("finalize {");
    expect(out).not.toContain("finalize as {");
  });
});
```

- [ ] **Step 7: Implement the formatter change**

In `lib/backends/agencyGenerator.ts` (`processFinalizeBlock`, line ~1673), reuse the existing `renderParams` (line ~628 — it already prints names, type hints, and multi-param lists correctly):

```ts
protected processFinalizeBlock(node: FinalizeBlock): string {
  this.increaseIndent();
  const bodyCodeStr = this.renderBody(node.body);
  this.decreaseIndent();
  const rendered = this.renderParams(node.params);
  const asClause =
    rendered.length === 0
      ? ""
      : rendered.length === 1
        ? ` as ${rendered[0]}`
        : ` as (${rendered.join(", ")})`;
  return this.indentStr(`finalize${asClause} {\n${bodyCodeStr}${this.indentStr("}")}`);
}
```

(If `renderParams` is private and inaccessible from this method's position, follow how the block-argument printing at line ~1112 renders its `as` clause instead — same file, same pattern.)

- [ ] **Step 8: Run formatter tests and the neighboring suites**

Run: `pnpm test:run lib/backends/agencyGenerator.test.ts lib/parsers/finalizeBinder.test.ts lib/typeChecker/finalize.test.ts 2>&1 | tee "$TMPDIR/finalize-fmt.log"`
Expected: PASS (finalize.test.ts guards against regressions in the existing finalize checks).

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # must NOT be main
printf 'feat: parse and print the finalize binder (finalize as draft)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude/commitmsg.txt
git add lib/types/finalizeBlock.ts lib/parsers/parsers.ts lib/parsers/finalizeBinder.test.ts lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts
git commit -F /tmp/claude/commitmsg.txt
```

---

### Task 2: Checker — declare the binder as `T | null`, reject collisions (AG6037) and multi-binders (AG6038)

**Files:**
- Create: `lib/typeChecker/finalizeBinder.ts`
- Modify: `lib/typeChecker/diagnostics.ts` (after `finalizeReturnShape`), `lib/typeChecker/diagnosticExplanations.ts`, `lib/typeChecker/index.ts:309`
- Test: `lib/typeChecker/finalizeBinder.test.ts` (new)

**Interfaces:**
- Consumes: `FinalizeBlock.params: FunctionParameter[]` from Task 1 (binder = `params[0]`; `params[0].typeHint` may be set).
- Produces: `declareFinalizeBinders(scopes: ScopeInfo[], ctx: TypeCheckerContext): void`, diagnostic keys `finalizeBinderCollision` (AG6037) and `finalizeBinderArity` (AG6038). The binder is visible to `checkScopes` typed `T | null`, where `T` is the explicit type hint when written (`finalize as d: Report` — "explicit annotation wins", the handler-param rule), else the scope's DECLARED return type, else `any`.

Background for this task: why a collision is an ERROR and not a shadow. The finalize body compiles in the enclosing scope, and the binder becomes a bare closure parameter (Task 3). A reference to a name the preprocessor knows as a local compiles to `__stack.locals.<name>` — so if the binder reused a local's name, every reference in the finalize body would silently read the LOCAL, never the draft. The type checker is the only place that can see this coming.

Also note one accepted limitation, mirroring inline handler params (`scopes.ts:516` declares those into the function scope too): the binder name is declared function-wide, so REFERENCING it outside the finalize is not flagged as undefined. The collision rule removes the dangerous direction (binder clobbering a real local); the reference-leak direction fails at runtime like a handler param would. Record this in the code comment.

- [ ] **Step 1: Write the failing checker tests**

Create `lib/typeChecker/finalizeBinder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

describe("finalize binder — typing and collisions (spec Part 3)", () => {
  it("types the binder as T | null: unguarded use as T errors", () => {
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize as d {
    const s: string = d
    return s
  }
}
node main() { return f() }`,
    ).filter((e) => /null|not assignable/i.test(e.message));
    expect(errs.length).toBeGreaterThan(0);
  });

  it("a null-guarded use narrows to T and passes", () => {
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize as d {
    if (d != null) {
      const s: string = d
      return s
    }
    return "empty"
  }
}
node main() { return f() }`,
    ).filter((e) => /null|not assignable/i.test(e.message));
    expect(errs).toHaveLength(0);
  });

  it("an undeclared return type leaves the binder as any (no errors AT ALL)", () => {
    // UNFILTERED on purpose (plan review T1): the bug this guards
    // against — the pass failing to declare `d` — surfaces as an
    // "undefined variable" error, which a binder/null/assignable
    // message filter would silently drop. Zero errors total is the
    // only assertion that fails in that direction. The unguarded
    // `const s: string = d` doubles as the any-permissiveness probe:
    // legal for `any`, an error for `T | null`.
    const errs = typecheckSource(
      `def f() {
  return "x"
  finalize as d {
    const s: string = d
    return s
  }
}
node main() { return f() }`,
    );
    expect(errs).toHaveLength(0);
  });

  it("a binder named like a MODULE-level const is allowed (collision check is scope-local)", () => {
    // The miscompile AG6037 prevents is a same-frame local resolving
    // to __stack.locals.<name>. A module global compiles differently
    // (not a frame local), so it is NOT a hazard, and a parent-walking
    // `has` would false-positive here (plan review finding 3 / M2).
    const errs = typecheckSource(
      `const banner = "b"
def f(): string {
  return "x"
  finalize as banner {
    if (banner != null) { return banner }
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.filter((e) => e.code === "AG6037")).toHaveLength(0);
  });

  it("a binder colliding with a local is AG6037", () => {
    const errs = typecheckSource(
      `def f(): string {
  const outline = "o"
  return outline
  finalize as outline {
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.some((e) => e.code === "AG6037")).toBe(true);
  });

  it("a binder colliding with a parameter is AG6037", () => {
    const errs = typecheckSource(
      `def f(topic: string): string {
  return topic
  finalize as topic {
    return "y"
  }
}
node main() { return f("t") }`,
    );
    expect(errs.some((e) => e.code === "AG6037")).toBe(true);
  });

  it("a fresh binder name does not disturb outer variables", () => {
    const errs = typecheckSource(
      `def f(): string {
  const outline = "o"
  return outline
  finalize as d {
    if (outline != null) { return outline }
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.filter((e) => e.code === "AG6037")).toHaveLength(0);
  });

  it("the binder-less form is untouched", () => {
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize {
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.filter((e) => e.code === "AG6037")).toHaveLength(0);
  });

  it("two binders is AG6038 (finalize yields one value)", () => {
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize as (a, b) {
    return "y"
  }
}
node main() { return f() }`,
    );
    expect(errs.some((e) => e.code === "AG6038")).toBe(true);
  });

  it("an explicit type hint wins over the scope's return type", () => {
    // def returns string; the binder is annotated number, so using it
    // as a string (after the null guard) must error.
    const errs = typecheckSource(
      `def f(): string {
  return "x"
  finalize as d: number {
    if (d != null) {
      const s: string = d
      return "y"
    }
    return "y"
  }
}
node main() { return f() }`,
    ).filter((e) => /not assignable/i.test(e.message));
    expect(errs.length).toBeGreaterThan(0);
  });
});
```

If `typecheckSource` returns diagnostics without a `.code` field, match on the message instead (`/collides/`) — check `lib/typeChecker/testUtils.ts` and `guardConstruct.test.ts` for the shape actually returned before writing assertions.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/typeChecker/finalizeBinder.test.ts 2>&1 | tee "$TMPDIR/finalize-checker.log"`
Expected: FAIL — no binder declaration exists, so the `T | null` tests find no error and the collision tests find no AG6037.

- [ ] **Step 3: Add the diagnostic**

In `lib/typeChecker/diagnostics.ts`, after the `finalizeReturnShape` entry:

```ts
finalizeBinderCollision: {
  code: "AG6037",
  severity: "error",
  message:
    "finalize binder '{name}' collides with a variable that already exists in this scope. Pick a fresh name. The finalize body reads the scope's locals directly, so a colliding binder would silently shadow the local.",
},
```

And after it:

```ts
finalizeBinderArity: {
  code: "AG6038",
  severity: "error",
  message:
    "finalize yields a single value — the scope's saved draft. Use one binder: finalize as {name} {{ ... }}.",
},
```

(Check how existing messages escape braces / interpolate before copying the `{name}` placeholder — mirror a neighboring entry exactly.)

In `lib/typeChecker/diagnosticExplanations.ts`, alongside the other finalize entries:

```ts
finalizeBinderCollision: `A finalize body runs in the same variable scope as the function or block it belongs to. The \`as\` binder adds one extra name: the scope's saved draft. If that name already belongs to a parameter or local, references inside the finalize could not tell the two apart, and the draft would silently win or lose depending on compilation details.

**How to fix:** rename the binder. Any name not already used in the scope works: \`finalize as draft { ... }\`.`,

finalizeBinderArity: `The \`as\` clause on a finalize binds what the abort yields to the block, and the abort yields exactly one thing: the scope's saved draft (or null when nothing was saved). There is no second value to bind, so a parameter list has no meaning here. The shared block-argument grammar is why the parser accepts the list at all.

**How to fix:** keep one binder: \`finalize as draft { ... }\`. Everything else the finalize needs is already in scope as ordinary locals.`,
```

- [ ] **Step 4: Write the pass**

Create `lib/typeChecker/finalizeBinder.ts`:

```ts
import type { ScopeInfo, TypeCheckerContext } from "./types.js";
import type { VariableType } from "../types.js";
import type { FinalizeBlock } from "../types/finalizeBlock.js";
import { walkNodes } from "../utils/node.js";
import { isInScope } from "./checker.js";
import { diagnostic } from "./diagnostics.js";
import { ANY_T, NULL_T } from "./primitives.js";

/** The binder's type: T | null, where T is the explicit annotation
 *  when written (`finalize as d: Report` — explicit annotation wins,
 *  the handler-param rule), else the scope's DECLARED return type
 *  (the slot is empty until the first saveDraft, hence the null arm).
 *  Neither present means `any` — inferred return types are out of
 *  scope for v1, the same rule the saveDraft tool schema follows
 *  (spec Part 5). */
function binderType(
  typeHint: VariableType | undefined,
  returnType: VariableType | undefined,
): VariableType {
  const t = typeHint ?? returnType;
  if (t === undefined) return ANY_T;
  return { type: "unionType", types: [t, NULL_T] };
}

/**
 * Declare each `finalize as <name>` binder into its scope, typed
 * `T | null`. A sibling of refineInlineHandlerParams: runs pre-flow so
 * checkScopes and the flow passes see the binding, and declares into
 * the FUNCTION scope (the finalize body has no scope of its own).
 *
 * A binder that collides with an existing name is an error (AG6037),
 * not a shadow: the binder compiles to a bare closure parameter, and a
 * colliding reference would resolve to `__stack.locals.<name>` — the
 * local — instead. The collision rule is what makes the codegen sound.
 *
 * Accepted limitation (mirrors inline handler params, scopes.ts): the
 * declaration is function-wide, so a reference to the binder OUTSIDE
 * the finalize is not flagged as undefined here.
 */
export function declareFinalizeBinders(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): void {
  for (const info of scopes) {
    ctx.withScope(info.scopeKey, () => {
      for (const { node, scopes: nodeScopes } of walkNodes(info.body)) {
        if (!isInScope(nodeScopes, info)) continue;
        if (node.type !== "finalizeBlock") continue;
        const fin = node as FinalizeBlock;
        if (fin.params.length === 0) continue;
        if (fin.params.length > 1) {
          ctx.errors.push(
            diagnostic(
              "finalizeBinderArity",
              { name: fin.params[0].name },
              fin.loc ?? null,
            ),
          );
          continue;
        }
        const binder = fin.params[0];
        if (info.scope.has(binder.name)) {
          ctx.errors.push(
            diagnostic(
              "finalizeBinderCollision",
              { name: binder.name },
              fin.loc ?? null,
            ),
          );
          continue;
        }
        info.scope.declare(
          binder.name,
          binderType(binder.typeHint, info.returnType),
        );
      }
    });
  }
}
```

Verify the `walkNodes` result shape (`{ node, scopes }`) and `isInScope` import against `handlerParamTyping.ts:109-110` — copy exactly what that file does; it is the working precedent. If `ScopeInfo` has no `returnType` field, find where `checkScopes` reads it (`checker.ts:177`) and use the same source.

One requirement on the collision check (plan review finding 3): it must be SCOPE-LOCAL. Read `Scope.has` in `lib/typeChecker/scope.ts` before using it — if it walks parent scopes, use (or add) a local-only variant. The hazard AG6037 prevents is a binder resolving to `__stack.locals.<name>` — a same-frame local or param. A name matching a MODULE global is not a hazard (globals compile through `__globals()`, not the frame), and a parent-walking check would wrongly reject it; the module-const test above pins this direction.

- [ ] **Step 5: Wire it in**

In `lib/typeChecker/index.ts`, import the pass and call it right after `refineInlineHandlerParams` (line ~309):

```ts
declareFinalizeBinders(scopes, ctx);
```

It must run before `buildFlowGraphs` for the same reason `refineInlineHandlerParams` must (see that function's ordering assertion).

- [ ] **Step 6: Run the tests**

Run: `pnpm test:run lib/typeChecker/finalizeBinder.test.ts lib/typeChecker/finalize.test.ts lib/typeChecker/saveDraft.test.ts 2>&1 | tee "$TMPDIR/finalize-checker2.log"`
Expected: PASS, including the pre-existing finalize/saveDraft suites.

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must NOT be main
printf 'feat: type the finalize binder as T | null, reject collisions and multi-binders\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude/commitmsg.txt
git add lib/typeChecker/finalizeBinder.ts lib/typeChecker/finalizeBinder.test.ts lib/typeChecker/diagnostics.ts lib/typeChecker/diagnosticExplanations.ts lib/typeChecker/index.ts
git commit -F /tmp/claude/commitmsg.txt
```

---

### Task 3: Codegen and runtime — pass the draft into the finalize closure

**Files:**
- Modify: `lib/runtime/abortedResult.ts:141` (`withFinalize`)
- Create: `lib/templates/backends/typescriptGenerator/finalizeClosure.mustache`
- Modify: `lib/backends/typescriptBuilder/finalizeCodegen.ts:156` (`closure`)
- Test: `lib/backends/finalizeBinderCodegen.test.ts` (new)

**Interfaces:**
- Consumes: `FinalizeBlock.params` (Task 1; the binder is `params[0]`, and Task 2 guarantees at most one param survives checking).
- Produces: `withFinalize(finalize: (draft: unknown) => Promise<unknown>, scopeName: string)`; generated closures `const __finalize = async (<binder>: any): Promise<any> => { ... }` when a binder exists, byte-identical output when not.

The design in one paragraph: `withFinalize` already holds the scope's own draft — `carryThrough(frame, scope)` and `fromError(error, frame, scope)` both copy `frame.savedDraft` into `this.partial` before any stop site calls `.withFinalize(...)`. So the runtime change is one line: call `finalize(this.partialValueOrNull())`. The throw-fallback path returns `this`, which carries the SAME partial — so "the draft is read before the finalize runs, and the same value is the fallback" (spec Part 3) holds by construction, with zero changes to `stopScope`, `abortReturn`, or `interceptedReturn`. Existing binder-less closures are `async () => ...`; passing them an argument they ignore is a no-op, and TypeScript accepts a zero-param function where a one-param function type is expected, so nothing else moves.

- [ ] **Step 1: Write the failing codegen test**

Create `lib/backends/finalizeBinderCodegen.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

function gen(src: string): string {
  const r = parseAgency(src, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return generateTypeScript(r.result, undefined, undefined, "test.agency");
}

describe("finalize binder codegen", () => {
  it("the closure takes the binder as a bare parameter", () => {
    const out = gen(
      "def f(): string {\n  return \"x\"\n  finalize as draft {\n    if (draft != null) { return draft }\n    return \"none\"\n  }\n}\nnode main() { return f() }\n",
    );
    expect(out).toContain("const __finalize = async (draft: any): Promise<any>");
    // The body must reference the parameter BARE, not a frame local —
    // that is the whole trick (handler-param precedent).
    expect(out).not.toContain("__stack.locals.draft");
  });

  it("binder-less output is byte-identical to the old form", () => {
    const out = gen(
      "def f(): string {\n  return \"x\"\n  finalize {\n    return \"y\"\n  }\n}\nnode main() { return f() }\n",
    );
    expect(out).toContain("const __finalize = async (): Promise<any>");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/backends/finalizeBinderCodegen.test.ts 2>&1 | tee "$TMPDIR/finalize-codegen.log"`
Expected: FAIL on the first test (`async ()` emitted, no param).

- [ ] **Step 3: Implement the codegen change — as a typestache template, not a raw string**

The closure emission is a multi-line codegen string, and those belong in `lib/templates/` (owner rule; see `blockSetup.mustache` for the pattern this copies). Create `lib/templates/backends/typescriptGenerator/finalizeClosure.mustache`:

```mustache
const __finalize = async ({{{binderParam}}}): Promise<any> => {
  const runner = new Runner(__ctx, {{{frameVar}}}, { state: {{{frameVar}}}, moduleId: {{{moduleId}}}, scopeName: {{{scopeName}}} });
{{{body}}}
  return runner.halted ? runner.haltResult : undefined;
};
```

Run `pnpm run templates` to compile it (only ever edit the `.mustache`, never the generated `.ts`).

In `lib/backends/typescriptBuilder/finalizeCodegen.ts`, import it the way `typescriptBuilder.ts:38` imports `blockSetup` (`import * as renderFinalizeClosure from "../../templates/backends/typescriptGenerator/finalizeClosure.js";`) and rewrite `closure()`:

```ts
private closure(finalize: FinalizeBlock, scopeName: string): TsNode {
  const parts = this.compileBody(finalize.body, FinalizeCodegen.STEP_BASE);
  const bodyStr = parts.map((n) => printTs(n, 1)).join("\n");
  // The binder is a plain closure parameter (never a frame local): it
  // was never declared via let/const, so body references print as the
  // bare identifier — the same mechanism inline handler params use.
  // AG6037 guarantees the name cannot collide with a real local, and
  // AG6038 guarantees at most one param reaches codegen.
  const binder = finalize.params[0];
  return ts.raw(
    renderFinalizeClosure.default({
      binderParam: binder !== undefined ? `${binder.name}: any` : "",
      frameVar: this.frameVar(),
      moduleId: JSON.stringify(this.moduleId),
      scopeName: JSON.stringify(scopeName + "#finalize"),
      body: bodyStr,
    }).trimEnd(),
  );
}
```

The template's output must be BYTE-IDENTICAL to the old raw string for binder-less programs — that is what Step 5's zero-churn check enforces. Watch the two usual template traps: a trailing newline from the file's last line (hence the `trimEnd()`; drop it if the template renders flush) and the newline between the runner line and `{{{body}}}`. If the first `make fixtures` diff shows whitespace-only churn, fix the TEMPLATE until the diff is empty; do not regenerate the fixtures around it.

- [ ] **Step 4: Implement the runtime change**

In `lib/runtime/abortedResult.ts`, `withFinalize`:

```ts
async withFinalize(
  finalize: (draft: unknown) => Promise<unknown>,
  scopeName: string,
): Promise<AbortedResult> {
  let value: unknown;
  try {
    // The partial this instance holds IS the scope's own saved draft
    // (carryThrough/fromError copied the frame slot before any stop
    // site called us) — yielded to a `finalize as draft` binder. Read
    // before the finalize runs; on throw the same value is the
    // fallback because the catch returns `this`.
    value = await finalize(this.partialValueOrNull());
  } catch (finalizeError) {
    this.logFinalizeFailure(scopeName, finalizeError);
    return this;
  }
  ...
```

(Only the signature, the call, and the comment change; the rest of the method body stays as it is.)

- [ ] **Step 4b: Unit-test the runtime half in isolation (plan review M5)**

The fixture proves the whole pipe; this pins the one-line runtime change so a regression fails at the unit level. Append to `lib/runtime/abortedResult.test.ts`, following that file's existing construction helpers for an `AbortedResult` carrying a partial:

```ts
describe("withFinalize passes the draft (finalize as draft)", () => {
  it("the finalize receives the partial this instance holds", async () => {
    const aborted = /* construct an AbortedResult whose partial is { value: "the-draft" }, using this file's existing helpers (carryThrough/fromError against a frame with savedDraft set) */;
    let received: unknown = "not-called";
    await aborted.withFinalize(async (draft) => {
      received = draft;
      return "finalized";
    }, "scope");
    expect(received).toBe("the-draft");
  });

  it("no partial yields null, matching the binder's null case", async () => {
    const aborted = /* same construction, frame with NO savedDraft */;
    let received: unknown = "not-called";
    await aborted.withFinalize(async (draft) => {
      received = draft;
      return "finalized";
    }, "scope");
    expect(received).toBe(null);
  });

  it("a throwing finalize still returns `this` — the same draft is the fallback", async () => {
    const aborted = /* partial = { value: "the-draft" } */;
    const result = await aborted.withFinalize(async () => {
      throw new Error("boom");
    }, "scope");
    expect(result).toBe(aborted);
    expect(result.partialValueOrNull()).toBe("the-draft");
  });
});
```

Replace the construction comments with this test file's real idiom — `abortedResult.test.ts` already builds instances with and without partials; copy its setup rather than inventing one.

Run: `pnpm test:run lib/runtime/abortedResult.test.ts 2>&1 | tee "$TMPDIR/withfinalize-unit.log"` — expected PASS.

- [ ] **Step 5: Run codegen tests + prove byte-stability**

Run: `pnpm test:run lib/backends/finalizeBinderCodegen.test.ts 2>&1 | tee "$TMPDIR/finalize-codegen2.log"`
Expected: PASS.

Then prove existing fixtures did not move:

```bash
make 2>&1 | tail -5
make fixtures 2>&1 | tail -5
git status --porcelain tests/ | tee "$TMPDIR/fixture-churn-a.log"
```

Expected: `git status` shows NO modified fixture `.js` files (the binder-less closure text is unchanged). If anything churned, diff it and understand why before proceeding — this task must be invisible to existing programs.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must NOT be main
printf 'feat: yield the saved draft to the finalize closure (finalize as draft)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude/commitmsg.txt
git add lib/runtime/abortedResult.ts lib/runtime/abortedResult.test.ts lib/backends/typescriptBuilder/finalizeCodegen.ts lib/backends/finalizeBinderCodegen.test.ts lib/templates/
git commit -F /tmp/claude/commitmsg.txt
```

---

### Task 4: Agency fixtures for the finalize binder

**Files:**
- Create: `tests/agency/guards/finalize-binder-returns-draft.agency` + `.test.json`
- Create: `tests/agency/guards/finalize-binder-null.agency` + `.test.json`
- Create: `tests/agency/guards/finalize-binder-throw-falls-back.agency` + `.test.json`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: end-to-end proof of the three spec Part 4 binder behaviors. Model all three on `tests/agency/guards/finalize-wins-over-draft.agency` / `finalize-error-falls-back.agency` — same mock, same guard budget, same reject handler.

- [ ] **Step 1: Write the returns-draft fixture**

`tests/agency/guards/finalize-binder-returns-draft.agency`:

```
// The binder yields the scope's OWN saved draft; the finalize returns
// it with a suffix — the two salvage tools composing (partials
// ergonomics spec, Part 3).
def work(): string {
  saveDraft("the-draft")
  const reply = llm("Reply with: pong")
  return reply

  finalize as draft {
    if (draft != null) {
      return draft + "+suffix"
    }
    return "no-draft"
  }
}

node main() {
  const result = guard(cost: 0.000001) {
    return work()
  }
  if (isFailure(result)) { return "unexpected" }
  return result.value
}
```

`tests/agency/guards/finalize-binder-returns-draft.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"the-draft+suffix\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [{ "return": "pong" }],
      "description": "finalize as draft yields the scope's saved draft; the finalize returns it with a suffix.",
      "interruptHandlers": [{ "action": "reject" }]
    }
  ]
}
```

- [ ] **Step 2: Write the null-binder fixture**

`tests/agency/guards/finalize-binder-null.agency` — identical shape, but `work` never calls `saveDraft`, and the finalize is:

```
  finalize as draft {
    if (draft == null) {
      return "was-null"
    }
    return "had-value"
  }
```

`.test.json` expects `"\"was-null\""`, same mocks and handlers as Step 1.

- [ ] **Step 3: Write the throw-falls-back fixture**

`tests/agency/guards/finalize-binder-throw-falls-back.agency` — the throwing mechanism copied from `finalize-error-falls-back.agency`:

```
// A throwing finalize falls back to the SAME draft the binder was
// bound to: read-before-run, same value both ways.
def work(): string {
  saveDraft("the-draft")
  const reply = llm("Reply with: pong")
  return reply

  finalize as draft {
    const broken: any = null
    return broken.field
  }
}

node main() {
  const result = guard(cost: 0.000001) {
    return work()
  }
  if (isFailure(result)) { return "unexpected-failure" }
  return result.value
}
```

`.test.json` expects `"\"the-draft\""`, same mocks and handlers.

- [ ] **Step 4: Build and run the three fixtures**

```bash
make 2>&1 | tail -3
pnpm run agency test tests/agency/guards/finalize-binder-returns-draft.agency 2>&1 | tee "$TMPDIR/fx-binder-1.log"
pnpm run agency test tests/agency/guards/finalize-binder-null.agency 2>&1 | tee "$TMPDIR/fx-binder-2.log"
pnpm run agency test tests/agency/guards/finalize-binder-throw-falls-back.agency 2>&1 | tee "$TMPDIR/fx-binder-3.log"
```

Expected: all three PASS. If a fixture fails on timing (trip not delivered where expected), compare against how `finalize-wins-over-draft` sequences its steps before changing the budget — these fixtures deliberately copy a proven shape.

- [ ] **Step 5: Regenerate checked-in fixture JS and commit**

```bash
make fixtures 2>&1 | tail -3
git status --porcelain tests/ | head
git branch --show-current   # must NOT be main
printf 'test: finalize binder fixtures (returns draft, null, throw fallback)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude/commitmsg.txt
git add tests/agency/guards/finalize-binder-*
git commit -F /tmp/claude/commitmsg.txt
```

---

### Task 5: Codegen — thread the enclosing return-type schema to `llm()` call sites

**Files:**
- Modify: `lib/backends/typescriptBuilder/scopeManager.ts` (new method after `returnType()`, line ~151)
- Modify: `lib/backends/typescriptBuilder.ts` (`processLlmCall`, after `runPromptEntries.clientConfig` at line ~3646)
- Test: `lib/backends/draftSchemaCodegen.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks (Part B starts here; independent of Part A).
- Produces: `ScopeManager.enclosingDeclaredReturnType(): VariableType | undefined`, and generated `runPrompt({ ..., draftSchema: z.string(), ... })` entries. Task 6 reads `args.draftSchema` in the runtime.

Two deliberate rules, both from the spec, both worth restating: (1) the schema keys on the nearest enclosing FUNCTION or NODE's DECLARED return type, walking past block scopes — a guard block owns the draft slot but carries no declared type, so the function's type is the best honest hint (spec finding 3). (2) `draftSchema` is emitted only when the `llm()` call has arguments beyond the prompt. A bare `llm("...")` cannot carry tools, so emitting the schema there would churn every fixture in the repo for no behavior. When the call has extra args (named options, a positional config object, or a splat), tools MAY be present, so the schema is threaded.

- [ ] **Step 1: Write the failing codegen tests**

Create `lib/backends/draftSchemaCodegen.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

function gen(src: string): string {
  const r = parseAgency(src, {}, false);
  if (!r.success) throw new Error("parse failed: " + r.message);
  return generateTypeScript(r.result, undefined, undefined, "test.agency");
}

describe("draftSchema threading (saveDraft tool, spec Part 2)", () => {
  it("threads the declared string return type when the call has options", () => {
    const out = gen(
      "def f(): string {\n  const r = llm(\"hi\", tools: [print])\n  return r\n}\nnode main() { return f() }\n",
    );
    expect(out).toContain("draftSchema: z.string()");
  });

  it("omits draftSchema on a bare llm(prompt) call", () => {
    const out = gen(
      "def f(): string {\n  const r = llm(\"hi\")\n  return r\n}\nnode main() { return f() }\n",
    );
    expect(out).not.toContain("draftSchema");
  });

  it("walks past a guard block to the enclosing def's declared type", () => {
    const out = gen(
      "def f(): string {\n  const r = guard(cost: $1) {\n    return llm(\"hi\", tools: [print])\n  }\n  if (isSuccess(r)) { return r.value }\n  return \"x\"\n}\nnode main() { return f() }\n",
    );
    expect(out).toContain("draftSchema: z.string()");
  });

  it("omits draftSchema when the enclosing def has no declared return type", () => {
    const out = gen(
      "def f() {\n  const r = llm(\"hi\", tools: [print])\n  return r\n}\nnode main() { return f() }\n",
    );
    expect(out).not.toContain("draftSchema");
  });

  it("threads an object schema for a structured declared return type", () => {
    const out = gen(
      "type Report = { title: string }\ndef f(): Report {\n  const r: Report = llm(\"hi\", tools: [print])\n  return r\n}\nnode main() { const x = f()\n return \"ok\" }\n",
    );
    expect(out).toMatch(/draftSchema: z\.object\(/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/backends/draftSchemaCodegen.test.ts 2>&1 | tee "$TMPDIR/draftschema.log"`
Expected: FAIL — no `draftSchema` is ever emitted.

- [ ] **Step 3: Add the ScopeManager method**

In `lib/backends/typescriptBuilder/scopeManager.ts`, after `returnType()`:

```ts
/**
 * Declared return type of the nearest ENCLOSING function or node,
 * walking outward past block scopes. Unlike `returnType()`, which
 * answers for the CURRENT scope (and answers `undefined` for blocks),
 * this is the saveDraft tool's schema key (partials-ergonomics spec
 * Part 2): a guard block owns the draft slot but carries no declared
 * type, so the enclosing def's declared type is the best-effort hint.
 */
enclosingDeclaredReturnType(): VariableType | undefined {
  // Innermost-first: the nearest non-block scope answers.
  const owner = [...this.stack]
    .reverse()
    .find((scope) => scope.type !== "block");
  if (owner === undefined) return undefined;
  switch (owner.type) {
    case "function":
      return this.compilationUnit.functionDefinitions[owner.functionName]
        ?.returnType ?? undefined;
    case "node":
      return this.compilationUnit.graphNodes.find(
        (n) => n.nodeName === owner.nodeName,
      )?.returnType ?? undefined;
    default:
      return undefined; // global scope
  }
}
```

(Check the private field name for the scope stack in that class — the walk must read whatever `push()` writes to. No C-style index loop: reverse-copy + `find` reads as "nearest non-block scope".)

- [ ] **Step 4: Emit `draftSchema` in `processLlmCall`**

In `lib/backends/typescriptBuilder.ts`, right after `runPromptEntries.clientConfig = clientConfig;` (line ~3646):

```ts
// Partials ergonomics (spec Part 2): thread the enclosing def's
// declared return type so a saveDraft tool in this call's tools
// array gets an honest value schema. Emitted only when the call has
// arguments beyond the prompt — a bare llm("...") can never carry
// tools, and skipping it keeps those call sites byte-identical.
// An `any` return is skipped at the TYPE level (isAnyType), so the
// runtime falls back to the string schema — never sniff the
// renderer's output string to detect it.
if (argsAfterPrompt.length > 0) {
  const declaredReturn = this.scopes.enclosingDeclaredReturnType();
  if (declaredReturn !== undefined && !isAnyType(declaredReturn)) {
    runPromptEntries.draftSchema = ts.raw(this.zodSchemaFor(declaredReturn));
  }
}
```

`isAnyType` is exported from `lib/typeChecker/utils.ts:50` — import it rather than re-deriving the check.

- [ ] **Step 5: Run the tests, then check fixture churn**

```bash
pnpm test:run lib/backends/draftSchemaCodegen.test.ts 2>&1 | tee "$TMPDIR/draftschema2.log"
make 2>&1 | tail -3
make fixtures 2>&1 | tail -3
git status --porcelain tests/ | tee "$TMPDIR/fixture-churn-b.log" | head -30
```

Expected: unit tests PASS. Fixture churn is EXPECTED here, but only in fixtures whose `llm()` calls pass options from inside a def/node with a declared return type — spot-check two or three diffs and confirm every change is exactly one added `draftSchema:` line. Anything else is a bug.

- [ ] **Step 6: Commit (including regenerated fixtures)**

```bash
git branch --show-current   # must NOT be main
printf 'feat: thread the enclosing declared return type as draftSchema at llm() call sites\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude/commitmsg.txt
git add lib/backends/typescriptBuilder/scopeManager.ts lib/backends/typescriptBuilder.ts lib/backends/draftSchemaCodegen.test.ts tests/
git commit -F /tmp/claude/commitmsg.txt
```

---

### Task 6: Runtime — the intrinsic-tool registry, with saveDraft as its first entry

**Files:**
- Create: `lib/runtime/intrinsicTools.ts` (the pattern), `lib/runtime/saveDraftTool.ts` (the first entry)
- Modify: `lib/runtime/prompt.ts` (three spots: the `args` type at ~line 830, the tool-list build at ~line 915, the tool-round loop at ~line 1499)
- Test: `lib/runtime/saveDraftTool.test.ts`, `lib/runtime/intrinsicToolSchema.test.ts` (both new)

**Interfaces:**
- Consumes: `args.draftSchema` (Task 5's generated output).
- Produces: the `IntrinsicTool` type and `findIntrinsic(fn: AgencyFunction): IntrinsicTool | undefined` from `intrinsicTools.ts`; `saveDraftIntrinsic: IntrinsicTool` and `draftCharCount(value: unknown): number` from `saveDraftTool.ts` — and the interception behavior Task 7's fixtures test.

**The architecture (owner review round 2).** saveDraft is the first tool the loop handles ITSELF instead of dispatching — and it will not be the last (attachment listing/viewing tools need thread access, and future run-control tools fit the same shape). So the pattern gets a seam: an `IntrinsicTool` is one object declaring its three responsibilities — WHO it is (`matches`), WHAT the provider sees (`buildDefinition`), and WHAT a call does (`handle`, returning the tool-result text). A module-level array is the registry. The LOOP owns everything generic — the ordered pass, resume idempotency (`pr.step`), statelog events, callback hooks, and the result-message push — so an intrinsic's `handle` is a pure-ish state transition and every future intrinsic inherits the bookkeeping for free. Deliberately NOT extensible by users: intrinsics manipulate run state (frames, drafts), which is exactly what user tools must not do; the registry is closed, in-runtime, and additions are code review events.

- [ ] **Step 1: Write the failing unit tests**

Create `lib/runtime/saveDraftTool.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgencyFunction } from "./agencyFunction.js";
import { findIntrinsic } from "./intrinsicTools.js";
import { saveDraftIntrinsic, draftCharCount } from "./saveDraftTool.js";

function fakeFn(name: string, module: string): AgencyFunction {
  return new AgencyFunction({
    name,
    module,
    fn: () => null,
    params: [
      { name: "value", hasDefault: false, defaultValue: undefined, variadic: false } as any,
    ],
    toolDefinition: { name, description: "d", schema: z.object({}) },
  });
}

/** A stack stub that records draft writes — handle() only ever calls
 *  setSavedDraft, and the real frame math is fixture-tested. */
function stubStack() {
  const saved: unknown[] = [];
  return {
    saved,
    stack: { setSavedDraft: (v: unknown) => saved.push(v) } as any,
  };
}

function call(args: Record<string, unknown> | undefined) {
  return { id: "t1", name: "saveDraft", arguments: args as any };
}

describe("saveDraft intrinsic — recognition", () => {
  it("the registry finds the stdlib pair (name + module)", () => {
    expect(findIntrinsic(fakeFn("saveDraft", "stdlib/index.agency"))).toBe(saveDraftIntrinsic);
  });

  it("a user function named saveDraft is NOT recognized", () => {
    expect(findIntrinsic(fakeFn("saveDraft", "my/module.agency"))).toBeUndefined();
  });

  it("a stdlib function with another name is NOT recognized", () => {
    expect(findIntrinsic(fakeFn("finalize", "stdlib/index.agency"))).toBeUndefined();
  });
});

describe("saveDraft intrinsic — synthesized definition", () => {
  it("declares exactly one required value param from the threaded schema", () => {
    const def = saveDraftIntrinsic.buildDefinition({ draftSchema: z.number() });
    expect(def.name).toBe("saveDraft");
    expect(def.description).toMatch(/best-so-far/);
    const schema = def.schema as z.ZodObject<any>;
    expect(Object.keys(schema.shape)).toEqual(["value"]);
    expect(schema.shape.value.safeParse(3).success).toBe(true);
    expect(schema.shape.value.safeParse("x").success).toBe(false);
  });

  it("falls back to string when no schema was threaded", () => {
    const def = saveDraftIntrinsic.buildDefinition({ draftSchema: undefined });
    const schema = def.schema as z.ZodObject<any>;
    expect(schema.shape.value.safeParse("x").success).toBe(true);
    expect(schema.shape.value.safeParse(3).success).toBe(false);
  });
});

describe("saveDraft intrinsic — handle (validation semantics)", () => {
  it("a matching value saves and acks with the char count", () => {
    const { saved, stack } = stubStack();
    const ack = saveDraftIntrinsic.handle({
      toolCall: call({ value: "hello" }),
      stateStack: stack,
      draftSchema: z.string(),
    });
    expect(saved).toEqual(["hello"]);
    expect(ack).toBe("Draft saved (5 characters).");
  });

  it("a missing value is an error and saves NOTHING", () => {
    const { saved, stack } = stubStack();
    const ack = saveDraftIntrinsic.handle({
      toolCall: call({}),
      stateStack: stack,
      draftSchema: z.string(),
    });
    expect(saved).toEqual([]);
    expect(ack).toMatch(/requires a "value" argument/);
  });

  it("a schema-mismatched value SAVES ANYWAY and acks with a helpful warning", () => {
    // The schema is a best-effort hint keyed to the declared function
    // type; the actual slot (a guard block) can legitimately differ.
    // Refusing the save could throw away real work on a wrong hint, so
    // the draft is kept and the warning teaches the model.
    const { saved, stack } = stubStack();
    const ack = saveDraftIntrinsic.handle({
      toolCall: call({ value: 42 }),
      stateStack: stack,
      draftSchema: z.string(),
    });
    expect(saved).toEqual([42]);
    expect(ack).toMatch(/^Draft saved \(\d+ characters\)\. Warning:/);
    expect(ack).toMatch(/does not match/);
  });
});

describe("draftCharCount", () => {
  it("counts string drafts directly", () => {
    expect(draftCharCount("hello")).toBe(5);
  });
  it("counts structured drafts by their JSON length", () => {
    expect(draftCharCount({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
  });
  it("returns 0 for undefined (JSON.stringify yields undefined there)", () => {
    // Deliberately narrow (plan review M4): a CIRCULAR value would make
    // JSON.stringify throw, uncaught — but tool args are JSON-origin,
    // so circularity cannot occur; the name claims only what is tested.
    expect(draftCharCount(undefined)).toBe(0);
  });
});
```

(If `AgencyFunction`'s constructor rejects that literal `params` shape, copy a valid `FuncParam` literal from `agencyFunction.ts` — the test's point is identity fields, not params.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/runtime/saveDraftTool.test.ts 2>&1 | tee "$TMPDIR/savedraft-unit.log"`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the registry and the saveDraft intrinsic**

Create `lib/runtime/intrinsicTools.ts` — the pattern, kept deliberately small:

```ts
import type { AgencyFunction, ToolDefinition } from "./agencyFunction.js";
import type { StateStack } from "./state/stateStack.js";
import { saveDraftIntrinsic } from "./saveDraftTool.js";

/** What one intrinsic call sees. Deliberately narrow: an intrinsic
 *  manipulates the RUN (frames, drafts), not the outside world, so it
 *  gets the call, the stack, and the threaded schema — nothing else.
 *  Widen this type only when a new intrinsic genuinely needs more. */
export type IntrinsicCall = {
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
  stateStack: StateStack;
  /** Zod schema threaded by the llm() codegen (saveDraft's value
   *  type); undefined when the call site had none. */
  draftSchema: unknown;
};

/** A tool the tool loop handles ITSELF, inline in the ordered pass,
 *  instead of dispatching into the concurrent pool. The loop owns all
 *  the generic bookkeeping — resume idempotency, statelog events,
 *  callbacks, the tool-result message — so `handle` is just the
 *  semantics and must be fast, synchronous, and interrupt-free.
 *  The registry is CLOSED: intrinsics touch run state, which is
 *  exactly what user tools must never do, so additions are code
 *  changes here, not a user-facing extension point. */
export type IntrinsicTool = {
  /** Identity check against a tools-array entry (name+module pair,
   *  never object identity — the prelude auto-import means modules
   *  hold their own wrapper objects). */
  matches: (fn: AgencyFunction) => boolean;
  /** The provider-facing definition, replacing the def's own. */
  buildDefinition: (ctx: { draftSchema: unknown }) => ToolDefinition;
  /** Handle one call; the return value is the tool-result text. */
  handle: (call: IntrinsicCall) => string;
};

const INTRINSIC_TOOLS: IntrinsicTool[] = [saveDraftIntrinsic];

export function findIntrinsic(fn: AgencyFunction): IntrinsicTool | undefined {
  return INTRINSIC_TOOLS.find((t) => t.matches(fn));
}
```

Create `lib/runtime/saveDraftTool.ts` — the first entry:

```ts
import { z } from "zod";
import type { IntrinsicTool } from "./intrinsicTools.js";

/** The stdlib module id every compiled stdlib export carries. No user
 *  module can carry it, so name+module is identity in practice — the
 *  runtime cannot import the stdlib singleton directly without a
 *  dependency cycle (partials-ergonomics spec Part 2). */
const STDLIB_INDEX_MODULE = "stdlib/index.agency";

/** The contract the type system cannot check, stated to the model. */
const DESCRIPTION =
  "Save your best-so-far answer as a draft. If the budget runs out, the " +
  "last saved draft is returned instead of a failure. The value must " +
  "match this function's return type.";

/** Character count for the acknowledgment message. */
export function draftCharCount(value: unknown): number {
  if (typeof value === "string") return value.length;
  const text = JSON.stringify(value);
  return text === undefined ? 0 : text.length;
}

/** `saveDraft` passed as a tool. Aliases (`const s = saveDraft`) keep
 *  both identity fields, so they recognize; a user's own def named
 *  saveDraft carries its own module id, so it runs as an ordinary
 *  tool. A `.rename()`d stdlib saveDraft changes the name and is NOT
 *  recognized — it falls through to the def path, whose draft files
 *  on the tool branch and is discarded (documented limitation). */
export const saveDraftIntrinsic: IntrinsicTool = {
  matches: (fn) =>
    fn.name === "saveDraft" && fn.module === STDLIB_INDEX_MODULE,

  buildDefinition: ({ draftSchema }) => ({
    name: "saveDraft",
    description: DESCRIPTION,
    schema: z.object({ value: (draftSchema as z.ZodTypeAny) ?? z.string() }),
  }),

  handle: ({ toolCall, stateStack, draftSchema }) => {
    const callArgs = toolCall.arguments ?? {};
    // Own-property check: the args object comes from the model.
    if (!Object.prototype.hasOwnProperty.call(callArgs, "value")) {
      return 'Error: saveDraft requires a "value" argument. Nothing was saved.';
    }
    const value = callArgs.value;
    // Save FIRST, validate second. The schema is a best-effort hint
    // keyed to the declared function type, and the actual slot (often
    // a guard block) can legitimately differ — refusing the save on a
    // possibly-wrong hint would throw away real work. The warning
    // teaches the model without costing it the draft.
    stateStack.setSavedDraft(value);
    const saved = `Draft saved (${draftCharCount(value)} characters).`;
    const valueSchema = (draftSchema as z.ZodTypeAny) ?? z.string();
    const parsed = valueSchema.safeParse(value);
    if (parsed.success) return saved;
    const issue = parsed.error.issues[0];
    return (
      `${saved} Warning: the value does not match this function's ` +
      `declared return type (${issue?.message ?? "type mismatch"}). ` +
      `The draft was kept, but match the declared type on your next save.`
    );
  },
};
```

Run: `pnpm test:run lib/runtime/saveDraftTool.test.ts` — expected PASS.

- [ ] **Step 4: Add `draftSchema` to runPrompt's args and substitute the tool definition**

In `lib/runtime/prompt.ts`:

(a) In the `runPrompt` args type (near `destructiveSink` at ~line 852), add:

```ts
  /** Zod schema for the saveDraft tool's `value` param, threaded by the
   *  llm() codegen from the enclosing def's declared return type.
   *  Consulted only when the tools array contains the stdlib saveDraft. */
  draftSchema?: unknown;
```

(b) At the tool-list build (~line 915), substitute the synthesized definition through the registry:

```ts
let tools = exposedFunctions
  .filter((fn) => fn.toolDefinition)
  .map((fn) =>
    findIntrinsic(fn)?.buildDefinition({ draftSchema: args.draftSchema }) ??
    fn.toolDefinition!,
  );
```

Import `findIntrinsic` from `./intrinsicTools.js` at the top of the file — prompt.ts never names saveDraft; it only knows the registry.

- [ ] **Step 5: Add the ordered interception pass**

In the tool round loop (~line 1499), between `const round = self.toolCallRound;` and the `pr.parallel` call. First partition the round ONCE, declaratively — no push-and-continue mutation threading through the loop:

```ts
// Partition the round: intrinsic calls (handled inline, in order)
// vs. everything else (dispatched concurrently as today). One
// partition, computed up front — the rest of the iteration reads
// these two lists and never re-derives them.
const intrinsicOf = (toolCall: smoltalk.ToolCallJSON) => {
  const handler = toolFunctions.find((fn) => fn.name === toolCall.name);
  return handler ? findIntrinsic(handler) : undefined;
};
const intrinsicCalls = toolCalls
  .map((toolCall, callIndex) => ({ toolCall, callIndex, intrinsic: intrinsicOf(toolCall) }))
  .filter((entry) => entry.intrinsic !== undefined);
const dispatchCalls = toolCalls.filter((toolCall) => intrinsicOf(toolCall) === undefined);
```

Then the ordered pass. `for...of` — NOT `forEach`, whose async callbacks would all fire without awaiting and un-order the writes, and not a C-style index loop either (the partition already carries `callIndex`):

```ts
// Ordered interception (partials-ergonomics spec Part 2): intrinsic
// calls are handled inline at their position in the call list, so two
// saves in one round apply in call-list order BY CONSTRUCTION — the
// writes happen here, in list order, not in scheduler-completion
// order. The draft files on the scope that owns this llm() call: the
// stack is [..., owner, runPrompt] (setupFunction pushed our frame),
// so setSavedDraft's callerFrame() write lands on the owner — the
// same frame shape as the stdlib saveDraft def path.
for (const { toolCall, callIndex, intrinsic } of intrinsicCalls) {
  const callSlug = `${callIndex}_${toolCall.id}`;
  await pr.step(`round.${round}.tool.${callSlug}.intrinsic`, async () => {
    const callArgs = toolCall.arguments ?? {};
    // The lifecycle mirrors the real dispatch path's events
    // (toolCallStart → hooks → toolCall) inside one toolExecution
    // span, so span-pairing consumers see intrinsic calls too.
    // Deliberate differences from the real path: one pr.step instead
    // of per-phase branch steps (there is no branch), and timeTaken 0
    // (an inline state write has no meaningful duration).
    const toolSpanId = ctx.statelogClient.startSpan("toolExecution");
    try {
      ctx.statelogClient.toolCallStart({
        toolName: toolCall.name,
        args: callArgs,
        model: JSON.stringify(clientConfig.model),
        threadId: __threads()?.activeId() ?? null,
      });
      await invokeCallbacks({
        ctx,
        name: "onToolCallStart",
        data: { toolName: toolCall.name, args: callArgs },
        stateStack,
      });
      const ack = intrinsic!.handle({
        toolCall,
        stateStack,
        draftSchema: args.draftSchema,
      });
      await invokeCallbacks({
        ctx,
        name: "onToolCallEnd",
        data: { toolName: toolCall.name, result: ack, timeTaken: 0 },
        stateStack,
      });
      ctx.statelogClient.toolCall({
        toolName: toolCall.name,
        args: callArgs,
        output: ack,
        model: JSON.stringify(clientConfig.model),
        timeTaken: 0,
        threadId: __threads()?.activeId() ?? null,
      });
      messages.push(
        smoltalk.toolMessage(ack, {
          tool_call_id: toolCall.id,
          name: toolCall.name,
        }),
      );
    } finally {
      ctx.statelogClient.endSpan(toolSpanId);
    }
  });
}
```

Then change the `pr.parallel` call to iterate `dispatchCalls` instead of `toolCalls`, guarded for the all-intrinsic round:

```ts
if (dispatchCalls.length > 0) {
  const parallelResult = await pr.parallel(
    `round.${round}.tools`,
    dispatchCalls,
    ...
```

Audit the rest of the `while` iteration for reads of `toolCalls` that should now read `dispatchCalls` (the interrupt check on `parallelResult` and the removed-tools filter after it); the `self.pendingToolCalls` bookkeeping keeps the FULL `toolCalls` list — on resume the partition recomputes identically and the ordered pass's `pr.step` guards skip the completed writes, which is exactly the idempotency the real tools get from their branch steps.

One resume subtlety to leave as a comment, not "fix" (plan review finding 2): the ack message survives resume through a different mechanism than the write. `pr.step` snapshots `messagesJSON` only on the INTERRUPT path, and a completed step returns before its body on resume, so the ack is never re-pushed — but it does not need to be. The ack was pushed to the LIVE thread, and whichever later checkpoint actually serializes (a sibling tool's interrupt bailout, the guard gate) calls `snapshotMessages()` against that live thread, ack included. Do NOT add a snapshot call in the intrinsic step; it would be redundant. The real safety net for a lost ack is that real providers reject a dangling `tool_use` with no result — the deterministic client does not validate pairing, which is why no fixture can pin this and the comment has to.

Three deliberate behaviors, each matching the spec, worth comments in code review: interception ignores the `maxToolCallRounds` limit (a draft write is free and salvage is the point); interception ignores `removedTools` (an intrinsic cannot error its way onto that list); the ack messages push before the concurrent tools’ results, which is harmless because providers pair results by `tool_call_id` (and by name+position on Gemini, where names differ) — the same guarantee the existing completion-order pushes rely on.

- [ ] **Step 6: Pin the observable surface — the provider schema, the ack, and the statelog events**

The fixtures prove the feature only through the salvaged draft — an indirect, downstream signal. The three things the spec actually promises at the surface are untested by them (plan review findings 1/M1/M3): the tool definition the PROVIDER receives (every fixture runs the `z.string()` fallback, so a silent substitution failure stays green), the ack tool message the MODEL receives, and the statelog events the TRACE receives. Cover all three in one runtime test file. Create `lib/runtime/intrinsicToolSchema.test.ts`, modeled on `lib/runtime/promptLabels.test.ts` (copy its `makeCtx` / `inFrame` harness), with two additions to that harness: the client's FIRST response returns a saveDraft tool call and its second returns a plain answer (a two-entry script instead of `toolCalls: []`), and `ctx.statelogClient` is replaced with a recorder stub that appends every `toolCallStart(...)` / `toolCall(...)` payload to an array (stub the other methods it touches as no-ops, following how the harness already fakes statelog config).

```ts
describe("saveDraft intrinsic — the observable surface", () => {
  it("the provider-bound schema uses the threaded draftSchema, not the fallback", async () => {
    const { providerConfigs } = await runSaveDraftPrompt({ draftSchema: z.number(), save: 3 });
    const saveDraftDef = (providerConfigs[0] as any).tools.find((t: any) => t.name === "saveDraft");
    expect(saveDraftDef).toBeDefined();
    // The value slot must be the THREADED schema: a number passes, a
    // string fails. With the fallback this assertion inverts — which
    // is exactly the silent failure this test exists to catch.
    expect(saveDraftDef.schema.shape.value.safeParse(3).success).toBe(true);
    expect(saveDraftDef.schema.shape.value.safeParse("x").success).toBe(false);
  });

  it("a structured draftSchema reaches the provider too (object, not just primitive)", async () => {
    const reportSchema = z.object({ title: z.string() });
    const { providerConfigs } = await runSaveDraftPrompt({
      draftSchema: reportSchema,
      save: { title: "t" },
    });
    const saveDraftDef = (providerConfigs[0] as any).tools.find((t: any) => t.name === "saveDraft");
    expect(saveDraftDef.schema.shape.value.safeParse({ title: "t" }).success).toBe(true);
    expect(saveDraftDef.schema.shape.value.safeParse("flat string").success).toBe(false);
  });

  it("without draftSchema the provider-bound value schema is the string fallback", async () => {
    const { providerConfigs } = await runSaveDraftPrompt({ draftSchema: undefined, save: "x" });
    const saveDraftDef = (providerConfigs[0] as any).tools.find((t: any) => t.name === "saveDraft");
    expect(saveDraftDef.schema.shape.value.safeParse("x").success).toBe(true);
    expect(saveDraftDef.schema.shape.value.safeParse(3).success).toBe(false);
  });

  it("the model receives the ack as a paired tool message", async () => {
    const { messages } = await runSaveDraftPrompt({ draftSchema: undefined, save: "hello" });
    const toolMsg = messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect((toolMsg as any).content).toBe("Draft saved (5 characters).");
    // Pairing: the result must carry the SAME id the tool call was
    // issued with, or real providers reject the round.
    expect((toolMsg as any).tool_call_id).toBe("mock-tool-0");
  });

  it("the trace receives toolCallStart and toolCall events for the intrinsic", async () => {
    const { statelogEvents } = await runSaveDraftPrompt({ draftSchema: undefined, save: "hello" });
    const start = statelogEvents.find((e) => e.kind === "toolCallStart");
    const end = statelogEvents.find((e) => e.kind === "toolCall");
    expect(start?.payload.toolName).toBe("saveDraft");
    expect(start?.payload.args).toEqual({ value: "hello" });
    expect(end?.payload.output).toBe("Draft saved (5 characters).");
  });
});
```

Write the `runSaveDraftPrompt` helper against the real `runPrompt` signature the way `promptLabels.test.ts` calls it (ctx + frame + `clientConfig: { tools: [stdlibShapedSaveDraft] }` + `draftSchema`), constructing the AgencyFunction with `name: "saveDraft", module: "stdlib/index.agency"` and returning `{ providerConfigs, messages, statelogEvents }` (the recorded provider configs, the thread's messages after the run, and the statelog recorder's array). Use the tool-call id the scripted client issued (`"mock-tool-0"` above — match whatever your script sets). If the provider-bound tool entry is not the raw ToolDefinition (smoltalk may wrap or convert it), adapt the schema assertions to wherever the zod schema actually lands in the recorded config; if the thread's message shape differs (roles, content field), adapt to the real `smoltalk.toolMessage` shape — the POINTS are: threaded schema left runPrompt, ack text + `tool_call_id` pairing in the thread, events in the trace.

- [ ] **Step 7: Typecheck and run the runtime suites**

```bash
pnpm exec tsc --noEmit 2>&1 | tee "$TMPDIR/tsc-prompt.log"
pnpm test:run lib/runtime/saveDraftTool.test.ts lib/runtime/intrinsicToolSchema.test.ts lib/runtime/promptLabels.test.ts lib/runtime/deterministicClient.test.ts 2>&1 | tee "$TMPDIR/savedraft-runtime.log"
```

Expected: clean typecheck, tests PASS.

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must NOT be main
printf 'feat: intrinsic-tool registry; intercept the stdlib saveDraft tool in the llm tool loop\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude/commitmsg.txt
git add lib/runtime/intrinsicTools.ts lib/runtime/saveDraftTool.ts lib/runtime/saveDraftTool.test.ts lib/runtime/intrinsicToolSchema.test.ts lib/runtime/prompt.ts
git commit -F /tmp/claude/commitmsg.txt
```

---

### Task 7: Agency fixtures for the saveDraft tool

**Files:**
- Create: `tests/agency/guards/savedraft-tool-basic.agency` + `.test.json`
- Create: `tests/agency/guards/savedraft-tool-alias-and-user.agency` + `.test.json`
- Create: `tests/agency/guards/savedraft-tool-order.agency` + `.test.json`
- Create: `tests/agency/guards/savedraft-tool-missing-value.agency` + `.test.json`
- Create: `tests/agency/guards/savedraft-tool-mismatch-still-saves.agency` + `.test.json`
- Create: `tests/agency/guards/savedraft-tool-resume.agency` + `.test.json`

**Interfaces:**
- Consumes: Tasks 5 + 6.
- Produces: end-to-end proof of every spec Part 4 saveDraft-tool behavior, including the frame-math pin (draft saved by the TOOL inside a guard block is salvaged by THAT guard).

**Determinism note (owner review round 2).** Every fixture in this plan is deterministic by construction: cost guards only (the deterministic client's synthetic per-call cost is fixed, so a `guard(cost: 0.000001)` trips at the same step every run), no time guards, no `sleep`/`spin`, no wall-clock anywhere. The resume fixture's interrupt sequence is also deterministic — interrupts serialize in arrival order and the cost gate fires at a fixed step. If any fixture turns out to need real elapsed time, STOP and flag it rather than tuning budgets; that is the flake class that burned #563/#566.

- [ ] **Step 1: The basic fixture — model saves, guard trips, reject returns the model's draft**

`tests/agency/guards/savedraft-tool-basic.agency`:

```
// The model saves a draft through the saveDraft TOOL; the guard trips
// on the next round; reject; the guard returns the model's own draft.
// This fixture is also the frame-math pin from the spec correction:
// the draft files on the guard block's frame (setSavedDraft's
// callerFrame() from inside runPrompt), and THAT guard salvages it.
node main() {
  const result = guard(cost: 0.000001) {
    return llm("Research the topic. Save drafts as you go.", tools: [saveDraft])
  }
  if (isFailure(result)) { return "no-draft" }
  return result.value
}
```

`tests/agency/guards/savedraft-tool-basic.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"model-draft\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "toolCalls": [{ "name": "saveDraft", "args": { "value": "model-draft" } }] },
        { "return": "never-reached" }
      ],
      "description": "A draft saved through the saveDraft tool is salvaged by the enclosing guard on reject. The second mock never runs.",
      "interruptHandlers": [{ "action": "reject" }]
    }
  ]
}
```

- [ ] **Step 2: Alias and user-shadow fixture**

`tests/agency/guards/savedraft-tool-alias-and-user.agency` — two nodes:

```
// Node 1: an alias intercepts identically (recognition is by the
// AgencyFunction's name+module fields, not the variable name).
node aliased() {
  const s = saveDraft
  const result = guard(cost: 0.000001) {
    return llm("work", tools: [s])
  }
  if (isFailure(result)) { return "no-draft" }
  return result.value
}
```

For the user-shadow half, a user def NAMED `saveDraft` must run as an ordinary tool and file nothing. Shadowing the prelude name in the same module makes the fixture ambiguous to read, so give the user function a distinct file: keep it simple with a single-module node whose tool is a user def named `saveDraft` (the prelude import is shadowed by the local def — this is exactly what the fixture proves keeps working):

```
def saveDraft(value: string): string {
  return "user-tool-ran"
}

node userShadow() {
  const result = guard(cost: 0.000001) {
    return llm("work", tools: [saveDraft])
  }
  if (isFailure(result)) { return "no-draft" }
  return result.value
}
```

`.test.json`: `aliased` mirrors the basic fixture (expect `"\"model-draft\""`, reject handler). `userShadow` mocks `[{ "toolCalls": [{ "name": "saveDraft", "args": { "value": "ignored" } }] }, { "return": "never" }]` with a reject handler and expects `"\"no-draft\""` — the user tool ran (as an ordinary tool) but filed no draft, so reject leaves the guard with nothing to salvage. IMPORTANT: put the two nodes in SEPARATE `.agency` files if the local-def shadowing interferes with node 1's prelude `saveDraft` — the prelude import is module-wide, and a module-level def of the same name shadows it everywhere in the file. Check `lib/preprocessors/prunePreludeShadows.ts` behavior first; two files is the safe default (`savedraft-tool-alias.agency` and `savedraft-tool-usershadow.agency`).

- [ ] **Step 3: Order fixture — two saves in one round, last wins**

`tests/agency/guards/savedraft-tool-order.agency` — same shape as the basic fixture. Mocks:

```json
"llmMocks": [
  { "toolCalls": [
    { "name": "saveDraft", "args": { "value": "first" } },
    { "name": "saveDraft", "args": { "value": "second" } }
  ] },
  { "return": "never" }
]
```

Expect `"\"second\""` with a reject handler — call-list order, not scheduler order.

- [ ] **Step 4: Missing-value fixture — the error ack, nothing saved, no crash**

`tests/agency/guards/savedraft-tool-missing-value.agency` — basic shape, but the guard budget is generous (`guard(cost: $1)`) so nothing trips:

```
node main() {
  const result = guard(cost: $1) {
    return llm("work", tools: [saveDraft])
  }
  if (isFailure(result)) { return "failed" }
  return result.value
}
```

Mocks: `[{ "toolCalls": [{ "name": "saveDraft" }] }, { "return": "done" }]` (no args — the deterministic client defaults them to `{}`). Expect `"\"done\""`, NO `interruptHandlers` (nothing trips; declaring a handler would make the harness assert an interrupt that never fires). The fixture proves the malformed call gets the error ack and the loop continues to the next round.

- [ ] **Step 4b: Mismatch fixture — a schema-violating draft is still saved**

`tests/agency/guards/savedraft-tool-mismatch-still-saves.agency` — same shape as the basic fixture (a node, so the schema is the `z.string()` fallback), but the mock saves a NUMBER:

```
// The model saves a value that violates the tool schema (a number
// against the string fallback). The intrinsic warns in the ack but
// keeps the draft — the schema is a best-effort hint, and salvage
// must not lose work over it. Reject proves the draft survived.
node main() {
  const result = guard(cost: 0.000001) {
    return llm("work", tools: [saveDraft])
  }
  if (isFailure(result)) { return "no-draft" }
  return result.value
}
```

Mocks: `[{ "toolCalls": [{ "name": "saveDraft", "args": { "value": 42 } }] }, { "return": "never" }]`, reject handler, expect `"42"` (the guard salvages the mismatched draft).

- [ ] **Step 5: Resume fixture — a draft from a completed round survives an interrupt**

`tests/agency/guards/savedraft-tool-resume.agency`:

```
// Round 1 saves a draft AND asks the user something (input()
// interrupts). The run checkpoints, the harness resolves the input,
// the run resumes — and the draft, serialized with the frame, is
// still there when the guard trips and is rejected.
def ask(q: string): string {
  return input(q)
}

node main() {
  const result = guard(cost: 0.000001) {
    return llm("work", tools: [saveDraft, ask])
  }
  if (isFailure(result)) { return "no-draft" }
  return result.value
}
```

`.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"model-draft\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "toolCalls": [
          { "name": "saveDraft", "args": { "value": "model-draft" } },
          { "name": "ask", "args": { "q": "continue?" } }
        ] },
        { "return": "never-reached" }
      ],
      "description": "A tool-saved DRAFT survives the checkpoint/resume caused by a sibling interrupting tool in the same round. Deliberately narrow (plan review T3): this pins frame serialization only — ack/thread integrity across resume is covered by the runtime surface tests, because the deterministic client does not validate tool_use/result pairing and could not fail on a lost ack.",
      "interruptHandlers": [
        { "action": "resolve", "resolvedValue": "yes" },
        { "action": "reject" }
      ]
    }
  ]
}
```

The saveDraft interception runs in the ORDERED pass before `ask` dispatches, so the draft is on the frame before the interrupt checkpoint serializes it. If the handler order proves wrong at runtime (the guard trip may deliver before or after the resolve depending on cost timing), read the failure log and reorder the handlers — the harness consumes them in interrupt-arrival order.

- [ ] **Step 6: Build, run all five, regenerate, commit**

```bash
make 2>&1 | tail -3
for f in savedraft-tool-basic savedraft-tool-alias savedraft-tool-usershadow savedraft-tool-order savedraft-tool-missing-value savedraft-tool-mismatch-still-saves savedraft-tool-resume; do
  pnpm run agency test tests/agency/guards/$f.agency 2>&1 | tee "$TMPDIR/fx-$f.log"
done
make fixtures 2>&1 | tail -3
git branch --show-current   # must NOT be main
printf 'test: saveDraft-tool fixtures (basic, alias, shadow, order, missing value, resume)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>\n' > /tmp/claude/commitmsg.txt
git add tests/agency/guards/savedraft-tool-*
git commit -F /tmp/claude/commitmsg.txt
```

(Adjust the file list to however Step 2 split the alias/shadow fixtures.)

---

### Task 8: Final verification sweep and PR prep

**Files:**
- No new code. Verification + the plan/spec bookkeeping commit.

- [ ] **Step 1: Full unit suite and structural lint**

```bash
pnpm test:run 2>&1 | tee "$TMPDIR/final-unit.log"
pnpm run lint:structure 2>&1 | tee "$TMPDIR/final-lint.log"
```

Expected: both clean. Fix anything that regressed; do NOT run the full Agency fixture suite (CI owns it) — re-run only the fixtures this plan created if a unit fix touched runtime code.

- [ ] **Step 2: Anti-pattern audit**

Read `docs/dev/anti-patterns.md` and audit the full branch diff (`git diff main...HEAD`) against it. Fix violations before the PR. This is the owner's #1 review flag.

- [ ] **Step 3: Record deviations in the spec**

Append an "As executed" section to `docs/superpowers/specs/2026-07-17-partials-ergonomics-design.md` listing every place the implementation deviated from the spec text (at minimum: the binder's checker declaration is function-wide with an AG6037 collision rule; `draftSchema` is emitted only for llm calls with post-prompt arguments; a renamed stdlib saveDraft is not intercepted). Commit with the message `docs: record as-executed deviations in the partials-ergonomics spec`.

- [ ] **Step 4: Open the PR**

Write the PR body to a file (end with the Claude Code attribution line), then:

```bash
gh pr create --title "Partials ergonomics: saveDraft as a tool, finalize as draft" --body-file /tmp/claude/prbody.txt
```

The body should name the two features, link the spec, call out the fixture churn from Task 5 as intentional, and list doc follow-ups for the owner (the owner-authored `docs/site/guide/partial-results.md` needs a section on both features; do not edit it yourself). Include a **known limitations** list — these are decisions, and untracked decisions get relitigated as bugs:

- A `.rename()`d stdlib saveDraft is not recognized as intrinsic; it runs as an ordinary tool whose draft files on the tool branch and is discarded.
- Gemini pairs tool results by name+position rather than `tool_call_id`, so intrinsic acks pushing before dispatched results can misalign when a real tool precedes saveDraft in the call list or a round contains two same-named calls. Real-provider-only, same class as the #566 finding; deterministic tests cannot catch it.
- The saveDraft schema keys on the enclosing FUNCTION's declared type while the draft files on the owning scope (often a guard block); when they differ the schema is a best-effort hint (spec finding 3).
- Time-based partials tests stay out until #575 (injectable TimeGuard clock) lands.

---

## Self-review notes (checked against the spec)

- **Spec coverage:** Part 2 surface + recognition + interception + schema + interactions → Tasks 5–7; Part 3 all four head forms, binder semantics, typing, mechanics → Tasks 1–4; Part 4 test list → Tasks 4 and 7 map one-to-one (draft-round resume is `savedraft-tool-resume`; the schema unit tests are Task 5 Step 1 plus Task 6 Step 1). Part 5 exclusions respected: no runtime validation, no auto-injection, declared types only.
- **Known deviations from spec text, on purpose:** (1) The spec's review-round-1 fold said interception writes the TOP frame via a new StateStack method; that was corrected in the spec on 2026-07-17 after verifying `runPrompt` pushes its own frame — the plan uses the existing `setSavedDraft` and pins the math with the basic fixture. (2) The binder types from the DECLARED return only (`any` fallback); the spec's "declared or inferred" is narrowed to match Part 5's inferred-types exclusion. (3) `finalize() as draft` formatter-canonicalizes to `finalize as draft` — spec-stated. 
- **Type consistency:** `params: FunctionParameter[]` (Task 1, parsed by the shared `asParser`) is read by Task 2 (`params[0]`, AG6038 for more) and Task 3 (`finalize.params[0].name`); `draftSchema` (Task 5 emit) is read by Task 6 as `args.draftSchema`; `isSaveDraftTool` / `buildSaveDraftToolDefinition` / `draftCharCount` names match between Task 6's module and its prompt.ts call sites.
- **Round 2 decisions (owner comments):** (1) The finalize closure emission moved from a raw `ts.raw` string to `finalizeClosure.mustache` — long codegen strings belong in `lib/templates/`; the zero-churn check enforces byte-identity. (2) The interception is shaped as an `IntrinsicTool` registry (`lib/runtime/intrinsicTools.ts`): saveDraft is the first tool the loop handles itself, and attachment/run-control tools are plausible next entries, so the pattern gets a seam — one object per intrinsic (matches / buildDefinition / handle), the loop owning all generic bookkeeping, the registry closed to users (intrinsics touch run state, exactly what user tools must not do). (3) Schema-violating saves: the intrinsic validates with the synthesized zod schema; a mismatch SAVES ANYWAY and acks with a specific warning (the schema is a best-effort hint — refusing on a possibly-wrong hint would lose real work); only a missing `value` refuses. Pinned by unit tests and the mismatch fixture. (4) No C-style loops in new code: reverse-copy+`find` for the scope walk, one declarative partition plus `for...of` for the ordered pass (NOT `forEach` — async callbacks there would not be awaited in order). (5) All fixtures are cost-guard deterministic; no time-based tests exist, by design. (6) From the parallel plan review: the schema-threading seam gets a RecordingClient test (Task 6 Step 6 — the fixtures alone all run the z.string() fallback and would stay green through a silent substitution failure), the any-type skip is `isAnyType` at the type level rather than sniffing the rendered string, and the intrinsic lifecycle emits inside a `toolExecution` span with its deliberate divergences from the real dispatch path stated in a comment.
- **Round 3 (plan review, `...-partials-ergonomics-REVIEW.md`):** T1 — the undeclared-return binder test asserts UNFILTERED zero errors (the filtered form could not fail on an undeclared binder, whose symptom is an undefined-variable message the filter dropped). M2/finding 3 — AG6037's check pinned scope-local with a module-const-named-binder test (a global is not a frame local, so it is not the miscompile hazard). M1/M3 — Step 6 grew from a schema-seam test into the full observable surface: provider schema (primitive AND object), the ack message with `tool_call_id` pairing, and the statelog events, all via the recording harness (no fixture can see any of these; the deterministic client does not validate pairing). M5 — `withFinalize` unit tests (receives the draft, null case, throw returns `this`). Finding 2 — the ack-survives-resume mechanism is now a stated comment (live thread + next `snapshotMessages()`; do not add a redundant snapshot). M4 — `draftCharCount`'s test name narrowed to what it tests. T3 — the resume fixture's description states it pins frame serialization only. Finding 5 — Gemini ordering and renamed-saveDraft joined the PR's known-limitations list, plus the schema-hint gap and the #575 clock-seam dependency for future time-based tests.
- **Reuse decision (owner review round 1):** the binder clause reuses `asParser`/`blockParamsParser`/`FunctionParameter` — the grammar and type block arguments already own — instead of a hand-rolled `as <name>` parse. Consequences inherited from the shared grammar and ruled on downstream: `finalize as { }` parses as binder-less (the documented no-param form; formatter canonicalizes it away), multi-param lists parse and are rejected by AG6038, and a typed binder (`as d: Report`) parses with the annotation winning over the scope's return type (the handler-param rule). NOT reused: the whole-node `functionCall`+`BlockArgument` pipeline — finalize is a declaration, not a call (FinalizeCodegen strips it from the statement stream; AG6032/6033 and the flow builder key on the node type; there is no callee to receive a block), so wrapping the body would add indirection without behavior.
