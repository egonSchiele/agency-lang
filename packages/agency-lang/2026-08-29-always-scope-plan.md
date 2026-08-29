# `@always` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every stdlib effect declares, on its own `effect` declaration, which payload fields an "approve always here" rule pins, and `std::policy` reads that declaration at runtime instead of a table inside the agency agent.

**Architecture:** A tag on the effect declaration (`@always(name)`, `@alwaysUnder(dir)`) is read by the typechecker (validation) and by codegen, which emits one registration call per tagged declaration at module JS-load. The runtime keeps a process-wide effect-to-fields registry. `std::policy` consults the registry when its caller passes no `fields:`, and escapes literal values before writing a rule.

**Tech Stack:** TypeScript (compiler, runtime), Agency (stdlib, tests), vitest, the Agency test runner (`pnpm run agency test`).

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/2026-08-29-always-scope-spec.md`

## Global Constraints

- Follow `docs/dev/contributing/coding-standards.md` and `docs/dev/contributing/anti-patterns.md`. Objects not maps, arrays not sets (except where the touched file already uses one), `type` not `interface`, no dynamic imports.
- Never commit on `main`. Work on a branch in a worktree under the agency-lang directory, for example `/Users/adityabhargava/agency-lang/worktree-always-scope` on branch `adit/always-scope`.
- Commit messages go in a file and are passed with `git commit -F <file>`; apostrophes on the command line fail.
- `make` rebuilds everything, including stdlib and templates. Run it once after Tasks 3 and 4 (template and runtime changes) and once at the end. Do not re-run it between unrelated edits.
- Run only the tests that cover changed files, and save output to a file in the scratchpad so a failure does not need a re-run: `pnpm vitest run <path> > <scratch>/<name>.log 2>&1`.
- Do not run the full Agency test suite locally. Run single Agency tests with `pnpm run agency test <file>`.
- Before the PR: `pnpm run typecheck` (three configs; bare `tsc` misses test files), `pnpm run fmt:ts`, `pnpm run lint:structure`, and `pnpm vitest run lib/sourceIsText.test.ts`.
- Never edit `CHANGELOG.md` or anything under `docs/site/`.
- Open the PR and stop. The owner merges.

## Two spec adjustments

1. **Tag syntax.** Tag arguments reject bare function calls
   (`lib/parsers/parsers.ts:2774`, `_identOrPfaParser`, on purpose), so the
   spec's `@always(subpaths(dir))` does not parse. Use two tag names:
   - `@always(f1, f2)`: pin each field to its exact value.
   - `@alwaysUnder(d1, d2)`: pin each field to the value and its subpaths
     (today's `matchSubpaths: true`).
   Both may appear on one declaration. Each argument must be a bare
   identifier.
2. **Registration site.** Registration calls are emitted at module JS-load
   next to `__registerStaticInit(...)`, not inside `__initializeStatic`.
   JS-load runs on import, before any handler exists, and needs no runtime
   context.

The spec file is updated for both in Task 0.

## Two facts the spec did not know

1. **`std::readBinary` and `std::writeBinary` are raised but never declared.**
   `stdlib/index.agency:293` and `:261` raise them; no file has an `effect`
   line for either. A scope lives on the declaration, so Task 7 adds the two
   declarations next to `std::read` in `stdlib/index.agency`. Side effect:
   the typechecker starts checking those two raise sites against a payload,
   which is what every other stdlib effect already gets.
2. **The registry is per process, and interrupts cross processes.** Code run
   through `std::agency` `run`, `runFile`, or `testFile` executes in a
   subprocess, and every interrupt it raises is forwarded to the parent's
   handlers (`lib/runtime/interrupts.ts:471`, `sendInterruptToParent`).
   `std::toolbox` uses `runFile` and `testFile`. If the parent never
   imported the module that declares the effect, its registry has no scope
   for it and the prompt would silently drop "approve always here". Task 3b
   sends the scope with the interrupt so the parent registers it on receipt.

## File map

| File | Responsibility |
|---|---|
| `lib/utils/alwaysTag.ts` (new) | Read `@always`/`@alwaysUnder` off a declaration's tags into `ScopedField[]`, reporting malformed arguments. Shared by typechecker and codegen. |
| `lib/typeChecker/effectPayloadCheck.ts` | Validate the tags against the payload and across duplicate declarations. |
| `lib/typeChecker/diagnostics.ts` | New diagnostic entries. |
| `lib/runtime/alwaysScope.ts` (new) | The registry: `__registerAlwaysScope`, `alwaysScopeFor`, `allAlwaysScopes`, plus the `ScopedField` type. |
| `lib/runtime/index.ts` | Export the registry. |
| `lib/runtime/ipc.ts` | `IpcInterruptMessage` carries the effect's scope; the parent registers it before running its handlers. |
| `lib/typeChecker/diagnosticExplanations.ts` | One `agency explain` entry per new diagnostic (a test enforces this). |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | Generated code imports `__registerAlwaysScope`. |
| `lib/backends/typescriptBuilder.ts`, `lib/backends/typescriptBuilder/sectionAssembler.ts` | Emit one registration call per tagged declaration. |
| `lib/runtime/policy.ts` | `escapeGlob` moves here from `builtinPolicies.ts`. |
| `lib/stdlib/policy.ts` | Re-export the registry read and `escapeGlob` for `std::policy`. |
| `stdlib/policy.agency` | `alwaysScopeFor`, `defaultScopedFields`, registry fallback in `buildScopedMatch`/`askUser`, escaping, no "always" for value-expecting interrupts. |
| `stdlib/**/*.agency` with `effect` declarations | One tag line per effect in the spec's table. |
| `stdlib/system.agency` | `host` on `std::openUrl`. |
| `stdlib/index.agency` | Declare `std::readBinary` and `std::writeBinary`, which are raised but undeclared today. |
| `lib/agents/agency-agent/lib/config.agency`, `lib/turn.agency` | Delete `ALWAYS_FIELDS`. |
| `docs/dev/agents/approval-policies.md`, `docs/dev/language/effect-always-tag.md` (new) | Dev notes. |

---

### Task 0: Branch, worktree, and spec adjustments

**Files:**
- Modify: `2026-08-29-always-scope-spec.md`

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/adityabhargava/agency-lang
git worktree add worktree-always-scope -b adit/always-scope main
cd worktree-always-scope/packages/agency-lang
pnpm install --frozen-lockfile
```

- [ ] **Step 2: Copy the spec and plan into the worktree**

