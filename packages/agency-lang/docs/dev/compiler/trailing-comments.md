# Trailing comments

How `agency fmt` keeps an end-of-line `//` comment where the author wrote it.

## The problem this solves

Before this existed, the formatter moved an end-of-line comment onto its own
line, above whatever came next. That silently changed what the comment appeared
to describe:

```agency
const x = 5 // explains x        →      const x = 5
const y = 6                             // explains x
                                        const y = 6
```

Being permissive here produced a *wrong result*, not merely an untidy one. The
same loss happened inside object types, where a wrapped object type dropped its
comments entirely.

## Two mechanisms, and which one applies

There are two, and picking the wrong one is the most common mistake.

**A complete construct** — a top-level declaration, a statement in any body, or
a match arm — carries its comment on the node itself:

```ts
// lib/types/base.ts
export type BaseNode = {
  loc?: SourceLocation;
  trailingComment?: LineComment;
};
```

**An item in a multiline list** — an array element, an object property, a call
argument, a parameter, an import name, a pattern element, a `thread` argument —
does *not* use `trailingComment`. List items are not separate AST nodes with a
common base, so their comments live in the list owner's `trivia` array, keyed by
the index of the item they belong to:

```ts
// lib/types/dataStructures.ts
type BeforeListTrivia = {
  anchorIndex: number;      // prints on its own line ABOVE item N
  comments: TriviaNode[];
  placement?: "before";     // never written by a parser
};

type TrailingListTrivia = {
  anchorIndex: number;      // prints at the END of item N's line
  placement: "trailing";
  comments: [LineComment];
};
```

The rule of thumb: if the thing has its own AST node in a statement stream, it
gets `trailingComment`. If it is an element of a comma-separated list, it gets a
`placement: "trailing"` entry in the owner's trivia.

`placement` is deliberately optional on the before-variant and no parser ever
writes `"before"`. That is what keeps every AST that predates this feature
byte-for-byte unchanged, and the existing assertions in
`lib/parsers/dataStructures.test.ts` and `lib/parsers/objectTypeTrivia.test.ts`
are the check on it. Do not start writing `placement: "before"`.

## Rule 1: one owner for the end of the line

`completeConstructEntry` in `lib/parsers/parsers.ts` wraps a construct parser
and owns everything to the end of that line: the construct, an optional
same-line comment, and the layout that terminates it.

It attaches a comment only when the construct's own parser has **not** already
consumed the line ending. That check is what stops a standalone comment on the
*next* line from being pulled up onto the previous statement.

The consequence for anyone adding a statement form: **a construct parser inside
one of these streams must not consume its own trailing newline.** Three streams
are wrapped today — the top level (`lib/parser.ts`), function and node bodies,
and match arms. When `completeConstructEntry` was introduced, all three had to
stop consuming that whitespace themselves, because `lineCommentCore`
deliberately stops *before* the newline and something has to consume it exactly
once.

Two helpers decide "did we cross a line", and they are not interchangeable:

- `consumedLineEnding(input, rest)` looks only at the **trailing whitespace** of
  what was consumed. Use it when an item may legitimately span several lines
  internally — it still counts as ending on its last line.
- `spanCrossesLine(from, to)` looks for a newline **anywhere** in the span. Use
  it for something that must sit entirely on one line, such as the delimiter
  between two list items.

Getting these backwards causes real bugs in both directions. A nested list
parser consumes the layout after its own closing brace, so the *next* line's
standalone comment ends up sitting exactly where a trailing comment would be
and gets stolen — that needs the trailing-whitespace rule. Meanwhile
`first\n, // c` must be refused, which needs the anywhere-in-the-span rule
applied to the delimiter alone.

Blank lines are sentinel characters (`BLANK_LINE_SENTINEL`) by the time parsing
runs, not `\n`. Any line-crossing check must treat the sentinel as a line
ending.

## Rule 2: reordering means remapping

The formatter does not always print list items in source order. It sorts
imports, moves an inline block argument to last, and prints `thread` arguments
in a fixed canonical order.

Trivia is anchored by **index**. So any path that reorders items must translate
the anchors, or every comment silently stays at its old position and ends up
describing the wrong thing:

```ts
remapListTrivia(trivia, canonicalSourceIndexes)
```

`canonicalSourceIndexes[c]` is the source index of the item that ends up at
canonical position `c`. A before-comment stays with the item it preceded; a
trailing comment stays with the item it followed.

It throws if the index list is not a permutation of the source items. That guard
catches a *malformed* remap — it cannot catch a **forgotten** one. If you add a
formatter path that reorders a list, nothing will fail; the comments will just be
wrong. Add a test that writes the items out of canonical order and asserts each
comment lands on its own item.

