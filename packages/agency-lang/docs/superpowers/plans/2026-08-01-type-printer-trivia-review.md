# Review: Type Printer Trivia Implementation Plan

## Recommendation: revise before implementation

The plan correctly identifies the data-loss bug and the formatter as the right
owner of multiline layout. It also has good round-trip and idempotence goals.
However, the proposed implementation is not yet a small or safe follow-up. Its
central design creates a second, incomplete type printer inside
`AgencyGenerator`. That duplicates syntax and precedence logic already owned by
`variableTypeToString`, and the proposed printer already has reachable cases
that change or delete valid source.

The smallest robust design is to keep one recursive type printer and give it an
optional object-type rendering hook. The Agency source formatter can provide a
trivia-aware hook; TypeScript generation and display-only consumers can omit
it and retain their exact current output.

## Explicit audit against `docs/dev/anti-patterns.md`

### Does the plan neatly encapsulate imperative code behind declarative interfaces?

**Not yet.** It makes a partial attempt, but the boundary is misleading.

At the call site, this looks declarative:

```ts
this.renderTypeSource(type)
```

The caller says what it wants—Agency source for a type—without managing the
tree walk or indentation. That part is good. However, `renderTypeSource` then
implements a second copy of the type grammar using a large imperative switch:

```ts
switch (type.type) {
  case "arrayType":
    // Reimplement array syntax and precedence.
  case "unionType":
    // Reimplement union syntax.
  case "genericType":
    // Reimplement generic syntax.
  // ...and so on.
}
```

This does not neatly separate the "what" from the "how." It hides the new
implementation from its immediate callers, but it does not encapsulate the
underlying complexity in its existing owner. Ordinary type syntax now has two
implementations, and changing the grammar requires knowing that both must be
updated.

The plan's Task 4 tests make this leak especially visible. Tests must know that
there are two printers, know which precedence rules were copied, strip trivia
and whitespace, and compare selected outputs. In other words, the duplicated
implementation becomes part of the maintenance interface.

A genuinely declarative boundary is:

```ts
variableTypeToString(type, aliases, true, {
  objectType: (object, printChild) =>
    object.trivia?.length
      ? this.renderObjectTypeSource(object, printChild)
      : undefined,
});
```

This says: "use the canonical type printer, but give trivia-bearing object
types formatter-owned layout." The shared printer still encapsulates the
imperative tree traversal, grammar, precedence, and shorthand rules.
`AgencyGenerator` encapsulates only indentation and comment placement. Each
kind of complexity has one owner.

The example above uses a ternary only to illustrate the policy compactly. The
implementation should use an ordinary `if` block to follow this repository's
readability rules:

```ts
objectType: (object, printChild) => {
  if (!object.trivia?.length) {
    return undefined;
  }
  return this.renderObjectTypeSource(object, printChild);
},
```

### Anti-patterns the plan does contain

| Anti-pattern | Verdict | Where it appears |
|---|---|---|
| **Duplicating existing code** | **Yes, severe** | Task 2 copies most of `variableTypeToString`, including precedence, wrappers, generic rendering, results, unions, and block types. |
| **Imperative code everywhere** | **Yes, structurally** | The second switch owns another full tree walk instead of declaring only the object-type formatting policy. `typeHasTrivia` adds a third traversal. |
| **Order-dependent mutable state** | **Yes, moderate** | Task 5 calls a rendering callback, changes `indentLevel`, calls it again, then restores the state. Correctness depends on call order and balanced mutation. |
| **Leaky abstractions** | **Yes, severe** | Task 4's tests know about two printers and their duplicated precedence rules. Task 3 also assumes call location determines source-versus-display policy, but `signatureOf` crosses that boundary. |
| **Useless special cases** | **Yes** | The separate `typeHasTrivia` gate and deliberately simplified `genericType`/`resultType` arms exist only because of the duplicated printer. The simplified arms are also incorrectly claimed to be unreachable. |
| **Inconsistent patterns** | **Yes, severe** | Ordinary types use the shared printer, while trivia-bearing types use a different printer with different union wrapping, result shorthand, and generic behavior. |
| **Single-character variable names** | **Minor** | Task 4 introduces `normalize = (s: string) => ...`. Use `source` or `formatted` instead. |

### Catalog entries the proposed code does not appear to add

