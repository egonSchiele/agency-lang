# Spec: Allow `//` and `/* */` comments inside record type definitions

## Problem

Today this fails to parse:

```ts
type Foo = {
  // a comment
  name: string,
  age: number,
}
```

Error: `Expected `}`. Did you forget to add a comma between object properties?`

Comments are accepted almost everywhere else in Agency, and the parser already preserves them so the formatter can re-emit them. Record-type bodies are an exception: even when a comment somehow parsed, the existing parser filters comments out (`lib/parsers/parsers.ts:1124-1129`) before returning, so the formatter would silently drop them anyway.

The match-block parser already accepts comments between cases (`lib/parsers/parsers.ts:2696`). We want parity for record types.

## Scope

In scope:
- `//` line comments and `/* ... */` block comments
- Three positions inside a record-type body: before the first property, between two properties, after the last property
- Multiple comments in a row in any of those positions
- Parser support **everywhere `objectTypeParser` is reachable** — top-level (`type Foo = { ... }`), inline (function params/returns, generic args, nested unions). Trivia is captured into the AST in every position.
- Formatter support for **top-level type aliases** (`type Foo = { ... }`) — i.e., wherever `aliasedTypeToString` is the renderer.
- Blank-line preservation between properties (statement-body parity, trivial to include alongside comments)

Out of scope:
- Trailing same-line comments (`name: string, // user's name`). Agency's global rule is comments live on their own line; not changed here.
- Comments inside *object literal expressions* (`{ a: 1, b: 2 }` as a value). Different parser, separate fix.
- Changing the property delimiter from `;\n` to `\n` in the formatter. The current emitter joins properties with `;\n`. Mixing `;` with comment lines is ugly but tolerable; flipping to newline-only is a visible churn across every existing fixture and belongs in its own PR.
- Forwarding `//` into generated TypeScript / Zod output. Comments are formatter-only trivia.
- **Formatter support for inline record types** (function-parameter types, nested object types). These render via `variableTypeToString` (in `lib/backends/typescriptGenerator/typeToString.ts`), which is shared with TS/Zod code generation and currently flattens object types to a single line (`{ a: number; b: string }`). Comments in inline positions are captured by the parser but dropped by the formatter. Fixing this requires threading indent context through `variableTypeToString` — a follow-up PR. Tracked as a known limitation in `lib/formatter.test.ts`.

## Design

### Key choice: side-channel, not interleave

The match-block precedent interleaves comments into the case list (`many(or(blankLineParser, commentParser, matchBlockParserCase))`). That works for `matchBlock` because `cases` is consumed only by the formatter.

`ObjectType.properties` is *not* like that. It's read in ~12 places: the typechecker (`lib/typeChecker/assignability.ts`), three TypeScript backend files (`typeToString.ts`, `typeToZodSchema.ts`, `validationDescriptor.ts`), the agency formatter, `typeWalker`, `synthesizer`, etc. Widening the entry type forces every one of those sites to filter trivia before doing semantic work, and any future consumer is one missed filter away from a bug.

Instead, attach trivia as a *separate* optional field on `ObjectType`:

```ts
// lib/types/typeHints.ts
export type ObjectTypeTrivia = {
  // Anchor: trivia appears "before the property at this index".
  // Use `properties.length` to anchor trailing trivia (after the last property).
  anchorIndex: number;
  comments: (AgencyComment | AgencyMultiLineComment | NewLine)[];
};

export type ObjectType = {
  type: "objectType";
  properties: ObjectProperty[];     // unchanged: semantic-only
  trivia?: ObjectTypeTrivia[];      // new: formatter-only, optional
  tags?: Tag[];
};
```

Invariants:
- `trivia` is sorted by `anchorIndex` ascending.
- At most one `ObjectTypeTrivia` entry per `anchorIndex`. Multiple consecutive comments at the same anchor are stored as multiple elements in that entry's `comments` array, in source order, with each element retaining its original node type (`comment` vs. `multiLineComment`). **Comments are never converted between `//` and `/* */` syntax** — the formatter dispatches on `node.type` and emits each in its original form.
- Anchor `0` means "before the first property"; anchor `properties.length` means "after the last property".
- `NewLine` entries represent blank lines (a single `NewLine` per blank-line run, matching how blank lines are handled elsewhere).

**Zero existing consumer changes.** Type semantics are unchanged. The formatter is the only thing that reads `trivia`.

### Parser

Replace the `sepBy(...)` in `objectTypeParser` (`lib/parsers/parsers.ts:1093`) with a `many` over a tagged union, so we can record whether each element is a property or trivia and in what order:

```ts
type ObjectBodyEntry =
  | { kind: "prop"; prop: ObjectProperty }
  | { kind: "trivia"; node: AgencyComment | AgencyMultiLineComment | NewLine };

const objectMemberParser = map(
  seqC(
    capture(
      or(
        taggedObjectPropertyParser,
        objectPropertyWithDescriptionParser,
        objectPropertyParser,
      ),
      "prop",
    ),
    optional(objectPropertyDelimiter),
  ),
  (r) => ({ kind: "prop", prop: r.prop } as ObjectBodyEntry),
);

const objectTriviaParser = or(
  map(blankLineParser, (n) => ({ kind: "trivia", node: n } as ObjectBodyEntry)),
  map(commentParser, (c) => ({ kind: "trivia", node: c } as ObjectBodyEntry)),
  map(multiLineCommentParser, (c) => ({ kind: "trivia", node: c } as ObjectBodyEntry)),
);

const objectBodyParser = many(or(objectTriviaParser, objectMemberParser));
```

