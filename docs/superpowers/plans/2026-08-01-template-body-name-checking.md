# Template body name checking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A template can only use names it declares or imports itself, plus the prelude and language builtins. Report a violation when the enclosing file is type-checked instead of crashing later in generated code.

**Architecture:** One always-on pass asks the declarative `findUndefinedTemplateNames(nodes, config)` API for unresolved names and turns the findings into `AG8015`. That API hides its imperative machinery: an isolated synthetic context, `buildScopes`, prelude injection, AST-position classification, and both `resolveVariable` and `resolveCall`. A holey file hands both ordinary undefined-name passes over to the template pass, so each missing variable or direct call produces one diagnostic.

**Tech Stack:** TypeScript, vitest, the existing type checker.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-08-01-template-body-name-checking-design.md`
**Spec review:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-08-01-template-body-name-checking-design-REVIEW.md`
**Plan reviews:**
- `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-08-01-template-body-name-checking-REVIEW.md`
- `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-08-01-template-body-name-checking-REVIEW-2.md`

## Global Constraints

- Never commit to `main`. Task 0 creates a worktree and branch. Check `git branch --show-current` before every commit.
- The public analysis boundary is declarative. Callers receive unresolved names; they do not assemble `resolveVariable` or `resolveCall` input records.
- Synthetic scope construction is isolated. It never receives the host context, host closures, host imports, host aliases, host flow state or host error array.
- The prelude is in scope. `print` is a prelude import, not a language builtin.
- Check variables and direct calls. `FunctionCall.functionName` is a string, so a `variableName`-only walk is incomplete.
- Preserve the existing treatment of method names: `obj.method()` does not make `method` a lexical name.
- Use braces for every `if`, `for` and `while` body, including one-line branches in snippets.
- Use descriptive variable names. Do not introduce single-character callback parameters.
- Do not put nested object types inline. Give each object shape a named type.
- Do not use `rm` or `rm -rf` in implementation steps. Delete tracked files with the patch tool.
- Run `make` before claiming the implementation works; vitest does not type-check.
- Save test output to a file and read that file. Do not rerun an expensive test only to recover output.
- Run only focused Agency execution fixtures locally. Do not run the full Agency execution suite.

---

# Background and invariants

A hole is opaque. Code around a hole cannot depend on a binding supplied by the filler:

```agency
static const mainNode = [|
  node main(): string {
  #mainBody
    print(res)
    return res
  }
|]

static const llmCall = [|
  const res = llm(#prompt)
|]
```

The template's use of `res` must fail while the literal still has open holes. The same rule covers a direct call such as `guarded()` supplied through a declaration hole and a host-file helper that will not exist after `toSource` and `runCode`.

A template body may use:

1. language builtins and JS globals recognized by the existing resolvers;
2. the prelude in `PRELUDE_NAMES`;
3. definitions, bindings and imports written inside the template itself.

It may not use declarations or imports from the host file.

`buildScopes` supplies the correct scope shape: one top-level scope and one parameter-seeded scope per nested `def` or `node`. A flat scope rejects parameters and locals and leaks one definition's locals into siblings.

`buildCompilationUnit(program)` does not resolve Agency imports into `importedFunctions` without a symbol table and source path. That is acceptable for this existence check: `walkScopeBody` declares every syntactic import in the lexical scope, so a non-prelude imported name resolves through `scope.has`. Do not copy host `importedFunctions` to compensate.

---

# File structure