The spec and plan are untracked files in the main checkout. Copy them (do not move them; the main checkout is the owner's).

```bash
cp /Users/adityabhargava/agency-lang/packages/agency-lang/2026-08-29-always-scope-spec.md .
cp /Users/adityabhargava/agency-lang/packages/agency-lang/2026-08-29-always-scope-plan.md .
```

- [ ] **Step 3: Patch the spec's syntax section**

In §5.1 replace the four-example block and the "Each argument is one of" list with:

```
@always(name)
effect std::env { name: string }

@always(command, cwd)
effect std::bash { command: string, cwd: string, timeout: number, stdin: string }

@alwaysUnder(dir)
effect std::read { dir: string, filename: string, offset: number, limit: number }

@alwaysUnder(src, dest)
effect std::copy { src: string, dest: string }
```

Each argument is a bare identifier naming a payload field. `@always` pins
the exact value; `@alwaysUnder` pins the value and everything under it
(the existing `matchSubpaths: true` behaviour). A declaration may carry
both tags. Tag arguments cannot be function calls (the tag parser rejects
them on purpose), which is why there are two tag names and not
`subpaths(dir)`.

Also in §5.1's typechecker rules, change "at most one `@always` per declaration" to "at most one of each tag per declaration", and in §5.6 replace every `subpaths(x)` with `@alwaysUnder(x)` and every bare list with `@always(...)`.

In §5.2, change "in the same position statics run" to "at module JS-load, next to `__registerStaticInit`".

- [ ] **Step 4: Commit**

```bash
git add 2026-08-29-always-scope-spec.md 2026-08-29-always-scope-plan.md
printf 'Add the @always scope spec and plan\n' > /tmp/msg.txt
git commit -F /tmp/msg.txt
```

(Use the scratchpad path for the message file if `/tmp` is off limits in your session.)

---

### Task 1: Read the tags (`lib/utils/alwaysTag.ts`)

**Files:**
- Create: `lib/utils/alwaysTag.ts`
- Test: `lib/utils/alwaysTag.test.ts`

**Interfaces:**
- Consumes: `Tag` from `lib/types/tag.ts` (`{ name: string; arguments: Expression[] }`), `VariableNameLiteral` from `lib/types/literals.ts` (`{ type: "variableName"; value: string }`).
- Produces:
  ```ts
  export const ALWAYS_TAG = "always";
  export const ALWAYS_UNDER_TAG = "alwaysUnder";
  export type AlwaysProblemKind = "badArgument" | "repeatedTag" | "namedTwice";
  export type AlwaysTagProblem = { kind: AlwaysProblemKind; tag: string; loc: Tag["loc"] };
  export type AlwaysScope = { fields: ScopedField[]; problems: AlwaysTagProblem[] };
  export function readAlwaysScope(tags?: Tag[]): AlwaysScope;
  export function isAlwaysTag(tag: Tag): boolean;
  export function hasAlwaysScope(tags?: Tag[]): boolean;
  ```
  `ScopedField` is imported (type only) from `lib/runtime/alwaysScope.ts`, which Task 3 creates; write the runtime type first if you do Task 1 before Task 3. The compiler already imports from the runtime elsewhere (`lib/backends/typescriptBuilder.ts`), so this is the existing pattern, not a new dependency direction.

  `fields` lists `@always` arguments first, then `@alwaysUnder`, in source order. A field named in both tags is a `namedTwice` problem; no merging, because the typechecker rejects the program anyway. `hasAlwaysScope` is true when any always-tag is present, tagged or not well-formed; Task 2 uses it to tell "untagged declaration" from "tagged with empty scope".

- [ ] **Step 1: Write the failing test**

```ts
// lib/utils/alwaysTag.test.ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { TypescriptPreprocessor } from "../preprocessors/typescriptPreprocessor.js";
import { readAlwaysScope } from "./alwaysTag.js";
import type { EffectDeclaration } from "../types/effectDeclaration.js";

/** Parse one source string and return its first effect declaration with
 *  tags attached the way the compiler sees them. `attachTags()` is the
 *  public tag-attachment step (`typescriptPreprocessor.ts:203`); the doc
 *  generator uses it the same way. The full `preprocess()` needs a
 *  compilation unit and is not required here. */
function declOf(src: string): EffectDeclaration {
  const parsed = parseAgency(src);
  if (!parsed.success) {
    throw new Error(parsed.message);
  }
  const pre = new TypescriptPreprocessor(parsed.result);
  pre.attachTags();
  const decl = parsed.result.nodes.find((n) => n.type === "effectDeclaration");
  if (!decl) throw new Error("no effect declaration");
  return decl as EffectDeclaration;
}

describe("readAlwaysScope", () => {
  it("returns no fields for an untagged declaration", () => {
    const scope = readAlwaysScope(declOf("effect app::x { a: string }").tags);
    expect(scope).toEqual({ fields: [], problems: [] });
  });

  it("reads exact fields from @always", () => {
    const scope = readAlwaysScope(
      declOf("@always(command, cwd)\neffect app::x { command: string, cwd: string }").tags,
    );
    expect(scope.fields).toEqual([
      { field: "command", matchSubpaths: false },
      { field: "cwd", matchSubpaths: false },
    ]);
    expect(scope.problems).toEqual([]);
  });

  it("reads subpath fields from @alwaysUnder", () => {
    const scope = readAlwaysScope(
      declOf("@alwaysUnder(dir)\neffect app::x { dir: string }").tags,
    );
    expect(scope.fields).toEqual([{ field: "dir", matchSubpaths: true }]);
  });

  it("combines both tags, exact first", () => {
    const scope = readAlwaysScope(
      declOf("@always(name)\n@alwaysUnder(dir)\neffect app::x { name: string, dir: string }").tags,
    );
    expect(scope.fields.map((field) => field.field)).toEqual(["name", "dir"]);
  });

  it("reports a non-identifier argument", () => {
    const scope = readAlwaysScope(
      declOf('@always("name")\neffect app::x { name: string }').tags,
    );
    expect(scope.fields).toEqual([]);
    expect(scope.problems.map((problem) => problem.kind)).toEqual(["badArgument"]);
  });

  it("reports a repeated tag", () => {
    const scope = readAlwaysScope(
      declOf("@always(a)\n@always(b)\neffect app::x { a: string, b: string }").tags,
    );
    expect(scope.problems.map((problem) => problem.kind)).toEqual(["repeatedTag"]);
  });

  it("reports a field named in both tags", () => {
    const scope = readAlwaysScope(
      declOf("@always(dir)\n@alwaysUnder(dir)\neffect app::x { dir: string }").tags,
    );
    // One problem per tag that names the field, so both tags get a location.
    expect(scope.problems.map((problem) => problem.kind)).toEqual(["namedTwice", "namedTwice"]);
  });

  it("reports a field named twice in one tag", () => {
    const scope = readAlwaysScope(declOf("@always(a, a)\neffect app::x { a: string }").tags);
    expect(scope.problems.map((problem) => problem.kind)).toEqual(["namedTwice"]);
  });

  it("treats an empty tag as a tagged declaration with no fields", () => {
    const tags = declOf("@always()\neffect app::x { a: string }").tags;
    expect(readAlwaysScope(tags)).toEqual({ fields: [], problems: [] });
    expect(hasAlwaysScope(tags)).toBe(true);
  });

  it("ignores unrelated tags", () => {
    const tags = declOf("@hidden\n@always(a)\neffect app::x { a: string }").tags;
    expect(readAlwaysScope(tags).fields).toEqual([{ field: "a", matchSubpaths: false }]);
    expect(hasAlwaysScope(declOf("@hidden\neffect app::y { a: string }").tags)).toBe(false);
  });
});
```

Import `hasAlwaysScope` alongside `readAlwaysScope`.

`attachTags()` mutates `program.nodes` in place, which is why the test reads `parsed.result.nodes` after calling it. If the constructor signature differs from `(program, config?, info?)` (`typescriptPreprocessor.ts:187`), match it.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run lib/utils/alwaysTag.test.ts > $SCRATCH/t1.log 2>&1; tail -20 $SCRATCH/t1.log`
Expected: fails with "Cannot find module './alwaysTag.js'".

- [ ] **Step 3: Write the implementation**

```ts
// lib/utils/alwaysTag.ts
import type { Tag } from "../types/tag.js";
import type { Expression } from "../types.js";
import type { ScopedField } from "../runtime/alwaysScope.js";

/** `@always(f1, f2)` and `@alwaysUnder(d1, d2)` on an effect declaration
 *  name the payload fields an "approve always here" policy rule pins.
 *  `@always` pins the exact value; `@alwaysUnder` pins the value and every
 *  subpath under it. See docs/dev/language/effect-always-tag.md. */
export const ALWAYS_TAG = "always";
export const ALWAYS_UNDER_TAG = "alwaysUnder";

export type AlwaysProblemKind = "badArgument" | "repeatedTag" | "namedTwice";
export type AlwaysTagProblem = { kind: AlwaysProblemKind; tag: string; loc: Tag["loc"] };
export type AlwaysScope = { fields: ScopedField[]; problems: AlwaysTagProblem[] };

export function isAlwaysTag(tag: Tag): boolean {
  return tag.name === ALWAYS_TAG || tag.name === ALWAYS_UNDER_TAG;
}

export function hasAlwaysScope(tags: Tag[] = []): boolean {
  return tags.some(isAlwaysTag);
}

function isIdentifier(argument: Expression): boolean {
  return argument.type === "variableName";
}

/** The field names a tag's arguments name. Non-identifier arguments are
 *  dropped here and reported by `readAlwaysScope`. */
function fieldNames(tag: Tag): string[] {
  return tag.arguments.filter(isIdentifier).map((argument) => (argument as { value: string }).value);
}

function problem(kind: AlwaysProblemKind, tag: Tag): AlwaysTagProblem {
  return { kind, tag: tag.name, loc: tag.loc };
}

function hasNonIdentifierArgument(tag: Tag): boolean {
  return !tag.arguments.every(isIdentifier);
}

function countOf(name: string, names: string[]): number {
  return names.filter((other) => other === name).length;
}

export function readAlwaysScope(tags: Tag[] = []): AlwaysScope {
  const exactTags = tags.filter((tag) => tag.name === ALWAYS_TAG);
  const underTags = tags.filter((tag) => tag.name === ALWAYS_UNDER_TAG);
  const alwaysTags = [...exactTags, ...underTags];
  const exactNames = exactTags.flatMap(fieldNames);
  const underNames = underTags.flatMap(fieldNames);
  const allNames = [...exactNames, ...underNames];

  const fields: ScopedField[] = [
    ...exactNames.map((field) => ({ field, matchSubpaths: false })),
    ...underNames.map((field) => ({ field, matchSubpaths: true })),
  ];

  const badArgument = alwaysTags
    .filter(hasNonIdentifierArgument)
    .map((tag) => problem("badArgument", tag));
  const repeatedTag = [exactTags, underTags]
    .filter((group) => group.length > 1)
    .map((group) => problem("repeatedTag", group[1]));
  const namedTwice = alwaysTags
    .filter((tag) => fieldNames(tag).some((name) => countOf(name, allNames) > 1))
    .map((tag) => problem("namedTwice", tag));

  return { fields, problems: [...badArgument, ...repeatedTag, ...namedTwice] };
}
```

Each output is a derivation from the two tag lists; nothing is mutated after it is built, and there is no sort because the concatenation order is the documented order. A field named in both tags yields one `namedTwice` problem per tag that names it, so each tag gets its own diagnostic location.

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run lib/utils/alwaysTag.test.ts > $SCRATCH/t1.log 2>&1; tail -20 $SCRATCH/t1.log`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add lib/utils/alwaysTag.ts lib/utils/alwaysTag.test.ts
printf 'Read @always and @alwaysUnder tags off effect declarations\n' > $SCRATCH/msg.txt
git commit -F $SCRATCH/msg.txt
```

---

### Task 2: Typechecker validation

**Files:**
- Modify: `lib/typeChecker/diagnostics.ts` (after `effectPayloadConflict`, around line 358)
- Modify: `lib/typeChecker/diagnosticExplanations.ts` (one entry per new diagnostic)
- Modify: `lib/typeChecker/effectPayloadCheck.ts` (`buildEffectRegistry`, around line 48)
- Test: `lib/typeChecker/effectPayloadCheck.test.ts`, `lib/typeChecker/diagnosticExplanations.test.ts` (existing, must stay green)

**Interfaces:**
- Consumes: `readAlwaysScope`, `isAlwaysTag` from Task 1.
- Produces: diagnostics `alwaysUnknownField`, `alwaysBadArgument`, `alwaysRepeatedTag`, `alwaysScopeConflict`, `alwaysStrayTag`. Later tasks rely on the guarantee that a program that typechecks has well-formed scopes, so codegen does no validation of its own.

- [ ] **Step 1: Write the failing tests**

Append to `lib/typeChecker/effectPayloadCheck.test.ts`:

```ts
describe("@always scope checking", () => {
  const messagesOf = (src: string) => typecheckSource(src).map((e) => e.message);

  it("accepts fields that exist in the payload", () => {
    const msgs = messagesOf(
      "@always(name)\n@alwaysUnder(dir)\neffect app::x { name: string, dir: string }",
    );
    expect(msgs.filter((m) => /@always/.test(m))).toEqual([]);
  });

  it("errors on a field the payload does not have", () => {
    const msgs = messagesOf("@always(nam)\neffect app::x { name: string }");
    expect(msgs.find((m) => /@always names 'nam', which effect 'app::x' does not carry/.test(m))).toBeDefined();
  });

  it("errors on a non-identifier argument", () => {
    const msgs = messagesOf('@always("name")\neffect app::x { name: string }');
    expect(msgs.find((m) => /@always arguments must be bare field names/.test(m))).toBeDefined();
  });

  it("errors on a repeated tag", () => {
    const msgs = messagesOf("@always(a)\n@always(b)\neffect app::x { a: string, b: string }");
    expect(msgs.find((m) => /@always appears more than once/.test(m))).toBeDefined();
  });

  it("errors when two declarations of one effect disagree on scope", () => {
    const msgs = messagesOf(
      "@always(a)\neffect app::x { a: string, b: string }\n" +
        "@always(b)\neffect app::x { a: string, b: string }",
    );
    expect(msgs.find((m) => /Conflicting @always scopes for effect 'app::x'/.test(m))).toBeDefined();
  });

  it("accepts two declarations that agree", () => {
    const msgs = messagesOf(
      "@always(a)\neffect app::x { a: string }\n@always(a)\neffect app::x { a: string }",
    );
    expect(msgs.filter((m) => /@always/.test(m))).toEqual([]);
  });

  it("errors on an @always tag that attached to a function", () => {
    const msgs = messagesOf("@always(x)\ndef f(x: string): string { return x }");
    expect(msgs.find((m) => /@always is only valid on an effect declaration/.test(m))).toBeDefined();
  });

  it("errors on an @always tag that attached to nothing", () => {
    // A tag above an import has no attach target and stays a standalone
    // `tag` node (typescriptPreprocessor.ts:129).
    const msgs = messagesOf('@always(x)\nimport { cwd } from "std::system"\neffect app::x { x: string }');
    expect(msgs.filter((m) => /@always is only valid on an effect declaration/.test(m))).toHaveLength(1);
  });

  it("treats the same fields in a different order as the same scope", () => {
    // Pins the order-insensitive compare. The runtime uses the same
    // function, so codegen output order can never matter.
    const msgs = messagesOf(
      "@always(a, b)\neffect app::x { a: string, b: string }\n" +
        "@always(b, a)\neffect app::x { a: string, b: string }",
    );
    expect(msgs.filter((m) => /Conflicting @always scopes/.test(m))).toEqual([]);
  });

  it("lets an untagged redeclaration inherit the tagged scope", () => {
    // The guide (docs/site/guide/effects.md, Payload types) shows a user
    // program declaring `effect std::read { dir: string, filename: string }`
    // with no tag. The stdlib copy is tagged. That must stay legal.
    const msgs = messagesOf("effect std::read { dir: string, filename: string }");
    expect(msgs.filter((m) => /@always/.test(m))).toEqual([]);
  });

  it("still rejects a tagged redeclaration that disagrees", () => {
    const msgs = messagesOf("@always(filename)\neffect std::read { dir: string, filename: string }");
    expect(msgs.find((m) => /Conflicting @always scopes for effect 'std::read'/.test(m))).toBeDefined();
  });
});
```

Note: the "conflict" test declares the same effect twice in one file, which also fires `effectDeclaredTwice`. That is fine; the assertion only looks for the scope conflict message.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run lib/typeChecker/effectPayloadCheck.test.ts > $SCRATCH/t2.log 2>&1; grep -E "✓|✗|×|passed|failed" $SCRATCH/t2.log | tail -12`
Expected: the eleven new tests fail (the two "inherit"/"different order" ones fail only because the stdlib is not yet tagged and the diagnostics do not exist; they go green in Task 7); the existing ones pass.

- [ ] **Step 3: Add the diagnostics**

In `lib/typeChecker/diagnostics.ts`, after the `namedArgsOnRaise` entry, add five entries. Pick the next unused `AG30xx` codes (grep the file for the highest `AG30` code first and continue from there):

```ts
  alwaysUnknownField: {
    code: "AG30NN",
    severity: "error",
    message: "@{tag} names '{field}', which effect '{effect}' does not carry.",
  },
  alwaysBadArgument: {
    code: "AG30NN",
    severity: "error",
    message: "@{tag} arguments must be bare field names, each named once.",
  },
  alwaysRepeatedTag: {
    code: "AG30NN",
    severity: "error",
    message: "@{tag} appears more than once on effect '{effect}'.",
  },
  alwaysScopeConflict: {
    code: "AG30NN",
    severity: "error",
    message: "Conflicting @always scopes for effect '{effect}'. All declarations of an effect must agree.",
  },
  alwaysStrayTag: {
    code: "AG30NN",
    severity: "error",
    message: "@{tag} is only valid on an effect declaration.",
  },
```

Then add one entry per new diagnostic to `DIAGNOSTIC_EXPLANATIONS` in `lib/typeChecker/diagnosticExplanations.ts`, copied in style from its `effectPayloadConflict` entry. This is not optional: `lib/typeChecker/diagnosticExplanations.test.ts` fails the build when any `DIAGNOSTICS` key lacks an entry. Its rules:

- one entry per diagnostic name, no extras;
- each at least 100 characters;
- no `${` anywhere;
- no `{word}` outside a code span (write `{tag}` placeholders only inside backticks, or not at all).

Write each as: what the error means in one sentence, a short example that triggers it, and how to fix it.

- [ ] **Step 4: Add the checks**

In `lib/typeChecker/effectPayloadCheck.ts`:

```ts
import { readAlwaysScope, hasAlwaysScope, isAlwaysTag } from "../utils/alwaysTag.js";
import type { AlwaysProblemKind, AlwaysTagProblem } from "../utils/alwaysTag.js";
import { sameScopedFields, type ScopedField } from "../runtime/alwaysScope.js";
import type { DiagnosticName } from "./diagnostics.js";
```

Inside `buildEffectRegistry`, after `const merged = mergePayload(effect, entries, ctx);`, add `ctx.errors.push(...alwaysScopeDiagnostics(effect, entries, merged));`. Then add, at the bottom of the file:

```ts
type TaggedDecl = { decl: EffectDeclaration; scope: ReturnType<typeof readAlwaysScope> };

/** Which diagnostic each tag-reading problem becomes. One fact, one place. */
const PROBLEM_DIAGNOSTIC: Record<AlwaysProblemKind, DiagnosticName> = {
  badArgument: "alwaysBadArgument",
  namedTwice: "alwaysBadArgument",
  repeatedTag: "alwaysRepeatedTag",
};

function problemDiagnostic(effect: string, tagged: TaggedDecl, problem: AlwaysTagProblem): TypeCheckError {
  const args = { tag: problem.tag, effect };
  return diagnostic(PROBLEM_DIAGNOSTIC[problem.kind], args, problem.loc ?? tagged.decl.loc ?? null);
}

function unknownFieldDiagnostic(effect: string, tagged: TaggedDecl, field: ScopedField): TypeCheckError {
  const tag = field.matchSubpaths ? ALWAYS_UNDER_TAG : ALWAYS_TAG;
  return diagnostic("alwaysUnknownField", { tag, field: field.field, effect }, tagged.decl.loc ?? null);
}

function isInPayload(payload: ObjectType, field: ScopedField): boolean {
  return payload.properties.some((property) => property.key === field.field);
}

/**
 * Diagnostics for the @always / @alwaysUnder tags across every declaration
 * of one effect. Only TAGGED declarations take part: an untagged
 * redeclaration (the guide shows users writing `effect std::read {...}`
 * with no tag) inherits the tagged scope and raises nothing. Among the
 * tagged ones: arguments are identifiers, each tag appears once, every
 * field exists in the payload, and all of them agree.
 */
function alwaysScopeDiagnostics(
  effect: string,
  entries: DeclEntry[],
  payload: ObjectType | null,
): TypeCheckError[] {
  const tagged: TaggedDecl[] = entries
    .filter((entry) => hasAlwaysScope(entry.decl.tags))
    .map((entry) => ({ decl: entry.decl, scope: readAlwaysScope(entry.decl.tags) }));

  const problems = tagged.flatMap((one) =>
    one.scope.problems.map((problem) => problemDiagnostic(effect, one, problem)),
  );
  const unknownFields = payload === null
    ? []
    : tagged.flatMap((one) =>
        one.scope.fields
          .filter((field) => !isInPayload(payload, field))
          .map((field) => unknownFieldDiagnostic(effect, one, field)),
      );
  const [first, ...rest] = tagged;
  const conflicts = first === undefined
    ? []
    : rest
        .filter((one) => !sameScopedFields(first.scope.fields, one.scope.fields))
        .map((one) => diagnostic("alwaysScopeConflict", { effect }, one.decl.loc ?? null));

  return [...problems, ...unknownFields, ...conflicts];
}
```

Import `ALWAYS_TAG`, `ALWAYS_UNDER_TAG` from `../utils/alwaysTag.js` and `TypeCheckError` from wherever `diagnostic()` gets its return type. Three independent derivations, each a filter and a map; no mutable `first`, no loop-carried state. `sameScopedFields` is the runtime's order-insensitive compare (Task 3), so the typechecker and the registry can never disagree about what "same scope" means.

For the stray-tag check, add a pass over `ctx.programNodes` (the field `collectDeclarations` already walks). A stray tag comes in two shapes: one the preprocessor attached to a def, type, or node (`attachTags` attaches pending tags to the next attach target of any kind), and one that never attached because the next node was an import or an expression, which stays in the tree as a standalone `tag` node (`typescriptPreprocessor.ts:129`). Check both:

```ts
/** The always-tags on a node that is not an effect declaration: a tag the
 *  preprocessor attached to a def, type, or node, or one it left standalone
 *  because nothing followed it that a tag can attach to. */
function strayAlwaysTags(node: AgencyNode): Tag[] {
  if (node.type === "effectDeclaration") {
    return [];
  }
  if (node.type === "tag") {
    return isAlwaysTag(node) ? [node] : [];
  }
  const attached = (node as { tags?: Tag[] }).tags ?? [];
  return attached.filter(isAlwaysTag);
}

function strayAlwaysTagDiagnostics(ctx: TypeCheckerContext): TypeCheckError[] {
  return walkNodes(ctx.programNodes)
    .flatMap(({ node }) => strayAlwaysTags(node))
    .map((tag) => diagnostic("alwaysStrayTag", { tag: tag.name }, tag.loc ?? null));
}
```

Import `Tag` from `../types/tag.js` and `AgencyNode` from `../types.js`. If `walkNodes` returns an iterator rather than an array, wrap it: `[...walkNodes(...)]`. Push the result from inside `buildEffectRegistry` (`ctx.errors.push(...strayAlwaysTagDiagnostics(ctx))`), not from `checkEffectPayloads`: the checker runs `checkEffectPayloads` once per pass and passes a prebuilt registry in precisely so registry-time diagnostics fire once (see the comment above `checkEffectPayloads`). A call at the top of `checkEffectPayloads` would report each stray tag once per pass.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run lib/typeChecker/effectPayloadCheck.test.ts lib/typeChecker/diagnosticExplanations.test.ts lib/typeChecker > $SCRATCH/t2.log 2>&1; tail -15 $SCRATCH/t2.log`
Expected: all pass, including the four explanation-catalogue checks. If a diagnostics-table snapshot test fails because of the new codes, update its snapshot as that test's own instructions say.

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker
printf 'Typecheck @always scopes against the effect payload\n' > $SCRATCH/msg.txt
git commit -F $SCRATCH/msg.txt
```

---

### Task 3: The runtime registry

**Files:**
- Create: `lib/runtime/alwaysScope.ts`
- Modify: `lib/runtime/index.ts` (next to the `crossModuleInitRegistry` export block, line 47)
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache:29`
- Test: `lib/runtime/alwaysScope.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ScopedField = { field: string; matchSubpaths: boolean };
  export function sameScopedFields(a: ScopedField[], b: ScopedField[]): boolean;
  export function __registerAlwaysScope(effect: string, fields: ScopedField[]): void;
  export function alwaysScopeFor(effect: string): ScopedField[];
  export function allAlwaysScopes(): Record<string, ScopedField[]>;
  ```
  Registering an empty `fields` is a no-op (so callers never need an "only if non-empty" guard). Registering the same effect twice with the same fields, in any order, is a no-op; with different fields it throws. `sameScopedFields` is order-insensitive and is the one definition of "same scope" for the typechecker (Task 2) and the registry. `ScopedField` is declared here and only here on the TypeScript side; `stdlib/policy.agency` keeps its own Agency copy because Agency types cannot import TypeScript types.

Why a module-level record and not `GlobalStore`: the registry is derived from code, not from a run, the same as `crossModuleInitRegistry.ts`, which also keeps a module-level record. It is re-populated on every JS-load and must not be checkpointed.

- [ ] **Step 1: Write the failing test**

```ts
// lib/runtime/alwaysScope.test.ts
import { describe, it, expect } from "vitest";
import { __registerAlwaysScope, alwaysScopeFor, allAlwaysScopes } from "./alwaysScope.js";

describe("always-scope registry", () => {
  it("returns [] for an unknown effect", () => {
    expect(alwaysScopeFor("test::never")).toEqual([]);
  });

  it("returns what was registered", () => {
    __registerAlwaysScope("test::a", [{ field: "name", matchSubpaths: false }]);
    expect(alwaysScopeFor("test::a")).toEqual([{ field: "name", matchSubpaths: false }]);
    expect(allAlwaysScopes()["test::a"]).toBeDefined();
  });

  it("ignores an identical re-registration", () => {
    __registerAlwaysScope("test::b", [{ field: "dir", matchSubpaths: true }]);
    __registerAlwaysScope("test::b", [{ field: "dir", matchSubpaths: true }]);
    expect(alwaysScopeFor("test::b")).toHaveLength(1);
  });

  it("throws on a conflicting re-registration", () => {
    __registerAlwaysScope("test::c", [{ field: "dir", matchSubpaths: true }]);
    expect(() =>
      __registerAlwaysScope("test::c", [{ field: "cwd", matchSubpaths: false }]),
    ).toThrow(/test::c/);
  });

  it("does not resolve prototype keys", () => {
    expect(alwaysScopeFor("constructor")).toEqual([]);
  });

  it("returns copies, so callers cannot mutate the registry", () => {
    __registerAlwaysScope("test::d", [{ field: "x", matchSubpaths: false }]);
    alwaysScopeFor("test::d").push({ field: "y", matchSubpaths: false });
    expect(alwaysScopeFor("test::d")).toHaveLength(1);
    allAlwaysScopes()["test::d"].push({ field: "z", matchSubpaths: false });
    expect(alwaysScopeFor("test::d")).toHaveLength(1);
  });

  it("treats an empty registration as a no-op", () => {
    __registerAlwaysScope("test::e", []);
    expect(allAlwaysScopes()["test::e"]).toBeUndefined();
    __registerAlwaysScope("test::f", [{ field: "x", matchSubpaths: false }]);
    expect(() => __registerAlwaysScope("test::f", [])).not.toThrow();
    expect(alwaysScopeFor("test::f")).toHaveLength(1);
  });

  it("accepts the same fields in a different order", () => {
    __registerAlwaysScope("test::g", [
      { field: "a", matchSubpaths: false },
      { field: "b", matchSubpaths: true },
    ]);
    expect(() =>
      __registerAlwaysScope("test::g", [
        { field: "b", matchSubpaths: true },
        { field: "a", matchSubpaths: false },
      ]),
    ).not.toThrow();
  });
});
```

The second half of the empty-registration test matters for the IPC receiver (Task 3b), which can receive `[]` for an effect the parent already knows: that must not throw.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/runtime/alwaysScope.test.ts > $SCRATCH/t3.log 2>&1; tail -5 $SCRATCH/t3.log`
Expected: "Cannot find module './alwaysScope.js'".

- [ ] **Step 3: Write the registry**

```ts
// lib/runtime/alwaysScope.ts
/**
 * Which payload fields an "approve always here" policy rule pins, per
 * effect. Filled by generated code: each `effect` declaration carrying an
 * `@always` / `@alwaysUnder` tag compiles to one `__registerAlwaysScope`
 * call at module JS-load. Read by `std::policy` when it builds a scoped
 * rule and when it decides whether to offer the option at all.
 *
 * Process-wide and derived from code, like `crossModuleInitRegistry.ts`.
 * Never checkpointed: a resume re-imports the modules and re-registers.
 */

export type ScopedField = { field: string; matchSubpaths: boolean };

// Null prototype: effect names are user-controlled strings.
const scopes: Record<string, ScopedField[]> = Object.create(null);

function includesField(fields: ScopedField[], wanted: ScopedField): boolean {
  return fields.some(
    (field) => field.field === wanted.field && field.matchSubpaths === wanted.matchSubpaths,
  );
}

/** Same fields, in any order. The typechecker and the registry share this
 *  so "these two declarations agree" means one thing. */
export function sameScopedFields(a: ScopedField[], b: ScopedField[]): boolean {
  return a.length === b.length && a.every((field) => includesField(b, field));
}

function describe(fields: ScopedField[]): string {
  return `[${fields.map((field) => field.field).join(", ")}]`;
}

function copyOf(fields: ScopedField[]): ScopedField[] {
  return fields.map((field) => ({ ...field }));
}

export function __registerAlwaysScope(effect: string, fields: ScopedField[]): void {
  // An empty scope is "nothing to say", never a claim that contradicts a
  // scope already registered. Codegen, IPC, and tests rely on this.
  if (fields.length === 0) {
    return;
  }
  const existing = scopes[effect] ?? [];
  if (sameScopedFields(existing, fields)) {
    return;
  }
  if (existing.length > 0) {
    throw new Error(
      `Effect '${effect}' registered two different @always scopes: ${describe(existing)} and ${describe(fields)}`,
    );
  }
  scopes[effect] = copyOf(fields);
}

export function alwaysScopeFor(effect: string): ScopedField[] {
  return copyOf(scopes[effect] ?? []);
}

export function allAlwaysScopes(): Record<string, ScopedField[]> {
  return Object.fromEntries(Object.keys(scopes).map((effect) => [effect, alwaysScopeFor(effect)]));
}
```

Because an empty `fields` returns early, codegen, the IPC receiver, and tests call this without an "only if non-empty" guard of their own.

- [ ] **Step 4: Export from the runtime and the generated-code imports**

In `lib/runtime/index.ts`, after the `crossModuleInitRegistry` export block:

```ts
export { __registerAlwaysScope, alwaysScopeFor, allAlwaysScopes } from "./alwaysScope.js";
export type { ScopedField } from "./alwaysScope.js";
```

In `lib/templates/backends/typescriptGenerator/imports.mustache`, line 29, append `__registerAlwaysScope,` to the line that starts `__registerStaticInit, __registerGlobalsInit,`. Then run `pnpm run templates` so `imports.ts` is regenerated. Do not edit `imports.ts` by hand.

- [ ] **Step 5: Run the test**

Run: `pnpm vitest run lib/runtime/alwaysScope.test.ts > $SCRATCH/t3.log 2>&1; tail -5 $SCRATCH/t3.log`
Expected: 8 passed.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/alwaysScope.ts lib/runtime/alwaysScope.test.ts lib/runtime/index.ts lib/templates/backends/typescriptGenerator/imports.mustache lib/templates/backends/typescriptGenerator/imports.ts
printf 'Runtime registry for @always scopes\n' > $SCRATCH/msg.txt
git commit -F $SCRATCH/msg.txt
```

---

### Task 3b: Scopes cross the subprocess boundary

**Files:**
- Modify: `lib/runtime/ipc.ts` (`IpcInterruptMessage` around line 200, `sendInterruptToParent` around line 359, `handleInterruptMessage` around line 879)
- Modify: `lib/runtime/interrupts.ts` (the `sendInterruptToParent` call, line 471)
- Test: `tests/agency/always-scope-over-ipc/main.agency` (written in Task 5 Step 3b, once `alwaysScopeFor` exists in `std::policy`)

**Interfaces:**
- Consumes: `alwaysScopeFor`, `__registerAlwaysScope` (Task 3).
- Produces: `IpcInterruptMessage.interrupt.alwaysScope?: ScopedField[]`. The child fills it from its own registry; the parent registers it before its handler chain runs.

Why: `std::agency` `run`, `runFile`, and `testFile` execute code in a child process, and every interrupt the child raises is forwarded to the parent's handlers (`interrupts.ts:471`). The parent may never have imported the module that declares the effect, so its registry is empty for it. The child always has, because it raised the effect. Sending the scope with the interrupt keeps "the declaration is the source of truth" true across processes. `std::toolbox` (which uses `runFile` and `testFile`) is the first user that would otherwise lose the "approve always here" option.

- [ ] **Step 1: Write the failing test**

The only test that can fail when the wiring is missing is one that crosses a real process boundary. A unit test of a `registerScopeFromIpc` helper would stay green with the send side or the receive side forgotten, so there is no such helper and no such test. Write `tests/agency/always-scope-over-ipc/main.agency`:

```
import { runCode } from "std::agency"
import { alwaysScopeFor } from "std::policy"

// The parent never declares child::ping. The only way its registry can
// know the scope is from the interrupt the child sends over IPC.
const CHILD = """
@always(name)
effect child::ping { name: string }

node main(): string {
  return interrupt child::ping("ping", { name: "x" })
  return "ran"
}
"""

node main(): string {
  let seen: ScopedField[] = []
  handle child::ping as intr {
    seen = alwaysScopeFor(intr.effect)
    reject intr
  }
  runCode(CHILD)
  if (seen.length != 1 || seen[0].field != "name" || seen[0].matchSubpaths) {
    return "FAIL: parent saw ${JSON.stringify(seen)}"
  }
  return "pass"
}
```

Import `ScopedField` from `std::policy`. Check the handler syntax against `tests/agency/` (`grep -rn "^  handle " tests/agency | head`) and copy the exact form; the `reject` keeps the child from doing anything after the raise. The `std::run` interrupt that `runCode` itself raises must be approved by the test's own handler or the runner's default: look at an existing `runCode` test under `tests/agency/` and copy how it handles that. `main.test.json` has the standard `"pass"` shape.

This test needs Task 5's `alwaysScopeFor` export, so it stays unwritten until then; write it in Task 5 Step 3b next to the other end-to-end test, and run it there. The runtime change itself is done here.

- [ ] **Step 2: Send the scope from the child**

In `ipc.ts`, add `alwaysScope: ScopedField[]` to the `interrupt` object type inside `IpcInterruptMessage` and to `sendInterruptToParent`'s `interruptData` parameter type. In `interrupts.ts:471`, pass it:

```ts
const parentOutcome = await sendInterruptToParent(
  { ...interruptObj, alwaysScope: alwaysScopeFor(interruptObj.effect) },
  interruptId,
);
```

Always send it, empty or not. The field is not optional and there is no "only when non-empty" branch: an empty array costs a few bytes and saves a special case on both ends.

- [ ] **Step 3: Register on receipt**

In `handleInterruptMessage` (`ipc.ts:879`), before `gatherChainOutcome`:

```ts
// The child carries the scope its effect declaration gave it; this process
// may never have imported that module. An empty scope registers nothing.
__registerAlwaysScope(msg.interrupt.effect, msg.interrupt.alwaysScope);
```

Nesting composes for free: a parent that is itself a subprocess re-sends from its (now filled) registry in Step 2.

A conflicting scope (child says one thing, parent another) throws from `__registerAlwaysScope`. That can only happen when the two processes compiled different declarations of the same effect, which the typechecker's `alwaysScopeConflict` already forbids within one program; let it throw rather than pick one.

- [ ] **Step 4: Run the existing subprocess tests**

Run: `pnpm vitest run lib/runtime/alwaysScope.test.ts lib/runtime/subprocessRunInfo.test.ts > $SCRATCH/t3b.log 2>&1; tail -8 $SCRATCH/t3b.log`, plus any test named `*ipc*` or `*subprocess*` under `lib/runtime/` and `lib/stdlib/` (grep for them). Expected: pass. Any test that constructs an `IpcInterruptMessage` by hand needs the new field; add `alwaysScope: []`.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/ipc.ts lib/runtime/interrupts.ts
printf 'Send the always-scope with each child interrupt over IPC\n' > $SCRATCH/msg.txt
git commit -F $SCRATCH/msg.txt
```

---

### Task 4: Codegen emits the registration

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` (`processNode` case `"effectDeclaration"`, line 636; `assembleSections` call, line 556)
- Modify: `lib/backends/typescriptBuilder/sectionAssembler.ts` (options type around line 350; emission around line 442)
- Test: `tests/typescriptGenerator/effectAlways.agency` and its generated `effectAlways.mjs`

**Interfaces:**
- Consumes: `readAlwaysScope` (Task 1), `__registerAlwaysScope` (Task 3, via `imports.mustache`).
- Produces: for each tagged declaration, one line in the generated module at JS-load:
  `__registerAlwaysScope("std::env", [{"field":"name","matchSubpaths":false}]);`

- [ ] **Step 1: Write the fixture source**

```
// tests/typescriptGenerator/effectAlways.agency
@always(name)
effect app::env { name: string }

@alwaysUnder(dir)
effect app::read { dir: string, filename: string }

effect app::plain { x: string }

node main() {
  return "ok"
}
```

- [ ] **Step 2: Run the integration test to see the fixture has no expected output**

Run: `pnpm vitest run lib/backends/typescriptGenerator.integration.test.ts > $SCRATCH/t4.log 2>&1; grep -i "effectAlways" $SCRATCH/t4.log | head`
Expected: the fixture is skipped or fails for a missing `.mjs`. Either is the failing state.

- [ ] **Step 3: Collect scopes in the builder**

In `lib/backends/typescriptBuilder.ts`:

Add a field near the other per-build collections (search for `private generatedStatements`):

```ts
  /** One `__registerAlwaysScope(...)` per tagged effect declaration. */
  private alwaysScopeRegistrations: TsNode[] = [];
```

Add the import:

```ts
import { readAlwaysScope } from "../utils/alwaysTag.js";
```

Replace the `effectDeclaration` case:

```ts
      case "effectDeclaration": {
        // The payload type is compile-time only. An @always scope is the
        // one thing a declaration contributes at runtime: one registration
        // at module JS-load. The typechecker already validated the tags.
        const { fields } = readAlwaysScope(node.tags);
        if (fields.length > 0) {
          this.alwaysScopeRegistrations.push(
            ts.raw(
              `__registerAlwaysScope(${JSON.stringify(node.effect)}, ${JSON.stringify(fields)});`,
            ),
          );
        }
        return ts.empty();
      }
```

Pass them to the assembler: in the `assembleSections({...})` call add `alwaysScopeRegistrations: this.alwaysScopeRegistrations,`.

- [ ] **Step 4: Emit in the assembler**

In `sectionAssembler.ts`, add to the options type (the one containing `staticInitStatements: TsNode[]` near line 350):

```ts
  /** `__registerAlwaysScope(...)` calls, one per tagged effect declaration. */
  alwaysScopeRegistrations: TsNode[];
```

In `assembleSections`, immediately before the `if (opts.staticVarNames.size > 0 || ...)` block near line 442:

```ts
  // Effect scopes register at JS-load, before any handler can exist and
  // with no runtime context needed.
  sections.push(...opts.alwaysScopeRegistrations);
```

If any other caller of `assembleSections` exists (grep for it), pass `alwaysScopeRegistrations: []` there.

- [ ] **Step 5: Regenerate fixtures and run the integration test**

Run: `make fixtures > $SCRATCH/fixtures.log 2>&1; tail -5 $SCRATCH/fixtures.log`
Then: `grep -n "__registerAlwaysScope" tests/typescriptGenerator/effectAlways.mjs`
Expected: two lines, for `app::env` and `app::read`, none for `app::plain`.

Run: `pnpm vitest run lib/backends/typescriptGenerator.integration.test.ts > $SCRATCH/t4.log 2>&1; tail -5 $SCRATCH/t4.log`
Expected: all pass. `make fixtures` regenerates every fixture; check `git status` shows only `effectAlways.mjs` as new and no other fixture changed. If others changed, the emission landed in a section that shifts existing output; move the `sections.push` so untagged modules produce byte-identical output.

- [ ] **Step 5b: Prove the registration runs at JS-load, not at node run**

The fixture proves the text is emitted. The claim in adjustment 2 is stronger: importing the module is enough, before any node runs and before any handler exists. Add to `lib/backends/typescriptGenerator.integration.test.ts` (or a sibling file if that test is table-driven):

```ts
it("registers @always scopes when the compiled module is imported", async () => {
  // Static import only; no node is called.
  await import("../../tests/typescriptGenerator/effectAlways.mjs");
  expect(alwaysScopeFor("app::env")).toEqual([{ field: "name", matchSubpaths: false }]);
  expect(alwaysScopeFor("app::read")).toEqual([{ field: "dir", matchSubpaths: true }]);
  expect(alwaysScopeFor("app::plain")).toEqual([]);
});
```

The repo bans dynamic `import()` in source (`eslint.config.js`); check whether the structural linter exempts test files. If it does not, use a top-level `import "../../tests/typescriptGenerator/effectAlways.mjs";` at the head of the test file instead, which is still an import with no node call.

- [ ] **Step 6: Commit**

```bash
git add lib/backends tests/typescriptGenerator/effectAlways.agency tests/typescriptGenerator/effectAlways.mjs
printf 'Emit __registerAlwaysScope for tagged effect declarations\n' > $SCRATCH/msg.txt
git commit -F $SCRATCH/msg.txt
```

The end-to-end proof that a compiled program fills the registry needs `alwaysScopeFor` in `std::policy`, which does not exist until Task 5. That test is written there (Task 5 Step 3b), so no commit on this branch carries a test known to be red.

---

### Task 5: `std::policy` reads the registry and escapes values

**Files:**
- Modify: `lib/runtime/policy.ts` (add `escapeGlob`), `lib/runtime/builtinPolicies.ts` (import it instead of defining it)
- Modify: `lib/stdlib/policy.ts` (re-exports)
- Modify: `stdlib/policy.agency` (`ScopedRuleFields` docs, `buildScopedMatch`, `askUser`, `cliPolicyHandler`, new exports)
- Test: `tests/agency/policy-build-scoped-match/main.agency` (extend), `tests/agency/policy-always-registry/main.agency` (new), `tests/agency/effect-always-registry/main.agency` (new), `lib/runtime/policy.test.ts` (extend if present, else create)

**Interfaces:**
- Consumes: `alwaysScopeFor`, `allAlwaysScopes` (Task 3).
- Produces in `std::policy`:
  ```
  export def alwaysScopeFor(effect: string): ScopedField[]
  export def defaultScopedFields(): ScopedRuleFields
  export def buildScopedMatch(intr, fields: ScopedRuleFields = {}): Record<string, string>
  cliPolicyHandler(file:, fields: ScopedRuleFields = {}, policy:, interactive:)
  ```
  Resolution: `fields[effect]` when the caller passed the key (an empty list suppresses the option); otherwise the registry.

- [ ] **Step 1: Move `escapeGlob` and test it**

In `lib/runtime/policy.ts` add:

```ts
/** Escape picomatch metacharacters so a literal value matches only itself
 *  inside a pattern. Used for every value a generated rule pins, and for
 *  the base directory of the built-in scoped policies. */
export function escapeGlob(s: string): string {
  return s.replace(/[\\*?{}()[\]!@+|,^$]/g, "\\$&");
}
```

In `lib/runtime/builtinPolicies.ts`, delete the local `escapeGlob` and add `escapeGlob` to the import from `./policy.js`.

Add to `lib/runtime/policy.test.ts` (create the file with the vitest header if it does not exist):

```ts
import { checkPolicy, escapeGlob } from "./policy.js";

describe("escapeGlob", () => {
  it("makes a literal value match only itself", () => {
    const policy = { "std::bash": [{ match: { command: escapeGlob("ls *.md") }, action: "approve" as const }] };
    expect(checkPolicy(policy, { effect: "std::bash", data: { command: "ls *.md" } }).type).toBe("approve");
    expect(checkPolicy(policy, { effect: "std::bash", data: { command: "ls a.md" } }).type).not.toBe("approve");
  });

  it("keeps a brace-expanded subpath scope working around an escaped base", () => {
    const base = escapeGlob("/tmp/[x]");
    const policy = { "std::read": [{ match: { dir: `{${base},${base}/**}` }, action: "approve" as const }] };
    expect(checkPolicy(policy, { effect: "std::read", data: { dir: "/tmp/[x]/sub" } }).type).toBe("approve");
    expect(checkPolicy(policy, { effect: "std::read", data: { dir: "/tmp/x/sub" } }).type).not.toBe("approve");
  });
});
```

Check `checkPolicy`'s exact signature in `lib/runtime/policy.ts:19` and adjust the interrupt argument shape if it needs `message`.

Run: `pnpm vitest run lib/runtime/policy.test.ts lib/runtime/builtinPolicies.test.ts > $SCRATCH/t5a.log 2>&1; tail -5 $SCRATCH/t5a.log`
Expected: pass.

- [ ] **Step 2: Re-export for `std::policy`**

In `lib/stdlib/policy.ts` add:

```ts
export { escapeGlob as _escapeGlob } from "@/runtime/policy.js";
export {
  alwaysScopeFor as _alwaysScopeFor,
  allAlwaysScopes as _allAlwaysScopes,
} from "@/runtime/alwaysScope.js";
```

- [ ] **Step 3: Write the failing Agency tests**

Extend `tests/agency/policy-build-scoped-match/main.agency`. Before the final `return "pass"` add:

```
  // Values are escaped: a rule generated from "ls *.md" must not be a glob.
  const bashFields: ScopedRuleFields = {
    "std::bash": [
      { field: "command", matchSubpaths: false },
      { field: "cwd", matchSubpaths: false },
    ],
  }
  const bashIntr = { effect: "std::bash", data: { command: "ls *.md", cwd: "/tmp/{a,b}" } }
  const m5 = buildScopedMatch(bashIntr, bashFields)
  if (m5.command != "ls \\*.md") { return "FAIL: command not escaped, got ${m5.command}" }
  if (m5.cwd != "/tmp/\\{a\\,b\\}") { return "FAIL: cwd not escaped, got ${m5.cwd}" }

  // Subpath values are escaped inside the brace expansion.
  const readIntr2 = { effect: "std::read", data: { dir: "/u/[x]", filename: "f" } }
  const m6 = buildScopedMatch(readIntr2, fields)
  if (m6.dir != "{/u/\\[x\\],/u/\\[x\\]/**}") { return "FAIL: subpath not escaped, got ${m6.dir}" }
```

Create `tests/agency/policy-always-registry/main.agency`:

```
import { keys } from "std::object"
import {
  buildScopedMatch,
  defaultScopedFields,
  alwaysScopeFor,
  ScopedRuleFields,
} from "std::policy"

@always(name)
effect app::env { name: string }

@alwaysUnder(dir)
effect app::read { dir: string, filename: string }

node main(): string {
  // No fields passed: the registry decides.
  const envIntr = { effect: "app::env", data: { name: "BRAVE_API_KEY" } }
  const m1 = buildScopedMatch(envIntr)
  if (m1.name != "BRAVE_API_KEY") { return "FAIL: registry scope not used, got ${JSON.stringify(m1)}" }

  const readIntr = { effect: "app::read", data: { dir: "/u/p", filename: "f" } }
  const m2 = buildScopedMatch(readIntr)
  if (m2.dir != "{/u/p,/u/p/**}") { return "FAIL: registry subpath scope, got ${JSON.stringify(m2)}" }

  // An explicit entry overrides the registry.
  const override: ScopedRuleFields = { "app::env": [] }
  const m3 = buildScopedMatch(envIntr, override)
  if (keys(m3).length != 0) { return "FAIL: empty override should suppress" }

  // An entry for another effect leaves this one on the registry.
  const other: ScopedRuleFields = { "app::read": [{ field: "filename", matchSubpaths: false }] }
  const m4 = buildScopedMatch(envIntr, other)
  if (m4.name != "BRAVE_API_KEY") { return "FAIL: unrelated override changed resolution" }

  // defaultScopedFields exposes the registry.
  const all = defaultScopedFields()
  if (all["app::env"] == null || all["app::env"].length != 1) { return "FAIL: defaultScopedFields" }
  if (alwaysScopeFor("app::env")[0].field != "name") { return "FAIL: alwaysScopeFor" }

  // recordScopedRule falls back to the registry the same way.
  const recorded = recordScopedRule({}, envIntr)
  if (checkPolicy(recorded, envIntr).type != "approve") { return "FAIL: recordScopedRule without fields" }
  const otherEnv = { effect: "app::env", data: { name: "OTHER" } }
  if (checkPolicy(recorded, otherEnv).type == "approve") { return "FAIL: recorded rule too wide" }
  return "pass"
}
```

Add `recordScopedRule` and `checkPolicy` to the import.

with `main.test.json` identical in shape to `policy-build-scoped-match/main.test.json`.

- [ ] **Step 3b: Write the two end-to-end tests (registry at run time; scope over IPC)**

Also write `tests/agency/always-scope-over-ipc/main.agency` exactly as Task 3b Step 1 specifies. It is the only test that fails when either end of the IPC wiring is missing.

Create `tests/agency/effect-always-registry/main.agency`:

```
import { alwaysScopeFor } from "std::policy"

@always(name)
effect app::env { name: string }

@alwaysUnder(dir)
effect app::read { dir: string }

node main(): string {
  const env = alwaysScopeFor("app::env")
  const rd = alwaysScopeFor("app::read")
  const none = alwaysScopeFor("app::nothing")
  if (env.length != 1 || env[0].field != "name" || env[0].matchSubpaths) {
    return "FAIL env: ${JSON.stringify(env)}"
  }
  if (rd.length != 1 || rd[0].field != "dir" || !rd[0].matchSubpaths) {
    return "FAIL read: ${JSON.stringify(rd)}"
  }
  if (none.length != 0) {
    return "FAIL none"
  }
  return "pass"
}
```

and `tests/agency/effect-always-registry/main.test.json`:

```json
{
  "tests": [
    { "nodeName": "main", "input": "", "expectedOutput": "\"pass\"", "evaluationCriteria": [{ "type": "exact" }] }
  ]
}
```


- [ ] **Step 4: Change `stdlib/policy.agency`**

Imports: add `_escapeGlob`, `_alwaysScopeFor`, `_allAlwaysScopes` to the `agency-lang/stdlib-lib/policy.js` import list.

Add the two exports next to `buildScopedMatch`:

```
export def alwaysScopeFor(effect: string): ScopedField[] {
  """
  The fields an "approve always here" rule pins for `effect`, from the effect's `@always` / `@alwaysUnder` declaration. Empty when the effect declares none.

  @param effect - The interrupt effect name, e.g. "std::env".
  """
  return _alwaysScopeFor(effect)
}

export def defaultScopedFields(): ScopedRuleFields {
  """Every declared always-scope, keyed by effect. What `cliPolicyHandler` uses when its caller passes no `fields`."""
  return _allAlwaysScopes()
}

// The one resolution rule: an explicit entry wins (an empty list
// suppresses the option); otherwise the effect's declared scope.
def scopedFieldsFor(effect: string, fields: ScopedRuleFields): ScopedField[] {
  if (fields[effect] != undefined) {
    return fields[effect]
  }
  return _alwaysScopeFor(effect)
}
```

Change `buildScopedMatch`'s signature to `fields: ScopedRuleFields = {}` and its body to use `scopedFieldsFor(intr.effect, fields)` in place of the `fields[intr.effect]` lookup. Do the same to `recordScopedRule` (`policy.agency:365`): `fields: ScopedRuleFields = {}`, and it already delegates to `buildScopedMatch`, so nothing else changes there. Every public entry that takes `fields` now has the same default and the same fallback. Escape the value:

```
    const literal = _escapeGlob("${value}")
    if (spec.matchSubpaths) {
      match[spec.field] = "{${literal},${literal}/**}"
    } else {
      match[spec.field] = literal
    }
```

Update the doc comment above `buildScopedMatch` to say values are escaped and that a missing `fields` entry falls back to the declaration.

In `askUser`, replace the `effectFields` lookup with `const effectFields = scopedFieldsFor(intr.effect, globalCliPolicyOpts.fields)`.

In `cliPolicyHandler`, make `fields: ScopedRuleFields = {}` and update its docstring: "@param fields - Per-effect override of which data fields the approve-always-here rule pins. Effects not listed use the scope their `effect` declaration carries; an empty list turns the option off for that effect."

Update the `ScopedRuleFields` doc block (around line 160) so it no longer says "Effects not present in this map don't offer the (ap) prompt option"; say they fall back to the declaration.

- [ ] **Step 5: Build and run the three Agency tests**

Run: `make > $SCRATCH/make5.log 2>&1; tail -3 $SCRATCH/make5.log`
Then:

```bash
pnpm run agency test tests/agency/policy-build-scoped-match/main.agency > $SCRATCH/t5b.log 2>&1
pnpm run agency test tests/agency/policy-always-registry/main.agency > $SCRATCH/t5c.log 2>&1
pnpm run agency test tests/agency/effect-always-registry/main.agency > $SCRATCH/t5d.log 2>&1
pnpm run agency test tests/agency/policy-record-scoped-rule/main.agency > $SCRATCH/t5e.log 2>&1
pnpm run agency test tests/agency/always-scope-over-ipc/main.agency > $SCRATCH/t5f.log 2>&1
tail -3 $SCRATCH/t5b.log $SCRATCH/t5c.log $SCRATCH/t5d.log $SCRATCH/t5e.log $SCRATCH/t5f.log
```

Expected: all five pass. To see the IPC test do its job, comment out the `__registerAlwaysScope` line in `handleInterruptMessage`, rerun `t5f` once, and confirm it fails; then restore it. If `policy-record-scoped-rule` asserted an unescaped value that now carries a backslash, update that assertion (the value it used will tell you).

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/policy.ts lib/runtime/policy.test.ts lib/runtime/builtinPolicies.ts lib/stdlib/policy.ts stdlib/policy.agency tests/agency/policy-build-scoped-match tests/agency/policy-always-registry tests/agency/effect-always-registry tests/agency/always-scope-over-ipc
printf 'std::policy reads @always scopes and escapes generated rule values\n' > $SCRATCH/msg.txt
git commit -F $SCRATCH/msg.txt
```

---

### Task 6: No "always" for value-expecting interrupts

**Files:**
- Modify: `stdlib/policy.agency` (`askUser`, around line 681)
- Test: `tests/agency/policy-ask-value-interrupt/main.agency` (new)

**Interfaces:**
- Consumes: `intr.expectsValue`, present on the interrupt record the handler receives (`lib/runtime/interrupts.ts:557`).

`askUser` is private and drives a terminal prompt, so the testable unit is the item list. Extract it as an exported function marked `@hidden` (see `stdlib/agents/agency/coding.agency:443` for the form): exported so an Agency test can import it, hidden so `agency doc` leaves it off the `std::policy` page and users are not invited to call a prompt internal.

- [ ] **Step 1: Write the failing test**

```
// tests/agency/policy-ask-value-interrupt/main.agency
import { map } from "std::array"
import { askUserChoices } from "std::policy"

@always(name)
effect app::env { name: string }

node main(): string {
  const permission = { effect: "app::env", data: { name: "X" }, expectsValue: false }
  const keys1 = map(askUserChoices(permission), \item -> item.key)
  if (keys1.join(",") != "a,r,aa,ap,rr") { return "FAIL permission: ${keys1.join(",")}" }

  const question = { effect: "app::question", data: { prompt: "?" }, expectsValue: true }
  const keys2 = map(askUserChoices(question), \item -> item.key)
  if (keys2.join(",") != "a,r") { return "FAIL question: ${keys2.join(",")}" }

  const noScope = { effect: "app::plain", data: {}, expectsValue: false }
  const keys3 = map(askUserChoices(noScope), \item -> item.key)
  if (keys3.join(",") != "a,r,aa,rr") { return "FAIL no scope: ${keys3.join(",")}" }
  return "pass"
}
```

plus the standard `main.test.json`.

- [ ] **Step 2: Extract the choice list**

In `stdlib/policy.agency`, move the `items` construction out of `askUser` into:

```
@hidden
export def askUserChoices(intr: any): ChoiceItem[] {
  """
  The answers the approval prompt offers for one interrupt. An interrupt that expects a value (a question, a review) gets once-only answers: "always" has no meaning when each raise wants its own answer.

  @param intr - The interrupt being asked about.
  """
  let items: ChoiceItem[] = [
    { key: "a", label: "approve once" },
    { key: "r", label: "reject once" },
  ]
  if (intr.expectsValue == true) {
    return items
  }
  items.push({ key: "aa", label: "approve always (every future ${intr.effect})" })
  if (scopedFieldsFor(intr.effect, globalCliPolicyOpts.fields).length > 0) {
    items.push({ key: "ap", label: "approve always here (${describeScopedMatch(intr)})" })
  }
  items.push({ key: "rr", label: "reject always" })
  return items
}
```

and have `askUser` call `const items = askUserChoices(intr)`. Keep the object-literal formatting the file already uses (one field per line) so `pnpm run fmt` leaves it alone.

- [ ] **Step 3: Build and run**

Run: `make > $SCRATCH/make6.log 2>&1; pnpm run agency test tests/agency/policy-ask-value-interrupt/main.agency > $SCRATCH/t6.log 2>&1; tail -3 $SCRATCH/t6.log`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add stdlib/policy.agency tests/agency/policy-ask-value-interrupt
printf 'Approval prompt offers no always choices for value-expecting interrupts\n' > $SCRATCH/msg.txt
git commit -F $SCRATCH/msg.txt
```

---

### Task 7: Tag every stdlib effect; `host` on `openUrl`

**Files:**
- Modify: every stdlib file listed below
- Modify: `stdlib/system.agency` (`openUrl`, line 158)
- Test: `lib/utils/alwaysTag.stdlib.test.ts` (new)

**Interfaces:**
- Consumes: the tag syntax from Task 0.
- Produces: the registry contents every `cliPolicyHandler` user sees.

- [ ] **Step 1: Write the coverage test first**

```ts
// lib/utils/alwaysTag.stdlib.test.ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { parseAgency } from "../parser.js";
import { TypescriptPreprocessor } from "../preprocessors/typescriptPreprocessor.js";
import { readAlwaysScope } from "./alwaysTag.js";
import type { EffectDeclaration } from "../types/effectDeclaration.js";

const STDLIB = path.resolve(__dirname, "../../stdlib");

function agencyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...agencyFiles(full));
    else if (entry.name.endsWith(".agency") && !full.includes("/tests/")) out.push(full);
  }
  return out;
}

