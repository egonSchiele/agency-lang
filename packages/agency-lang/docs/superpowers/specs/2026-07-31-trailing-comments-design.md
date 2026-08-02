# Trailing comments

## Goal

Agency preserves a same-line `//` comment beside the complete construct it
describes when `agency fmt` reformats the file.

Users learn one rule:

> A `//` comment written at the end of a complete declaration, statement,
> match arm, or item in a multiline list stays attached to that construct.
> In a comma-separated list, write the comma before the comment.

```agency
type UserId = string // top-level declaration

node main() {
  const ids = [
    1, // first item
    2, // second item
  ]

  save(
    ids, // values to save
    retries: 3, // retry budget
  ) // complete call statement
}
```

The rule follows Agency's existing layout grammar rather than parser
implementation boundaries. It applies to complete constructs and to item lists
that already permit line breaks. It does not make an inline-only grammar
multiline merely to admit comments.

## Problem

Today Agency usually parses a trailing comment but loses its placement. For
example:

```agency
const x = 5 // explains x
const y = 6
```

formats as:

```agency
const x = 5
// explains x
const y = 6
```

The text survives, but the formatter makes it appear to describe `y`. Similar
relocation occurs at top level, in match arms, and in trivia-aware lists such as
arrays, objects, and object types. Other multiline lists, including calls and
function parameters, reject comments because they have no trivia model.

The language should not expose those internal differences to users.

## Supported positions

The complete feature includes every complete-construct stream and every list
grammar that already accepts line breaks.

### Complete constructs

- Top-level declarations and expression statements.
- Statements in every body, including function, node, `if`/`else`, `while`,
  `for`, `thread`, `subthread`, `guard`, `handle`, inline handler, `finalize`,
  `parallel`, `seq`, destructive, block-argument, and block match-arm bodies.
- Inline and block match arms.
- Statement-kind code-literal bodies, which parse through `bodyParser`.

### Multiline lists

- Array items.
- Object-literal entries.
- Object-type properties and schema/effect payload properties.
- Function-call arguments, including named and splat arguments, method/access
  chain calls, and inline block arguments.
- Interrupt, `raise`, and `guard` argument lists, which consume the same
  multiline argument grammar.
- `def` and `node` parameters.
- Named imports, node imports, and named exports.
- Array and object binding patterns.
- Array and object match patterns.
- Thread/subthread named arguments.
- Parallel named arguments.

### Principled exclusions

These positions are out of scope because their current grammar is inline-only:

- tag arguments;
- generic type arguments and generic declaration parameters;
- value-parameterized type arguments and declarations;
- effect sets, `raises` lists, and block-type parameters;
- block/lambda parameter lists;
- `new` arguments;
- any other list whose separators accept horizontal spaces but not newlines.

If a future change makes one of those lists multiline, trailing-comment support
becomes part of that syntax change's definition of done.

Also out of scope:

- trailing `/* ... */` metadata—block comments remain ordinary trivia;
- comments inside unfinished expressions, such as between an operator and its
  right operand;
- placing a comma after a `//` comment—the comment owns the rest of the line, so
  comma lists use `item, // comment`;
- comment reflow or width-based relocation;
- preserving exact original whitespace or delimiter spelling;
- emitting source comments into generated TypeScript.

## Architecture

Two parser shapes need different metadata, but they implement one language
rule.

```diagram
                          ┌──────────────────────────────┐
                          │ Preserve trailing // comment │
                          └──────────────┬───────────────┘
                                         │
                     ┌───────────────────┴───────────────────┐
                     │                                       │
                     ▼                                       ▼
┌──────────────────────────────────┐      ┌──────────────────────────────────┐
│ Complete construct streams       │      │ Multiline delimited lists       │
│                                  │      │                                  │
│ completeConstructEntry(parser)   │      │ owner.trivia: ListTrivia[]       │
│                                  │      │                                  │
│ BaseNode.trailingComment         │      │ placement: before | trailing     │
└──────────────────────────────────┘      └──────────────────────────────────┘
```

