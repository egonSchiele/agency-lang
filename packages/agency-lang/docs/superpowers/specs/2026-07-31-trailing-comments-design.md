# Trailing comments

## Background

Write this in an Agency file:

```ts
const x = 5 // explains x
const y = 6
```

Run `agency fmt` and you get this:

```ts
const x = 5
// explains x
const y = 6
```

The comment parses, and its text is never lost. But it moves. And where it
moves to is directly above `const y = 6`, so a comment written to explain `x`
now reads as explaining `y`. Formatting a file silently changed what a comment
appears to say.

The same thing happens for object type members, array items, object literal
fields, and match arms. In every position, a comment following code on the same
line is re-rendered on its own line above whatever comes next.

This matters because agents write trailing comments constantly. It is one of
the most ingrained habits in every language they have learned from, and Agency
neither rejects it nor honors it — it accepts the input and quietly rearranges
the meaning. Of all the ways Agency can surprise someone writing it, this is the
only one I know of where being permissive produces a *wrong result* rather than
an inconvenient one.

### Why it happens

This is not a formatter bug. Trailing comments have nowhere to live in the AST.

Comments inside a function body are parsed as ordinary body nodes. In
`_bodyParserImpl` (`lib/parsers/parsers.ts:4804`) the body is
`many(seqC(capture(_bodyNodeParser, "node"), optionalSpacesOrNewline))`, and
`commentParser` (`lib/parsers/parsers.ts:4781`) is one of the alternatives
`_bodyNodeParser` (`:4744`) tries. So
`const x = 5 // explains x` parses as two sibling nodes in the body array: an
assignment, then a comment. Nothing records that they were on the same line.
The generator walks the body and emits one line per node, which is exactly what
you see.

Inside literals and type bodies there is a richer mechanism — *trivia* — but it
cannot express trailing either. Trivia anchors a comment to a position
*between* items. `lib/types/typeHints.ts:255-258` documents the scheme:

```
anchorIndex: 0                    — appears before the first property
anchorIndex: N                    — appears between
anchorIndex: properties.length    — appears after the last property
```

It answers "which gap is this comment in", not "which line is it at the end
of". And `emitTriviaAt` (`lib/backends/agencyGenerator.ts:774`) can only push
whole lines into the output. Object types, array literals, and object literals
all share that one helper, which is why all three behave identically.

So the fix has to add a place for the information to live.

## Why not a wrapper node

The obvious model is a node that wraps another node and adds a comment to it:

```ts
type TrailingComment = { type: "trailingComment", node: AgencyNode, comment: AgencyComment }
```

This is the wrong shape for this codebase, and the reason is a documented safety
property rather than a style preference.

A wrapper changes the shape of the tree. Every consumer that matches on node
types — the walkers, the typechecker, the preprocessors, both lowering passes,
both generators — would need to know to unwrap it. And
`docs/dev/template-agency.md:75` records what happens when one of them doesn't:

> That makes **`walkNodes`' descent completeness load-bearing for safety**: a
> node kind whose expression children the walker misses under-reports free
> names, no test fails, and a filler silently captures a template binder — the
> exact bug hygiene exists to prevent, failing open.

That is the failure mode. Not a crash, not a red test — a Template Agency filler
silently capturing a binder it should not have. The corpus invariants in
`lib/utils/expressionSlots.test.ts` exist specifically because this class of bug
is invisible. Introducing a wrapper node that can appear in any position is
volunteering for it.

An optional **field** avoids all of it:

```ts
export type BaseNode = {
  loc?: SourceLocation;
  /** A `//` comment that followed this node on the same source line. */
  trailingComment?: AgencyComment;
};
```

The tree shape is unchanged, so no walker needs to know the field exists. A
consumer that ignores it behaves exactly as it does today. This is how every
comparable piece of formatter-only or optional metadata is already modeled here:
`trivia` on arrays and object types, `raises` and `markers` on function
definitions, `loc` on everything. None of them is a wrapper node.

## The model

**A comment trails the node whose source range ends on that line.**

That single rule handles the case that seems hardest — a multi-line construct:

```ts
const x = someCall(
  a,
  b
) // trailing on the whole statement
```

The comment attaches to the statement, because the statement is what ends on
that line. The generator emits it after the closing `)`. This also survives
reflow: the comment stays at the end of its node even if the formatter moves the
node to a different physical line.

Every node carries `loc` with `start` and `end` character offsets
(`lib/types/base.ts`), so "which node ends here" is computable. Note that
`loc.line` is the node's *start* line only — the end line has to be derived from
the `end` offset.

**Only `//` comments.** A `//` comment necessarily runs to the end of its line,
so "the code before it on this line" is unambiguous. A `/* ... */` comment can
have code after it on the same line, which makes "trailing" undefined —
`const x = 5 /* why */ + 1` is not a trailing comment at all. Block comments
keep today's behavior.

## Phase 1 — statements in a body

This is the common case and the one agents hit. It is also the simplest, because
a statement's trailing comment is already parsed as its immediate next sibling.

### Parser

One site: `_bodyParserImpl` (`lib/parsers/parsers.ts:4804`). Today each
iteration parses a node then consumes `optionalSpacesOrNewline`. Change it so
that after parsing a node, the parser looks ahead past spaces **but not past a
newline** for a comment. If it finds one, it attaches it as `trailingComment` on
the node just parsed and consumes it, instead of letting the next loop iteration
pick it up as a sibling.

The distinction is entirely "did we cross a newline first". A comment on its own
line is still a sibling body node and keeps today's behavior, which is correct —
that is what a standalone comment is.

### Generator