Post-process the resulting `ObjectBodyEntry[]` into `{ properties, trivia }`:

```ts
const properties: ObjectProperty[] = [];
const trivia: ObjectTypeTrivia[] = [];
let pending: (AgencyComment | AgencyMultiLineComment | NewLine)[] = [];

for (const entry of entries) {
  if (entry.kind === "trivia") {
    pending.push(entry.node);
  } else {
    if (pending.length) {
      trivia.push({ anchorIndex: properties.length, comments: pending });
      pending = [];
    }
    properties.push(entry.prop);
  }
}
if (pending.length) {
  trivia.push({ anchorIndex: properties.length, comments: pending });
}

return success(
  { type: "objectType", properties, ...(trivia.length ? { trivia } : {}) },
  result.rest,
);
```

Delete the existing filter at `parsers.ts:1124-1129`.

**Delimiter / required-comma behavior is preserved.** Because both `objectMemberParser` and `objectTriviaParser` consume their own trailing whitespace/newline (and `commentParser` already eats its trailing newline — see `parsers.ts:259-268`), `many(or(...))` does not require a separator between entries. But `objectPropertyParser` does NOT consume a trailing delimiter on its own — it's the `optional(objectPropertyDelimiter)` in `objectMemberParser` that consumes one (and only one) `,;\n` after a property. So:

- `name: string\n age: number` — first prop consumes its trailing newline as delimiter; second prop has no delimiter. Works (legal today).
- `name: string  age: number` (no separator, both on one line) — second prop fails to start because there's no `,;\n` after the first. Fails (illegal today). Preserved.
- `name: string\n // c\n age: number` — first prop consumes its `\n`. Comment runs. Second prop runs. Works (new).
- `name: string // c\n age: number` (same-line trailing comment) — `optional(objectPropertyDelimiter)` matches `\n` only after `optionalSpaces`, but `commentParser` eats from the cursor with its own leading `optionalSpaces`. So the first prop will NOT consume a delimiter (the space-then-`//` is not `,;\n`), the comment parser will start, eat the `// c\n`, and then `age:` parses. That accidentally makes trailing same-line comments work for the *parser*. But they'll be attached as `anchorIndex: 1` trivia (preceding `age`), not as a trailing comment on `name`, so the formatter will re-emit them on their own line — consistent with the global "comments live on their own line" rule. **Note this in a comment in the post-processor.** No behavior change vs. spec scope; just a graceful degradation.

The outer `parseError("Expected `}`...", char("}"))` still fires when `many` can't make progress — the existing error message is preserved.

### Formatter

Replace `aliasedTypeToString` (`lib/backends/agencyGenerator.ts:649-666`) with a loop that interleaves trivia at the recorded anchor indices:

```ts
protected aliasedTypeToString(aliasedType: VariableType): string {
  if (aliasedType.type === "objectType") {
    this.increaseIndent();
    const lines: string[] = [];
    const trivia = aliasedType.trivia ?? [];
    const triviaByAnchor = new Map<number, ObjectTypeTrivia>();
    for (const t of trivia) triviaByAnchor.set(t.anchorIndex, t);

    const emitTrivia = (anchor: number) => {
      const t = triviaByAnchor.get(anchor);
      if (!t) return;
      for (const node of t.comments) {
        if (node.type === "newLine") {
          lines.push(""); // blank line
        } else if (node.type === "comment") {
          lines.push(this.indentStr(`//${node.content}`));
        } else {
          // multiLineComment
          lines.push(this.indentStr(this.processMultiLineComment(node)));
        }
      }
    };

    for (let i = 0; i < aliasedType.properties.length; i++) {
      emitTrivia(i);
      const prop = aliasedType.properties[i];
      const isLast = i === aliasedType.properties.length - 1;
      // Match the existing emitter: properties joined with ";\n", last has no ";"
      lines.push(this.indentStr(this.stringifyProp(prop)) + (isLast ? "" : ";"));
    }
    emitTrivia(aliasedType.properties.length); // trailing trivia

    this.decreaseIndent();
    return "{\n" + lines.join("\n") + "\n" + this.indentStr("}");
  }
  return variableTypeToString(aliasedType, this.typeAliases, true);
}
```

Notes:
- `processMultiLineComment` is the existing helper used elsewhere in `agencyGenerator.ts` for `/* ... */`. Reuse it as-is — don't reinvent leading-space normalization.
- For `//` comments we emit `//${content}` to mirror how `commentParser` captures content verbatim after `//`. Verify against an existing call site in `agencyGenerator.ts` (e.g., the match-block formatter) and copy that convention exactly.
- Property `;` separator is preserved (out of scope to change). Comments do not get `;`.