type Declared = { file: string; effect: string; scope: string[]; problems: AlwaysTagProblem[] };

function effectDeclarations(file: string): EffectDeclaration[] {
  const parsed = parseAgency(fs.readFileSync(file, "utf8"));
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.message}`);
  }
  // attachTags() only, not preprocess(): the full pipeline wants a
  // compilation unit and runs every transform, which stdlib files with
  // splices or templates may not survive standalone.
  new TypescriptPreprocessor(parsed.result).attachTags();
  return parsed.result.nodes.filter(
    (node): node is EffectDeclaration => node.type === "effectDeclaration",
  );
}

function describeField(field: ScopedField): string {
  return field.matchSubpaths ? `${field.field}/**` : field.field;
}

function declared(file: string, decl: EffectDeclaration): Declared {
  const { fields, problems } = readAlwaysScope(decl.tags);
  return { file, effect: decl.effect, scope: fields.map(describeField), problems };
}

/** Every effect declaration in the stdlib, one entry per DECLARATION.
 *  Some effects are declared in two files (`std::read` and `std::write`
 *  in both `stdlib/index.agency` and `stdlib/agency.agency`); keeping
 *  every declaration lets the test check that all copies agree instead
 *  of letting the last file parsed win. */
function stdlibDeclarations(): Declared[] {
  return agencyFiles(STDLIB).flatMap((file) =>
    effectDeclarations(file).map((decl) => declared(file, decl)),
  );
}

