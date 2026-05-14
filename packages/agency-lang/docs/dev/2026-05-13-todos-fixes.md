# Fixes for `new-todos.md` issues

This document describes the fixes applied for each issue listed in `new-todos.md`.
Issue 4 was intentionally skipped per request.

---

## Issue 1 — `obj[key]` syntax

**Status:** No fix needed.

Verified against existing tests and parser fixtures: `obj[key]` (computed
member access on an object) is already supported via the existing
`valueAccess` chain. No code change.

---

## Issue 2 — Parens around types

**Status:** Fixed.

**Symptom:** Types like `(name | serving_size)[]` or `(string | number)[]`
failed to parse because the union needed grouping before the array
suffix could apply.

**Fix:** Added a new `parenthesizedTypeParser` to
`lib/parsers/parsers.ts` that accepts `( T )` and unwraps to the inner
type. Registered it in:

- `arrayTypeParser` — so `(union)[]` parses
- `unionItemParser` — so a parenthesized type can appear inside a union
- `variableTypeParser` — so it's available everywhere a type can appear

```ts
// (T) — a parenthesized type expression. Lets users write
// (name | serving_size)[] or (string | number)[].
export const parenthesizedTypeParser: Parser<VariableType> = ...
```

### Follow-up: parens around expressions used as access-chain heads

**Symptom:** Even though `(a + b)` parsed as a sub-expression in a
binop, `(a + b).foo`, `(arr)[0]`, `(foo()).length`, and
`(new Foo()).method()` were all broken — the parser treated the chain
elements as separate (often invalid) statements after the parens.

**Fix (`lib/parsers/parsers.ts`):** Extended `parenParser` to attempt
an access chain after the closing `)`. If any chain element matches,
wrap the inner expression in a `ValueAccess` so `.field` / `[i]` /
`.method()` bind to the parenthesized expression.

**Fix (`lib/backends/typescriptBuilder.ts`):** In `processValueAccess`,
when the base is a non-trivial expression (not a `variableName`,
`functionCall`, or `valueAccess`), wrap it in parens before applying
the chain — otherwise `a + b.foo` would emit instead of `(a + b).foo`.

---

## Issue 3 — Complex index expressions like `users[0 + 1].name`

**Status:** No fix needed.

Verified against existing test fixtures: complex expressions inside
`[]` (binary expressions, member access, etc.) are already supported by
the `valueAccess` chain. No code change.

---

## Issue 4 — `system()` only inside threads

**Status:** Skipped per request.

---

## Issue 5 — `Result` type collision

**Status:** Fixed.

**Symptom:** A user could declare `type Result = ...`, silently shadowing
the built-in `Result` type and producing confusing errors downstream.

**Fix:** Added a hard error in `lib/symbolTable.ts`:

```ts
const RESERVED_TYPE_NAMES = new Set<string>(["Result"]);

case "typeAlias":
  if (RESERVED_TYPE_NAMES.has(node.aliasName)) {
    throw new Error(
      `'${node.aliasName}' is a reserved built-in type; cannot be redefined.`,
    );
  }
```

---

## Issue 6 — Types defined inside a node

**Status:** Fixed.

**Symptom:** A `type Foo = ...` declared inside a `node` body or `def`
body wasn't visible to the LLM structured-output runtime, because each
generated `runner.step(...)` closure couldn't see the declaration sitting
inside another step.

**Fix (codegen — `lib/backends/typescriptBuilder.ts`):**

Added a hoisting pass that walks a function/node body (without crossing
nested function/graphNode/method boundaries), collects every `typeAlias`
declaration, and emits the resulting TS declarations once at the top of
the enclosing function/node body. Each hoisted AST node is recorded in
`hoistedTypeAliasNodes` so `processNode` skips its in-body emission to
avoid redeclaration:

- `collectBodyTypeAliases(body)` — recursive collector
- `hoistBodyTypeAliases(body)` — emits the TS decls and marks AST nodes
- Hoist sites: function definition body, graph node body, class method body

**Fix (typechecker — `lib/typeChecker/checker.ts` and `interruptAnalysis.ts`):**

`walkNodes` returns nodes from nested scopes too; without filtering, an
expression inside `node main()` would also be re-checked under the
global scope, where the local type alias was not visible. Added an
`isInScope(scopes, info)` filter to all three scoped checks
(`checkFunctionCallsInScope`, `checkReturnTypesInScope`,
`checkExpressionsInScope`). For interrupt analysis, wrapped the walk in
`ctx.withScope(info.scopeKey, …)` so `synthType` can resolve
scope-local type aliases.

---

## Issue 7 — `with approve` in a return statement

**Status:** Fixed.

**Symptom:** `return foo() with approve` failed to parse. The
`returnStatementParser` consumed the inner `foo()` call before
`withModifierParser` had a chance to see the `with` suffix, leaving
`with approve` dangling.

**Fix (`lib/parsers/parsers.ts`):**

