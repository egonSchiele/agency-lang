# Type Printer Trivia Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `agency fmt` from deleting comments and blank lines written inside an object type, no matter where that object type appears.

**Architecture:** Add a recursive, indentation-aware type printer to the Agency formatter that handles object types carrying comments, and delegates everything else to the existing `variableTypeToString`. A cheap "does this type contain any comments?" check gates the whole thing, so any type without comments takes today's code path unchanged.

**Tech Stack:** TypeScript, Vitest, `AgencyGenerator`.

---

## Background: what is broken and why

You do not need to have read the trailing-comments work to follow this. Here is
everything that matters.

### The symptom

Agency lets you write an object type across several lines, with comments:

```agency
type User = {
  id: string // stable, never reused
  name: string
}
```

`agency fmt` reformats a file. On the type above it does the right thing and
keeps the comment. But wrap that same object type in almost anything, and the
comment is silently deleted:

```agency
type Users = {
  id: string // stable, never reused
}[]
```

formats to:

```agency
type Users = { id: string }[]
```

The comment is gone. Not moved — gone. The same loss happens when the object
type is a function parameter, a return type, or the value of a property inside
another object type.

Blank lines are lost the same way, for the same reason. A blank line between
two properties is stored in the same place a comment is.

### Why it happens

There are two different pieces of code that turn a type into text.

**The Agency formatter** is a class, `AgencyGenerator`, in
`/Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/agencyGenerator.ts`.
It has one method that knows about comments in object types:
`aliasedTypeToString`. That method checks whether the type it was handed is
*itself* an object type. If so, it prints it across multiple lines and includes
the comments. If not — and `{ ... }[]` is an *array* type, not an object type —
it gives up and calls the other piece of code.

**The shared type printer** is a plain function, `variableTypeToString`, in
`/Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptGenerator/typeToString.ts`.
It is shared between the Agency formatter and the TypeScript code generator; a
`forFormatting` flag switches a few details between the two dialects. It walks
the whole type tree recursively and always prints an object type on one line as
`{ a: string; b: number }`. It has never emitted a comment, a blank line, or a
line break inside an object type, and it has no idea what the current
indentation is.

So: comments survive only when the object type is the outermost thing in a type
alias. Everywhere else, the tree walk reaches `variableTypeToString`, which
throws the comments away.

### This is not new, and it is not from the trailing-comments work

Verified on `origin/adit/trailing-comments-integration` before any of this
change existed: `type Values = { /* a comment on its own line */ value: number }[]`
already lost the comment. The trailing-comments PRs added a second *kind* of
comment (one at the end of a line) that falls into the same existing hole. They
did not create the hole.

That matters for how you read failures: if something in this area is broken
before you start, it is probably this bug, not something you did.

### Where comments are stored

When the parser reads an object type, it records comments and blank lines in a
separate array on the object type node called `trivia`. ("Trivia" is the
long-standing name in this codebase for text that has no meaning to the program
but must survive formatting: comments and blank lines.) Each entry says which
property it belongs to, by index:

```ts
type ListTrivia = BeforeListTrivia | TrailingListTrivia;

type BeforeListTrivia = {
  anchorIndex: number;      // prints on its own line ABOVE property N
  comments: TriviaNode[];
  placement?: "before";     // omitted in practice
};

type TrailingListTrivia = {
  anchorIndex: number;      // prints at the END of property N's line
  placement: "trailing";
  comments: [LineComment];
};
```

These live in
`/Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/dataStructures.ts`.

**The parser side already works.** This was checked directly by printing the
parsed tree for both broken cases. For `type Values = { value: number // keep }[]`
the tree is:

```
arrayType
  elementType: objectType
    properties: [ value: number ]
    trivia: [ { anchorIndex: 0, placement: "trailing", comments: [ " keep" ] } ]
```

The comment is present and correctly anchored. Nothing needs to change in the
parser. **This is a rendering-only fix.**

### The tool you will reuse

`AgencyGenerator` already has a method that prints a list across multiple lines
with comments in the right places: `renderListWithTrivia`. It handles
indentation and both comment placements. Its signature:

```ts
protected renderListWithTrivia<T>(args: {
  items: T[];
  trivia: ListTrivia[] | undefined;
  open: string;
  close: string;
  renderItem: (item: T, index: number) => { leadingLines?: string[]; code: string };
  separator: (index: number, itemCount: number) => string;
}): string;
```

One detail matters a lot later: `renderItem` is a **callback**, and
`renderListWithTrivia` calls it *after* it has increased the indentation. So
anything rendered inside `renderItem` is automatically produced at the correct
depth. Code that renders list items eagerly into strings *before* calling a list
renderer does not get that, and Task 5 exists because of it.

---

