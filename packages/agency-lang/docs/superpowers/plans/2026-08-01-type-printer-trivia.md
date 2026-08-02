# Type Printer Trivia Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agency fmt` preserve comments, blank lines, and semantic property metadata inside object types at every source-formatting position, while direct display signatures omit all trivia and type-alias reference bodies retain full source rendering.

**Architecture:** Keep `variableTypeToString` as the only recursive type printer and add an optional declarative object-type rendering hook that every recursive edge forwards. `AgencyGenerator` installs source and display policies around that hook and owns object layout and indentation. Source layout activates for trivia or semantic property metadata so the inline fallback cannot discard tags or descriptions. Direct `signatureOf` consumers, including `std::agency` `_describe`, strip object and parameter trivia. `agency doc` uses source rendering for type-alias reference bodies, preserving alias doc comments, property comments, validators, descriptions, and multiline layout; its function and node signatures remain trivia-free. Existing wrapped-list layout remains unchanged.

**Tech Stack:** TypeScript, Vitest, Agency parser and formatter.

## Global Constraints

- Run every command from `packages/agency-lang` in the current worktree; all paths below are relative to that directory.
- Preserve no-hook `variableTypeToString` output byte-for-byte, including TypeScript generation, generic value arguments, `Result` shorthand, precedence, effect sets, long unions, and block-type `raises` clauses. Formatter source output is intentionally exempt when an object has property tags or descriptions: metadata safety requires Agency-owned multiline layout even without trivia.
- Do not add `typeHasTrivia`, a second recursive printer, duplicated precedence helpers, or printer-agreement tests.
- Keep direct `signatureOf` and `std::agency` `describe` on an explicit display rendering path; object and parameter comments and blank-line trivia must not appear there. `agency doc` type aliases instead use full source rendering so reference bodies retain alias and property comments, validators, descriptions, and multiline layout. Its function and node signatures use the trivia-free display path.
- Compose type-alias assignments structurally so a multiline right-hand side follows `=` immediately; generated signatures and doc code blocks must contain no trailing whitespace.
- Do not change parser code. The PR #768 issue is already fixed: `objectMemberEntry` checks `consumedLineEnding(input, item.rest)` before both pre- and post-delimiter trailing-comment parses.
- Do not edit `docs/site/` or add other user-facing documentation.
- Keep cosmetic continuation indentation out of scope. This work must not change unrelated wrapped lists or generated documentation.
- Follow `docs/dev/anti-patterns.md`: preserve one syntax owner, expose a declarative hook, avoid repeated stateful rendering, and do not add dynamic imports, `Map`, `Set`, one-line `if` statements, nested ternaries, or single-character names.
- Redirect test and verification runs to `.tmp/type-printer-trivia-*.txt`, inspect the saved output, and remove those files before finishing. Regenerate fixtures with `make fixtures`, then run `make`; checked-in `docs/site/` must remain clean. After `make`, run the full unit suite, structural lint, and `git diff --check`. The full Agency execution suite and performance suite are not required.
- Do not amend or force-push. Eventual implementation commits use `git commit -F`; the implementation PR must target `adit/trailing-comments-integration`.

---

## Scope and file map

The parser already preserves object-type `trivia`; the loss occurs when the shared printer reaches a nested object and uses its current inline branch. The implementation changes only these responsibilities:

| File | Responsibility |
|---|---|
| `lib/backends/typescriptGenerator/typeToString.ts` | Define the optional object hook and remain the canonical recursive syntax/precedence printer. |
| `lib/backends/typescriptGenerator/typeToString.test.ts` | Pin no-hook compatibility and recursive hook forwarding. |
| `lib/backends/agencyGenerator.ts` | Install the source hook, lay out trivia-bearing object types, and explicitly select plain rendering for `signatureOf`. |
| `lib/backends/agencyGenerator.test.ts` | Exact production-formatter output (including blank-line preprocessing), reparse/idempotence, nested and root blank-line preservation, and wrapper/source-position coverage. |
| `lib/cli/doc.test.ts` | Exact `agency doc` regressions for source-rendered aliases and trivia-free function/node signatures. |
| `lib/stdlib/agency.test.ts` | Exact `std::agency` `_describe` plain-signature regression. |