| File | Responsibility |
| --- | --- |
| `lib/typeChecker/nameReferences.ts` | **New.** Neutral AST classification shared by ordinary and template name diagnostics. |
| `lib/typeChecker/templateNames.ts` | **New.** Declarative undefined-template-name analysis and the thin `AG8015` reporting pass. All synthetic-context details stay private. |
| `lib/typeChecker/templateNames.test.ts` | **New.** Behavioral coverage for variables, calls, per-definition scopes, imports, prelude, isolation and ownership. |
| `lib/typeChecker/undefinedVariableDiagnostic.ts` | Use shared variable-reference classification; stand down for holey files. |
| `lib/typeChecker/undefinedFunctionDiagnostic.ts` | Use shared bare-call classification; stand down for holey files. |
| `lib/typeChecker/diagnostics.ts` | Add `AG8015`. |
| `lib/typeChecker/diagnosticExplanations.ts` | Add `agency explain` prose for `AG8015`. |
| `lib/typeChecker/index.ts` | Run the template-name pass next to `checkTemplateHoles`. |
| `tests/agency/templates/literalCompose.agency` | Delete after its self-contained replacement passes. |
| `tests/agency/templates/literalCompose.test.json` | Delete with the old fixture. |
| `tests/agency/templates/literalComposeSelfContained.agency` | **New.** Preserve fill, graft, origin, second fill and execution coverage. |
| `tests/agency/templates/literalComposeSelfContained.test.json` | **New.** Retain the `"lit-ok"` expectation. |
| `docs/site/guide/template-agency.md` | Explain the self-contained-fragment rule and correct the composition example. |

---

### Task 0: Create the isolated branch

- [ ] **Step 1: Create the worktree and branch inside `agency-lang`**

```bash
cd /Users/adityabhargava/agency-lang
git worktree add worktree-template-names -b adit/template-body-names origin/main
cd worktree-template-names
pnpm install
git branch --show-current
```

Expected: `adit/template-body-names`. All later paths are relative to `worktree-template-names/packages/agency-lang`.

---

### Task 1: Put shared name-position policy behind neutral helpers

This task is a behavior-preserving refactor. Wear only the refactoring hat: move existing decisions, verify unchanged diagnostics, then commit before adding `AG8015`.

**Files:**
- Create: `lib/typeChecker/nameReferences.ts`
- Modify: `lib/typeChecker/undefinedVariableDiagnostic.ts`
- Modify: `lib/typeChecker/undefinedFunctionDiagnostic.ts`
- Test: `lib/typeChecker/undefinedVariableDiagnostic.test.ts`
- Test: the existing undefined-function diagnostic tests beside `undefinedFunctionDiagnostic.ts`

**Interfaces:**
- Produces: `hasFunctionOrNodeAncestor(ancestors): boolean`
- Produces: `isResolvableVariableReference(ref, ancestors): boolean`
- Produces: `isResolvableBareCall(call, ancestors): boolean`

- [ ] **Step 1: Record the focused baseline**

```bash
ls lib/typeChecker/*undefined*Function*.test.ts
pnpm test:run lib/typeChecker/undefinedVariableDiagnostic.test.ts lib/typeChecker/undefinedFunctionDiagnostic.test.ts > /tmp/template-names-t1-before.txt 2>&1
grep -E "Tests |FAIL " /tmp/template-names-t1-before.txt
```

Expected: PASS. If `ls` prints a different exact function-test filename, use that filename in this and later commands.

- [ ] **Step 2: Create the neutral helper module**

Move, rather than copy, the existing variable-reference and nested-definition decisions. Add the bare-call decision already encoded in `checkUndefinedFunctions`:

```ts
import type {
  AgencyNode,
  FunctionCall,
  VariableNameLiteral,
} from "../types.js";
import type { WalkAncestor } from "../utils/node.js";

export function hasFunctionOrNodeAncestor(
  ancestors: readonly unknown[],
): boolean {
  for (const ancestor of ancestors) {
    const type = (ancestor as AgencyNode | undefined)?.type;
    if (type === "function" || type === "graphNode") {
      return true;
    }
  }
  return false;
}

export function isResolvableVariableReference(
  ref: VariableNameLiteral,
  ancestors: readonly WalkAncestor[],
): boolean {
  const parent = ancestors[ancestors.length - 1] as AgencyNode | undefined;
  if (!parent) {
    return false;
  }
  if (parent.type === "valueAccess" && parent.base !== ref) {
    return false;
  }
  for (const ancestor of ancestors) {
    const node = ancestor as AgencyNode;
    if (node.type === "forLoop") {
      if (ref.value === node.itemVar || ref.value === node.indexVar) {
        return false;
      }
    }
    if ((ancestor as { type: string }).type === "blockArgument") {
      const block = ancestor as {
        type: "blockArgument";
        params: { name: string }[];
      };
      if (block.params.some((param) => param.name === ref.value)) {
        return false;
      }
    }
  }
  return true;
}

export function isResolvableBareCall(
  call: FunctionCall,
  ancestors: readonly WalkAncestor[],
): boolean {
  if (call.synthetic) {
    return false;
  }
  const parent = ancestors[ancestors.length - 1] as AgencyNode | undefined;
  return parent?.type !== "valueAccess";
}
```