// The decision table from the spec (§5.6). Adding an effect to the stdlib
// means adding a row here, so nobody ships an effect without deciding
// what "approve always here" means for it.
const EXPECTED: Record<string, string[]> = {
  "std::read": ["dir/**"],
  "std::readBinary": ["dir/**"],
  "std::readImage": ["dir/**"],
  "std::write": ["dir/**"],
  "std::writeBinary": ["dir/**"],
  "std::edit": ["dir/**"],
  "std::ls": ["dir/**"],
  "std::glob": ["dir/**"],
  "std::grep": ["dir/**"],
  "std::mkdir": ["dir/**"],
  "std::remove": ["target/**"],
  "std::copy": ["src/**", "dest/**"],
  "std::move": ["src/**", "dest/**"],
  "std::applyPatch": [],
  "std::exec": ["command", "subcommand"],
  "std::bash": ["command", "cwd"],
  "std::run": [],
  "std::git::status": ["cwd/**"],
  "std::git::log": ["cwd/**"],
  "std::git::diff": ["cwd/**"],
  "std::git::show": ["cwd/**"],
  "std::git::branchList": ["cwd/**"],
  "std::git::remoteList": ["cwd/**"],
  "std::git::blame": ["cwd/**"],
  "std::git::stashList": ["cwd/**"],
  "std::git::add": ["cwd/**"],
  "std::git::commit": ["cwd/**"],
  "std::git::checkout": ["cwd/**"],
  "std::git::switch": ["cwd/**"],
  "std::git::branchCreate": ["cwd/**"],
  "std::git::branchDelete": ["cwd/**"],
  "std::git::stashPush": ["cwd/**"],
  "std::git::stashPop": ["cwd/**"],
  "std::git::restore": ["cwd/**"],
  "std::env": ["name"],
  "std::setEnv": ["name"],
  "std::getSecret": ["service", "key"],
  "std::setSecret": ["service", "key"],
  "std::deleteSecret": ["service", "key"],
  "std::authorize": ["name"],
  "std::getAccessToken": ["name"],
  "std::revokeAuth": ["name"],
  "std::authorizeCalendar": ["clientId"],
  "std::http::fetch": ["method", "baseUrl"],
  "std::http::fetchJSON": ["method", "baseUrl"],
  "std::http::fetchMarkdown": ["method", "baseUrl"],
  "std::openUrl": ["host"],
  "std::search": [],
  "std::tavilySearch": [],
  "std::wikipedia::search": [],
  "std::wikipedia::summary": [],
  "std::wikipedia::article": [],
  "std::weather": [],
  "std::browserUse": [],
  "std::sendEmail": ["to"],
  "std::sendSms": ["to"],
  "std::sendIMessage": ["to"],
  "std::notify": [],
  "std::say": [],
  "std::synthesizeSpeech": [],
  "std::transcribe": [],
  "std::record": [],
  "std::screenshot": [],
  "std::clipboardCopy": [],
  "std::clipboardPaste": [],
  "mcp::call": ["server", "tool"],
  "std::skills::skillsDir": ["dir/**"],
  "std::skills::commandsDir": ["dir/**"],
  "std::toolbox::scan": ["dir/**"],
  "std::toolbox::review": [],
  "std::memory::enableMemory": [],
  "std::memory::disableMemory": [],
  "std::memory::remember": [],
  "std::memory::recall": [],
  "std::memory::forget": [],
  "std::listEvents": ["calendarId"],
  "std::createEvent": ["calendarId"],
  "std::updateEvent": ["calendarId"],
  "std::deleteEvent": ["calendarId"],
  "std::notes::create": ["folder"],
  "std::notes::append": ["folder"],
  "std::notes::read": ["folder"],
  "std::notes::search": ["folder"],
  "std::notes::list": ["folder"],
  "std::notes::delete": ["folder"],
  "std::question": [],
  "std::agents::planApprove": [],
  "std::exit": [],
};