## What "done" looks like

All of these format correctly and keep their comments:

```agency
type Users = {
  id: string // stable
}[]

type Shape = {
  x: number // horizontal
} | null

def save(user: {
  id: string // stable
}) { }

def load(): {
  id: string // stable
} { }

type Outer = {
  inner: {
    x: number // innermost
  }
  name: string
}
```

And a blank line between two properties survives in all of those positions too.

---

## Global Constraints

- A type containing no trivia must print **byte-for-byte** the way it does
  today. This is the single most important constraint; it is what makes the
  change safe.
- Never change `variableTypeToString`. It is shared with TypeScript code
  generation, where multi-line object types and comments would be wrong.
- Do not make display-only callers multi-line. `agency doc`
  (`lib/cli/doc.ts`), `std::agency` (`lib/stdlib/agency.ts`), template filling
  (`lib/runtime/template/fill.ts`, `lib/runtime/template/explainMismatch.ts`),
  `lib/utils/node.ts`, and `lib/utils/holes.ts` all want a single-line string
  and must keep calling `variableTypeToString` directly.
- Every formatter test asserts three things: the expected text appears, the
  output re-parses, and formatting twice gives the same result.
- Do not edit anything under `docs/site/` — no user-facing documentation
  changes in this work.
- Do not amend or force-push. Put commit messages in a file and use
  `git commit -F`.
- Run only the tests that cover what you changed; save output to a file and
  read the file rather than re-running.
- `pnpm run typecheck` is **already red** on this branch: 15 pre-existing
  errors, all in `lib/serve/`. Prove you added none by diffing against a
  baseline, not by expecting exit code 0.
- Never use `Map`, `Set`, dynamic imports, one-line `if` statements, or nested
  ternaries.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `lib/types/dataStructures.ts` | `typeHasTrivia` predicate | 1 |
| `lib/backends/agencyGenerator.ts` | Recursive trivia-aware type printer; call-site routing; lazy item rendering | 1–5 |
| `lib/backends/typeTrivia.test.ts` | All tests for this feature | 1–5 |
| `lib/formatter.test.ts` | Round-trip cases alongside existing formatter tests | 3, 5 |

Note there is no new production file. The printer belongs on `AgencyGenerator`
because it needs the generator's live indentation state and its
`renderListWithTrivia`; splitting it out would mean passing that state around
by hand.

---

## Task 1: The gate and the delegate

This task adds the recursive printer as a **pure pass-through**. It changes no
output at all. That is the point: it proves the plumbing before any behavior
moves.

**Files:**
- Modify: `lib/types/dataStructures.ts`
- Modify: `lib/backends/agencyGenerator.ts`
- Create: `lib/backends/typeTrivia.test.ts`

**Interfaces:**
- Produces: `typeHasTrivia(type: VariableType): boolean` exported from
  `lib/types/dataStructures.ts`; `protected renderTypeSource(type: VariableType): string`
  on `AgencyGenerator`.
- Consumed by: Tasks 2–5.

- [ ] **Step 1: Write the failing test**

Create `/Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typeTrivia.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { typeHasTrivia } from "@/types/dataStructures.js";
import type { VariableType } from "@/types/typeHints.js";

const numberType: VariableType = { type: "primitiveType", value: "number" };

const plainObject: VariableType = {
  type: "objectType",
  properties: [{ key: "x", value: numberType }],
};

const objectWithComment: VariableType = {
  type: "objectType",
  properties: [{ key: "x", value: numberType }],
  trivia: [
    {
      anchorIndex: 0,
      placement: "trailing",
      comments: [{ type: "comment", content: " keep" }],
    },
  ],
};

describe("typeHasTrivia", () => {
  it("is false for a leaf type", () => {
    expect(typeHasTrivia(numberType)).toBe(false);
  });

  it("is false for an object type with no trivia", () => {
    expect(typeHasTrivia(plainObject)).toBe(false);
  });

  it("is true for an object type with trivia", () => {
    expect(typeHasTrivia(objectWithComment)).toBe(true);
  });

  it("finds trivia through an array wrapper", () => {
    expect(
      typeHasTrivia({ type: "arrayType", elementType: objectWithComment }),
    ).toBe(true);
  });

  it("finds trivia through a union member", () => {
    expect(
      typeHasTrivia({
        type: "unionType",
        types: [numberType, objectWithComment],
      }),
    ).toBe(true);
  });

  it("finds trivia in a nested property value", () => {
    expect(
      typeHasTrivia({
        type: "objectType",
        properties: [{ key: "inner", value: objectWithComment }],
      }),
    ).toBe(true);
  });

  it("finds trivia in a block type return", () => {
    expect(
      typeHasTrivia({
        type: "blockType",
        params: [],
        returnType: objectWithComment,
      } as VariableType),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd /Users/adityabhargava/agency-lang/packages/agency-lang
pnpm test:run lib/backends/typeTrivia.test.ts > /tmp/tt-task1-red.txt 2>&1; echo $?
```

