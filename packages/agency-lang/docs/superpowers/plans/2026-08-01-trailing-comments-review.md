# Review: Language-Wide Trailing Comments Plan

## Recommendation

**The revised plan is safe to execute as a sequence of reviewable milestones.**

The original plan was not safe. It exposed parser implementation boundaries as
language rules, could attach standalone comments to the preceding statement,
and duplicated parser and generator mechanics. The revised design instead
defines one user-facing boundary:

> Preserve a same-line `//` comment on a complete declaration, statement, or
> match arm, and on an item in every list grammar that already supports
> multiline layout.

Inline-only grammars remain inline-only. This is a principled grammar boundary,
not an exception users must memorize based on whether a construct appears at
top level or in a body.

The work is intentionally divided into milestones. The universal guide text
must not ship until every included surface is implemented and verified.

## Scope conclusion

The earlier statement that there was “only one confirmed consumer” was true
only of the narrow body-parser proposal. It was not true of the desired
language feature. The revised inventory includes:

- top-level construct streams;
- every body stream;
- inline and block match arms;
- arrays, objects, and object types;
- calls, call-chain calls, `interrupt`, `raise`, and `guard` arguments;
- function and node parameters;
- imports and exports;
- binding and match patterns;
- thread/subthread and parallel named arguments;
- statement-kind code-literal bodies where they reuse `bodyParser`.

The plan excludes only grammars that do not currently permit multiline layout,
such as tags, generics, effect sets, block parameters, and `new` arguments.
Supporting comments there would first require a separate syntax decision to
make those lists multiline.

## Original correctness findings and resolution

### Consumed newlines could attach standalone comments

Many statement parsers consume their terminating whitespace. Looking only at
`parsed.rest` therefore cannot distinguish:

```agency
const x = 1 // trailing
```

from:

```agency
const x = 1
// standalone
```

**Resolved:** `consumedLineEnding(input, rest)` is the single boundary check.
`withTrailingLineComment` inspects the consumed source and refuses attachment
when the wrapped parser crossed a line. Negative tests cover assignment,
return/raise, call, block, and blank-line paths.

### Attached comments could strand their terminating newline

`lineCommentCore` correctly stops before the newline, but a match-arm or list
stream must then advance past that layout before parsing its next entry.

**Resolved:** `completeConstructEntry` owns post-construct layout for top-level,
body, and match streams. `trailingLineCommentEntry` owns post-comment layout in
lists. Tests require a commented non-final match arm, a commented non-final
list item, and trailing trivia followed by standalone trivia.

### Top-level behavior contradicted the old body-only scope

A generator hook could not emit top-level metadata that only `bodyParser`
attached.

**Resolved:** top-level `nodeParser`, body streams, and match-arm streams use the
same complete-entry abstraction. Top-level behavior is now part of the feature,
not an unsupported “later phase.”

### Body and multiline-expression coverage was incomplete

The original matrix omitted several body owners and substituted a block case
for the required multiline-call case.

**Resolved:** the plan includes node/function, `if`/`else`, loops, thread and
subthread, guard, handle and inline handlers, finalize, parallel, seq,
destructive, match-arm, block-argument, and code-literal bodies. It separately
tests a comment after the closing `)` of a call that remains multiline.

### Owner source locations could accidentally include comments

Extending `loc.end` would change linter replacements and diagnostics by making
the comment part of the syntactic statement range.

**Resolved:** attached comments retain their own location and never modify the
owner's range. The plan includes raw source-slice assertions and existing
location-sensitive parser, linter, LSP, and formatter suites.

### The proposed base type was not executable

Importing aggregate `AgencyComment` into foundational `base.ts` would create an
inverted dependency, while using it without an import would not compile.

**Resolved:** a leaf `LineComment` type lives beside `BaseNode` and remains
structurally compatible with `AgencyComment` without a runtime import cycle.

### Verification commands were incomplete or invalid

The old plan referenced a nonexistent location test, did not reliably typecheck
tests, and bypassed the repository-owned performance command.

**Resolved:** the revised plan names existing focused files, uses
`pnpm run typecheck`, runs `make` before broad tests, uses
`pnpm run test:perf`, saves expensive output once, and runs location-sensitive
parser/linter/LSP suites.

## Additional findings from the language-wide review

### Shared argument parsing had more consumers than `FunctionCall`