describe("every stdlib effect has a decided always-scope", () => {
  const declarations = stdlibDeclarations();

  it("has no malformed tags", () => {
    const malformed = declarations.filter((one) => one.problems.length > 0);
    expect(malformed.map((one) => `${one.file} ${one.effect}`)).toEqual([]);
  });

  it("matches the decision table", () => {
    // Effects declared in the stdlib but missing from the table, and rows
    // in the table with no declaration, both fail here.
    const declaredEffects = [...new Set(declarations.map((one) => one.effect))].sort();
    expect(declaredEffects).toEqual(Object.keys(EXPECTED).sort());
    const wrong = declarations.filter(
      (one) => JSON.stringify(one.scope) !== JSON.stringify(EXPECTED[one.effect]),
    );
    expect(wrong.map((one) => `${one.file} ${one.effect}: ${one.scope.join(",")}`)).toEqual([]);
  });
});
```

Comparing every declaration to the table also checks that duplicate declarations agree with each other, since they must both equal the same row. (`Set` is used once here for deduplication in a test; if the linter objects, `filter((effect, index, list) => list.indexOf(effect) === index)` does the same.) Import `AlwaysTagProblem` from `./alwaysTag.js` and `ScopedField` from `../runtime/alwaysScope.js`.

Run it once now to get the real list of declared effects: `pnpm vitest run lib/utils/alwaysTag.stdlib.test.ts > $SCRATCH/t7.log 2>&1; grep -A40 "Expected\|Received" $SCRATCH/t7.log | head -80`. The first failure prints which effects exist that the table lacks (data connectors such as `std::fred`, `std::edgar`, `std::bluesky` declare effects the spec inventory listed by module) and which table rows have no declaration (e.g. `std::createEvent` may be declared with a different name). Fix the table to the real declaration names, keeping the spec's decisions: connectors and other query-style effects get `[]`. Do not remove a row to make the test pass unless the effect truly does not exist.

- [ ] **Step 1b: Declare `std::readBinary` and `std::writeBinary`**

Both are raised from `stdlib/index.agency` (`:293` and `:261`) and declared nowhere, so there is no line to tag. Add them next to `std::read` in `stdlib/index.agency`, with payloads matching the raise sites exactly (the typechecker checks the raise site against the declaration from now on):

```
@alwaysUnder(dir)
effect std::readBinary { dir: string, filename: string }