### A leaf `LineComment` type

`BaseNode` must not import the aggregate `lib/types.ts` module that imports it.
Define the leaf shape beside `BaseNode`:

```ts
export type LineComment = {
  type: "comment";
  content: string;
  loc?: SourceLocation;
};

export type BaseNode = {
  loc?: SourceLocation;
  trailingComment?: LineComment;
};
```

`AgencyComment` remains structurally compatible. This avoids both an aggregate
import cycle and a duplicated inline type.

An optional field is safer than a wrapper node. A wrapper changes tree shape and
would require every walker, lowerer, checker, and generator to unwrap it.
`docs/dev/template-agency.md` explains why walker completeness is load-bearing
for Template Agency hygiene: a missed child can silently capture a binder.

### Exact line-comment parsing

Split the current comment parser into two layers:

```ts
export const lineCommentCore: Parser<AgencyComment> = seqC(
  set("type", "comment"),
  str("//"),
  capture(manyTill(or(newline, blankLineParser)), "content"),
);

export const commentParser: Parser<AgencyComment> = map(
  seqC(
    optionalSpaces,
    capture(lineCommentCore, "comment"),
    optionalSpacesOrNewline,
  ),
  (result) => result.comment,
);
```

`lineCommentCore` begins exactly at `//` and does not own surrounding
whitespace. The standalone `commentParser` preserves today's behavior. Other
parsers no longer need undocumented knowledge of `commentParser`'s whitespace
policy.

### Complete constructs: a reusable decorator

Top-level and body child parsers consume inconsistent amounts of trailing
whitespace. The decorator must inspect the trailing whitespace in the source
the wrapped parser consumed; checking only `rest` is incorrect because a child
may already have consumed the newline before a standalone comment.

```ts
type TrailingCommentOwner = {
  type: string;
  trailingComment?: LineComment;
};

type TrailingCommentOptions<T> = {
  canAttach?: (value: T) => boolean;
};

function consumedLineEnding(input: string, rest: string): boolean {
  const consumedLength = input.length - rest.length;
  const consumed = input.slice(0, consumedLength);
  const trailingWhitespace = consumed.match(/[ \t\r\n]*$/)?.[0] ?? "";
  return /[\r\n]/.test(trailingWhitespace);
}

export function withTrailingLineComment<T extends TrailingCommentOwner>(
  parser: Parser<T>,
  options: TrailingCommentOptions<T> = {},
): Parser<T> {
  return (input: string) => {
    const parsed = parser(input);
    if (!parsed.success) {
      return parsed;
    }

    if (options.canAttach && !options.canAttach(parsed.result)) {
      return parsed;
    }

    if (consumedLineEnding(input, parsed.rest)) {
      return parsed;
    }

    const comment = seqR(optionalSpaces, lineCommentCore)(parsed.rest);
    if (!comment.success) {
      return parsed;
    }

    return success(
      { ...parsed.result, trailingComment: comment.result },
      comment.rest,
    );
  };
}

export function completeConstructEntry<T extends TrailingCommentOwner>(
  parser: Parser<T>,
  options?: TrailingCommentOptions<T>,
): Parser<T> {
  return map(
    seqC(
      capture(withTrailingLineComment(parser, options), "value"),
      optionalSpacesOrNewline,
    ),
    (result) => result.value,
  );
}
```

`withTrailingLineComment` owns the same-line decision and leaves the line ending
in `rest`. A second shared `completeConstructEntry` composes it with
`optionalSpacesOrNewline`. Top-level, body, and match-arm streams consume that
complete entry, so every stream advances past an attached comment without
duplicating cursor logic. Body/top-level call sites supply a declarative
`canAttach` policy where trivia alternatives share the same parser union.