Expected: exit 1, with an error about `typeHasTrivia` not being exported.

- [ ] **Step 3: Add the predicate**

Append to `/Users/adityabhargava/agency-lang/packages/agency-lang/lib/types/dataStructures.ts`:

```ts
/** Whether any object type anywhere inside `type` carries comments or blank
 *  lines. The Agency formatter uses this to decide between the ordinary
 *  single-line type printer and the slower multi-line one, so that a type
 *  with no comments in it prints exactly as it always has. */
export function typeHasTrivia(type: VariableType): boolean {
  switch (type.type) {
    case "objectType":
      return (
        (type.trivia?.length ?? 0) > 0 ||
        type.properties.some((prop) => typeHasTrivia(prop.value))
      );
    case "arrayType":
      return typeHasTrivia(type.elementType);
    case "unionType":
    case "intersectionType":
      return type.types.some(typeHasTrivia);
    case "keyofType":
      return typeHasTrivia(type.operand);
    case "indexedAccessType":
      return typeHasTrivia(type.objectType) || typeHasTrivia(type.index);
    case "genericType":
      return type.typeArgs.some(typeHasTrivia);
    case "resultType":
      return typeHasTrivia(type.successType) || typeHasTrivia(type.failureType);
    case "blockType":
      return (
        type.params.some((param) => typeHasTrivia(param.typeAnnotation)) ||
        typeHasTrivia(type.returnType)
      );
    default:
      return false;
  }
}
```

Add `import type { VariableType } from "./typeHints.js";` at the top if it is
not already imported.

The `default` arm covers the leaf kinds (`primitiveType`, `stringLiteralType`,
`numberLiteralType`, `booleanLiteralType`, `typeAliasVariable`, `schemaType`,
`functionRefType`), none of which can contain an object type.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm test:run lib/backends/typeTrivia.test.ts > /tmp/tt-task1-green.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 5: Add the delegating printer**

In `/Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/agencyGenerator.ts`,
add this method next to `aliasedTypeToString`:

```ts
/** Print a type as Agency source. Types with no comments in them go
 *  through the shared single-line printer unchanged; only a type that
 *  actually carries comments takes the multi-line path, which is what keeps
 *  this change from touching existing output. */
protected renderTypeSource(type: VariableType): string {
  if (!typeHasTrivia(type)) {
    return variableTypeToString(type, this.typeAliases, true);
  }
  return variableTypeToString(type, this.typeAliases, true);
}
```

Both arms are identical on purpose. Task 2 replaces the second one. Import
`typeHasTrivia` from `../types/dataStructures.js`.

- [ ] **Step 6: Confirm nothing changed**

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts lib/formatter.test.ts > /tmp/tt-task1-nochange.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 7: Commit**

Write `/tmp/tt-task1-commit.txt`:

```text
fmt: add a trivia gate for type printing

Add typeHasTrivia and a renderTypeSource entry point that currently delegates
to the existing printer in both directions. No output changes.
```

```bash
git add lib/types/dataStructures.ts lib/backends/agencyGenerator.ts lib/backends/typeTrivia.test.ts
git commit -F /tmp/tt-task1-commit.txt
```

---

## Task 2: Print object types wherever they are nested

Now make the second arm real. This task makes the type printer recursive, so an
object type carrying comments prints multi-line no matter how deeply it is
wrapped.

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/backends/typeTrivia.test.ts`

**Interfaces:**
- Consumes: `typeHasTrivia`, `renderTypeSource`, `renderListWithTrivia`.
- Produces: a `renderTypeSource` that handles every wrapper kind.

- [ ] **Step 1: Write the failing tests**

Add to `lib/backends/typeTrivia.test.ts`:

```ts
import { formatSource } from "@/formatter.js";
import { parseAgency } from "@/parser.js";

function expectFormats(source: string, mustContain: string[]): string {
  const once = formatSource(source);
  expect(once).not.toBeNull();
  for (const fragment of mustContain) {
    expect(once).toContain(fragment);
  }
  expect(parseAgency(once as string, {}, false, false).success).toBe(true);
  expect(formatSource(once as string)).toBe(once);
  return once as string;
}