@alwaysUnder(dir)
effect std::writeBinary { dir: string, filename: string, mode: string }
```

Check the type of `mode` at the `writeBinary` raise site (`stdlib/index.agency:261-265`) and copy it. Do not add them to `stdlib/agency.agency`'s copies; that file only redeclares the effects its own code raises.

- [ ] **Step 2: Add `host` to `openUrl`**

In `stdlib/system.agency`, change the declaration and the raise:

```
@always(host)
effect std::openUrl { url: string, host: string }
```

```
export def openUrl(url: string): Result {
  """
  Open a URL in the user's default browser.

  @param url - The URL to open
  """
  return interrupt std::openUrl("Are you sure you want to open this URL in the browser?", {
    url: url,
    host: urlHost(url)
  })

  return try _openUrl(url)
}
```

Check `std::path` or `std::http` for an existing URL-host helper (grep `hostname` under `stdlib/` and `lib/stdlib/`). If none exists, add to `lib/stdlib/system.ts`:

```ts
/** The hostname of a URL, or "" when the string is not a URL. Used as the
 *  policy scope for std::openUrl. `URL.canParse` (Node 19.9+; the package
 *  floor is 22.13) avoids a try/catch that would swallow the error. */
export function _urlHost(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname : "";
}
```

and in `stdlib/system.agency` import it and wrap: `def urlHost(url: string): string { return _urlHost(url) }`.

Test both the helper and the payload. In `lib/stdlib/system.test.ts` (create if absent):

```ts
describe("_urlHost", () => {
  it("returns the hostname of a URL", () => {
    expect(_urlHost("https://example.com/a/b?c=d")).toBe("example.com");
  });
  it("returns an empty string for a non-URL", () => {
    expect(_urlHost("not a url")).toBe("");
  });
});
```

And `tests/agency/open-url-host/main.agency`, which proves the raise carries `host` without ever opening a browser (the handler rejects, so `_openUrl` is never reached; see `system.agency:158-167`):

```
import { openUrl } from "std::system"