The owner's `loc.end` does **not** extend through the comment. Existing source
replacement and diagnostic code treats the construct's location as its
syntactic range; the comment remains separate formatter metadata.

### Lists: compatibility-preserving placement metadata

Lists own their trivia because the separator belongs before a trailing comment:

```agency
first, // comment
```

Attaching the comment to the expression would make generic expression rendering
produce the invalid order `first // comment,`.

Unify the existing `Trivia` and `ObjectTypeTrivia` shapes without changing
serialized ASTs for existing standalone comments:

```ts
export type BeforeListTrivia = {
  anchorIndex: number;
  comments: TriviaNode[];
  placement?: "before";
};

export type TrailingListTrivia = {
  anchorIndex: number;
  placement: "trailing";
  comments: [LineComment];
};

export type ListTrivia = BeforeListTrivia | TrailingListTrivia;

export type Trivia = ListTrivia;
export type ObjectTypeTrivia = ListTrivia;
```

For `before`, `anchorIndex` is the item the trivia precedes; `items.length`
means before the closer. Existing parser output omits `placement`, preserving
current AST snapshots. For `trailing`, `anchorIndex` is the item the line
comment follows.

Multiple entries may share an anchor. For example:

```agency
[
  first, // explains first
  // prepares second
  second,
]
```

produces a trailing record for item 0 and a before record for item 1. The
generator must process all matching entries, not use `.find(...)`.

### Shared list parsing without erasing separator rules

Share trivia classification, partitioning, and result shape. Do not force all
lists through one separator policy. Agency has at least:

1. comma lists, where another item requires a comma;
2. object-type lists, where comma, semicolon, or newline separates properties;
3. match-arm streams, which contain complete constructs and use the decorator.

The common list result is:

```ts
export type ParsedList<T> = {
  items: T[];
  trivia?: ListTrivia[];
};
```

A comma-list parser accepts the item parser plus explicit policy data:

```ts
type CommaListPolicy = {
  closer: string;
  cardinality: "zero-or-more" | "one-or-more";
  trailingComma: "allow" | "reject";
};
```

This retains each grammar's load-bearing missing-comma checks without silently
broadening trailing-comma or empty-list behavior. Arrays, objects, calls, and
parameters keep their existing policies. Node imports and binding/match
patterns continue to reject trailing commas. Object-type members keep their
separate punctuation-or-newline policy and permit an undelimited final member.
The comma-list source order is:

1. item;
2. horizontal whitespace;
3. comma when another item follows;
4. horizontal whitespace;
5. optional same-line `//` trailing trivia;
6. line ending and standalone trivia;
7. next item or closer.

The final item may use `item // comment` before a closer on the next line. A
non-final item must use `item, // comment`.

### AST ownership

Named fields make the list being described explicit when a node can own more
than one list:

```ts
FunctionCall.argumentTrivia?: ListTrivia[];
FunctionDefinition.parameterTrivia?: ListTrivia[];
GraphNodeDefinition.parameterTrivia?: ListTrivia[];
InterruptStatement.argumentTrivia?: ListTrivia[];
GuardBlock.argumentTrivia?: ListTrivia[];
type CallChainElement = {
  kind: "call";
  optional?: boolean;
} & Pick<FunctionCall, "arguments" | "block" | "argumentTrivia">;
NamedImport.nameTrivia?: ListTrivia[];
ImportNodeStatement.nodeTrivia?: ListTrivia[];
NamedExportBody.nameTrivia?: ListTrivia[];
ArrayPattern.elementTrivia?: ListTrivia[];
ObjectPattern.propertyTrivia?: ListTrivia[];
MessageThread.argumentTrivia?: ListTrivia[];
ParallelBlock.argumentTrivia?: ListTrivia[];
MatchBlockCase.trailingComment?: LineComment;
```

Arrays, objects, and object types retain their existing `trivia` field names.