Use the actual type import locations if `../types.js` does not re-export either type. Keep moved behavior byte-for-byte where possible.

- [ ] **Step 3: Route both ordinary passes through the helpers**

In `undefinedVariableDiagnostic.ts`, import the shared helpers; delete the local `hasFunctionOrNodeAncestor`, `isReferencePosition`, and binder-skip loops; call `isResolvableVariableReference` before `checkVariableRef`.

In `undefinedFunctionDiagnostic.ts`, import the shared helpers; delete its local `hasFunctionOrNodeAncestor`; replace the synthetic-call and immediate-`valueAccess` checks with `isResolvableBareCall`.

Do not change severity, resolver inputs, messages or diagnostic ownership in this task.

- [ ] **Step 4: Verify behavior is unchanged**

```bash
pnpm test:run lib/typeChecker/undefinedVariableDiagnostic.test.ts lib/typeChecker/undefinedFunctionDiagnostic.test.ts > /tmp/template-names-t1-after.txt 2>&1
grep -E "Tests |FAIL " /tmp/template-names-t1-after.txt
```

Expected: PASS with the same test count as the baseline.

- [ ] **Step 5: Type-check and commit the refactor**

```bash
make > /tmp/template-names-make-t1.txt 2>&1
echo "make: $?"
git branch --show-current
git add lib/typeChecker/nameReferences.ts lib/typeChecker/undefinedVariableDiagnostic.ts lib/typeChecker/undefinedFunctionDiagnostic.ts
git commit -F - <<'EOF'
refactor: share lexical name reference classification

Variable and direct-call diagnostics now share neutral helpers for deciding
which AST positions are lexical names. Behavior and severity are unchanged.
EOF
```

Expected: `make: 0`; branch is not `main`.

---

### Task 2: Add the declarative template-name analysis and `AG8015`

The public analysis API returns findings. It does not expose `ScopeInfo`, resolver registries, a `base` input bag, `preludeHas`, or synthetic contexts. Imperative scope construction and AST walking stay inside `templateNames.ts`.

**Files:**
- Create: `lib/typeChecker/templateNames.ts`
- Create: `lib/typeChecker/templateNames.test.ts`
- Modify: `lib/typeChecker/diagnostics.ts`
- Modify: `lib/typeChecker/diagnosticExplanations.ts`
- Modify: `lib/typeChecker/index.ts`

**Interfaces:**
- Produces: `UndefinedTemplateName = { name: string; loc: SourceLocation | null }`
- Produces: `findUndefinedTemplateNames(nodes: AgencyNode[], config: AgencyConfig): UndefinedTemplateName[]`
- Produces: `checkTemplateNames(ctx: TypeCheckerContext): void`
- Keeps private: synthetic contexts, scopes, resolver records and prelude lookup.

- [ ] **Step 1: Write behavioral tests first**

Create `lib/typeChecker/templateNames.test.ts`. Use `typeCheckSource` for diagnostic behavior and these helpers:

```ts
import { describe, expect, it } from "vitest";
import { typeCheckSource } from "../compiler/typecheck.js";

function diagnosticsOf(source: string) {
  const report = typeCheckSource(source);
  return [...report.errors, ...report.warnings];
}

function codesOf(source: string): string[] {
  return diagnosticsOf(source).map((diagnostic) => diagnostic.code);
}

function messageFor(source: string, code: string): string | undefined {
  return diagnosticsOf(source).find((diagnostic) => diagnostic.code === code)
    ?.message;
}

function withLiteral(body: string[]): string {
  return [
    "node host() {",
    "  const template = [|",
    ...body,
    "  |]",
    '  print("host")',
    "}",
    "",
  ].join("\n");
}
```

Add these red cases. Each must assert `AG8015`; call cases must also assert that the message names the callee:

1. `print(res)` after `#body` reports `res`.
2. `guarded()` after `#helpers` reports `guarded`.
3. `helper()` where `helper` exists only in the host file reports `helper`.
4. A first-class host helper (`const tool = helper`) reports `helper`.
5. A second nested definition reading a local declared only in its sibling reports that local.
6. A misspelled direct call in a literal reports the misspelled callee.

Add these green cases. None may emit `AG8015`:

1. A nested `def` parameter used in its body.
2. A nested `node` parameter used in its body.
3. A local declared and used inside one nested definition.
4. A `for` binder used inside the loop.
5. A block parameter using the real syntax `xs.map(\\(item) -> item + 1)`.
6. A top-level literal binding used later in the literal.
7. A direct call to a `def` declared in the literal.
8. A first-class reference to a `def` declared in the literal.
9. A non-prelude import, `import { edit } from "std::fs"`, used both as `edit(...)` and as `const tool = edit`. Do not use `read`; `read` is in `PRELUDE_NAMES` and would make the test vacuous.
10. `print` as a direct prelude call.
11. `llm` as a direct builtin call.
12. `obj.method()` where `obj` is declared in the literal; `method` is not checked as a lexical name.

Add two isolation cases:

1. A literal containing `const value: string = 1` emits no leaked `AG2001`; this pass checks names only, and `buildScopes`' incidental synthetic diagnostics must be discarded.
2. Two literals may each declare `def greet`; neither emits `AG8015`. This pins scope-key reuse to isolated per-call state.

Finally, assert that the message for `res` contains both `res` and `declares or imports`.

- [ ] **Step 2: Run the tests and prove they are red**

```bash
pnpm test:run lib/typeChecker/templateNames.test.ts > /tmp/template-names-t2-red.txt 2>&1
grep -E "Tests |FAIL " /tmp/template-names-t2-red.txt
```

Expected: reporting tests fail because `AG8015` does not exist. Green cases should remain green. If every test passes, stop: the tests are vacuous.

- [ ] **Step 3: Add the diagnostic and explanation**

Add beside the other `AG80xx` entries in `diagnostics.ts`:

```ts
templateNameNotDefined: {
  code: "AG8015",
  severity: "error",
  message:
    "`{name}` is not defined in this template. A template can only use names it declares or imports itself, because a hole hides whatever fills it. Move the code that defines `{name}` into this template, or move the code that uses it into the fragment that defines it.",
},
```

Add the exhaustive `diagnosticExplanations.ts` entry. Explain that the template is checked before filling, the host file will not exist in generated source, and the repair is to keep each fragment self-contained.

- [ ] **Step 4: Implement the declarative analysis boundary**

Create `templateNames.ts` with these named public types only:

```ts
export type UndefinedTemplateName = {
  name: string;
  loc: SourceLocation | null;
};

export function findUndefinedTemplateNames(
  nodes: AgencyNode[],
  config: AgencyConfig,
): UndefinedTemplateName[]

export function checkTemplateNames(ctx: TypeCheckerContext): void
```

Use this private capability shape. It hides resolver records instead of returning a nested `{ scopes, base }` data bag:

```ts
type TemplateNameScope = {
  body: AgencyNode[];
  kind: "topLevel" | "definition";
  resolvesVariable(name: string): boolean;
  resolvesCall(name: string): boolean;
};
```

Private implementation requirements:

1. Wrap `nodes` in `{ type: "agencyProgram", nodes }`.
2. Call `buildCompilationUnit(program)` without host symbol-table state.
3. Build a fresh `TypeCheckerContext` explicitly. Do not spread an outer context; `findUndefinedTemplateNames` receives only `config`, which makes host leakage impossible at the type boundary.
4. Populate `functionDefs`, `nodeDefs`, aliases and JS imports from the synthetic unit. Build graph-node keys with `declaredName(node.nodeName)`.
5. Use fresh objects for `errors`, inferred return types, match types and interrupt effects; use a fresh `Set` for in-progress inference.
6. Leave `symbolTable`, `currentFile` and `flowEnv` absent.
7. Implement local `withScope` and `getTypeAliases` closures over a private `currentScopeKey` and `unit.typeAliases`. Restore the previous key in `finally`.
8. Make `inferReturnTypeFor` close over the synthetic context, not the host checker.
9. Call `buildScopes(syntheticContext)`. Discard `syntheticContext.errors`; this API reports undefined names only.
10. For each returned scope, create `resolvesVariable` and `resolvesCall` closures. Both use local definitions/imports, the current lexical scope and `PRELUDE_NAMES`. Calls use `resolveCall`; values use `resolveVariable`.
11. Agency import names resolve through the lexical scope populated by `walkScopeBody`. Do not copy host `importedFunctions`.

The isolated context must follow this construction pattern:

```ts
function isolatedContext(
  program: AgencyProgram,
  config: AgencyConfig,
): TypeCheckerContext {
  const unit = buildCompilationUnit(program);
  let currentScopeKey = GLOBAL_SCOPE_KEY;
  let context: TypeCheckerContext;
  const nodeDefs = Object.fromEntries(
    unit.graphNodes.map((node) => [declaredName(node.nodeName), node]),
  );

  context = {
    programNodes: program.nodes,
    scopedTypeAliases: unit.typeAliases,
    currentScopeKey,
    functionDefs: { ...unit.functionDefinitions },
    nodeDefs,
    importedFunctions: { ...unit.importedFunctions },
    jsImportedNames: { ...unit.jsImportedNames },
    interruptEffectsByFunction: {},
    errors: [],
    inferredReturnTypes: {},
    inferringReturnType: new Set<string>(),
    matchExprTypes: {},
    matchExprYieldTypes: {},
    config,
    getTypeAliases: () => unit.typeAliases.visibleIn(currentScopeKey),
    withScope: <Result>(key: string, fn: () => Result): Result => {
      const previous = currentScopeKey;
      currentScopeKey = key;
      try {
        return fn();
      } finally {
        currentScopeKey = previous;
      }
    },
    inferReturnTypeFor: (name, definition) =>
      inferReturnTypeFor(name, definition, context),
  };
  return context;
}
```

If TypeScript rejects the self-reference assignment, use a small local factory closure, but preserve every isolation property above. Do not solve it with a cast or by spreading the host context.

- [ ] **Step 5: Implement name finding with both resolver paths**

`findUndefinedTemplateNames` must:

- iterate each `TemplateNameScope`;
- skip nested definition bodies while walking the synthetic top-level scope;
- use `isResolvableVariableReference` before calling `resolvesVariable`;
- use `isResolvableBareCall` before calling `resolvesCall`;
- append `{ name, loc }` only when the selected resolver returns unresolved;
- use braces around every branch.

Method calls are deliberately not lexical call names. Their base and arguments are still visited normally.

`checkTemplateNames` must remain thin:

```ts
export function checkTemplateNames(ctx: TypeCheckerContext): void {
  for (const visit of walkNodesArray(ctx.programNodes)) {
    if (visit.node.type !== "codeLiteral") {
      continue;
    }
    const findings = findUndefinedTemplateNames(visit.node.nodes, ctx.config);
    for (const finding of findings) {
      ctx.errors.push(
        diagnostic(
          "templateNameNotDefined",
          { name: finding.name },
          finding.loc,
        ),
      );
    }
  }
}
```

Wire `checkTemplateNames(ctx)` next to `checkTemplateHoles(ctx)` in `index.ts`.

- [ ] **Step 6: Run focused tests and type-check**