node main(): string {
  let host = "unset"
  handle std::openUrl as intr {
    host = intr.data.host
    reject intr
  }
  openUrl("https://example.com/a/b")
  if (host != "example.com") { return "FAIL: host was ${host}" }
  return "pass"
}
```

Copy the handler syntax from an existing test under `tests/agency/` as in Task 3b. Standard `main.test.json`.

- [ ] **Step 3: Tag the declarations**

Add the tag line directly above each `effect` line per the table. For a file with a run of declarations (`stdlib/git.agency:97-114`) each one gets its own tag line. `std::read` and `std::write` are declared twice, in `stdlib/index.agency:36-44` and `stdlib/agency.agency:56-60`; tag both copies identically, or the coverage test (which compares every declaration of an effect) and the typechecker's `alwaysScopeConflict` both fail. Examples of the shapes:

```
@alwaysUnder(dir)
effect std::read { dir: string, filename: string, offset: number, limit: number }

@always(command, cwd)
effect std::bash { command: string, cwd: string, timeout: number, stdin: string }

@always(method, baseUrl)
effect std::http::fetch { baseUrl: string, path: string, method: string }

@always(server, tool)
effect mcp::call {
  server: string,
  tool: string,
  args: Record<string, any>
}
```

Where a declaration has a doc comment above it, the tag goes between the doc comment and the `effect` line (the preprocessor attaches both to the declaration; `stdlib/toolbox.agency:111` shows a doc-commented declaration to copy from).

- [ ] **Step 3b: Pin the formatter round-trip**

`make` formats the stdlib. `processEffectDeclaration` (`lib/backends/agencyGenerator.ts:880`) calls `formatAttachedTags`, so tags survive today, but nothing tests it, and if that call is ever lost every tag in the stdlib disappears on the next `make` with no error. Add to `lib/backends/agencyGenerator.test.ts`, in the style of its neighbours:

```ts
it("keeps @always and @alwaysUnder tags on an effect declaration", () => {
  const src = "@always(name)\n@alwaysUnder(dir)\neffect app::x { name: string, dir: string }\n";
  expect(formatSource(src)).toBe(src);
});
```

Use whatever round-trip helper that file already uses (`formatSource` per `parser-test-conventions`; check the file).

- [ ] **Step 4: Run the coverage test, typecheck the stdlib, and format**

```bash
pnpm vitest run lib/utils/alwaysTag.stdlib.test.ts > $SCRATCH/t7.log 2>&1; tail -5 $SCRATCH/t7.log
make > $SCRATCH/make7.log 2>&1; tail -3 $SCRATCH/make7.log
```

Expected: the test passes and `make` (which typechecks the stdlib) reports no `AG30` diagnostics. Run `pnpm run fmt stdlib/system.agency` and any other file you touched, and check `git diff --stat` shows only tag lines and the `openUrl` change.

- [ ] **Step 5: Run the existing policy-related agency tests**

```bash
for t in tests/agency/policy-*/main.agency tests/agency/open-url-host/main.agency lib/agents/agency-agent/tests/readPolicy.agency lib/agents/agency-agent/tests/execPolicy.agency lib/agents/agency-agent/tests/gitPolicy.agency lib/agents/agency-agent/tests/mcpGating.agency; do
  name=$(echo "$t" | tr '/' '_')
  pnpm run agency test "$t" > "$SCRATCH/t7b-$name.log" 2>&1 || echo "FAILED: $t"