describe("object type comments survive type wrappers", () => {
  it("keeps a comment inside an array-wrapped object type", () => {
    expectFormats(`type Users = {\n  id: string // stable\n}[]\n`, [
      "id: string // stable",
      "}[]",
    ]);
  });

  it("keeps a comment inside a union member", () => {
    expectFormats(`type Shape = {\n  x: number // horizontal\n} | null\n`, [
      "x: number // horizontal",
    ]);
  });

  it("keeps a comment inside an intersection member", () => {
    expectFormats(
      `type Both = {\n  x: number // horizontal\n} & Named\n`,
      ["x: number // horizontal"],
    );
  });

  it("keeps a comment inside a generic type argument", () => {
    expectFormats(
      `type Wrapped = Container<{\n  x: number // horizontal\n}>\n`,
      ["x: number // horizontal"],
    );
  });

  it("keeps a comment inside a nested property value", () => {
    expectFormats(
      `type Outer = {\n  inner: {\n    x: number // innermost\n  }\n  name: string\n}\n`,
      ["x: number // innermost"],
    );
  });

  it("keeps a standalone comment line, not just a trailing one", () => {
    expectFormats(
      `type Users = {\n  // the primary key\n  id: string\n}[]\n`,
      ["// the primary key"],
    );
  });
});
```

- [ ] **Step 2: Run and confirm the failures**

```bash
pnpm test:run lib/backends/typeTrivia.test.ts > /tmp/tt-task2-red.txt 2>&1; echo $?
```

Expected: exit 1, six failures. The comments are missing from the output.

- [ ] **Step 3: Make the printer recursive**

Replace `renderTypeSource` in `lib/backends/agencyGenerator.ts` with:

```ts
protected renderTypeSource(type: VariableType): string {
  if (!typeHasTrivia(type)) {
    return variableTypeToString(type, this.typeAliases, true);
  }

  switch (type.type) {
    case "objectType":
      return this.renderObjectTypeSource(type);

    case "arrayType": {
      const inner = this.renderTypeSource(type.elementType);
      return this.needsParensInArray(type.elementType)
        ? `(${inner})[]`
        : `${inner}[]`;
    }

    case "unionType":
      return type.types.map((member) => this.renderTypeSource(member)).join(" | ");

    case "intersectionType":
      return type.types
        .map((member) => {
          const rendered = this.renderTypeSource(member);
          return member.type === "unionType" ? `(${rendered})` : rendered;
        })
        .join(" & ");

    case "keyofType": {
      const operand = this.renderTypeSource(type.operand);
      return this.needsParensAfterKeyof(type.operand)
        ? `keyof (${operand})`
        : `keyof ${operand}`;
    }

    case "indexedAccessType": {
      const object = this.renderTypeSource(type.objectType);
      const wrapped = this.needsParensBeforeIndex(type.objectType)
        ? `(${object})`
        : object;
      return `${wrapped}[${this.renderTypeSource(type.index)}]`;
    }

    case "genericType": {
      const args = type.typeArgs
        .map((arg) => this.renderTypeSource(arg))
        .join(", ");
      return `${type.name}<${args}>`;
    }

    case "resultType": {
      const success = this.renderTypeSource(type.successType);
      const failure = this.renderTypeSource(type.failureType);
      return `Result<${success}, ${failure}>`;
    }

    case "blockType": {
      const params = type.params
        .map((param) => {
          const rendered = this.renderTypeSource(param.typeAnnotation);
          return param.name ? `${param.name}: ${rendered}` : rendered;
        })
        .join(", ");
      // `raises` is Agency-only surface syntax and easy to drop by accident;
      // it must survive here exactly as it does in the shared printer.
      const raises = type.raises
        ? ` raises ${effectSetToSource(type.raises, this.typeAliases)}`
        : "";
      return `(${params}) -> ${this.renderTypeSource(type.returnType)}${raises}`;
    }

    default:
      return variableTypeToString(type, this.typeAliases, true);
  }
}

/** The object-type body, across lines, with its comments. */
private renderObjectTypeSource(type: ObjectType): string {
  return this.renderListWithTrivia({
    items: type.properties,
    trivia: type.trivia,
    open: "{",
    close: "}",
    renderItem: (prop) => ({
      leadingLines: (prop.tags ?? []).map((tag) => this.formatTag(tag).trim()),
      code: this.stringifyProp(prop),
    }),
    separator: (index, count) => (index === count - 1 ? "" : ";"),
  });
}
```

Then add the three parenthesization helpers, so the rules live in one place
rather than being restated at each use:

```ts
/** `(a | b)[]` must not print as `a | b[]`, which re-parses as
 *  `a | (b[])`. keyof and intersection have the same hazard. */
private needsParensInArray(element: VariableType): boolean {
  return (
    element.type === "unionType" ||
    element.type === "keyofType" ||
    element.type === "intersectionType"
  );
}

private needsParensAfterKeyof(operand: VariableType): boolean {
  return operand.type === "unionType" || operand.type === "intersectionType";
}