```bash
pnpm test:run lib/typeChecker/templateNames.test.ts > /tmp/template-names-t2-green.txt 2>&1
grep -E "Tests |FAIL " /tmp/template-names-t2-green.txt
make > /tmp/template-names-make-t2.txt 2>&1
echo "make: $?"
```

Expected: all template-name tests pass and `make: 0`. A red green-case means the scope boundary is wrong; fix the analysis, not the test.

- [ ] **Step 7: Run the focused type-checker directory**

```bash
pnpm test:run lib/typeChecker/ > /tmp/template-names-typechecker-t2.txt 2>&1
grep -E "Tests |FAIL " /tmp/template-names-typechecker-t2.txt | head -20
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add lib/typeChecker/templateNames.ts lib/typeChecker/templateNames.test.ts lib/typeChecker/diagnostics.ts lib/typeChecker/diagnosticExplanations.ts lib/typeChecker/index.ts
git commit -F - <<'EOF'
feat: report unresolved names inside code literals

Template name analysis now hides synthetic scope construction behind a
declarative findings API. It checks both value references and direct calls
against template-local declarations and imports, the prelude and builtins.
EOF
```

---

### Task 3: Give holey files one owner for variable and call diagnostics

A `.agency` file with holes is itself a template. `AG8015` owns every undefined variable and bare call in that file. The ordinary passes must both stand down, or calls produce `AG8015` plus `AG4004`.

**Files:**
- Modify: `lib/typeChecker/templateNames.ts`
- Modify: `lib/typeChecker/templateNames.test.ts`
- Modify: `lib/typeChecker/undefinedVariableDiagnostic.ts`
- Modify: `lib/typeChecker/undefinedFunctionDiagnostic.ts`

- [ ] **Step 1: Add the ownership tests**

Add a `describe("AG8015: template files", ...)` block covering:

1. Holey file with missing variable: contains `AG8015`, not `AG4007`.
2. Holey file with missing direct call: contains `AG8015`, not `AG4004`.
3. Holey file with an ordinary variable typo away from the hole: still contains `AG8015`.
4. Holey file with an ordinary call typo away from the hole: still contains `AG8015`.
5. Hole-free missing variable: no `AG8015`; ordinary variable configuration remains unchanged.
6. Hole-free missing call: contains `AG4004`, not `AG8015`.

- [ ] **Step 2: Prove the handoff tests fail**

```bash
pnpm test:run lib/typeChecker/templateNames.test.ts -t "template files" > /tmp/template-names-t3-red.txt 2>&1
grep -E "Tests |FAIL " /tmp/template-names-t3-red.txt
```

Expected: template-file `AG8015` checks fail before implementation.

- [ ] **Step 3: Analyze the whole file when it has holes**

At the start of `checkTemplateNames`, before looking for literals:

```ts
if (holeNames(ctx.programNodes).length > 0) {
  const findings = findUndefinedTemplateNames(ctx.programNodes, ctx.config);
  reportTemplateNameFindings(findings, ctx);
}
```

Extract private `reportTemplateNameFindings` so the literal and whole-file paths do not duplicate the diagnostic loop. This is a coherent reused responsibility, not a one-use wrapper.

- [ ] **Step 4: Make both ordinary passes stand down**

After each pass computes its configured mode, add the same explicit ownership guard:

```ts
if (holeNames(ctx.programNodes).length > 0) {
  return;
}
```

Apply it to both `checkUndefinedVariables` and `checkUndefinedFunctions`. Import `holeNames` from `../utils/holes.js` in both files.

This is a whole-file behavior change, not local deduplication. In a file with holes, neither `AG4007` nor `AG4004` appears; the always-on template pass is a superset for those name positions.

- [ ] **Step 5: Verify the ownership boundary**

```bash
pnpm test:run lib/typeChecker/templateNames.test.ts lib/typeChecker/undefinedVariableDiagnostic.test.ts lib/typeChecker/undefinedFunctionDiagnostic.test.ts > /tmp/template-names-t3-green.txt 2>&1
grep -E "Tests |FAIL " /tmp/template-names-t3-green.txt
make > /tmp/template-names-make-t3.txt 2>&1
echo "make: $?"
```