The plan does **not** appear to introduce nested ternaries, one-line `if`
statements, dynamic imports/requires, `Map`, `Set`, unlogged `catch` blocks,
unsafe file deletion, deeply nested object type definitions, or catastrophic
tests. The existing `80`-column threshold is reused rather than introducing a
new unexplained magic number.

Those clean details are worth preserving, but they do not offset the central
duplication and abstraction problems.

## Blocking findings

### 1. The second type printer is duplicated code, and it already loses syntax

Task 2 reimplements arrays, unions, intersections, `keyof`, indexed access,
generics, results, and block types. This is the "duplicating existing code"
anti-pattern in `docs/dev/anti-patterns.md`. The proposed agreement tests do
not make the duplication safe; they only compare four examples and still
leave two sources of truth.

There are already concrete regressions in the proposed implementation.

#### Generic value arguments are dropped

The proposed `genericType` arm prints only the name and type arguments:

```ts
return `${type.name}<${args}>`;
```

But generic types can also carry `valueArgs`, which the existing printer
preserves. This path is reachable:

```agency
type T = Container<{
  x: number // keep
}>(3)
```

Because the generic contains object trivia, it takes the new path and formats
without `(3)`.

#### `Result` shorthand changes on a reachable path

The plan says the simplified `resultType` arm is unreachable, but it is
reachable whenever either result argument contains a commented object type:

```agency
type Loaded = Result<{
  value: string // keep
}>
```

The existing printer emits the one-argument `Result<T>` form when the failure
type is `string`. The proposed printer always emits `Result<T, string>`. That
violates the plan's byte-for-byte compatibility constraint.

The proposed "simplified arms stay unreachable" tests do not exercise a
trivia-bearing generic or result. They only prove that trivia-free values take
the old path, so they cannot catch either bug.

#### Other rules would have two owners

The plan also duplicates:

- array, `keyof`, indexed-access, and intersection parentheses;
- effect-set handling in unions;
- long-union wrapping;
- block-type syntax and `raises` handling;
- generic and result canonicalization.

A test suite can sample these rules, but it cannot remove the maintenance cost
or guarantee that future printer changes are copied to both implementations.

### 2. Use a declarative rendering hook instead

The shared printer should continue to own recursion and all ordinary type
syntax. Give it an optional formatter hook for the one syntax node that needs
special layout:

```ts
type TypePrintHooks = {
  objectType?: (
    type: ObjectType,
    printChild: (child: VariableType) => string,
  ) => string | undefined;
};
```

Conceptually, the existing object-type branch becomes:

```ts
if (variableType.type === "objectType") {
  const rendered = hooks?.objectType?.(
    variableType,
    (child) => variableTypeToString(child, typeAliases, forFormatting, hooks),
  );
  if (rendered !== undefined) {
    return rendered;
  }

  // Existing inline object rendering remains unchanged.
}
```

Every existing recursive call forwards the same hooks. `AgencyGenerator`
provides a hook that renders an object type multiline only when that object has
trivia. This gives consumers a declarative interface—"render object types this
way when appropriate"—while leaving the imperative indentation logic
encapsulated in `AgencyGenerator`.

This design eliminates:

- `typeHasTrivia`;
- the second recursive printer;
- all three duplicated precedence helpers;
- Task 4's printer-agreement tests;
- the double traversal of every formatted type.

It also naturally finds trivia at any printed depth without maintaining a
second list of recursive `VariableType` edges.

### 3. `typeHasTrivia` duplicates an existing traversal and is incomplete

If the gate is retained, it should use the existing declarative `visitTypes`
abstraction rather than implement another type-tree traversal:

```ts
return visitTypes(type, (nested) =>
  nested.type === "objectType" && (nested.trivia?.length ?? 0) > 0
);
```

More importantly, the plan incorrectly calls `schemaType` and
`functionRefType` leaves. They contain nested types:

```ts
type SchemaType = {
  type: "schemaType";
  inner: VariableType;
};

type FunctionRefType = {
  params: FunctionParameter[];
  returnType: VariableType | null;
  raises?: VariableType;
};
```

The proposed traversal also ignores `blockType.raises`. The existing
`visitTypes` is itself missing the `raises` edges, so reusing it would first
require deciding and testing its child-edge contract. The rendering-hook
design avoids this unrelated walker work because it follows exactly the nodes
the printer actually prints.

### 4. Routing every `AgencyGenerator` call also changes user-facing docs

Task 3 says display-only consumers are protected because direct calls outside
`agencyGenerator.ts` remain unchanged. That is not true.