private needsParensBeforeIndex(objectType: VariableType): boolean {
  return (
    objectType.type === "keyofType" ||
    objectType.type === "unionType" ||
    objectType.type === "intersectionType"
  );
}
```

These mirror the rules in `variableTypeToString`. They are duplicated
deliberately: that function is shared with TypeScript code generation and must
not grow an indentation-aware mode. Task 4 adds tests that pin the duplication
so the two cannot silently drift.

Import `ObjectType` and `VariableType` from `../types/typeHints.js` if they are
not already imported.

Note the deliberate simplifications versus `variableTypeToString`:
`resultType` here always prints the two-argument form rather than the
`Result` / `Result<T>` shorthands, and `genericType` omits value arguments.
Both are unreachable on this path — a type with trivia in it contains an object
type, and neither shorthand can hold one. Task 4 adds a guard test.

One more divergence, deliberate and harmless: `variableTypeToString` breaks a
long union onto `\n  | ` continuation lines once it passes a length threshold.
The arm above always joins with `" | "`. A union containing an object type is
already going multi-line at the object type, so the threshold logic would fight
with that rather than help. It stays a stable fixed point either way, but do
not be surprised that a commented union wraps differently from an uncommented
one. The whitespace-insensitive agreement test in Task 4 will not flag it.

Note that `effectSetToSource` is already imported at the top of this file.

- [ ] **Step 4: Make `aliasedTypeToString` use the new printer**

Replace the whole body of `aliasedTypeToString` with:

```ts
protected aliasedTypeToString(aliasedType: VariableType): string {
  if (aliasedType.type === "objectType") {
    return this.renderObjectTypeSource(aliasedType);
  }
  return this.renderTypeSource(aliasedType);
}
```

The root object-type case stays explicit because a type alias whose right-hand
side is an object type prints multi-line whether or not it has comments — that
is existing behavior and must not change.

- [ ] **Step 5: Make property values recurse**

`renderObjectTypeSource` renders each property with `stringifyProp`, and
`stringifyProp` calls the single-line printer. Until that changes, an object
type nested inside another object type's property still loses its comments —
the "nested property value" test above will keep failing.

In `stringifyProp`, replace both calls:

```ts
// was: variableTypeToString(unionWithoutNull, this.typeAliases, true)
let str = `${prop.key}?: ${this.renderTypeSource(unionWithoutNull)}`;
```

```ts
// was: variableTypeToString(prop.value, this.typeAliases, true)
let str = `${prop.key}: ${this.renderTypeSource(prop.value)}`;
```

These two are part of the recursion, not of the call-site routing in Task 3;
Task 3's list excludes them because they are done here.

- [ ] **Step 6: Run the tests**

```bash
pnpm test:run lib/backends/typeTrivia.test.ts lib/backends/agencyGenerator.test.ts lib/formatter.test.ts lib/parsers/objectTypeTrivia.test.ts > /tmp/tt-task2-green.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 7: Commit**

Write `/tmp/tt-task2-commit.txt`:

```text
fmt: print object type comments through type wrappers

Make the Agency type printer recursive so an object type carrying comments
prints across lines wherever it appears, instead of only as the root of a
type alias.
```

```bash
git add lib/backends/agencyGenerator.ts lib/backends/typeTrivia.test.ts
git commit -F /tmp/tt-task2-commit.txt
```

---

## Task 3: Route the formatter's call sites