done
tail -n 2 $SCRATCH/t7b-*.log
```

Expected: no `FAILED:` line, and every tail shows a pass. One log per test, so a failure names its file instead of hiding in a shared log. Also run `pnpm vitest run lib/stdlib/system.test.ts > $SCRATCH/t7c.log 2>&1; tail -5 $SCRATCH/t7c.log`.

- [ ] **Step 6: Commit**

```bash
git add stdlib lib/stdlib/system.ts lib/stdlib/system.test.ts lib/utils/alwaysTag.stdlib.test.ts tests/agency/open-url-host
printf 'Declare the approve-always scope on every stdlib effect\n' > $SCRATCH/msg.txt
git commit -F $SCRATCH/msg.txt
```

---

### Task 8: Remove the agent's table

**Files:**
- Modify: `lib/agents/agency-agent/lib/config.agency:41-100` (delete `ALWAYS_FIELDS` and its `ScopedRuleFields` import)
- Modify: `lib/agents/agency-agent/lib/turn.agency` (the import at line 25 and `fields: ALWAYS_FIELDS,` at line 102)
- Test: `lib/agents/agency-agent/tests/envPolicy.agency` (new) with `envPolicy.test.json`

- [ ] **Step 1: Write the failing test**

What this test must prove: the agent's own handler, built the way `turn.agency` builds it, offers "approve always here" for `std::env` and pins the name, with no table in the agent. A test that only calls `buildScopedMatch` proves nothing about the agent (it passes with `ALWAYS_FIELDS` still in place), so go through the agent's handler builder instead.

Read `policyHandlerFor` in `lib/agents/agency-agent/lib/turn.agency` (around line 95-110) and check whether it is exported or can be. Then:

```
/*
 * The agent passes no scope table of its own: the choices its policy
 * handler offers for std::env come from the effect's declaration.
 * `askUserChoices` is what the handler shows; if the agent still carried a
 * table, or the stdlib lost its tag, the (ap) choice would not be there.
 */
import { map } from "std::array"
import { askUserChoices } from "std::policy"
import { policyHandlerFor } from "../lib/turn.agency"
import { env } from "std::system"

node envOffersAlwaysHere(): string[] {
  // Installs the agent's cliPolicyHandler with the agent's own options,
  // which is the only place `fields` could still be passed from.
  policyHandlerFor("minimal", "", true)
  const intr = { effect: "std::env", data: { name: "BRAVE_API_KEY" }, expectsValue: false }
  return map(askUserChoices(intr), \item -> item.label)
}
```

with `envPolicy.test.json` expecting the labels to contain `"approve always here (name=BRAVE_API_KEY)"` (use a `contains` criterion if the runner has one; otherwise return the one matching label and use `exact`). Match `policyHandlerFor`'s real signature; the call above is a guess at its shape. The `import { env } from "std::system"` line is deliberate: it loads the module that declares `std::env`, the same way the agent does. Without it `std::env` has no registered scope in this test's process.

If `policyHandlerFor` cannot be exported without reshaping `turn.agency`, fall back to the manual check in Step 3 and say so in the PR: "the agent-side removal is covered by a manual run, not a test".

- [ ] **Step 2: Delete the table**

In `config.agency` remove the `ALWAYS_FIELDS` constant, its comment block, and `ScopedRuleFields` from the `std::policy` import if nothing else uses it. In `turn.agency` remove `ALWAYS_FIELDS` from the `./config.agency` import and the `fields: ALWAYS_FIELDS,` line in `policyHandlerFor`. Grep `lib/agents` for `ALWAYS_FIELDS` to confirm no other reader.

- [ ] **Step 3: Build and run**

```bash
make > $SCRATCH/make8.log 2>&1; tail -3 $SCRATCH/make8.log
pnpm run agency test lib/agents/agency-agent/tests/envPolicy.agency > $SCRATCH/t8.log 2>&1; tail -5 $SCRATCH/t8.log
```

Expected: pass. Also start the agent once by hand to see the prompt: `pnpm run agency agent --policy minimal -i` then ask it "what is my HOME env var". Expected prompt line: `approve always here (name=HOME)`. Quit without saving.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/agency-agent
printf 'Agent takes approve-always scopes from effect declarations\n' > $SCRATCH/msg.txt
git commit -F $SCRATCH/msg.txt
```

---

### Task 9: Dev notes and PR

**Files:**
- Create: `docs/dev/language/effect-always-tag.md`
- Modify: `docs/dev/agents/approval-policies.md` (add a section)
- Modify: `docs/dev/agents/agent-brains.md` only if it mentions `ALWAYS_FIELDS` (grep first)

- [ ] **Step 1: Write the language note**

`docs/dev/language/effect-always-tag.md`, following the shape of `docs/dev/language/validation-annotations.md` (what it is, pipeline, files, subtleties):

```markdown
# `@always` and `@alwaysUnder` on effect declarations

An effect declaration can say which of its payload fields an "approve
always here" policy rule pins:

    @always(name)
    effect std::env { name: string }

    @alwaysUnder(dir)
    effect std::read { dir: string, filename: string, offset: number, limit: number }

`@always` pins the exact value. `@alwaysUnder` pins the value and every
subpath under it (`{value,value/**}`). A declaration may carry both.
Arguments are bare field names; the tag parser rejects function calls, so
there is no `subpaths(dir)` form.

## Pipeline

1. The preprocessor attaches the tags to the `effectDeclaration` node.
2. `lib/utils/alwaysTag.ts` reads them into `ScopedField[]`.
3. The typechecker (`lib/typeChecker/effectPayloadCheck.ts`) checks every
   field exists in the payload, each tag appears once, arguments are
   identifiers, duplicate declarations agree, and the tag is on an effect
   declaration. Diagnostics: `alwaysUnknownField`, `alwaysBadArgument`,
   `alwaysRepeatedTag`, `alwaysScopeConflict`, `alwaysStrayTag`.
4. Codegen (`lib/backends/typescriptBuilder.ts`) emits
   `__registerAlwaysScope("std::env", [{"field":"name","matchSubpaths":false}]);`
   at module JS-load, next to `__registerStaticInit`. An untagged
   declaration still erases.
5. The runtime registry (`lib/runtime/alwaysScope.ts`) holds the result.
   It is process-wide, derived from code, and never checkpointed.
6. `std::policy` reads it: `alwaysScopeFor(effect)`,
   `defaultScopedFields()`, and inside `buildScopedMatch` and the prompt.

## Subtleties

- The registry fills when a module is imported. An effect raised from
  TypeScript (`mcp::call`) is covered because `stdlib/mcp.agency` declares
  it and every MCP user imports that module.
- The registry is per process. Code run through `std::agency` `run`,
  `runFile`, or `testFile` raises interrupts in a child that forwards them
  to the parent's handlers, and the parent may never have imported the
  declaring module. So each forwarded interrupt carries its scope
  (`IpcInterruptMessage.interrupt.alwaysScope`, `lib/runtime/ipc.ts`) and
  the parent registers it on receipt. `std::toolbox` depends on this.
- Values in a generated rule are escaped (`escapeGlob` in
  `lib/runtime/policy.ts`), so approving `ls *.md` saves a rule for that
  exact command. Hand-written rules stay patterns.
- The stdlib coverage test `lib/utils/alwaysTag.stdlib.test.ts` holds the
  decision table. A new stdlib effect fails it until a row is added.
- Resume: a resumed program re-imports its modules, so the registry is
  rebuilt from code and is never part of a checkpoint. This is asserted,
  not tested; the Agency test runner has no resume step to test it with.
- An untagged redeclaration of a tagged effect (the guide shows users
  writing `effect std::read { ... }`) inherits the tagged scope. Only
  tagged declarations take part in the conflict check.
```

- [ ] **Step 2: Add a section to `approval-policies.md`**

After "Where policies come from", add:

```markdown
## What "approve always here" pins

The prompt's "approve always here" answer saves a rule scoped to some of
the interrupt's data fields. Which fields is declared on the effect with
`@always` / `@alwaysUnder` (see
[effect-always-tag.md](../language/effect-always-tag.md)); the agent
passes no table of its own. `cliPolicyHandler`'s `fields:` argument is an
override: an entry replaces the declared scope for that effect, and an
empty list turns the option off. Interrupts that expect a value (a
question, a review) get no "always" answers at all.
```

Then grep `docs/dev` for `ALWAYS_FIELDS` and fix any remaining mention.

- [ ] **Step 3: Pre-PR checks**

```bash
pnpm run typecheck > $SCRATCH/tc.log 2>&1; tail -5 $SCRATCH/tc.log
pnpm run fmt:ts > $SCRATCH/fmt.log 2>&1
pnpm run lint:structure > $SCRATCH/lint.log 2>&1; tail -5 $SCRATCH/lint.log
pnpm vitest run lib/sourceIsText.test.ts lib/utils lib/runtime/alwaysScope.test.ts lib/runtime/policy.test.ts lib/stdlib/system.test.ts lib/typeChecker/effectPayloadCheck.test.ts lib/typeChecker/diagnosticExplanations.test.ts lib/backends/agencyGenerator.test.ts lib/backends/typescriptGenerator.integration.test.ts > $SCRATCH/final.log 2>&1; tail -8 $SCRATCH/final.log
git diff main --numstat | awk '$1=="-" && $2=="-"'   # must print nothing (no binaries)
```

Read the diff against `docs/dev/contributing/anti-patterns.md` and `docs/dev/contributing/verbal-tics.md` before pushing. Commit any formatter changes.

- [ ] **Step 4: Open the PR**

Write the description to a file, then:

```bash
git push -u origin adit/always-scope
gh pr create --title "Declare approve-always scopes on effect declarations (@always)" --body-file $SCRATCH/pr.md
```

The body: the Brave-key example, the tag syntax, where the registry lives, the escaping fix, the value-expecting prompt change, and a link to the spec path. Stop after the PR is open; the owner merges.

---

## Self-review against the spec

- §5.1 tag and validation: Tasks 0, 1, 2.
- §5.2 runtime path, registration at JS-load, registry outside GlobalStore, idempotent registration, TS-raised effects: Tasks 3, 4. Subprocess-raised effects (not in the spec): Task 3b.
- Undeclared `std::readBinary` / `std::writeBinary` (not in the spec): Task 7 Step 1b.
- §5.3 registry fallback, override semantics, `defaultScopedFields`: Task 5.
- §5.4 escaping, `escapeGlob` shared: Task 5.
- §5.5 `host` on `openUrl`: Task 7.
- §5.6 the table: Task 7 (as the coverage test's `EXPECTED`).
- §5.7 value-expecting interrupts: Task 6.
- §5.8 agent table removed: Task 8.
- §5.9 `agency doc` unchanged: no task, by decision.
- §7 tests: each task carries its own; the stdlib coverage test is Task 7 Step 1.
- §8 docs: Task 9.

Type consistency: `ScopedField` is declared once on the TypeScript side, in `lib/runtime/alwaysScope.ts`, and imported (type only) by `lib/utils/alwaysTag.ts` and the typechecker. `stdlib/policy.agency` keeps the Agency-side copy. `sameScopedFields` is likewise declared once and used by both the typechecker and the registry.

Tests that fail for the reason they exist, checked one by one:

- Wiring across processes: `always-scope-over-ipc` (parent never declares the effect).
- Registration at import, not at run: Task 4 Step 5b.
- Agent carries no table: Task 8's `envPolicy` goes through the agent's handler builder, or the PR says the check is manual.
- Formatter keeps tags: Task 7 Step 3b.
- Same fields, different order: a typechecker test and a registry test.
- Untagged user redeclaration stays legal: a typechecker test.
- `recordScopedRule` falls back like `buildScopedMatch`: in `policy-always-registry`.
- `openUrl` carries `host`: `open-url-host` plus `_urlHost` unit tests.

Two decisions the plan makes that the owner may want to overrule:

- A conflicting `__registerAlwaysScope` throws at import time (Task 3) and on IPC receipt (Task 3b). The typechecker already rejects the only way to reach that state within one program, so the runtime treats it as a bug, not a warning.
- `agency doc` still does not show which fields "approve always here" pins (§5.9). That is the page a user would look at. File a follow-up issue rather than widening this PR.