No new production file is needed. Do not modify `lib/types/dataStructures.ts`, formatter/parser implementation files, generated fixtures, or user-facing docs.

The required interface is:

```ts
export type TypePrintHooks = {
  objectType?: (
    type: ObjectType,
    printChild: (child: VariableType) => string,
  ) => string | undefined;
};

export function variableTypeToString(
  variableType: VariableType,
  typeAliases: Record<string, VariableType>,
  forFormatting?: boolean,
  hooks?: TypePrintHooks,
): string;
```

Returning `undefined` means “use the existing inline object rendering.” The callback must recurse with the same aliases, dialect, and hooks. `AgencyGenerator` supplies a hook only from its source path:

```ts
private renderTypeSource(type: VariableType): string {
  return variableTypeToString(type, this.typeAliases, true, {
    objectType: (objectType, printChild) => {
      if (!objectType.trivia?.length) {
        return undefined;
      }
      return this.renderObjectTypeSource(objectType, printChild);
    },
  });
}
```

`renderObjectTypeSource` and `stringifyProp` accept `printChild`; they do not recurse independently. Root object aliases retain their existing multiline layout by calling the same object layout method directly. Nested objects continue through the canonical inline branch only when they have neither trivia nor semantic property metadata. Display rendering calls the same formatter-owned object layout with `trivia` removed for root aliases and metadata-bearing nested objects.

---

### Task 1: Add the recursive object rendering hook without changing default output

**Files:**
- Modify: `lib/backends/typescriptGenerator/typeToString.ts`
- Modify: `lib/backends/typescriptGenerator/typeToString.test.ts`

**Interfaces:**
- Consumes: existing `ObjectType` and `VariableType` definitions.
- Produces: exported `TypePrintHooks` and the four-argument `variableTypeToString`; no-hook output remains unchanged.

- [ ] **Step 1: Write focused failing tests for the hook contract**

In `lib/backends/typescriptGenerator/typeToString.test.ts`, add tests that construct types directly. Keep the existing aliases fixture. The first test records the object nodes reached and delegates by returning `undefined`; compare exact strings so the default dialect remains pinned:

```ts
it("preserves exact output when the object hook delegates", () => {
  const type: VariableType = {
    type: "genericType",
    name: "Container",
    typeArgs: [{
      type: "objectType",
      properties: [{ key: "value", value: { type: "primitiveType", value: "number" } }],
    }],
    valueArgs: [{ type: "number", value: "3" }],
  };
  const visited: ObjectType[] = [];

  const rendered = variableTypeToString(type, {}, true, {
    objectType: (objectType) => {
      visited.push(objectType);
      return undefined;
    },
  });

  expect(rendered).toBe("Container<{ value: number }>(3)");
  expect(visited).toHaveLength(1);
});
```

Add a second table-driven test whose hook renders an object as `OBJECT<${printChild(property.value)}>` and asserts exact output through every recursive edge the printer emits: array; union; intersection; `keyof`; indexed access object and index; generic type arguments plus `(3)` value arguments; `Result` success/failure including `Result<T>` when failure is `string`; block parameters, return, and `raises`. Include nested objects so `printChild` must forward the hook.

- [ ] **Step 2: Run the focused test and save the expected failure**

```bash
mkdir -p .tmp
pnpm test:run lib/backends/typescriptGenerator/typeToString.test.ts > .tmp/type-printer-trivia-task1-red.txt 2>&1
```

Expected: nonzero exit because `variableTypeToString` does not accept hooks. Inspect with `cat .tmp/type-printer-trivia-task1-red.txt`.

- [ ] **Step 3: Add the optional hook and forward it through all recursion**

Import `ObjectType` as a type, export `TypePrintHooks`, and add `hooks?: TypePrintHooks` after `forFormatting`. At the beginning of the existing `objectType` branch, call the hook:

```ts
const rendered = hooks?.objectType?.(
  variableType,
  (child) => variableTypeToString(child, typeAliases, forFormatting, hooks),
);
if (rendered !== undefined) {
  return rendered;
}
```