The recursive printer exists but almost nothing calls it. This task points the
formatter's fourteen type-printing sites at it.

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/backends/typeTrivia.test.ts`
- Modify: `lib/formatter.test.ts`

**Interfaces:**
- Consumes: `renderTypeSource` from Task 2.

- [ ] **Step 1: Write the failing tests**

Add to `lib/backends/typeTrivia.test.ts`:

```ts
describe("object type comments survive in every declaration position", () => {
  it("keeps a comment in a function parameter type", () => {
    expectFormats(`def save(user: {\n  id: string // stable\n}) {\n}\n`, [
      "id: string // stable",
    ]);
  });

  it("keeps a comment in a node parameter type", () => {
    expectFormats(`node save(user: {\n  id: string // stable\n}) {\n}\n`, [
      "id: string // stable",
    ]);
  });

  it("keeps a comment in a return type", () => {
    expectFormats(`def load(): {\n  id: string // stable\n} {\n}\n`, [
      "id: string // stable",
    ]);
  });

  it("keeps a comment in a variable type annotation", () => {
    expectFormats(
      `node main() {\n  const u: {\n    id: string // stable\n  } = value\n}\n`,
      ["id: string // stable"],
    );
  });

  it("keeps a comment in an effect payload type", () => {
    expectFormats(`effect io::write {\n  path: string // where\n}\n`, [
      "path: string // where",
    ]);
  });
});
```

- [ ] **Step 2: Run and confirm the failures**

```bash
pnpm test:run lib/backends/typeTrivia.test.ts > /tmp/tt-task3-red.txt 2>&1; echo $?
```

Expected: exit 1, five failures.

- [ ] **Step 3: Route every formatter call site**

In `lib/backends/agencyGenerator.ts`, replace each call of the form
`variableTypeToString(X, this.typeAliases, true)` with `this.renderTypeSource(X)`.
Task 2 already did four of the fourteen (`aliasedTypeToString` and the two in
`stringifyProp`). List what is left with:

```bash
grep -n "variableTypeToString(" lib/backends/agencyGenerator.ts
```

Each remaining one is the same mechanical edit. For example, in `renderParams`:

```ts
// was:
const typeStr = variableTypeToString(p.typeHint, this.typeAliases, true);
// becomes:
const typeStr = this.renderTypeSource(p.typeHint);
```

The remaining sites, by what they print:

| What it prints | Method |
|---|---|
| `schema(T)` expression | `processNodeInner`, `schemaExpression` case |
| A hole's type annotation | the hole renderer |
| A function or node parameter type | `renderParams` |
| A generic parameter default | `formatTypeParams` |
| A value parameter type | `formatValueParams` |
| A variable type annotation | `processAssignment` |
| Three type-pattern positions | the type-pattern renderers |
| A return type | `buildSignature` |
| A handle-block handler parameter | the handle-block renderer |

When you are done, the only `variableTypeToString` call left in this file
should be the delegate inside `renderTypeSource` itself.

Leave every call outside this file alone. `lib/cli/doc.ts`,
`lib/stdlib/agency.ts`, `lib/utils/node.ts`, `lib/utils/holes.ts`,
`lib/runtime/template/fill.ts`, and `lib/runtime/template/explainMismatch.ts`
all want a single-line string.

- [ ] **Step 4: Run the tests**

```bash
pnpm test:run lib/backends/typeTrivia.test.ts lib/formatter.test.ts lib/backends/agencyGenerator.test.ts lib/cli/doc.test.ts > /tmp/tt-task3-green.txt 2>&1; echo $?
```

Expected: exit 0. `doc.test.ts` is in the list to prove documentation output
still prints types on one line.

- [ ] **Step 5: Prove the whole standard library is unaffected**

```bash
cd /Users/adityabhargava/agency-lang/worktree-type-trivia
make > /tmp/tt-task3-build.txt 2>&1; echo "build: $?"
git status --short
```

Expected: exit 0, and `git status` shows only files you edited. `make`
recompiles every `.agency` file in the standard library and examples through
the changed printer, so a formatting regression shows up here.

- [ ] **Step 6: Commit**

Write `/tmp/tt-task3-commit.txt`:

```text
fmt: route formatter type printing through renderTypeSource

Point the formatter's type-printing sites at the trivia-aware printer.
Display-only callers keep the single-line printer.
```

```bash
cd /Users/adityabhargava/agency-lang/worktree-type-trivia/packages/agency-lang
git add lib/backends/agencyGenerator.ts lib/backends/typeTrivia.test.ts lib/formatter.test.ts
git commit -F /tmp/tt-task3-commit.txt
```

---

## Task 4: Pin the duplicated parenthesization rules

Task 2 copied three parenthesization rules out of `variableTypeToString`.
Duplicated rules drift. This task makes drift fail a test.

**Files:**
- Modify: `lib/backends/typeTrivia.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.

- [ ] **Step 1: Write the agreement tests**

Add to `lib/backends/typeTrivia.test.ts`:

```ts
// renderTypeSource duplicates variableTypeToString's parenthesization rules,
// because that function is shared with TypeScript codegen and must not learn
// about indentation. These cases fail if the two ever disagree: each type is
// printed once with a comment inside it (new path) and once without (old
// path), and the two must differ only by the comment.
describe("the two type printers agree on parentheses", () => {
  it.each([
    ["array of union", `({ x: number }PLACEHOLDER | null)[]`],
    ["array of intersection", `({ x: number }PLACEHOLDER & Named)[]`],
    ["keyof union", `keyof ({ x: number }PLACEHOLDER | Named)`],
    ["intersection containing union", `({ x: number }PLACEHOLDER | null) & Named`],
  ])("agrees on %s", (_name, shape) => {
    const withComment = shape.replace(
      "{ x: number }PLACEHOLDER",
      "{\n  x: number // c\n}",
    );
    const without = shape.replace("{ x: number }PLACEHOLDER", "{ x: number }");

    const commented = formatSource(`type T = ${withComment}\n`);
    const plain = formatSource(`type T = ${without}\n`);
    expect(commented).not.toBeNull();
    expect(plain).not.toBeNull();

    // Strip the comment and all whitespace from both, and they must match.
    const normalize = (s: string) =>
      s.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "");
    expect(normalize(commented as string)).toBe(normalize(plain as string));
    expect(parseAgency(commented as string, {}, false, false).success).toBe(true);
  });
});

// The simplified `resultType` and `genericType` arms in renderTypeSource are
// only reachable when the type contains an object type. If that ever stops
// being true, these catch it.
describe("simplified arms stay unreachable", () => {
  it("prints a bare Result shorthand through the old printer", () => {
    const once = formatSource(`type R = Result\n`);
    expect(once).toContain("type R = Result");
    expect(once).not.toContain("Result<");
  });

  it("prints a single-argument Result shorthand through the old printer", () => {
    const once = formatSource(`type R = Result<number>\n`);
    expect(once).toContain("Result<number>");
  });
});
```