Call-chain calls, `interrupt`, `raise`, and `guard` reshape the output of
`argumentListParser`; changing the parser alone would lose or fail to render
their trivia.

**Resolved:** each owning AST type receives explicit `argumentTrivia`, each
parser propagates it, and each generator path uses the shared argument renderer.

### Inline blocks could disappear on the trivia-aware render path

The parser extracts an inline block from `arguments`, but the initial renderer
proposal passed only `node.arguments` to the list renderer.

**Resolved:** parsing records source indexes; remapping validates a complete
permutation; rendering uses a virtual canonical list containing ordinary
arguments followed by the extracted block. Tests assert the block itself and
both block/ordinary comment adjacency.

### A universal comma delimiter would broaden existing syntax

Some lists allow trailing commas and some reject them; some are empty-capable
and others require at least one item.

**Resolved:** `CommaListPolicy` makes `cardinality` and `trailingComma` explicit.
Named policy choices preserve each current grammar, and negative tests pin every
rejecting family. Object-type members retain a separate newline-or-punctuation
policy with an optional final delimiter.

### Object-property tags did not fit a string-only item renderer

Passing pre-indented multiline strings through a generic renderer would leak
indentation mechanics and risk dropping `@validate`/`@jsonSchema` tags.

**Resolved:** item renderers return `{ leadingLines?, code }`; the shared list
renderer owns indentation, separators, and comment placement.

### Trivia remapping could silently produce an undefined anchor

`Record<number, number>` falsely represented a partial source-to-canonical
lookup as total.

**Resolved:** remapping validates that canonical indexes are a permutation,
uses an explicitly optional lookup, preserves the closer anchor, and fails at
the remapping boundary if an item anchor is invalid.

## Anti-pattern audit

### Duplicating existing code — present originally, now addressed

The original generator reconstructed `//${content}` in separate standalone and
trailing paths. The revised plan makes `commentText` the sole line-comment text
renderer. Existing argument, tag, pattern, alias, and marker renderers remain the
source of item text.

### Imperative code everywhere — not the final design

Parser cursor management and formatter indentation are inherently imperative.
The important question is whether every caller repeats those mechanics. In the
revised plan, they do not:

```ts
const nodeParser = completeConstructEntry(nodeParserInner);

const arguments = commaDelimitedList(argumentParser, CALL_ARGUMENT_POLICY);

return this.renderListWithTrivia({
  items,
  trivia,
  renderItem,
  separator,
  // delimiters omitted here
});
```

The imperative mechanics live behind these interfaces:

- `consumedLineEnding` owns consumed-source inspection;
- `completeConstructEntry` owns complete-stream cursor progress;
- the list entry engine owns delimiter/comment parsing;
- `partitionTrivia` owns classification and anchoring;
- `remapListTrivia` owns canonical reordering;
- `renderListWithTrivia` owns indentation and placement.

Grammar call sites declaratively select the item parser, attachment predicate,
cardinality, trailing-comma rule, delimiters, and item renderer. This is the
intended “declarative interface around imperative implementation” pattern.

### Leaky abstractions — present originally, now addressed

Callers previously needed to know whether a child parser and `commentParser`
consumed whitespace. Exact line-comment parsing, consumed-line detection, and
post-comment layout now have named owners. Structured rendered items prevent
indentation policy from leaking into object-type callers.

### Useless special cases — present originally, now addressed

The old plan branched on `.success` for `many(...)` and `optionalSpaces`, which
always succeed, and proposed redundant whitespace passes as harmless. The
revised combinator structure removes those branches. Cardinality is expressed
by parser shape rather than a fabricated post-`many` failure.

### Inconsistent patterns — present originally, now addressed

Complete constructs share one stream entry, multiline lists share one trivia
model and rendering contract, and separator differences are explicit policies
rather than unrelated implementations.

### One-line `if` statements and nested ternaries — present originally, removed

All new snippets use braced conditionals. No nested ternary is proposed.

### Not found

The plan does not introduce order-dependent mutable state outside normal parser
sequencing, dynamic imports, `Map`, `Set`, unsafe deletion, swallowed exceptions,
catastrophic tests, wrapper AST nodes, or changes to handler registration.

## Execution guidance

Treat this as one language feature but implement it in the plan's milestones.
At each milestone, preserve existing no-trivia output and run the focused tests
before broadening to the next owner family. Do not document the universal rule
until the final compatibility gate confirms every promised multiline surface.