Expected: PASS and `make: 0`.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add lib/typeChecker/templateNames.ts lib/typeChecker/templateNames.test.ts lib/typeChecker/undefinedVariableDiagnostic.ts lib/typeChecker/undefinedFunctionDiagnostic.ts
git commit -F - <<'EOF'
feat: check every name in a template file once

The always-on template pass owns undefined variables and direct calls in a
file with holes. The ordinary AG4007 and AG4004 passes stand down there, so
one missing name produces one structural diagnostic.
EOF
```

---

### Task 4: Replace the composition fixture without losing execution coverage

**Files:**
- Create: `tests/agency/templates/literalComposeSelfContained.agency`
- Create: `tests/agency/templates/literalComposeSelfContained.test.json`
- Delete after replacement passes: `tests/agency/templates/literalCompose.agency`
- Delete after replacement passes: `tests/agency/templates/literalCompose.test.json`
- Modify: `docs/site/guide/template-agency.md`

- [ ] **Step 1: Re-read the old fixture and expected output**

```bash
cat tests/agency/templates/literalCompose.agency
cat tests/agency/templates/literalCompose.test.json
```

The replacement must preserve all of these: expression-literal filling, partial fill, graft into a wrapper, remaining-hole origin, second fill, `toSource`, `runCode`, interrupt approval and the final `"lit-ok"` result.

- [ ] **Step 2: Add the self-contained fixture**

Create `literalComposeSelfContained.agency`:

```agency
import { fill, holesOf, toSource, runCode } from "std::agency"