- [ ] **Step 2: Run them**

```bash
pnpm test:run lib/backends/typeTrivia.test.ts > /tmp/tt-task4.txt 2>&1; echo $?
```

Expected: exit 0. If a parenthesization case fails, fix the helper in
`renderTypeSource` — do not weaken the test.

- [ ] **Step 3: Commit**

Write `/tmp/tt-task4-commit.txt`:

```text
test: pin agreement between the two type printers

Fail if the duplicated parenthesization rules drift, and if the deliberately
simplified Result and generic arms ever become reachable.
```

```bash
git add lib/backends/typeTrivia.test.ts
git commit -F /tmp/tt-task4-commit.txt
```

---

## Task 5: Indent a multi-line type correctly inside a wrapped list

This fixes a cosmetic problem that a spike confirmed is real.

**The problem.** `renderParams` turns each parameter into a string *before*
handing the list to `wrapList`. If the list then turns out to be too long,
`wrapList` increases the indentation and lays the items out on separate lines —
but the parameter strings were already built at the old indentation. A
parameter whose type is multi-line comes out under-indented:

```agency
def f(
  aaaaaaaaaaaaaaaa: {
  x: number // keep
},
  bbbbbbbbbbbbbbbbbb: string,
) {
}
```

`x: number` should be at four spaces and `}` at two.

**Severity.** Cosmetic only. This was verified: the output above still
re-parses, and formatting it a second time produces exactly the same text, so
it is a stable fixed point rather than a corruption. It needs a long parameter
list *and* a commented object type to appear at all. Fix it last, and if it
turns out to be more invasive than the steps below suggest, it is the piece to
cut.