Function-call inline blocks need explicit re-anchoring. The parser currently
extracts an inline block from `arguments`, and the formatter canonicalizes it to
the last argument. Trivia must move with its source item into that canonical
order. A standalone comment before the following source argument remains with
that following argument. Remapping validates that canonical source indexes are
a permutation and rejects an unmapped anchor instead of producing
`anchorIndex: undefined`. Rendering uses a virtual item list containing ordinary
arguments followed by the extracted inline block, so the block cannot disappear
on the trivia-aware path.

### Generator interfaces

Separate comment text from standalone placement:

```ts
protected commentText(comment: LineComment): string {
  return `//${comment.content}`;
}

protected processComment(comment: AgencyComment): string {
  return this.indentStr(this.commentText(comment));
}

protected appendTrailingComment(
  code: string,
  comment: LineComment | undefined,
): string {
  return comment ? `${code} ${this.commentText(comment)}` : code;
}
```

`processNode` uses `appendTrailingComment` for ordinary complete constructs.
Sorted imports bypass ordinary `processNode`, so their sorting render path must
append the comment after moving the import. Match arms use the same helper.

Delimited lists use a shared multiline renderer. An item renderer returns
structured `{ leadingLines?, code }` data, allowing object-property tags and
similar item-owned lines without passing pre-indented multiline strings through
the abstraction. With no trivia, callers retain the existing `wrapList` output.
With trivia, rendering must:

1. force multiline form;
2. emit every before record for the item;
3. render the item and its canonical separator;
4. append every trailing record for that item;
5. emit before records anchored at the closer.

A construct containing trailing comments never collapses to one line.

## Testing

Formatter tests assert canonical expected output, successful reparsing, and a
second-format fixed point. Byte identity is not required because imports,
spacing, delimiters, and inline-block position already canonicalize.

Required coverage includes:

- top-level declarations and sorted imports whose comments move with them;
- standalone-comment negatives after assignment, return, call, block, and blank
  line paths that consume whitespace differently;
- every body owner listed above;
- inline and block match arms;
- a comment after the closing `)` of a multiline call statement;
- unchanged owner `loc.end`;
- existing array/object/object-type trivia AST snapshots with no new
  `placement` field;
- missing-comma regressions for arrays and objects;
- trailing plus standalone comments at the same logical list boundary;
- parser progress after a trailing comment on a non-final match arm and list
  item;
- a standalone comment after a nested item parser that consumes its newline;
- non-final and final items in each supported list family;
- calls with positional, named, splat, access-chain, and inline-block arguments;
- interrupt, `raise`, and `guard` arguments;
- function and node parameters, including variadic, defaulted, and validated
  parameters;
- imports, exports, binding patterns, match patterns, thread args, and parallel
  args;
- tagged object-type properties with trailing comments;
- unchanged cardinality and trailing-comma acceptance for every migrated list
  family;
- block comments remaining ordinary before-trivia;
- test TypeScript compilation, structural lint, unit tests, formatter corpus,
  build, and parser performance.

Comments have no runtime semantics, so no Agency execution tests or LLM calls
are needed.

## Compatibility and safety

- No wrapper node is introduced, preserving walker completeness.
- Existing ASTs without trailing comments do not gain fields.
- Existing before-trivia records do not gain `placement`.
- Existing `Trivia` and `ObjectTypeTrivia` exported names remain aliases.
- `loc` continues to describe the syntactic owner, not attached formatter
  metadata.
- Literal comma requirements remain unchanged.
- Handlers remain ordinary body consumers; the shared body decorator must never
  skip or unregister them.
- The TypeScript generator ignores formatter-only trivia exactly as it does
  today.

## Delivery

This is one language feature delivered in reviewable milestones:

1. complete-construct metadata, parsing, and rendering;
2. shared list metadata and migration of existing trivia-aware lists;
3. call arguments and declaration parameters;
4. remaining already-multiline surfaces;
5. documentation and compatibility verification.

The guide should publish the universal rule only after all milestones land.