Leave the existing inline object code directly below it. Add `hooks` to every recursive call in `variableTypeToString`: array element, ordinary union members, object properties, block parameter/return/raises rendering paths, both `Result` arguments, generic type arguments, intersection members, `keyof` operand, and both indexed-access operands. Also forward hooks through helpers that recurse (`effectSetMemberToSource` and `effectSetToSource`) by extending their private/internal signatures only as needed; their existing callers may omit hooks.

Do not alter any branch’s syntax, precedence conditions, union wrapping, `formatValueArgs`, or `Result` shorthand. The hook replaces only object layout when it returns a string.

- [ ] **Step 4: Run and inspect the focused green test**

```bash
pnpm test:run lib/backends/typescriptGenerator/typeToString.test.ts > .tmp/type-printer-trivia-task1-green.txt 2>&1
cat .tmp/type-printer-trivia-task1-green.txt
```

Expected: exit 0 and the file reports all tests passed.

- [ ] **Step 5: Commit the independently reviewable printer contract**

```bash
printf '%s\n' 'feat: add an object hook to the canonical type printer' > .tmp/type-printer-trivia-commit.txt
git add lib/backends/typescriptGenerator/typeToString.ts lib/backends/typescriptGenerator/typeToString.test.ts
git commit -F .tmp/type-printer-trivia-commit.txt
```

---

### Task 2: Install formatter-owned object layout and preserve wrapper syntax exactly

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/backends/agencyGenerator.test.ts`

**Interfaces:**
- Consumes: `TypePrintHooks` behavior and recursive `printChild` from Task 1.
- Produces: `renderTypeSource`, `renderObjectTypeSource`, and `stringifyProp` as the source-formatting policy; no second type-tree traversal.

- [ ] **Step 1: Add exact failing wrapper tests**

Add a local assertion helper beside the existing formatter helper in `lib/backends/agencyGenerator.test.ts`:

```ts
function formatAgency(source: string): string {
  const formatted = formatSource(source);
  expect(formatted).not.toBeNull();
  return formatted?.trim() ?? "";
}

function expectExactStableFormat(source: string, expected: string): void {
  const once = formatAgency(source);
  expect(once).toBe(expected);
  expect(parseAgency(once, {}, false, false).success).toBe(true);
  expect(formatAgency(once)).toBe(expected);
}
```

Use `formatSource`, rather than calling `parseAgency(source)` directly, so the
tests exercise production's `replaceBlankLines` preprocessing. Blank lines
must survive inside both nested wrapper objects and root object aliases; each
exact case must reparse and reach the same formatting fixed point.

Use complete exact strings—not `toContain`—for a compact set of cases covering:

```agency
type Generic = Container<{
  x: number // keep
}>(3)

type Loaded = Result<{
  x: number // keep
}>

type Callback = (arg: {
  x: number // keep
}) -> {
  y: string // keep
}

type Optional = {
  nested: {
    x: number // keep
  } | null
}
```

Add exact cases for standalone comments and blank lines at nested and root object positions, plus arrays, ordinary/effect-set unions, intersections, `keyof`, and indexed access. Ensure expected output pins all suffixes, parentheses, `(3)`, one-argument `Result<T>`, block arrows, and `raises <...>`. Include an object nested inside another object property so `stringifyProp` must use `printChild`.

- [ ] **Step 2: Run and inspect the expected formatter failures**

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts > .tmp/type-printer-trivia-task2-red.txt 2>&1
```

Expected: nonzero exit because nested object trivia is dropped. Inspect the saved output once.

- [ ] **Step 3: Implement only formatter-owned object layout**

Add `renderTypeSource` exactly as specified in the architecture section. Extract the current root-object body of `aliasedTypeToString` into:

```ts
private renderObjectTypeSource(
  objectType: ObjectType,
  printChild: (child: VariableType) => string,
): string
```

Keep `renderListWithTrivia` as the indentation/comment owner. Change `stringifyProp` to accept `printChild` and use it for both the ordinary property value and the optional-property union-without-null value. Preserve tags, descriptions, separators, and optional shorthand exactly.

