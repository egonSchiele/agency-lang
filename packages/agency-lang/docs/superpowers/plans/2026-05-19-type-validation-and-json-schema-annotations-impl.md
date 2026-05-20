# Type Validation & JSON Schema Annotations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new annotations — `@validate(fn1, fn2, ...)` for runtime validation chains and `@jsonSchema({...})` for JSON-Schema metadata — usable on type aliases and type properties, and ship a small standard library (`std::validators`, `std::schemas`, `std::types`) that exercises them.

**Architecture:** A single AST change widens `Tag.arguments` from `string[]` to `Expression[]`. The preprocessor and the object-type parser both grow the ability to attach those tags to type-level targets (`typeAlias` nodes and `ObjectProperty` entries). The type checker carries tags on `TypeAliasEntry`, propagates them through `resolveType`, and enforces a static-expression restriction on `@jsonSchema` arguments. The TypeScript builder emits `.meta({...})` for `@jsonSchema` and, for `!`-validated values, threads the Zod-parsed value through a chain of async validator calls via a new `__validateChain` runtime helper. Removal of the legacy `# description` syntax is a fast-follow PR after this lands.

**Tech Stack:** tarsec parser combinators, vitest, structural linter, Zod 4 (`.meta()` API).

**Spec:** `docs/superpowers/specs/2026-05-19-type-validation-and-json-schema-annotations-design.md`

---

## Key Risks and Gotchas

1. **`Tag.arguments` is `string[]` today.** Every reader of `tag.arguments` in the codebase (search `\.arguments\b` on `Tag` nodes — currently only `lib/preprocessors/typescriptPreprocessor.ts` cares) must be updated to read `Expression[]`. Existing callers that expect strings (e.g. `@goal("...")`, `@optimize(prompt, temperature)`) must continue to round-trip identically — string-literal expressions and identifier expressions are the new bare forms.