// Compose-then-parameterize with fragments that declare every name they use.
node main(): string {
  const programTemplate = [|
    def guarded(): string {
      const ms: number = #minutes
      #body
      return "lit-ok"
    }

    export node main(): string {
      return guarded()
    }
  |]
  const body = [| print("step") |]
  const wrapper = [|
    #helpers
  |]

  const partial = fill(programTemplate, { body: body })
  if (isFailure(partial)) {
    return "program fill failed: ${partial.error}"
  }
  const program = fill(wrapper, { helpers: partial.value })
  if (isFailure(program)) {
    return "compose failed: ${program.error}"
  }
  const remaining = holesOf(program.value)
  if (remaining.length != 1) {
    return "wrong hole count: ${remaining.length}"
  }
  if (remaining[0].origin != "helpers") {
    return "origin missing"
  }
  const done = fill(program.value, { minutes: 120000 })
  if (isFailure(done)) {
    return "final fill failed: ${done.error}"
  }
  handle {
    const result = runCode(toSource(done.value))
    if (isFailure(result)) {
      return "run failed: ${result.error}"
    }
    return result.value
  } with (effect) {
    if (effect.effect == "std::run") {
      return approve()
    }
  }
}
```

Create `literalComposeSelfContained.test.json` with the old fixture's exact test shape and expected output `"\"lit-ok\""`.

- [ ] **Step 3: Build and run the replacement before deleting anything**

```bash
make > /tmp/template-names-make-t4.txt 2>&1
pnpm run a test tests/agency/templates/literalComposeSelfContained.agency > /tmp/template-names-fixture-t4.txt 2>&1
grep -E "passed|failed|PASS|FAIL" /tmp/template-names-fixture-t4.txt
```

Expected: PASS with `"lit-ok"`.

- [ ] **Step 4: Delete the old fixture with the patch tool**

Delete exactly these tracked files; do not use `rm`:

- `tests/agency/templates/literalCompose.agency`
- `tests/agency/templates/literalCompose.test.json`

- [ ] **Step 5: Sweep template fixtures and examples**

```bash
pnpm run a test tests/agency/templates > /tmp/template-names-fixtures-t4.txt 2>&1
grep -E "Tests |FAIL|failed" /tmp/template-names-fixtures-t4.txt | head -30
grep -R -n "\[|" examples tests/agency/templates > /tmp/template-name-literals.txt
```

Read failures and relevant search results. If another literal uses a host or filler-supplied name, make that fragment self-contained. Do not rewrite unrelated examples.

- [ ] **Step 6: Correct the guide**

In `docs/site/guide/template-agency.md`, move `print(res)` into the fragment that declares `res`:

```agency
static const llmCall = [|
  const res = llm(#prompt)
  print(res)
|]
```

Add two or three sentences: a template may use the prelude, builtins and names it declares or imports itself. It may not depend on a declaration supplied through a hole because the hole is opaque while the template is checked.

- [ ] **Step 7: Commit fixture and documentation changes**

```bash
git branch --show-current
git add tests/agency/templates docs/site/guide/template-agency.md
git commit -F - <<'EOF'
test: make composed template fragments self-contained

The replacement keeps partial fill, grafting, hole-origin propagation,
second fill and generated-program execution while every fragment declares
the names it uses. The guide now teaches the same boundary.
EOF
```

---

# Before opening the PR

- [ ] Audit the diff against `docs/dev/anti-patterns.md` and `docs/dev/coding-standards.md`.
- [ ] Confirm no public helper returns raw resolver registries or requires callers to build `scopeHas`.
- [ ] Confirm `templateNames.ts` is the only owner of synthetic context construction and that it receives `AgencyConfig`, not a host `TypeCheckerContext`.
- [ ] Confirm direct calls and variable references both have red and green tests.
- [ ] Confirm the import test uses non-prelude `edit`, not `read`.
- [ ] Confirm every sample `if` uses braces and no new callback uses a single-character name.
- [ ] `pnpm run lint:structure > /tmp/template-names-lint.txt 2>&1`; read the output.
- [ ] `make > /tmp/template-names-make-final.txt 2>&1`; require exit 0.
- [ ] `pnpm test:run lib/typeChecker/ > /tmp/template-names-typechecker-final.txt 2>&1`; read the output.
- [ ] `pnpm test:run > /tmp/template-names-unit-final.txt 2>&1`; read the output.
- [ ] `pnpm run a test tests/agency/templates > /tmp/template-names-fixtures-final.txt 2>&1`; read the output.
- [ ] Say plainly in the PR description that holey files no longer emit `AG4004` or `AG4007`; `AG8015` owns both kinds of missing name.
- [ ] Name the deleted fixture, replacement fixture and guide change in the PR description.
- [ ] Write the PR description to a file and pass it with `--body-file`.
- [ ] Remove the worktree only after merge.

---

# Self-review notes

**Spec coverage:** Task 2 enforces the three-part scope for code literals and checks both value and call names. Task 3 applies the same rule to template files and prevents duplicate ordinary diagnostics. Task 4 preserves the execution fixture and updates user guidance.

**Declarative boundary:** `findUndefinedTemplateNames` returns domain findings. Raw `ScopeInfo`, resolver registries, prelude lookup and synthetic contexts are private. The caller says what it needs; the analysis owns how it is computed.

**No placeholders:** The isolated-context fields, graph-node key construction, Agency-import mechanism, call-position rules, ownership handoff, fixture body and verification commands are explicit.

**Known risks and guards:**

1. Over-rejection: prelude, builtin, parameter, local, loop, block-parameter, import and method-call tests stay green.
2. Under-reporting: filler variable, filler call, host variable, host call, sibling-local and misspelled-call tests stay red until implementation.
3. Host leakage: the public analysis accepts `AgencyConfig`, not the host context; non-prelude host declarations/imports have explicit red tests.
4. Synthetic diagnostic leakage: the incompatible annotated assignment test proves `buildScopes` diagnostics are discarded.
5. Scope-key reuse: two literals declaring the same function name are analyzed independently.
6. Opaque literal traversal: the outer pass finds literals, then explicitly analyzes each literal's own nodes. Nested literals remain parser-refused.

The plan is ready to implement when all review findings above remain represented in Tasks 1–4.