1. Reordered `bodyParser` so `withModifierParser` runs before
   `returnStatementParser` and `assignmentParser`.
2. Extended `withModifierParser` so the inner statement can be a
   `returnStatement` in addition to `assignment`/`functionCall`:

```ts
const stmtResult = or(
  modifiedAssignmentParser,
  assignmentParser,
  returnStatementParser,
  functionCallParser,
)(input);
```

---

## Issue 8 — `tool-retry` test failure

**Status:** Fixed.

**Symptom:** Test was disabled via a `skip` file. The original failure
message in `new-todos.md` ("Unknown named argument 'action'") was an
LLM-side hallucination from real (non-mocked) runs, where the LLM added
an `action` parameter that the tool didn't declare. Once mocks were in
place, that issue disappeared, but a different fixture mismatch
remained.

**Root cause of the remaining failure:** `safeNestedMethodTool` in
`tests/agency-js/tool-retry/agent.agency` was incorrectly defined as a
plain `def` that called the unsafe `throwError()` import via a
counter, instead of (per its test description) being a wrapper around
a safe class method.

**Fix (`tests/agency-js/tool-retry/agent.agency`):**

Added a `safe nestedFlakyWrite` method to `ItemService`:

```agency
safe nestedFlakyWrite(id: string): any {
  if (id != "") {
    return flakyWrite("${this.prefix}-${id}")
  }
  return id
}
```

Updated `safeNestedMethodTool` to call it:

```agency
def safeNestedMethodTool(id: string) {
  let svc = new ItemService("nsvc")
  return svc.nestedFlakyWrite(id)
}
```

Removed the `skip` file. Test now passes (1/1 TS tests).

---

## Issue 9 — Nested fork blocks can't see outer block args

**Status:** Fixed.

**Symptom:** When a `fork` (or `race`) block was nested inside another
fork block, the inner branch's `__bstack.args` only contained the
inner iteration variable. Outer block-arg values were lost.

**Fix (codegen — `lib/backends/typescriptBuilder.ts`):**

Added a `_forkBlockDepth` counter, incremented when entering a fork
block body, decremented on exit. The depth value seen at the start of
the inner block tells us we're nested.

When rendering a nested block via `forkBlockSetup.mustache`, pass
`isNested: true`.

**Fix (template — `lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache`):**

Capture the parent block's args via closure *before* the inner block
scope opens (so the inner `const __bstack = …` doesn't put `__bstack`
in TDZ), then merge them into the inner `__bstack.args`:

```mustache
{{#isNested}}
const __parentForkArgs = __bstack.args;
{
{{/isNested}}
const __bstack = __forkBranchStack.getNewState();
…
{{#isNested}}
Object.assign(__bstack.args, __parentForkArgs);
{{/isNested}}
__bstack.args[{{{paramNameQuoted}}}] = __forkItem;
…
{{#isNested}}
}
{{/isNested}}
```

---

## Issue 10 — `+=` (and friends) with globals

**Status:** Fixed.

**Symptom:** `foo += 1` where `foo` is a global produced invalid JS
because the LHS lowered to `__ctx.globals.get(...)`, which isn't a
valid assignment target. Result: `Invalid assignment target` from
esbuild.

**Fix (`lib/backends/typescriptBuilder.ts`):**

In `processBinOpExpression`, detect compound assignments to a global
LHS and lower to a `get` + `set` pair:

```ts
const COMPOUND_ASSIGN_TO_BINARY: Record<string, string> = {
  "+=": "+", "-=": "-", "*=": "*", "/=": "/",
};

const compoundOp = COMPOUND_ASSIGN_TO_BINARY[node.operator];
if (
  compoundOp !== undefined &&
  node.left.type === "variableName" &&
  node.left.scope === "global"
) {
  const name = node.left.value;
  const getNode = ts.scopedVar(name, "global", this.moduleId);
  const rightNode = this.processNode(node.right);
  const newValue = ts.binOp(getNode, compoundOp, rightNode, {
    parenRight: true,
  });
  return ts.globalSet(this.moduleId, name, newValue);
}
```

For `foo += 1` this emits:

```ts
__ctx.globals.set(
  "<module>.agency",
  "foo",
  __ctx.globals.get("<module>.agency", "foo") + 1
);
```

---

## Files changed

- `lib/backends/typescriptBuilder.ts` — Issues 6, 9, 10
- `lib/parsers/parsers.ts` — Issues 2, 7
- `lib/symbolTable.ts` — Issue 5
- `lib/typeChecker/checker.ts` — Issue 6 (scope filter)
- `lib/typeChecker/interruptAnalysis.ts` — Issue 6 (scope wrap)
- `lib/templates/backends/typescriptGenerator/forkBlockSetup.mustache` — Issue 9
- `tests/agency-js/tool-retry/agent.agency` — Issue 8
- `tests/agency-js/tool-retry/skip` — removed (Issue 8)