2. **`attachTags` only knows about four statement node types.** It currently attaches to `graphNode`, `function`, `assignment`, `functionCall` ([lib/preprocessors/typescriptPreprocessor.ts:112-145](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/preprocessors/typescriptPreprocessor.ts#L112-L145)). It must be extended to `typeAlias`, otherwise tags above `type Foo = ...` are silently dropped.

3. **Property-level tags live inside the type expression parser.** `attachTags` runs at the statement level and cannot see inside `{ ... }` object-type bodies. Tag accumulation for `ObjectProperty` is a new feature of `objectTypeParser` (around [parsers.ts:884-920](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L884-L920)).

4. **`TypeAliasEntry` is widely consumed.** Adding `tags?: Tag[]` is a one-line change to [`lib/types/typeHints.ts:46-49`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/typeHints.ts#L46-L49), but every site that constructs a `TypeAliasEntry` (notably [`compilationUnit.ts:48`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/compilationUnit.ts#L48)) must thread tags through. Missing one means annotations stop propagating at a module boundary.

5. **`resolveType` is the propagation seam.** Tag propagation for both generic instantiations and plain alias references must happen here, not at codegen. Codegen reads tags off the resolved node; it does not look them up.

6. **`!` validation goes through `__validateType`.** The single existing seam is [`lib/runtime/schema.ts:27`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/schema.ts#L27), called from emitter sites listed in [`lib/backends/typescriptBuilder.ts:2130, 2230`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptBuilder.ts#L2130) and the IR builder [`lib/ir/builders.ts:401`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/ir/builders.ts#L401). The new `__validateChain` helper must be wired in at every one of those sites — missing one means validators silently don't run for some `!` positions, which is a safety bug per the CLAUDE.md guidance on handlers and safety infrastructure.

7. **Validators are async, Zod is sync.** Do not switch the Zod path to `safeParseAsync` — see spec §"Why run validators outside Zod". The new helper awaits validator calls *after* the sync Zod parse succeeds.

8. **`.meta()` must be the last call in the Zod chain.** A single `appendMeta(schemaExpr, metaObj)` helper in the typescript generator enforces this. Any code path that constructs a Zod expression must go through it.

9. **`# description` removal is OUT of this PR.** The annotation infrastructure lands first. The fast-follow PR will codemod every fixture and example. While both coexist, mixing `# desc` and `@jsonSchema({description: ...})` on the same property is an error.

10. **Make is required after stdlib changes.** Three new stdlib files (`stdlib/validators.{agency,js}`, `stdlib/schemas.{agency,js}`, `stdlib/types.{agency,js}`) need a `make` build after authoring.

11. **Recursive type walker depth cap defaults to 64.** Adjust if real workloads need more; do not remove it.

12. **Spread in object literals is already supported** via `splatParser` ([parsers.ts:1372](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts) area). Do not re-invent.

---

## File Structure

**New files:**

| File | Purpose |
|------|---------|
| `lib/runtime/validateChain.ts` | Async validator-chain helper; recursion-walker for nested types |
| `lib/runtime/validateChain.test.ts` | Unit tests for the helper |
| `lib/typeChecker/jsonSchemaArgValidator.ts` | Static-expression restriction enforcement for `@jsonSchema(...)` |
| `lib/typeChecker/jsonSchemaArgValidator.test.ts` | Unit tests for the restriction |
| `stdlib/validators.agency` + `stdlib/validators.js` | `isEmail`, `isUrl`, `isUuid`, `isInt`, `isPositive`, `isNegative`, `min`, `max`, `minLength`, `maxLength`, `matches` |
| `stdlib/schemas.agency` + `stdlib/schemas.js` | `emailFormat`, `urlFormat`, `uuidFormat`, `dateTimeFormat`, `dateFormat`, `ipv4Format`, `ipv6Format` |
| `stdlib/types.agency` + `stdlib/types.js` | Pre-baked `Email`, `URL`, `UUID` aliases |
| `docs/site/guide/annotations.md` | User-facing docs for `@validate` / `@jsonSchema` and the stdlib modules |

**Files modified:**

| File | Purpose in this plan |
|------|----------------------|
| `lib/types/tag.ts` | `arguments: string[]` → `arguments: Expression[]` |
| `lib/types/typeHints.ts` | Add `tags?: Tag[]` to `ObjectProperty` and `TypeAliasEntry`; allow `tags?: Tag[]` on `TypeAlias` |
| `lib/parsers/parsers.ts` | Tag-argument expression parser (restricted subset); attach tags inside `objectTypeParser`; ordering for `typeAliasParser` |
| `lib/preprocessors/typescriptPreprocessor.ts` | Extend `attachTags` to attach to `typeAlias` |
| `lib/compilationUnit.ts` | Carry `tags` on `TypeAliasEntry` when adding to `ScopedTypeAliases` |
| `lib/typeChecker/*.ts` (resolveType + callers) | Propagate tags from alias to use-site through `resolveType`; merge property/alias tags per spec |
| `lib/backends/typescriptGenerator/typeToZodSchema.ts` | Emit `.meta({...})` via new `appendMeta` helper; remove legacy `.describe(prop.description)` later (fast-follow) |
| `lib/backends/typescriptBuilder.ts` | Replace direct `__validateType(...)` calls with `__validateChain(...)` for any type carrying `@validate` tags |
| `lib/ir/builders.ts` | Mirror the builder change at the IR level |
| `lib/utils/formatType.ts` | Round-trip tags in `agencyGenerator` for `ObjectProperty` and `TypeAlias` |
| `lib/backends/agencyGenerator.ts` | Emit `@validate(...)` / `@jsonSchema(...)` above aliases and properties |
| `docs/site/guide/types.md` | Cross-link to the new annotations doc |

---

## Task 1: Widen `Tag.arguments` to `Expression[]`

**Files:**
- Modify: `lib/types/tag.ts`
- Modify: `lib/preprocessors/typescriptPreprocessor.ts`
- Modify: `lib/backends/agencyGenerator.ts` (anywhere it prints tag args back out)

- [ ] **Step 1: Write a failing AST test**

In `lib/types/tag.test.ts` (create if missing), assert that a `Tag` value compiles with `arguments: [{ type: "stringLiteral", value: "hi" } as Expression]`. Use `tsc --noEmit` (`pnpm run typecheck`) for the failing signal.

- [ ] **Step 2: Run the typecheck to verify the field is still `string[]`**

```
pnpm run typecheck 2>&1 | tee /tmp/typecheck.log
```

Expected: type error pointing at the new test file.

- [ ] **Step 3: Widen the type**

Edit [lib/types/tag.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/tag.ts):

```typescript
import { BaseNode } from "./base.js";
import type { Expression } from "./ast.js";

export type Tag = BaseNode & {
  type: "tag";
  name: string;
  arguments: Expression[];
};
```

- [ ] **Step 4: Fix every downstream consumer**

```
grep -rn "\\.arguments" lib/ --include="*.ts" | grep -v test | grep -iE "tag" | tee /tmp/tag-readers.log
```

Expected callers to patch (initial survey — re-grep before editing):
- `lib/preprocessors/typescriptPreprocessor.ts` (uses for `@goal`, `@optimize`)
- `lib/backends/agencyGenerator.ts` (prints tags back out)

For each: when the argument is a string-literal expression, recover the string via the existing literal node shape; when it's an identifier expression, recover the identifier. Add a small helper `tagArgToLegacyString(arg: Expression): string | null` so existing string-only consumers don't grow expression-handling logic.

- [ ] **Step 5: Run all parser, preprocessor, generator tests**

```
pnpm test:run lib/types lib/preprocessors lib/backends 2>&1 | tee /tmp/task1-tests.log
```

Expected: PASS (existing tags `@goal("...")`, `@optimize(prompt, temperature)` still behave identically).

- [ ] **Step 6: Commit**

```bash
git add lib/types/tag.ts lib/preprocessors/typescriptPreprocessor.ts lib/backends/agencyGenerator.ts lib/types/tag.test.ts
git commit -F .git/COMMIT_MSG  # contents: "refactor: widen Tag.arguments to Expression[]"
```

---

## Task 2: Tag parser accepts the restricted expression subset

**Files:**
- Modify: `lib/parsers/parsers.ts` (around the existing `tagParser`)
- Add tests in: `lib/parsers/tag.test.ts` (create if missing)

The allowed forms per spec: literals (string / number / boolean / `null`), identifiers, function calls, object literals (including spread). No ternaries, no binary ops, no pipes, no member access, no template strings, no array literals.

- [ ] **Step 1: Write failing parser tests**

Create / append `lib/parsers/tag.test.ts` with cases:

```typescript
import { tagParser } from "./parsers.js";

it("parses @validate(isEven)", () => {
  const r = tagParser("@validate(isEven)");
  expect(r.success).toBe(true);
  expect(r.result.arguments[0].type).toBe("variableName"); // or whatever identifier shape is
});

it("parses @validate(min(0), max(150))", () => {
  const r = tagParser("@validate(min(0), max(150))");
  expect(r.success).toBe(true);
  expect(r.result.arguments).toHaveLength(2);
  expect(r.result.arguments[0].type).toBe("functionCall");
});

it("parses @jsonSchema({ format: \"email\" })", () => {
  const r = tagParser('@jsonSchema({ format: "email" })');
  expect(r.success).toBe(true);
  expect(r.result.arguments[0].type).toBe("agencyObject");
});

it("parses @jsonSchema({ ...emailFormat, description: \"work\" })", () => {
  const r = tagParser('@jsonSchema({ ...emailFormat, description: "work" })');
  expect(r.success).toBe(true);
});

it("rejects @validate(x > 5)", () => {
  const r = tagParser("@validate(x > 5)");
  expect(r.success).toBe(false);
});

it("preserves @goal(\"old style\") as string-literal expression", () => {
  const r = tagParser('@goal("old style")');
  expect(r.success).toBe(true);
  expect(r.result.arguments[0].type).toBe("stringLiteral");
});
```

- [ ] **Step 2: Run tests, watch them fail**

```
pnpm test:run lib/parsers/tag.test.ts 2>&1 | tee /tmp/task2-fail.log
```

- [ ] **Step 3: Implement the restricted-subset argument parser**

Replace `tagArg`, `tagArgsList`, and `_tagParserInner` at [parsers.ts:1316-1352](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L1316-L1352).

```typescript
// Restricted subset of expressions allowed inside @tag(...) arguments.
// NO ternaries, binops, pipes, member access, template strings, array literals.
const restrictedTagArgParser: Parser<Expression> = label(
  "a tag argument (literal, identifier, function call, or object literal)",
  or(
    lazy(() => functionCallParser),       // @validate(min(0))
    lazy(() => agencyObjectParser),        // @jsonSchema({ ... })
    lazy(() => stringLiteralParser),
    lazy(() => numberLiteralParser),
    lazy(() => booleanLiteralParser),
    lazy(() => nullLiteralParser),
    lazy(() => varNameParser),             // identifier — must come LAST (greedy)
  ),
);

const tagArgsList = map(
  seqC(
    char("("),
    optionalSpaces,
    capture(sepBy(comma, restrictedTagArgParser), "args"),
    optionalSpaces,
    char(")"),
  ),
  (r) => r.args,
);

const _tagParserInner = trace(
  "tagParser",
  seqC(
    set("type", "tag"),
    char("@"),
    capture(many1WithJoin(varNameChar), "name"),
    capture(or(tagArgsList, succeed([] as Expression[])), "arguments"),
    optionalSemicolon,
  ),
);
```

Confirm the actual node-type strings (`"variableName"`, `"functionCall"`, `"agencyObject"`, `"stringLiteral"`, `"numberLiteral"`, `"booleanLiteral"`) by reading the existing AST type definitions before final implementation.

- [ ] **Step 4: Re-run tag tests**

```
pnpm test:run lib/parsers/tag.test.ts 2>&1 | tee /tmp/task2-pass.log
```

Expected: PASS.

- [ ] **Step 5: Run full parser suite to catch regressions**

```
pnpm test:run lib/parsers 2>&1 | tee /tmp/task2-parsers.log
```

Expected: PASS (no existing `@tag(...)` regressions).

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/tag.test.ts
git commit -m "feat(parser): tag arguments accept restricted expression subset"
```

---

## Task 3: Attach tags to `typeAlias` statements

**Files:**
- Modify: `lib/preprocessors/typescriptPreprocessor.ts` (`attachTags`)
- Modify: `lib/types/typeHints.ts` (`TypeAlias` already has `BaseNode`; confirm a `tags?: Tag[]` field can be added)

- [ ] **Step 1: Write a failing preprocessor test**

In `lib/preprocessors/typescriptPreprocessor.test.ts` (or create) assert that after preprocessing the source

```
@validate(isEmail)
type Email = string
```

the resulting `typeAlias` node has `tags` containing one element with `name === "validate"`.

- [ ] **Step 2: Run, watch fail**

```
pnpm test:run lib/preprocessors 2>&1 | tee /tmp/task3-fail.log
```

- [ ] **Step 3: Extend `attachTags`**

Edit [`lib/preprocessors/typescriptPreprocessor.ts:122-128`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/preprocessors/typescriptPreprocessor.ts#L122-L128):

```typescript
if (pendingTags.length > 0) {
  if (
    node.type === "graphNode" || node.type === "function" ||
    node.type === "assignment" || node.type === "functionCall" ||
    node.type === "typeAlias"
  ) {
    (node as any).tags = [...((node as any).tags || []), ...pendingTags];
    pendingTags = [];
  } else {
    result.push(...pendingTags);
    pendingTags = [];
  }
}
```

Add `tags?: Tag[]` to `TypeAlias` in [`lib/types/typeHints.ts`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/typeHints.ts) (currently has `type`, `aliasName`, `aliasedType`, `typeParams?`, `exported?`, `docComment?`). Use a proper typed cast in the preprocessor instead of `as any`.

- [ ] **Step 4: Re-run tests**

```
pnpm test:run lib/preprocessors 2>&1 | tee /tmp/task3-pass.log
```

- [ ] **Step 5: Commit**

```bash
git add lib/preprocessors/typescriptPreprocessor.ts lib/types/typeHints.ts lib/preprocessors/typescriptPreprocessor.test.ts
git commit -m "feat(preprocessor): attach tags to typeAlias nodes"
```

---

## Task 4: Parse property-level tags inside object types

**Files:**
- Modify: `lib/types/typeHints.ts` (add `tags?: Tag[]` to `ObjectProperty`)
- Modify: `lib/parsers/parsers.ts` (`objectTypeParser` around line 884)

- [ ] **Step 1: Failing parser test**

In `lib/parsers/objectType.test.ts` (create if missing):

```typescript
import { objectTypeParser } from "./parsers.js";

it("attaches @validate tag to a property", () => {
  const src = `{
    @validate(isEmail)
    email: string
  }`;
  const r = objectTypeParser(src);
  expect(r.success).toBe(true);
  const prop = r.result.properties[0];
  expect(prop.key).toBe("email");
  expect(prop.tags).toHaveLength(1);
  expect(prop.tags[0].name).toBe("validate");
});

it("attaches multiple tags to a property", () => {
  const src = `{
    @validate(isEmail)
    @jsonSchema({ format: "email" })
    email: string
  }`;
  const r = objectTypeParser(src);
  expect(r.success).toBe(true);
  expect(r.result.properties[0].tags).toHaveLength(2);
});

it("plain property still parses with no tags", () => {
  const src = `{ name: string }`;
  const r = objectTypeParser(src);
  expect(r.success).toBe(true);
  expect(r.result.properties[0].tags).toBeUndefined();
});
```

- [ ] **Step 2: Run, watch fail**

```
pnpm test:run lib/parsers/objectType.test.ts 2>&1 | tee /tmp/task4-fail.log
```

- [ ] **Step 3: Add the field**

In [`lib/types/typeHints.ts:105-109`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/typeHints.ts#L105-L109):

```typescript
export type ObjectProperty = {
  key: string;
  value: VariableType;
  description?: string;   // legacy — removed in fast follow
  tags?: Tag[];           // new
};
```

- [ ] **Step 4: Extend `objectTypeParser`**

In [parsers.ts:884-920](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts#L884-L920), change the `sepBy` alternative list to first try a "tagged property" parser that accumulates one or more `tagParser` outputs followed by an `objectPropertyParser` / `objectPropertyWithDescriptionParser`, then writes the tags onto the resulting property:

```typescript
const taggedObjectPropertyParser: Parser<ObjectProperty> = trace(
  "taggedObjectPropertyParser",
  map(
    seqC(
      capture(
        many1(seqC(tagParser, optionalSpacesOrNewline)),
        "tags",
      ),
      capture(
        or(objectPropertyWithDescriptionParser, objectPropertyParser),
        "prop",
      ),
    ),
    (r) => {
      const tags = (r.tags as Array<{ tag: Tag }>).map((t) => t.tag);
      return { ...r.prop, tags };
    },
  ),
);

// In the inner or(...) list, put taggedObjectPropertyParser FIRST so it
// runs before the plain property parsers.
sepBy(
  objectPropertyDelimiter,
  or(
    taggedObjectPropertyParser,
    objectPropertyWithDescriptionParser,
    objectPropertyParser,
    commentParser,
    multiLineCommentParser,
  ),
),
```

The exact `seqC`/`capture` shape may need tweaking to match how `tagParser` returns its inner value; consult `tarsec`-style examples elsewhere in the file.

- [ ] **Step 5: Pass tests**

```
pnpm test:run lib/parsers/objectType.test.ts lib/parsers 2>&1 | tee /tmp/task4-pass.log
```

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/types/typeHints.ts lib/parsers/objectType.test.ts
git commit -m "feat(parser): accept tags above type-object properties"
```

---

## Task 5: Carry tags on `TypeAliasEntry`

**Files:**
- Modify: `lib/types/typeHints.ts` (add `tags?: Tag[]` to `TypeAliasEntry`)
- Modify: `lib/compilationUnit.ts` (`ScopedTypeAliases.add` accepts and stores tags)
- Modify: every constructor / `add()` call site for `TypeAliasEntry`

- [ ] **Step 1: Failing typecheck**

In a new `lib/compilationUnit.test.ts` test, call `aliases.add("Email", { type: "primitiveType", name: "string" }, undefined, [{ type: "tag", name: "validate", arguments: [] }])` and assert that `aliases.get(...)["Email"].tags` exists.

- [ ] **Step 2: Run, watch fail**

```
pnpm test:run lib/compilationUnit 2>&1 | tee /tmp/task5-fail.log
```

- [ ] **Step 3: Widen the entry**

```typescript
// lib/types/typeHints.ts
export type TypeAliasEntry = {
  body: VariableType;
  typeParams?: TypeParam[];
  tags?: Tag[];   // NEW
};
```

In [`lib/compilationUnit.ts:46-50`](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/compilationUnit.ts#L46-L50):

```typescript
add(scopeKey: string, name: string, body: VariableType, typeParams?: TypeParam[], tags?: Tag[]): void {
  if (!this.byScope[scopeKey]) this.byScope[scopeKey] = {};
  const entry: TypeAliasEntry = { body };
  if (typeParams) entry.typeParams = typeParams;
  if (tags && tags.length > 0) entry.tags = tags;
  this.byScope[scopeKey][name] = entry;
}
```

- [ ] **Step 4: Update all call sites that add aliases**

```
grep -rn "typeAliases\.add\|new TypeAliasEntry\|ScopedTypeAliases" lib/ --include="*.ts" | tee /tmp/alias-add-sites.log
```

Every site that converts a `typeAlias` AST node into a `TypeAliasEntry` must now also pass `node.tags`.

- [ ] **Step 5: Pass tests**

```
pnpm test:run lib/compilationUnit lib/typeChecker 2>&1 | tee /tmp/task5-pass.log
```

- [ ] **Step 6: Commit**

```bash
git add lib/types/typeHints.ts lib/compilationUnit.ts lib/typeChecker/ lib/compilationUnit.test.ts
git commit -m "feat(types): carry tags on TypeAliasEntry"
```

---

## Task 6: Propagate tags through `resolveType`

**Files:**
- Modify: `lib/typeChecker/*.ts` — wherever `resolveType` is defined (search for its definition)
- Modify: helper that merges alias + property tags

This is the most subtle task. After substitution:

- A reference to a plain alias `Email` resolves to its body **with the alias's tags attached** (on a shallow copy of the body — do not mutate the alias entry).
- A reference to a generic alias `NonEmptyArray<Email>` resolves to the substituted body **with the outer alias's tags attached**; the inner `Email` element type carries its own tags, which the downstream walker picks up.
- When the use site already carries tags (a property with `@validate(...)` over its declared alias), per-spec merge rules apply:
  - `@validate`: concat — alias tags first, then property tags.
  - `@jsonSchema`: merge object literals; property keys override alias keys.

- [ ] **Step 1: Failing type-checker / unit tests**

Create `lib/typeChecker/resolveType.tags.test.ts`:

```typescript
it("non-generic alias propagates tags to use site", () => {
  // Setup ScopedTypeAliases with `Email` having tags
  // Resolve a reference to Email
  // Assert resolved node has tags attached
});

it("generic alias propagates outer tags to instantiation", () => {
  // NonEmptyArray<Email> resolves to ArrayType with NonEmptyArray's tags
});

it("property tags merge with alias tags (validate concat)", () => {
  // alias Email has @validate(isEmail)
  // property `to: Email` has @validate(notBanned)
  // Resolved property type carries tags [isEmail, notBanned] in @validate order
});

it("property tags merge with alias tags (jsonSchema override)", () => {
  // alias has @jsonSchema({ format: "email", description: "alias desc" })
  // property has @jsonSchema({ description: "prop desc" })
  // Merged jsonSchema: { format: "email", description: "prop desc" }
});
```

- [ ] **Step 2: Run, watch fail**

```
pnpm test:run lib/typeChecker/resolveType.tags 2>&1 | tee /tmp/task6-fail.log
```

- [ ] **Step 3: Implement propagation**

Find `resolveType` (it lives in `lib/typeChecker/`; the generics plan called it out as the substitution seam). At the end of resolution, if the entry has `tags`, attach a *cloned* copy onto the returned `VariableType`. The returned node grows an optional `tags?: Tag[]` field — add this to the relevant `VariableType` variants (`primitiveType`, `objectType`, `arrayType`, etc.) or attach via a wrapper. Prefer extending `BaseNode` if all `VariableType` shapes share it, otherwise add the field per relevant variant.

Add a helper `mergeTagSets(aliasTags, useSiteTags): Tag[]` that:
- concatenates `@validate(...)` argument lists across all `@validate` tags (alias first, then use-site), producing a single combined `@validate` tag;
- merges `@jsonSchema(...)` object-literal arguments left-to-right (alias first, use-site overrides), producing a single combined `@jsonSchema` tag;
- preserves any other tag names unchanged (concat).

- [ ] **Step 4: Pass tests**

```
pnpm test:run lib/typeChecker 2>&1 | tee /tmp/task6-pass.log
```

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/ lib/types/typeHints.ts
git commit -m "feat(typeChecker): propagate and merge annotation tags through resolveType"
```

---

## Task 7: Enforce `@jsonSchema` argument restrictions in the type checker

**Files:**
- Create: `lib/typeChecker/jsonSchemaArgValidator.ts`
- Create: `lib/typeChecker/jsonSchemaArgValidator.test.ts`
- Hook into: the type-checker pass that walks `Tag`s on aliases/properties

Per spec: each leaf expression inside `@jsonSchema(...)` must be a literal, an object literal containing only allowed exprs/spreads, an identifier resolving to a static `const` global, or a function call to a top-level `def` / imported function with allowed-expr arguments.

- [ ] **Step 1: Failing tests**

```typescript
// jsonSchemaArgValidator.test.ts

it("accepts {format: \"email\"}", () => {
  expect(validateJsonSchemaArg(objLit({format: strLit("email")}), scope).ok).toBe(true);
});

it("accepts identifier bound to a top-level const", () => {
  // scope has `const emailFormat = {format: "email"}` (top-level)
  expect(validateJsonSchemaArg(ident("emailFormat"), scope).ok).toBe(true);
});

it("rejects identifier bound to a let", () => {
  expect(validateJsonSchemaArg(ident("someLet"), scope).ok).toBe(false);
});

it("rejects member access", () => {
  expect(validateJsonSchemaArg(memberAccess(...), scope).ok).toBe(false);
});

it("rejects ternary", () => { ... });
it("rejects template string", () => { ... });
it("rejects array literal", () => { ... });
it("accepts function call min(0)", () => { ... });
it("rejects function call whose argument is a forbidden expression", () => { ... });
```

- [ ] **Step 2: Run, watch fail**

```
pnpm test:run lib/typeChecker/jsonSchemaArgValidator 2>&1 | tee /tmp/task7-fail.log
```

- [ ] **Step 3: Implement the validator**

```typescript
// lib/typeChecker/jsonSchemaArgValidator.ts
import type { Expression } from "../types/ast.js";
import type { Scope } from "../compilationUnit.js";

export type JsonSchemaArgValidationResult =
  | { ok: true }
  | { ok: false; reason: string; loc?: { line: number; col: number } };

export function validateJsonSchemaArg(
  expr: Expression,
  scope: Scope,
): JsonSchemaArgValidationResult {
  switch (expr.type) {
    case "stringLiteral":
    case "numberLiteral":
    case "booleanLiteral":
    case "nullLiteral":
      return { ok: true };
    case "agencyObject":
      // walk entries + splats
      ...
    case "functionCall":
      // every argument must itself validate
      ...
    case "variableName":
      // must resolve to a top-level const-bound name
      ...
    default:
      return { ok: false, reason: `not allowed inside @jsonSchema: ${expr.type}`, loc: expr.loc };
  }
}
```

Determining "top-level const-bound" requires the scope's binding metadata. If the scope API doesn't currently distinguish `const` from `let`, add a small accessor; do not weaken the restriction.

- [ ] **Step 4: Hook into the type-checker pass**

Find the pass that walks alias/property tags after `resolveType`. For every `@jsonSchema` tag, call `validateJsonSchemaArg` on each argument and surface failures via the existing type-check error channel.

- [ ] **Step 5: Pass tests + add an end-to-end integration test**

Create `tests/agency/types/jsonschema-arg-restriction.agency` that uses a forbidden expression inside `@jsonSchema(...)` and asserts compilation fails. (Use the existing pattern in `tests/agency/` per `docs/misc/TESTING.md`.)

```
pnpm test:run lib/typeChecker 2>&1 | tee /tmp/task7-pass.log
pnpm run agency test tests/agency/types/jsonschema-arg-restriction.agency 2>&1 | tee /tmp/task7-int.log
```

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker/jsonSchemaArgValidator.ts lib/typeChecker/jsonSchemaArgValidator.test.ts tests/agency/types/jsonschema-arg-restriction.agency
git commit -m "feat(typeChecker): restrict @jsonSchema argument expressions"
```

---

## Task 8: Codegen — `.meta({...})` for `@jsonSchema`

**Files:**
- Modify: `lib/backends/typescriptGenerator/typeToZodSchema.ts`

- [ ] **Step 1: Failing fixture test**

Add `tests/typescriptGenerator/jsonSchema.test.ts` (or extend an existing fixture) asserting that

```agency
@jsonSchema({ format: "email", description: "work email" })
type WorkEmail = string
```

emits a Zod expression ending in `.meta({ format: "email", description: "work email" })`.

- [ ] **Step 2: Run, watch fail**

```
pnpm test:run tests/typescriptGenerator/jsonSchema 2>&1 | tee /tmp/task8-fail.log
```

- [ ] **Step 3: Add `appendMeta` helper and call it**

In `lib/backends/typescriptGenerator/typeToZodSchema.ts`, add:

```typescript
function appendMeta(schemaExpr: string, metaExpr: string | null): string {
  if (!metaExpr) return schemaExpr;
  return `${schemaExpr}.meta(${metaExpr})`;
}
```

In every code path that finishes building a Zod schema for a type or property, route the final string through `appendMeta`, passing the printed `@jsonSchema` argument (or `null` if no such tag). The printed argument is the use-site Expression printed by the existing expression printer — no transformation needed, since Zod consumes the object as-is at module load time.

Ensure the canonical chain order documented in the spec is preserved: `.meta()` is the absolute last `.` call. If any current call site appends `.nullable()` / `.optional()` / `.default()` *after* the type-construction call, restructure the local code so `.meta()` is appended *after* those, never before.

- [ ] **Step 4: Pass tests + visual fixture diff**

```
pnpm test:run tests/typescriptGenerator 2>&1 | tee /tmp/task8-pass.log
make fixtures   # rebuild integration fixtures so diffs are visible
git diff tests/typescriptGenerator/fixtures | head -200
```

Spot-check the diff: every type with `@jsonSchema` should grow a trailing `.meta(...)` and nothing else should change.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptGenerator/ tests/typescriptGenerator/
git commit -m "feat(codegen): emit .meta() for @jsonSchema tags"
```

---

## Task 9: Runtime helper `__validateChain`

**Files:**
- Create: `lib/runtime/validateChain.ts`
- Create: `lib/runtime/validateChain.test.ts`

The helper does what the spec pseudocode lays out: Zod parse, then thread the parsed value through a list of async validator functions in order, short-circuiting on the first `failure`. It also exposes a recursion-walker for nested types.

- [ ] **Step 1: Failing tests**

```typescript
// validateChain.test.ts
import { z } from "zod";
import { __validateChain } from "./validateChain.js";
import { success, failure, isFailure, isSuccess } from "./result.js";

const ctx = {}; // mock __ctx

it("passes Zod and runs validators in order", async () => {
  const isPos = async (_ctx: unknown, x: number) =>
    x > 0 ? success(x) : failure("must be positive");
  const isEven = async (_ctx: unknown, x: number) =>
    x % 2 === 0 ? success(x) : failure("must be even");
  const r = await __validateChain(4, z.number(), [isPos, isEven], ctx);
  expect(isSuccess(r)).toBe(true);
});

it("short-circuits on first failure", async () => {
  const isPos = async (_ctx: unknown, x: number) =>
    x > 0 ? success(x) : failure("not positive");
  const everCalled = vi.fn();
  const isEven = async (_ctx: unknown, x: number) => { everCalled(); return success(x); };
  const r = await __validateChain(-1, z.number(), [isPos, isEven], ctx);
  expect(isFailure(r)).toBe(true);
  expect(everCalled).not.toHaveBeenCalled();
});

it("threads transformed value through chain", async () => {
  const double = async (_ctx: unknown, x: number) => success(x * 2);
  const isFour = async (_ctx: unknown, x: number) =>
    x === 4 ? success(x) : failure("not 4");
  const r = await __validateChain(2, z.number(), [double, isFour], ctx);
  expect(isSuccess(r)).toBe(true);
});

it("returns Zod failure when structural parse fails", async () => {
  const r = await __validateChain("nope", z.number(), [], ctx);
  expect(isFailure(r)).toBe(true);
});

it("skips validators on null branch of a union", async () => {
  // delegated to recursion walker — see next task
});
```

- [ ] **Step 2: Run, watch fail**

```
pnpm test:run lib/runtime/validateChain 2>&1 | tee /tmp/task9-fail.log
```

- [ ] **Step 3: Implement**

```typescript
// lib/runtime/validateChain.ts
import { z } from "zod";
import { success, failure, isFailure, isSuccess } from "./result.js";
import type { ResultValue } from "./result.js";

export type AgencyValidator = (
  ctx: unknown,
  value: unknown,
) => Promise<ResultValue>;

export async function __validateChain(
  value: unknown,
  schema: z.ZodType,
  validators: AgencyValidator[],
  ctx: unknown,
): Promise<ResultValue> {
  if (isFailure(value)) return value as ResultValue;
  const zr = schema.safeParse(value);
  if (!zr.success) return failure(zr.error.message);

  let current: ResultValue = success(zr.data);
  for (const v of validators) {
    if (!isSuccess(current)) return current;
    current = await v(ctx, (current as { value: unknown }).value);
  }
  return current;
}
```

- [ ] **Step 4: Pass tests**

```
pnpm test:run lib/runtime/validateChain 2>&1 | tee /tmp/task9-pass.log
```

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/validateChain.ts lib/runtime/validateChain.test.ts
git commit -m "feat(runtime): __validateChain — async validator chain after Zod parse"
```

---

## Task 10: Recursion-walking helper for nested types

**Files:**
- Modify: `lib/runtime/validateChain.ts`
- Modify: `lib/runtime/validateChain.test.ts`

The walker traverses a value alongside a structural descriptor (built by the builder at codegen time) and runs the right validator chain at each depth. The structural descriptor mirrors the resolved type tree, carrying per-position validator lists. Depth-cap default 64.

- [ ] **Step 1: Decide descriptor shape**

A `TypeValidationDescriptor` is one of:

```typescript
type TypeValidationDescriptor =
  | { kind: "leaf"; schema: z.ZodType; validators: AgencyValidator[] }
  | { kind: "object"; schema: z.ZodType; validators: AgencyValidator[];
      properties: Record<string, TypeValidationDescriptor> }
  | { kind: "array"; schema: z.ZodType; validators: AgencyValidator[];
      element: TypeValidationDescriptor }
  | { kind: "union"; schema: z.ZodType; validators: AgencyValidator[];
      branches: Array<{ test: (v: unknown) => boolean; descriptor: TypeValidationDescriptor }> }
  | { kind: "nullable"; schema: z.ZodType; validators: AgencyValidator[];
      inner: TypeValidationDescriptor };
```

- [ ] **Step 2: Failing walker tests**

```typescript
it("runs per-element validators across an array", async () => { ... });
it("recurses into object properties", async () => { ... });
it("dispatches union to matching branch only", async () => { ... });
it("skips inner validators on null/undefined branch", async () => { ... });
it("enforces depth limit", async () => {
  const r = await __validateChainRecursive(deepNested, descriptor, ctx, { maxDepth: 3 });
  expect(isFailure(r)).toBe(true);
  expect((r as any).reason).toMatch(/recursion depth/);
});
```

- [ ] **Step 3: Implement**

Add `__validateChainRecursive(value, descriptor, ctx, opts?)` that walks `descriptor` and `value` in lockstep, calling `__validateChain` at each node for `descriptor.validators`, then recursing for arrays / objects / unions. Track `depth` and bail with `failure("validation recursion depth exceeded")` past `opts.maxDepth ?? 64`.

- [ ] **Step 4: Pass tests**

```
pnpm test:run lib/runtime/validateChain 2>&1 | tee /tmp/task10.log
```

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/validateChain.ts lib/runtime/validateChain.test.ts
git commit -m "feat(runtime): recursion walker for nested type validation"
```

---

## Task 11: Builder emits `__validateChain` / `__validateChainRecursive` for `!` sites

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (2 emit sites: function-param/return validation at line ~2130, assignment at ~2230)
- Modify: `lib/ir/builders.ts` (`__validateType` builder at line 401)
- Modify: `lib/backends/typescriptBuilder/pipeChainEmitter.ts` (pipe-return wrapper)

The decision rule:

- If the resolved type has **no** `@validate` tags anywhere (root or nested), emit the existing `__validateType(value, schema)` — zero behaviour change.
- Otherwise, build a `TypeValidationDescriptor` from the resolved type tree at codegen time and emit `await __validateChainRecursive(value, <descriptor>, __ctx)`.

The descriptor literal is a TypeScript expression — same machinery used to emit the Zod schema, with extra fields for the validator list. Use the IR builders to construct it.

- [ ] **Step 1: Failing integration test**

Add `tests/agency/types/validate-annotation.agency`:

```
import { isEmail } from "std::validators"

@validate(isEmail)
type Email = string

def main() {
  let bad: Email! = "not-an-email"
  print(bad)
}
```

(Without `std::validators` ready yet, inline a local `def isEmail(...) {...}` for this first test.) Assert the run produces a validation failure, not a success.

- [ ] **Step 2: Run, watch fail**

```
pnpm run agency test tests/agency/types/validate-annotation.agency 2>&1 | tee /tmp/task11-fail.log
```

- [ ] **Step 3: Plumb tag detection**

At each `!` emit site, walk the resolved type to check if any node carries `@validate`. Helper:

```typescript
function hasAnyValidateTag(t: VariableType): boolean {
  if (t.tags?.some((tag) => tag.name === "validate")) return true;
  switch (t.type) {
    case "arrayType": return hasAnyValidateTag(t.elementType);
    case "objectType": return t.properties.some((p) =>
      p.tags?.some((tag) => tag.name === "validate") || hasAnyValidateTag(p.value));
    case "unionType": return t.types.some(hasAnyValidateTag);
    // ... etc, mirroring substituteTypeParams enumeration
    default: return false;
  }
}
```

- [ ] **Step 4: Emit the descriptor**

A new function `buildValidationDescriptor(type: VariableType): TsExpression` that mirrors `typeToZodSchema` but emits the descriptor object instead. Reuse the existing schema-emit code for the `schema` field of each descriptor node.

Tag arguments inside `@validate(...)` are printed as raw expressions (function references / function-call factories). The resulting validator list expression looks like `[isEmail, min(0), max(150)]`.

- [ ] **Step 5: Replace `__validateType` call at each emit site**

For each site found earlier:

```typescript
// before
__validateType(value, ZodSchema)

// after
hasAnyValidateTag(resolvedType)
  ? `await __validateChainRecursive(${value}, ${descriptorExpr}, __ctx)`
  : `__validateType(${value}, ${zodSchemaExpr})`
```

The expression is now async — propagate the `await` to the surrounding emitted function. All `!` sites should already be inside async-generated functions (Agency functions compile to async), but verify.

- [ ] **Step 6: Pass tests**

```
pnpm test:run 2>&1 | tee /tmp/task11-pass.log
pnpm run agency test tests/agency/types/validate-annotation.agency 2>&1 | tee /tmp/task11-int.log
```

- [ ] **Step 7: Commit**

```bash
git add lib/backends/ lib/ir/ tests/agency/types/
git commit -m "feat(codegen): wire __validateChain into !-validated emit sites"
```

---

## Task 12: Stdlib — `std::validators`

**Files:**
- Create: `stdlib/validators.agency`
- Create: `stdlib/validators.js`

- [ ] **Step 1: Write the Agency surface**

```
// stdlib/validators.agency
import { Result } from "agency"

export def isEmail(x: string): Result { ... }
export def isUrl(x: string): Result { ... }
export def isUuid(x: string): Result { ... }
export def isInt(x: number): Result { ... }
export def isPositive(x: number): Result { ... }
export def isNegative(x: number): Result { ... }
export def min(n: number): function { ... }
export def max(n: number): function { ... }
export def minLength(n: number): function { ... }
export def maxLength(n: number): function { ... }
export def matches(re: string): function { ... }
```

Match the existing stdlib style (cross-reference `stdlib/email.agency` and `stdlib/math.agency` for conventions).

- [ ] **Step 2: Write the JS implementations**

```javascript
// stdlib/validators.js
// Each function is async (Agency surface) and returns success(value) or failure(reason).
export async function isEmail(_ctx, x) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)
    ? { kind: "success", value: x }
    : { kind: "failure", reason: `not a valid email: ${x}` };
}
// ... etc
```

(Use the canonical `success` / `failure` helpers from `lib/runtime/result.js` so shapes match exactly.)

- [ ] **Step 3: Build**

```
make 2>&1 | tee /tmp/task12-make.log
```

Per CLAUDE.md: `make` is required after stdlib changes.

- [ ] **Step 4: Write integration tests**

`tests/agency/stdlib/validators.agency` — one assertion per validator, exercising both success and failure paths.

- [ ] **Step 5: Run**

```
pnpm run agency test tests/agency/stdlib/validators.agency 2>&1 | tee /tmp/task12-test.log
```

- [ ] **Step 6: Commit**

```bash
git add stdlib/validators.agency stdlib/validators.js tests/agency/stdlib/validators.agency
git commit -m "feat(stdlib): add std::validators module"
```

---

## Task 13: Stdlib — `std::schemas`

**Files:**
- Create: `stdlib/schemas.agency`
- Create: `stdlib/schemas.js`

Format helpers only (per spec — trivial 1:1 helpers were dropped).

- [ ] **Step 1: Author**

```
// stdlib/schemas.agency
export const emailFormat = { format: "email" }
export const urlFormat = { format: "uri" }
export const uuidFormat = { format: "uuid" }
export const dateTimeFormat = { format: "date-time" }
export const dateFormat = { format: "date" }
export const ipv4Format = { format: "ipv4" }
export const ipv6Format = { format: "ipv6" }
```

```javascript
// stdlib/schemas.js
export const emailFormat = { format: "email" };
// ... etc
```

- [ ] **Step 2: Build**

```
make 2>&1 | tee /tmp/task13-make.log
```

- [ ] **Step 3: Smoke-test import + use in `@jsonSchema`**

`tests/agency/stdlib/schemas.agency` imports the helpers and uses them in `@jsonSchema({ ...emailFormat })`; assert the generated TS contains `.meta({ format: "email" })`.

- [ ] **Step 4: Commit**

```bash
git add stdlib/schemas.agency stdlib/schemas.js tests/agency/stdlib/schemas.agency
git commit -m "feat(stdlib): add std::schemas module"
```

---

## Task 14: Stdlib — `std::types` (pre-baked validated aliases)

**Files:**
- Create: `stdlib/types.agency`
- Create: `stdlib/types.js`

- [ ] **Step 1: Author**

```
// stdlib/types.agency
import { isEmail, isUrl, isUuid } from "std::validators"
import { emailFormat, urlFormat, uuidFormat } from "std::schemas"

@validate(isEmail)
@jsonSchema({ ...emailFormat })
export type Email = string

@validate(isUrl)
@jsonSchema({ ...urlFormat })
export type URL = string

@validate(isUuid)
@jsonSchema({ ...uuidFormat })
export type UUID = string
```

The `.js` companion may be empty (pure type re-exports).

- [ ] **Step 2: Build**

```
make 2>&1 | tee /tmp/task14-make.log
```

- [ ] **Step 3: Integration test**

`tests/agency/stdlib/types.agency`:

```
import { Email } from "std::types"

def main() {
  let bad: Email! = "not-email"
  print(bad)
}
```

Assert run produces a validation failure.

- [ ] **Step 4: Run**

```
pnpm run agency test tests/agency/stdlib/types.agency 2>&1 | tee /tmp/task14-test.log
```

- [ ] **Step 5: Commit**

```bash
git add stdlib/types.agency stdlib/types.js tests/agency/stdlib/types.agency
git commit -m "feat(stdlib): add std::types with pre-baked Email/URL/UUID"
```

---

## Task 15: Round-trip tags through `agencyGenerator`

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/utils/formatType.ts` if it emits aliases/properties

`pnpm run fmt foo.agency` must re-emit `@validate(...)` and `@jsonSchema(...)` annotations above the alias/property they belong to. Without this, the formatter silently drops them.

- [ ] **Step 1: Failing test**

`tests/agencyGenerator/tags.test.ts`:

```typescript
it("round-trips @validate on a type alias", () => {
  const src = '@validate(isEmail)\ntype Email = string';
  const ast = parse(src);
  const out = generate(ast);
  expect(out).toContain("@validate(isEmail)");
  expect(out).toContain("type Email = string");
});

it("round-trips @jsonSchema and @validate on a property", () => { ... });
```

- [ ] **Step 2: Run, watch fail**

```
pnpm test:run tests/agencyGenerator 2>&1 | tee /tmp/task15-fail.log
```

- [ ] **Step 3: Emit tag prefix in alias and property emitters**

In `lib/backends/agencyGenerator.ts`, find the alias-emission and property-emission functions, and emit a `tagToString(tag)` line before each, where `tagToString` uses the existing expression printer for the arguments.

- [ ] **Step 4: Pass tests**

```
pnpm test:run tests/agencyGenerator 2>&1 | tee /tmp/task15-pass.log
```

- [ ] **Step 5: Commit**

```bash
git add lib/backends/agencyGenerator.ts lib/utils/formatType.ts tests/agencyGenerator/tags.test.ts
git commit -m "feat(generator): round-trip @validate/@jsonSchema tags"
```

---

## Task 16: End-to-end test matrix

**Files:**
- Create: `tests/agency/types/annotations/` directory

Per spec, exercise every behaviour with one Agency test each. None of these tests requires an LLM call (per CLAUDE.md guidance on `tests/agency/`).

- [ ] **Step 1: Author**

For each, follow the pattern in `tests/agency/types/`. Tests:

| File | Scenario |
|------|----------|
| `validate-alias-passes.agency` | `@validate` on alias, `!` validation succeeds for valid input |
| `validate-alias-fails.agency` | Same, fails for invalid input with the expected `failure` reason |
| `validate-property.agency` | `@validate` on a single property of an object type |
| `validate-multiple-fns.agency` | `@validate(a, b, c)` runs in order, transform threads through |
| `validate-short-circuits.agency` | First failure stops the chain; later validators don't run |
| `validate-merges-alias-and-property.agency` | Alias `@validate(a)` + property `@validate(b)` = `[a, b]` |
| `validate-nested-array.agency` | Per-element validation across an array |
| `validate-nested-object.agency` | Validation recurses into nested objects |
| `validate-union-branch.agency` | Only matching union branch's validators run |
| `validate-nullable-skips.agency` | `null` / `undefined` skips inner validators |
| `validate-recursion-cap.agency` | Pathological deep input fails with depth-exceeded |
| `jsonschema-on-alias.agency` | `.meta()` appears in generated TS |
| `jsonschema-merge.agency` | Property `@jsonSchema` overrides alias's same keys, inherits unset |
| `validate-only-runs-with-bang.agency` | Without `!`, validators do NOT run |
| `validate-generic-instantiation.agency` | `@validate(nonEmpty) type NonEmptyArray<T> = T[]` validates outer at every instantiation |

- [ ] **Step 2: Run them all and save**

```
pnpm test:run tests/agency/types/annotations 2>&1 | tee /tmp/task16-tests.log
```

Per CLAUDE.md: save the output to a file so you don't have to re-run if any fail.

- [ ] **Step 3: Triage failures**

For any failing test, attribute to one of the earlier tasks and patch there, not in the test. (The tests should pass as a consequence of correct code, not by adjusting expectations.)

- [ ] **Step 4: Commit**

```bash
git add tests/agency/types/annotations/
git commit -m "test: end-to-end coverage for @validate and @jsonSchema annotations"
```

---

## Task 17: User-facing docs

**Files:**
- Create: `docs/site/guide/annotations.md`
- Modify: `docs/site/guide/types.md` — cross-link to the new doc
- Modify: `docs/site/.vitepress/config.mts` — add the new page to nav

- [ ] **Step 1: Write `annotations.md`**

Cover, in this order:

1. The two annotations (`@validate`, `@jsonSchema`).
2. When validation runs (only with `!`, link to the schemas page).
3. Stdlib quick reference: `std::validators`, `std::schemas`, `std::types`.
4. Merge / override rules with a worked example.
5. Behaviour on nested types, unions, nullables, and recursion.
6. The "supported JSON Schema keywords" reference table (numeric / length / array constraints + link to the JSON Schema spec).
7. Restrictions on `@jsonSchema` argument expressions (and why).

- [ ] **Step 2: Wire into nav**

In [docs/site/.vitepress/config.mts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/docs/site/.vitepress/config.mts), add an entry for the new page under the Guide section.

- [ ] **Step 3: Cross-link from `types.md`**

Add a short "Validation and JSON Schema annotations → [annotations.md](annotations.md)" callout in the appropriate section of `types.md`.

- [ ] **Step 4: Build the docs locally**

If `docs:dev` is wired:

```
pnpm --filter agency-lang docs:dev   # or whatever the script is
```

Visually confirm the new page renders and links resolve. (No automated test; eyeball.)

- [ ] **Step 5: Commit**

```bash
git add docs/site/guide/annotations.md docs/site/guide/types.md docs/site/.vitepress/config.mts
git commit -m "docs: add annotations guide for @validate and @jsonSchema"
```

---

## Task 18: Run the structural linter + full validation pass

**Files:** none (verification only).

- [ ] **Step 1: Structural linter**

```
pnpm run lint:structure 2>&1 | tee /tmp/lint.log
```

Expected: clean. Fix any flagged patterns introduced by this work.

- [ ] **Step 2: Full test suite**

```
pnpm test:run 2>&1 | tee /tmp/full-tests.log
```

Expected: all green. Per CLAUDE.md, save output to file — do not re-run blindly if anything fails.

- [ ] **Step 3: Fixtures refresh**

```
make fixtures 2>&1 | tee /tmp/fixtures.log
git diff tests/typescriptGenerator/fixtures | wc -l
```

Confirm fixture diffs are bounded to what this work changed (`.meta(...)` additions where `@jsonSchema` appears, async wrappers at new `!` sites where `@validate` appears). No drive-by changes.

- [ ] **Step 4: Build**

```
make 2>&1 | tee /tmp/make.log
```

- [ ] **Step 5: Commit any fixture updates**

```bash
git add tests/typescriptGenerator/fixtures
git commit -m "test: refresh fixtures for annotation codegen"
```

---

## Fast-Follow PR (separate from this plan)

After this plan lands and is exercised in the wild for at least one merge cycle:

1. Codemod every `# description` in `lib/`, `stdlib/`, `examples/`, `tests/`, `docs/` to `@jsonSchema({ description: "..." })`.
2. Remove `objectPropertyDescriptionParser` and `objectPropertyWithDescriptionParser` from `lib/parsers/parsers.ts`.
3. Remove the `description?: string` field from `ObjectProperty` in `lib/types/typeHints.ts`.
4. Remove the `.describe("...")` codegen path in `lib/backends/typescriptGenerator/typeToZodSchema.ts`.
5. During the brief overlap window (after this plan, before the fast follow): mixing `# description` and `@jsonSchema({description: ...})` on the same property is a parse-time error.

This is a separate plan document and a separate PR; do not bundle.

---

## Plan Review Loop

Once this plan is saved, the next step (per the writing-plans skill) is to dispatch a single plan-document-reviewer subagent with the plan + spec as inputs, iterate to "✅ Approved", and then choose an execution mode (subagent-driven recommended).