For root object aliases, `aliasedTypeToString` calls `renderObjectTypeSource` with a callback to `renderTypeSource`, preserving the current always-multiline root object layout. For every other type it calls `renderTypeSource`. Do not add `typeHasTrivia`, switch on other type kinds, copy precedence conditions, or rerender a child outside `printChild`.

- [ ] **Step 4: Run focused printer and formatter tests**

```bash
pnpm test:run lib/backends/typescriptGenerator/typeToString.test.ts lib/backends/agencyGenerator.test.ts > .tmp/type-printer-trivia-task2-green.txt 2>&1
cat .tmp/type-printer-trivia-task2-green.txt
```

Expected: exit 0. Exact wrapper output reparses and reaches a formatting fixed point.

- [ ] **Step 5: Commit the formatter policy**

```bash
printf '%s\n' 'fix: preserve object type trivia through wrappers' > .tmp/type-printer-trivia-commit.txt
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts
git commit -F .tmp/type-printer-trivia-commit.txt
```

---

### Task 3: Route every source position while keeping signatures plain

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/backends/agencyGenerator.test.ts`
- Modify: `lib/cli/doc.test.ts`
- Modify: `lib/stdlib/agency.test.ts`

**Interfaces:**
- Consumes: `renderTypeSource` from Task 2 and no-hook `variableTypeToString` from Task 1.
- Produces: explicit source/display policy at each `AgencyGenerator` entry point.

- [ ] **Step 1: Add exact failing source-position tests**

Add table-driven exact stable-format tests for every formatter-facing position currently calling `variableTypeToString(..., true)`:

- `schema({ ... })` type argument;
- hole annotation `#value: { ... }`;
- function and node parameter types;
- function and node return types;
- generic type-parameter defaults;
- value-parameter types;
- variable declaration annotations;
- type patterns in match arms and `is` expressions;
- inline handler parameter types;
- finalize block parameter types;
- type aliases and effect payloads.

Each input must put a standalone or trailing comment in the nested object and assert the complete canonical source, successful reparse, and idempotence. Use valid Agency syntax throughout, for example:

```agency
def save(value: {
  id: string // keep
}): Result<{
  ok: boolean // keep
}> {
  return success({ ok: true })
}
```

Copy less familiar syntax (generic defaults, value parameters, patterns, handlers, and finalize parameters) from existing tests in this file before writing each case; parse the proposed input in the test rather than inventing grammar.

- [ ] **Step 2: Add exact failing display-policy regressions**

In `lib/cli/doc.test.ts`, generate docs from exported aliases/functions whose alias, parameter, and return object types contain comments. Assert the exact signature code fences remain plain and contain no `// keep`, for example:

````text
```ts
load(input: { id: string }): { value: string }
```
````

In `lib/stdlib/agency.test.ts`, pass equivalent exported declarations to `_describe` and assert exact `signature` strings for alias, function, and node entries. These tests prove `signatureOf` does not accidentally inherit source trivia policy.

- [ ] **Step 3: Run and inspect the expected routing failures**

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts lib/cli/doc.test.ts lib/stdlib/agency.test.ts > .tmp/type-printer-trivia-task3-red.txt 2>&1
```

Expected: source-position cases fail because they still use the plain printer; display expectations document the boundary.

- [ ] **Step 4: Route source calls and make display rendering explicit**

Replace source-formatting calls in `AgencyGenerator` with `this.renderTypeSource(...)`: schema expressions, holes, `renderParams`, generic defaults, value-parameter types, assignments, all type-pattern renderers, source return types, inline handler parameters, and finalize parameters. Use `grep -n "variableTypeToString" lib/backends/agencyGenerator.ts` to audit the list, but do not mechanically replace display calls.

Add a named plain helper so policy is visible rather than inferred from call location:

```ts
private renderTypeDisplay(type: VariableType): string {
  return variableTypeToString(type, this.typeAliases, true);
}
```

Thread a `"source" | "display"` policy through `renderParams`, `buildSignature`, and alias rendering where they are shared by full source generation and `signatureOf`. Full definitions use source rendering; `signatureOf` passes display and uses `renderTypeDisplay` recursively/no-hook for alias, parameter, and return types. Keep raises rendering unchanged and plain. Avoid mutable class mode: policy must be an explicit argument so one call cannot affect another.

- [ ] **Step 5: Run the three focused suites**

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts lib/cli/doc.test.ts lib/stdlib/agency.test.ts > .tmp/type-printer-trivia-task3-green.txt 2>&1
cat .tmp/type-printer-trivia-task3-green.txt
```