Both `agency doc` and `std::agency` create an `AgencyGenerator` and call
`signatureOf`. `signatureOf` delegates to the methods Task 3 changes:

```diagram
agency doc / std::agency
          │
          ▼
     signatureOf
          │
          ├──▶ buildSignature ──▶ renderParams / return type
          │
          └──▶ aliasedTypeToString
```

Therefore, a comment inside a parameter, return type, or nested alias can make
a user-facing signature multiline and expose formatter trivia. Running the
current doc tests does not prove otherwise because the plan adds no commented
signature cases.

Make the rendering policy explicit:

- source formatting uses the trivia-aware hook;
- `signatureOf` uses the existing plain rendering policy;
- add exact regression tests for `agency doc` and `std::agency` describe with
  comments in alias, parameter, and return types.

Do not rely on an allowlist of direct calls outside one file to define this
boundary.

## Important findings

### 5. Task 5 is too broad and renders stateful content twice

Changing `wrapList` and every caller to callbacks broadens this fix into calls,
arrays, imports, and every parenthesized list. The callback is invoked once to
measure and again after mutating `indentLevel` to render. Even if current
parameter rendering is safe to repeat, "render this arbitrary content twice"
is a fragile contract for a stateful generator.

Prefer a local layout operation: when `wrapList` chooses multiline output,
indent every continuation line in an already rendered item by one additional
indent level. For example:

```ts
private indentContinuationLines(item: string): string {
  const continuationIndent = this.indent(1);
  return item
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : continuationIndent + line))
    .join("\n");
}
```

Then use that only in `wrapList`'s wrapped branch. One-line items remain
unchanged, multiline parameter types gain the missing indentation, and no
content is rendered twice. If a lazy callback is still preferred, scope it to
signature parameters rather than converting every list caller.

### 6. Coverage does not support the plan's completeness claim

The wrapper tests should include exact-output cases for at least:

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

Also test each formatter-facing source position that the plan routes: schema
expressions, holes, type patterns, generic defaults, value-parameter types,
handler parameters, and finalize parameters. `toContain` alone is insufficient
for wrapper semantics; assert exact canonical output where suffixes,
parentheses, shorthand, or value arguments could be lost.

### 7. The plan's absolute paths point at the wrong checkout

The plan is in:

```text
/Users/adityabhargava/agency-lang/worktree-type-trivia/packages/agency-lang
```

but many instructions edit or `cd` to:

```text
/Users/adityabhargava/agency-lang/packages/agency-lang
```

Following those commands would modify and test the main checkout instead of
this worktree. Remove the absolute paths. State once that commands run from
`packages/agency-lang` in the current worktree, then use relative paths.

### 8. Several verification steps do not verify what they claim

- The Task 6 typecheck baseline is captured after Tasks 1–5 are committed.
  `git stash` does not remove those commits, so the "baseline" already includes
  nearly the complete implementation. Capture the baseline before Task 1 or
  compare with the base commit in another worktree.
- `make` rebuilds much more than source formatting and can regenerate tracked
  files, including content under `docs/site/`, contrary to this work's stated
  constraint. Use targeted formatter round-trip tests instead unless a
  standard-library source file changes.
- The final full test and performance suites contradict the earlier instruction
  to run only tests covering the change. Focus first on missing exact wrapper,
  source-position, and display-consumer tests.

## Parser finding from the preceding review

The separate parser bug reported on PR #768 is already fixed in this branch.
`objectMemberEntry` now checks `consumedLineEnding(input, item.rest)` both before
trying a pre-delimiter trailing comment and before trying a post-delimiter one.
This prevents a standalone comment after a multiline nested object type from
attaching to the previous property. This follow-up does not need another parser
change for that issue.

## Suggested revised scope

1. Add an optional object-type rendering hook to the existing recursive type
   printer, with no-hook behavior pinned as unchanged.
2. Add a formatter-owned `renderTypeSource` that installs the hook.
3. Let `renderObjectTypeSource` and `stringifyProp` use the hook's recursive
   `printChild` callback.
4. Route source-formatting positions through that policy while keeping
   `signatureOf` explicitly on its display policy.
5. Fix multiline continuation indentation locally in `wrapList`.
6. Add exact wrapper, source-position, idempotence, reparse, and display-policy
   tests.

This is still a moderate follow-up, but it is substantially smaller and less
risky than maintaining a second type grammar inside `AgencyGenerator`.