**The cause and the cure.** `renderListWithTrivia` does not have this problem,
because its `renderItem` is a callback invoked *after* the indent increases.
`wrapList` takes finished strings. So: give the parameter path the same lazy
treatment.

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/backends/typeTrivia.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("indents a multi-line parameter type inside a wrapped parameter list", () => {
  const source =
    `def f(aaaaaaaaaaaaaaaa: {\n  x: number // keep\n}, bbbbbbbbbbbbbbbbbb: string, cccccccccccccccc: number, dddddddddddd: string) {\n}\n`;
  const once = expectFormats(source, ["x: number // keep"]);
  expect(once).toContain("\n    x: number // keep\n");
  expect(once).toContain("\n  }");
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
pnpm test:run lib/backends/typeTrivia.test.ts > /tmp/tt-task5-red.txt 2>&1; echo $?
```

Expected: exit 1 — the comment line is at two spaces, not four.

- [ ] **Step 3: Make `wrapList` render items lazily**

Change `wrapList` to take a callback instead of finished strings:

```ts
private wrapList(
  renderItems: () => string[],
  prefix: string,
  open: string,
  close: string,
  suffix: string = "",
): string {
  const inlineItems = renderItems();
  const inline = `${prefix}${open}${inlineItems.join(", ")}${close}${suffix}`;
  if (inlineItems.length === 0) {
    return inline;
  }
  if (this.indentStr(inline).length <= 80) {
    return inline;
  }
  this.increaseIndent();
  // Re-render at the deeper indent: an item that is itself multi-line
  // bakes the indentation in when it is built.
  const lines = renderItems().map((item) => this.indentStr(`${item},`));
  this.decreaseIndent();
  return `${prefix}${open}\n${lines.join("\n")}\n${this.indent()}${close}${suffix}`;
}
```

Update every `wrapList` caller to pass a function. Find them with:

```bash
grep -n "wrapList(" lib/backends/agencyGenerator.ts
```

For a caller that has a plain array with no nested rendering, `() => items` is
enough. The parameter path must pass `() => this.renderParams(node.parameters)`
so the types are re-rendered at the deeper indent.

`renderParenList` takes finished strings today; give it the same callback
treatment so it can forward one to `wrapList`.

- [ ] **Step 4: Run the tests**

```bash
pnpm test:run lib/backends/typeTrivia.test.ts lib/formatter.test.ts lib/backends/agencyGenerator.test.ts lib/parsers/listTrailingComments.test.ts > /tmp/tt-task5-green.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 5: Commit**

Write `/tmp/tt-task5-commit.txt`:

```text
fmt: indent a multi-line type inside a wrapped list

Render list items lazily so an item built at the outer indent is rebuilt when
the list decides to wrap.
```

```bash
git add lib/backends/agencyGenerator.ts lib/backends/typeTrivia.test.ts
git commit -F /tmp/tt-task5-commit.txt
```

---

## Task 6: Blank lines, and the full gate

**Files:**
- Modify: `lib/backends/typeTrivia.test.ts`

- [ ] **Step 1: Add blank-line cases**

A blank line between properties is stored in the same `trivia` array as a
comment, so it should already work. Prove it:

```ts
describe("blank lines inside object types survive too", () => {
  it("keeps a blank line between properties in a wrapped object type", () => {
    const once = expectFormats(
      `type Users = {\n  id: string\n\n  name: string\n}[]\n`,
      ["id: string"],
    );
    expect(once).toContain("id: string\n\n");
  });

  it("keeps a blank line in a parameter type", () => {
    const once = expectFormats(
      `def save(user: {\n  id: string\n\n  name: string\n}) {\n}\n`,
      ["id: string"],
    );
    expect(once).toContain("id: string\n\n");
  });
});
```

- [ ] **Step 2: Run them**

```bash
pnpm test:run lib/backends/typeTrivia.test.ts > /tmp/tt-task6.txt 2>&1; echo $?
```

Expected: exit 0. If a blank line is dropped, the cause is in
`renderListWithTrivia`'s handling of `newLine` trivia nodes, not in this
feature — fix it there and note it in the pull request.

- [ ] **Step 3: Typecheck against a baseline**

`pnpm run typecheck` is already red on this branch with 15 pre-existing errors
in `lib/serve/`. Prove you added none:

```bash
git stash -q -u
pnpm run typecheck > /tmp/tt-baseline.txt 2>&1
git stash pop -q
pnpm run typecheck > /tmp/tt-mine.txt 2>&1
diff <(grep "error TS" /tmp/tt-baseline.txt) <(grep "error TS" /tmp/tt-mine.txt) && echo "IDENTICAL"
```

Expected: `IDENTICAL`.

- [ ] **Step 4: Structural lint**

```bash
pnpm run lint:structure > /tmp/tt-lint.txt 2>&1; echo $?
```

Expected: exit 0.

- [ ] **Step 5: Full unit suite**

```bash
pnpm test:run > /tmp/tt-full.txt 2>&1; echo "unit: $?"
grep -E 'Tests |Test Files' /tmp/tt-full.txt | tail -2
```

Expected: exit 0, no failed files.

- [ ] **Step 6: Performance**

```bash
pnpm run test:perf > /tmp/tt-perf.txt 2>&1; echo $?
```

Expected: exit 0. `typeHasTrivia` runs on every type the formatter prints, so
check the formatter timing did not regress. Record the numbers in the pull
request.

- [ ] **Step 7: Audit against the anti-pattern guide**

Read `/Users/adityabhargava/agency-lang/packages/agency-lang/docs/dev/anti-patterns.md`
and confirm from `git diff`:

- `variableTypeToString` is unchanged;
- the parenthesization rules exist in exactly one place on the new path, as
  named helpers;
- display-only callers still call `variableTypeToString` directly;
- no `Map`, `Set`, dynamic import, one-line `if`, or nested ternary was added;
- nothing under `docs/site/` was touched.

- [ ] **Step 8: Open the pull request**

Base it on `adit/trailing-comments-integration`, not `main`. State in the
description that the bug was pre-existing rather than introduced by the
trailing-comments work, and give the before and after for
`type Users = { id: string // stable }[]`.

---

## Final review checklist

- [ ] A type with no comments in it prints byte-for-byte as it did before.
- [ ] `variableTypeToString` is untouched.
- [ ] Comments survive in array, union, intersection, generic-argument,
  nested-property, parameter, return-type, variable-annotation, and
  effect-payload positions.
- [ ] Blank lines survive in the same positions.
- [ ] Documentation output (`agency doc`) still prints types on one line.
- [ ] Every formatter test asserts re-parse and formatting twice.
- [ ] The duplicated parenthesization rules have agreement tests.
- [ ] `make` leaves the working tree clean.
- [ ] Typecheck matches the pre-existing baseline exactly.