### Consumer audit

Because `properties` is unchanged, no semantic consumer needs to change:

- `lib/typeChecker/assignability.ts` (10+ sites reading `.properties`) — unchanged.
- `lib/backends/typescriptGenerator/typeToString.ts`, `typeToZodSchema.ts`, `validationDescriptor.ts` — unchanged.
- `lib/typeChecker/typeWalker.ts`, `synthesizer.ts`, etc. — unchanged.
- `variableTypeToString` (rendering types in error messages) — unchanged. Errors won't show comments because they don't read `trivia`.
- `__agency_descriptor` walker (`docs/dev/validation-annotations.md`) — unchanged.

The only consumer that needs updating is `agencyGenerator.ts:aliasedTypeToString`.

## Acceptance criteria

1. `pnpm run ast` parses each of the following without error:
   ```ts
   type Foo = { // leading
     name: string,
     age: number,
   }
   type Bar = {
     name: string,
     // between
     age: number,
   }
   type Baz = {
     name: string,
     age: number,
     // trailing
   }
   type Qux = {
     /* block leading */
     name: string,
   }
   type Quux = {
     // first
     // second
     name: string,

     age: number,
   }
   ```
2. For each example in (1), `pnpm run fmt` is idempotent (`fmt(fmt(x)) === fmt(x)`) AND preserves the *position* of every comment (leading stays leading, between stays between, trailing stays trailing) and the *order* of consecutive comments.
3. Inline record types accept comments identically:
   ```ts
   def f(x: {
     // a
     a: number,
     b: string,
   }): { /* result */ r: number } { ... }
   ```
4. The type checker sees the same type with or without comments: assignability, structural compatibility, and error messages are byte-identical between `{ a: number, b: string }` and `{ /* c */ a: number, // c2\n b: string }`.
5. Generated TypeScript and Zod schemas for a record type contain no trace of any comment.
6. All existing record-type round-trip tests in `lib/formatter.test.ts` and `lib/backends/agencyGenerator.test.ts` pass without modification.
7. New parser tests in `lib/parsers/parsers.test.ts` (or a sibling) cover: leading / between / trailing / multiple-consecutive / block-comment / blank-line / inline-record-type positions.
8. New formatter tests cover the same positions and assert idempotency.
9. `make` passes.
10. `pnpm run lint:structure` passes.
11. `pnpm run agency test <file>` passes for any new agency-level test that defines a record type with comments and exercises it at runtime (e.g., constructs a value and calls a node that takes the type).

## Implementation order

1. **Add `ObjectTypeTrivia` type and `trivia?` field on `ObjectType`** in `lib/types/typeHints.ts`. Compile — should produce *zero* errors (field is optional, no consumers read it).
2. **Update `objectTypeParser`** in `lib/parsers/parsers.ts:1093`: replace the `sepBy` body, delete the filter at lines 1124-1129, emit `trivia` when non-empty. Add parser tests.
3. **Update `aliasedTypeToString`** in `lib/backends/agencyGenerator.ts:649`. Add formatter tests.
4. **Run `make fixtures`** — there should be no diffs to existing fixtures because (a) `properties` is unchanged and (b) old fixtures have no comments inside record types. If any fixture diffs, investigate before regenerating.
5. **Run `make`** and `pnpm run lint:structure`.
6. Spot-check with one agency execution test that constructs and consumes a record-typed value defined with a comment.

## Risks

- **Trivia stripped by AST transformations.** If any preprocessor reconstructs an `ObjectType` from scratch (e.g., `validationDescriptor.ts` line 240), the new value won't carry `trivia`. That's *fine* — those reconstructions are semantic, not user-facing source, and the formatter never sees them. No action needed. But: if there's a code path that pretty-prints a *transformed* `ObjectType` back into source for the user (the formatter loop on already-walked types), trivia loss is expected and acceptable. Grep for `aliasedTypeToString` callers to confirm — there should be exactly one (`processTypeAlias`).
- **AST JSON snapshot churn.** `pnpm run ast` output for any record-type fixture that previously had no `trivia` field is unchanged; new fixtures that exercise comments add a `trivia` array. Anyone who diffs ASTs across versions will see the new optional field. Acceptable.
- **Parser ambiguity on trailing same-line comments.** Documented above — falls into "trivia anchored at next property" with no behavior change vs. the global rule. Add a unit test that pins this behavior.
- **Tag-prefixed properties.** `taggedObjectPropertyParser` already wraps a property and attaches tags. The new body parser tries it first, so a comment *between* a `@tag(...)` line and its property would parse as a comment, not as part of the tag block, and the tag block would then fail to find its property — i.e., `// c\n@validate(x)\nemail: string` works (comment attached to property index), but `@validate(x)\n// c\nemail: string` would break the tag binding. **Add a test that pins both:** comments are allowed before tag blocks but NOT between a tag and its property. If users want them between, that's a separate spec.

## Open questions

None — moved everything from the original spec's Open Questions into Scope (blank lines: in), Out of Scope (`;` → `\n`, same-line trailing comments), or Risks (tag-prefixed properties).