Expected: exit 0; source comments survive every parseable formatter position, while `signatureOf`, `agency doc`, and `_describe` remain exact plain strings.

- [ ] **Step 6: Commit the explicit policy boundary**

```bash
printf '%s\n' 'fix: separate source and display type rendering' > .tmp/type-printer-trivia-commit.txt
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts lib/cli/doc.test.ts lib/stdlib/agency.test.ts
git commit -F .tmp/type-printer-trivia-commit.txt
```

---

### Final verification

- [ ] **Step 1: Run all focused suites and structural lint**

```bash
pnpm test:run lib/backends/typescriptGenerator/typeToString.test.ts lib/backends/agencyGenerator.test.ts lib/cli/doc.test.ts lib/stdlib/agency.test.ts > .tmp/type-printer-trivia-final-tests.txt 2>&1
pnpm run lint:structure > .tmp/type-printer-trivia-lint.txt 2>&1
cat .tmp/type-printer-trivia-final-tests.txt
cat .tmp/type-printer-trivia-lint.txt
```

Expected: both commands exit 0. Diagnose any failure from the saved file before rerunning only the affected command.

- [ ] **Step 2: Audit scope and anti-patterns**

Run:

```bash
git diff --stat adit/trailing-comments-integration...HEAD
git diff --name-only adit/trailing-comments-integration...HEAD
grep -R -n "typeHasTrivia" lib || true
grep -n "variableTypeToString" lib/backends/agencyGenerator.ts
git status --short
```

Confirm: one recursive printer; one declarative object hook; all recursive edges forward it; no copied precedence logic; no second traversal; display calls are explicit; no repeated rendering or broad caller conversion; parser and `docs/site/` are untouched; generic `(3)`, `Result<T>`, block `raises`, wrappers, every source position, exact display output, reparse, and idempotence are covered. Re-read `docs/dev/anti-patterns.md` and inspect the diff specifically for duplication, imperative leakage, order-dependent mutable state, useless special cases, and inconsistent patterns.

- [ ] **Step 3: Commit, clean temporary output, and prepare the eventual PR**

```bash
printf '%s\n' 'fix: preserve type trivia in formatter output' > .tmp/type-printer-trivia-commit.txt
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts lib/cli/doc.test.ts lib/stdlib/agency.test.ts
git commit -F .tmp/type-printer-trivia-commit.txt
rm -f .tmp/type-printer-trivia-*.txt
git status --short
```

Expected: no temporary output remains and the worktree contains no unintended files. The eventual PR targets `adit/trailing-comments-integration` and states that PR #768’s parser fix is already present and out of scope.

---

## Final acceptance checklist

- [ ] `variableTypeToString` is the sole recursive type syntax/precedence printer, and no-hook output is pinned unchanged.
- [ ] The optional object hook is forwarded through every recursive edge and can delegate with `undefined`.
- [ ] `AgencyGenerator` owns only trivia-aware object layout, indentation, and explicit source/display selection.
- [ ] Exact source tests cover generic value args, `Result` shorthand, block types, optional/nested types, arrays, unions, intersections, `keyof`, indexed access, and every formatter-facing type position.
- [ ] Cosmetic continuation indentation remains unchanged, so unrelated wrapped lists and generated docs retain their existing output.
- [ ] Direct `signatureOf`, `agency doc` function/node signatures, and `std::agency` exact regressions prove comments do not leak into display signatures; exact alias-doc regressions prove reference bodies retain full source trivia and metadata.
- [ ] Focused tests and structural lint pass from saved output; parser code, generated content, and user-facing docs are unchanged.
- [ ] The anti-pattern audit passes, and the eventual implementation PR base is `adit/trailing-comments-integration`.