## Rule 3: state the list policy

`commaDelimitedList` is the shared parser for a comma-separated list that may
span lines. Every call site passes a policy rather than relying on a default,
because these genuinely differ across the grammar and getting one wrong silently
widens what the language accepts:

```ts
type CommaListPolicy = {
  closer: string;
  cardinality: "zero-or-more" | "one-or-more";
  trailingComma: "allow" | "reject";
};
```

| Policy | Sites | Cardinality | Trailing comma |
|---|---|---|---|
| `CALL_ARGUMENT_LIST` | call arguments, `def`/`node` parameters | zero-or-more | allow |
| `NAMED_ARGUMENT_LIST` | `thread` / `parallel` arguments | zero-or-more | allow |
| `IMPORT_NAME_LIST` | `import { a, b }` | one-or-more | allow |
| `IMPORT_NODE_LIST` | `import node { a, b }` | one-or-more | **reject** |
| `EXPORT_NAME_LIST` | `export { a, b } from` | one-or-more | allow |
| `ARRAY_PATTERN_LIST` | array binding and match patterns | zero-or-more | **reject** |
| `OBJECT_PATTERN_LIST` | object binding and match patterns | zero-or-more | **reject** |

`NAMED_ARGUMENT_LIST` and `CALL_ARGUMENT_LIST` are identical today. They are kept
as separate names because they answer to different grammars and only coincide by
accident; collapsing them would make a future divergence look like a bug.

**Adding a new list site:** read the grammar it has today before choosing.
`sepBy1` means one-or-more, `sepBy` means zero-or-more, and a trailing
`optional(comma)` means the trailing comma is allowed. Then pin your `reject`
choice with a negative test asserting the trailing comma still fails. Those
negative tests are not ceremony — when the reject policy was first written its
closer-lookahead did not skip whitespace, so every reject site was still quietly
permissive and only the negative tests caught it.

Object *type* members are the one list that does not use this helper. A newline
is itself a legal delimiter there, so a comment can appear on either side of it
and the site has its own policy (`objectMemberEntry`).

## Rule 4: never export an unwrapped stream parser

A parser meant for a statement stream should only be reachable in its wrapped
form. `matchBlockParserCase` is the model: the implementation is
`matchBlockParserCaseInner`, kept module-private, and only the
`completeConstructEntry`-wrapped version is exported.

Following this means a future construct either reuses `bodyParser` and gets
comment support for free, or opts out visibly. Exporting the raw parser makes it
easy to build a new stream that silently drops comments.

## Rendering

`commentText` is the only thing that builds `//${content}`. `appendTrailingComment`
is the only thing that places one after code. `renderListWithTrivia` owns
indentation and both comment placements for lists; callers hand it their existing
item renderer and a separator policy and must not place comments themselves.

Trivia-free code keeps its existing inline or wrapping behavior exactly. A
comment forces the multiline form, because a `//` cannot share a line with what
follows it.

Type printing works slightly differently. `variableTypeToString` remains the one
recursive type printer and is shared with TypeScript codegen; the Agency
formatter passes it an optional `TypePrintHooks.objectType` hook that takes over
only for an object type carrying trivia. Every recursive edge forwards the hook.
Display paths — `signatureOf`, `agency doc`, `std::agency`'s `describe` — pass no
hook and stay compact and comment-free.

## The three ways this regresses

Each of these bit this feature at least once during development, and they share
one symptom: a comment that parsed correctly vanishes from the output.

1. **A new statement stream that does not use `completeConstructEntry`.**
2. **A generator path that renders nodes without going through `processNode`.**
   Sorted imports do exactly this, which is why comment placement is repeated in
   `sortAndRenderImports`.
3. **A node kind with more than one parser or renderer, where only one was
   updated.** Four parsers hand-build their AST node and copied only the fields
   they knew about: `guardBlockParser`, `namedImportParser`,
   `namedExportBodyParser`, and the mixed-import render path. A mixed import
   (`import tools, { a }`) renders through `processImportNameType`, not through
   the sole-named-import path.

If you are touching this area, grep for *every* parser and *every* renderer of
the node kind you are changing. The common case passing is not evidence the
others do.

## Deliberate non-goals

Block comments (`/* ... */`) never attach — "trailing" has no meaning when code
can follow on the same line. Trivia nodes (comments, blank lines) never own a
trailing comment themselves. Inline-only grammars stay inline-only: tags,
generics, value-parameterized types, effect and `raises` lists, block and lambda
parameters, and `new` arguments.

Attaching a comment never extends the owner's `loc`. Source maps and the
language server read `loc`, and the comment is formatting data, not part of the
construct.