`AgencyGenerator` renders a body one node per line. Where a body statement's
line is produced, append `" " + this.processComment(node.trailingComment)` when
the field is set. `processComment` already exists at
`lib/backends/agencyGenerator.ts:1607`.

### What Phase 1 covers

Any statement in any body: node bodies, function bodies, `if` and `while` and
`for` bodies, `handle` blocks, `guard` blocks, `thread` blocks. All of them go
through `bodyParser`, so one parser change covers them all.

## Phase 2 — items in literals and type bodies

```ts
const arr = [
  1, // one
  2, // two
]
```

Arrays, object literals, and object types already anchor comments by index. What
is missing is one bit per trivia entry distinguishing the two placements:

```ts
export type Trivia = {
  anchorIndex: number;
  comments: TriviaNode[];
  /** True when these comments trailed item `anchorIndex - 1` on its own line,
   *  rather than sitting on their own line before item `anchorIndex`. */
  trailing?: boolean;
};
```

`ObjectTypeTrivia` gets the same field. The generator change is confined to
`emitTriviaAt` (`lib/backends/agencyGenerator.ts:774`) plus its three callers,
since a trailing entry must be appended to the previous line rather than pushed
as a new one — which means `emitTriviaAt` needs to return the trailing text
instead of only pushing lines.

Splitting a single trivia entry that holds both kinds is the fiddly part: a
trailing comment and then a standalone comment before the next item are both
anchored at the same index and must not be merged. The cleanest handling is to
let the parser emit two entries at the same `anchorIndex`, one flagged trailing
and one not, and have the generator emit the trailing one first.

## Phase 3 — argument and parameter lists — deferred

```ts
foo(
  a, // first
  b
)
```

Function calls and parameter lists have no trivia at all today, so this needs
the anchoring infrastructure built from scratch for them, not just extended.
Deferred, and possibly indefinitely — this is a much rarer shape in agent-written
code than the first two.

## The reflow rule

The genuine hazard is not modeling, it is collapsing. If the formatter takes a
multi-line construct holding two trailing comments and prints it on one line,
both comments end up on the same output line and the result is nonsense — or,
worse, unparseable.

**A construct containing trailing comments never collapses to one line.**

There is direct precedent. `armPrintsInline`
(`lib/backends/agencyGenerator.ts:1484`) already governs when a one-statement
match arm may print inline, and its rule is "the author's form wins: an arm
written as a block prints as a block." PR #712 tightened it further so that an
arm only collapses when the single-statement grammar can re-parse the result,
with the reasoning that degrading to block form is "more verbose, never
unparseable — the right failure direction for a formatter." The same reasoning
applies unchanged here.

## Testing

Round-trip tests are the core of this. For each supported position: parse source
with a trailing comment, format, and assert the output is byte-identical to the
input. That single assertion covers both the parser attaching correctly and the
generator emitting in the right place.

Specific cases to pin:

- **Every body kind.** A trailing comment on a statement inside a node body,
  function body, `if`, `while`, `for`, `handle`, `guard`, and `thread` block.
- **The relocation regression.** The exact case from the Background —
  `const x = 5 // explains x` followed by `const y = 6` — must round-trip with
  the comment still on the first line. This is the bug the whole spec exists for.
- **Multi-line node.** A comment after the closing `)` of a call spanning several
  lines attaches to the statement and stays after the `)`.
- **Standalone comments are unaffected.** A comment on its own line stays a
  sibling body node and renders on its own line. This is the negative case that
  proves the newline check works.
- **Last statement in a body.** A trailing comment on the final statement, with
  the closing `}` on the next line.
- **Block comments keep old behavior.** `const x = 5 /* why */` does not attach.
- **No collapse.** A construct holding trailing comments stays expanded even when
  it would otherwise print inline.
- **Idempotence.** Formatting twice changes nothing on the second pass.

Phase 2 adds the same battery for array items, object literal fields, and object
type members, plus the mixed case where one item has a trailing comment and the
next is preceded by a standalone one.

No Agency execution tests are needed. Comments have no runtime meaning; this is
entirely a parse-and-print change.

## Risks and open questions

**`BaseNode` is universal.** Adding `trailingComment` to `BaseNode` puts the
field on every node type in the language, including ones that can never carry a
trailing comment because they are not statements. That is harmless — it is
optional and nothing reads it unless set — and it matches how `loc` is already
handled. The alternative, declaring it on each statement type individually,
means a long list that will drift as node types are added. `BaseNode` is the
right call, but it is worth naming the trade-off rather than pretending there
isn't one.

**Exact-match AST tests.** Some parser tests assert on whole AST objects. Adding
an optional field does not change any existing tree, since the field is only
present when a trailing comment was actually found, so those should be
unaffected. Worth confirming early rather than discovering late.

**The TypeScript generator.** This spec covers `AgencyGenerator` only, since the
motivating problem is `agency fmt` rearranging a user's file. Carrying trailing
comments into generated TypeScript would make compiled output more readable, but
nothing depends on it and it is a separate change.

**Interaction with `loc` offsets.** Attaching a comment to the preceding node
does not change that node's `loc.end`, so a node's recorded range will no longer
cover everything the parser consumed for it. Nothing currently depends on that
being exact for statements, but source-map generation and the LSP both read
`loc`, so this deserves a check before implementation rather than an assumption.

## Out of scope

- **Making trailing comments idiomatic.** This spec makes them survive; it does
  not make them recommended. The guide should keep advising against them until
  Phase 1 lands, then say plainly which positions honor them.
- **Comment reflow or rewrapping.** A long trailing comment stays long. The
  formatter does not move it to its own line to fit a width budget.
- **Attaching comments to expressions inside a line.** `foo(a /* x */, b)`
  stays as-is. Only end-of-line comments are in scope.
