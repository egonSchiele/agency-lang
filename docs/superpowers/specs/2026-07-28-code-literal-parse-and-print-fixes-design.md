# Code literals: declarations mis-parse, and `toSource` throws on a static

**Revision 2 (2026-07-28).** Rewritten after review
(`2026-07-28-code-literal-parse-and-print-fixes-design-REVIEW.md`). Part 1's
fix has changed shape entirely — see "Response to review" at the end for what
changed and why. Part 2 is unchanged apart from one corrected fact.

Two independent bugs, both found while working through the Template Agency
guide. They are written up together because they are both small, both surface
in the code-literal path, and both are things a person hits within their first
hour of using templates.

- **Part 1** is the serious one. A declaration written without a return type
  parses into a tree that does not mean what the source says. Nothing errors.
- **Part 2** is a one-line fix. Calling `toSource` on a `static const` code
  literal throws a `TypeError`.

Neither depends on the other. They can ship as one PR or two.

---

# Part 1: declarations mis-parse as a name followed by a call

## What you see

A user writes a template and runs `agency fmt`:

```ts
const template = [|
  node main() {
    const topic = #topic
    return llm("Research: ${topic}")
  }
|]
```

and the formatter prints `node` and `main() {` on separate lines. It reads
like a formatting bug. It is not — the formatter is printing exactly what it
was handed.

## What is actually in the tree

```json
{
  "type": "codeLiteral",
  "kind": "statements",
  "nodes": [
    { "type": "variableName", "value": "node" },
    { "type": "functionCall", "functionName": "main", "block": { ... } }
  ]
}
```

There is no node declaration in there. The literal holds two statements: the
bare name `node`, evaluated and discarded, then a call to a function called
`main` that happens to take a trailing block. The formatter prints a bare name
on one line and a call on the next. That is the whole visible symptom of a
tree that is wrong all the way down.

## Why it happens

Two ordinary facts collide.

**A call can take a trailing block.** `main() { ... }` is a perfectly good
function call with a block argument, used throughout the standard library.

**Keywords are not reserved in expression position.** `node`, `def` and `type`
are all in `RESERVED_WORDS` (`lib/parsers/parsers.ts:213`), but that list has
exactly one consumer: identifier-hole fill validation
(`lib/runtime/template/fill.ts:266`). The grammar never consults it. This
compiles and runs today:

```ts
node main() {
  const node = 1
  print("${node}")
}
```

Put them together and the statement parser reads `node main() { ... }` as a
name followed by a call, consumes every character, and reports success.

## This is not a code-literal bug

The most important finding, and the one that changed this spec. The same
mis-parse happens in an ordinary node body, no literal anywhere:

```ts
node main() {
  node inner() { print(1) }
  print("x")
}
```

This **compiles**. `agency ast` shows the body holding `variableName "node"`
followed by a call to `inner`. Running it gives:

```
ERROR Node main crashed: node is not defined
ReferenceError: node is not defined
```

`def helper() { return 1 }` inside a body does the same thing. (`def
helper(): number { ... }` is rejected with "expected node body", because the
return type makes the call reading fail — the same annotation coincidence
described below.)

So the ambiguity lives in the body grammar. Code literals did not create it;
they made it visible, because a literal offers the body parser text that was
meant to be a whole program.

## Why code literals amplify it

`parseCodeLiteralBody` (`lib/parsers/parsers.ts:3044`) parses a literal body
three ways and takes the first that consumes it all:

1. as a single expression (`parsers.ts:3059`)
2. as a list of statements (`parsers.ts:3063`)
3. as a whole program (`parsers.ts:3067`)

Smallest-first is right in general: a fragment inferred as the smallest kind
that fits can be grafted in the most places. But it means that when the
statements parser *wrongly* accepts a declaration, the program parser — which
would have produced the correct tree — is never consulted.

## How much is affected

**Everything below is verified by repro, not inferred.**

Inside a literal:

| Literal body | Kind | What the tree holds |
| --- | --- | --- |
| `node main() { ... }` | `statements` | name `node`, call to `main` |
| `def foo() { return 1 }` | `statements` | name `def`, call to `foo` |
| `node m(x: number) { ... }` | `statements` | name `node`, call to `m` |
| two `node` declarations | `statements` | two names, two calls |
| `// comment` then `node main() { ... }` | `statements` | comment, name, call |
| `print(1)` then `node main() { ... }` | `statements` | call, name, call |
| `node main(): string { ... }` | `program` | correct `graphNode` |
| `def foo(): number { ... }` | `program` | correct `function` |
| `import { read } from "std::fs"` | `program` | correct import |

The pattern: **a return type annotation saves you.** With `: string` present
the statements attempt fails, so parsing falls through to the program attempt
and gets the right answer. Every worked example in
`docs/site/guide/template-agency.md` annotates its return type, which is why
this was never noticed.

In an ordinary body: `node inner() { ... }` and `def helper() { ... }` both
mis-parse, as shown above.

### A second, unrelated failure in the same function

```ts
[| static const x = 1 |]
```

does not mis-parse — it fails outright, with a message about a context the
user was never in:

```
`static` and `export` declarations are only supported at module top level.
Inside function and node bodies, use `optimize const ...` ...
```

`bodyReservedModifierParser` (`parsers.ts:4451`) exists to give a good error
when someone writes `static const` inside a function body, and it reports
through tarsec's `parseError`, which **throws**. The throw escapes the
statements attempt and leaves `parseCodeLiteralBody` before the program
attempt runs. So a body a program parse would have accepted is rejected by a
diagnostic meant for somewhere else. The same thing happens mid-body:
`[| const a = 1` newline `static const x = 2 |]` also hard-fails.

## Why the wrong tree is worse than it looks

Nothing downstream catches it:

- The host type checker treats a literal body as a leaf and never looks inside.
- `holesOf` and `fill` both still work — holes are still holes wherever they sit.
- `toSource` prints the wrong tree, which re-parses to the same wrong tree, so
  a round trip looks stable.
- `runCode` compiles a program that calls an undefined function instead of
  declaring a node.

The user's first signal is a runtime failure inside generated code, several
steps removed from the source that caused it. In the body case there is no
generated program at all — just `ReferenceError: node is not defined` pointing
at nothing.

## Approaches considered and rejected

**Reserve keywords in expression position.** Make `node`, `def` and `type`
illegal as identifiers and the coincidence disappears at the root. Rejected:
a language-wide breaking change. `const node = 1` compiles today, and any
program using `type`, `test`, `from` or `with` as a variable name would stop
compiling.

**Try the program parse first, always.** Rejected: it silently reclassifies
bodies that are correct today. A bare call at file scope is legal Agency
(verified), and so is a top-level `const`, so `[| print(1) print(2) |]` and
`[| const x = 1 |]` would both flip from `statements` to `program`.

**Route by leading keyword** — peek at the body's first word, and if it is a
declaration keyword, go straight to the program parser. **This was revision
1's proposal, and it is rejected now.** Review found it breaks legal bodies:
`[| node |]`, `[| node.run() |]` and `[| node + 1 |]` all parse as expressions
today, and all begin with the word `node`. Verified. Refining the peek to
"keyword, whitespace, identifier" rescues those, but the approach has a deeper
problem: it only ever looks at the *first* word, so `[| print(1)` newline
`node main() {} |]` is never routed and still mis-parses. And it cannot touch
the ordinary-body case at all, because there is no literal to route.

## The proposed fix

Two changes. The first removes the ambiguity; the second stops an unrelated
throw from short-circuiting kind inference.

### Change 1: a declaration keyword in statement position is not a name

Add an alternative to `_bodyNodeParser` (`lib/parsers/parsers.ts:4576`) that
matches `node` or `def` followed by whitespace and then an identifier, and
**declines** — an ordinary parser failure carrying a directive message:

> `node` and `def` declarations are only legal at the top level of a file.

The shape check is what keeps it safe. `node` followed by an identifier is
declaration-name position and nothing else: `node.run()` has a dot next,
`node + 1` an operator, `node(x)` a paren, `node { }` a brace, bare `node`
nothing at all. None of those match, so every legal use of `node` as a
variable is untouched.

It must be an ordinary failure, **not** a `parseError` throw. A throw is
exactly what makes the `static const` bug above, and would reintroduce it here.

The effect in each context:

- **In an ordinary body**, no other alternative matches, so the body parse
  fails and the user gets a real error instead of a program that calls a
  function that does not exist.
- **In a code literal**, the statements attempt fails, so the program attempt
  runs and produces the correct declaration. No routing table, no keyword set,
  no peeking.

### Change 2: a throw during one attempt must not abandon the others

In `parseCodeLiteralBody`, wrap the expression and statements attempts so that
a `TarsecError` thrown from inside them is converted into an ordinary attempt
failure. An attempt that dies is an attempt that did not match; the remaining
attempts should still run.

This fixes `[| static const x = 1 |]` and the mid-body variant, both of which
are legal programs today rejected by a body-context diagnostic.

The narrower alternative — special-case `bodyReservedModifierParser` — is
worse. Any parser reached during an attempt can throw, and the next one added
would silently reintroduce the same class of bug.

### What this fixes

| Case | Before | After |
| --- | --- | --- |
| `[| node main() {} |]` | `statements`, wrong tree | `program`, correct |
| `[| def foo() {} |]` | `statements`, wrong tree | `program`, correct |
| two declarations in one literal | `statements`, wrong tree | `program`, correct |
| comment, then declaration | `statements`, wrong tree | `program`, correct |
| `print(1)`, then declaration | `statements`, wrong tree | `program`, correct |
| `node inner() {}` in a node body | compiles, crashes at run time | parse error |
| `def helper() {}` in a node body | compiles, crashes at run time | parse error |
| `[| static const x = 1 |]` | hard parse failure | `program`, correct |
| `const a = 1`, then `static const` | hard parse failure | `program`, correct |

### What deliberately does not change

- `[| node |]`, `[| node.run() |]`, `[| node + 1 |]` — still `expr`. The
  expression attempt runs first and the shape check never fires.
- `const node = 1` and every other keyword-as-variable use — untouched.
- `[| type P = { n: number } |]` — still `statements`. See below.
- `[| effect Foo |]` — still `statements`. Effect declarations are legal in
  bodies (`effectDeclParser` and `effectSetDeclParser` are alternatives in
  `_bodyNodeParser`, `parsers.ts:4577-4579`), so a body-legal reading is the
  right one.
- `[| const x = 1 |]` stays `statements`; `[| print(1) |]` stays `expr`.
- `debugger` and `goto x` — both parse as bare names today (verified;
  `debugger` produces `variableName "debugger"`, resolved as a builtin). Only
  `node` and `def` are in the shape check, so neither is affected. This is the
  reason the check is not "a lone reserved word is not a statement": that
  broader rule would break `debugger`.

### One accepted regression

A body where `node` genuinely is a variable and the next line genuinely is a
call:

```
[| node
   main() |]
```

now fails to parse. That text is indistinguishable from the bug being fixed,
and no sensible program contains it. Naming it here so it is a decision rather
than a surprise.

## What this fix does not close

`type` gets the wrong kind. `[| type P = { n: number } |]` produces a correct
`typeAlias` node under kind `statements`, because type aliases are legal in
bodies too. The tree is right, but a `statements` fragment cannot fill a
declaration hole, so a literal holding only a type alias cannot be spliced as
a declaration.

Revision 1 proposed routing `type` to the program parser. Review showed the
cost is wider than it looked: any multi-statement body starting with a type
alias would be affected, and `[| type P = { n: number }` newline `return 1 |]`
— legal as statements today, since `return` is a body statement — would route
to the program parser and hard-fail.

**Recommendation: leave `type` alone in this change** and treat "a literal
holding only declarations should be usable as a declaration fragment" as its
own feature, where kind inference can be looked at properly. This fix is a
correctness fix; that one is a capability change, and mixing them costs the
clean claim that no body which parses today changes its kind.

## Tests

In `lib/parsers/codeLiteral.test.ts`:

- Every mis-parsing form from the table — bare `node`, bare `def`, node with
  parameters, two declarations, comment-first, statement-then-declaration —
  asserts kind `program` **and** the first node's `type`. Asserting the kind
  alone is not enough; the kind was already wrong for a reason only the node
  type reveals.
- Annotated forms (`node main(): string`) still infer `program`, so the fix
  did not reach them by a different route.
- `static const x = 1` parses as `program`, alone and after another statement.
- Unchanged bodies: `[| node |]`, `[| node.run() |]`, `[| node + 1 |]` stay
  `expr`; `[| const x = 1 |]` stays `statements`; `[| type P = ... |]` stays
  `statements`; `[| effect Foo |]` stays `statements`. These are the Finding 1
  and Finding 2 regression guards and are the most valuable tests here.
- A syntactically broken declaration (`node main( {`) reports a parse error
  and does not silently succeed as statements.

In the body-parser tests:

- `node inner() { ... }` and `def helper() { ... }` inside a node body are
  parse errors, and the message names the top-level rule.
- `debugger` alone in a body still parses.
- `node.run()`, `node + 1`, `node(x)` and `node { }` as ordinary statements
  still parse, with `node` as a variable.

In `lib/backends/agencyGenerator.roundtrip.test.ts`, a golden for a literal
holding an un-annotated `node main()`, since the reported symptom was a
formatter one and a golden is what stops it coming back.

An execution fixture under `tests/agency/templates/` that builds a literal
holding an un-annotated `node main()`, fills it, and runs it end to end
through `runCode` — the check that parse, fill, print, re-parse, compile and
run all agree. No LLM call needed.

## Implementation note

The quality of the error in the ordinary-body case depends on tarsec's
rightmost-failure reporting picking the declining parser's message over the
alternatives tried after it. That is expected but not verified. If the message
comes out generic, the fallback is to position the alternative so its failure
is rightmost, the way `bodyReservedModifierParser` is positioned today — but
still without the throw. Confirm this early; it is the difference between a
good error and a confusing one, and it is the only part of Change 1 that is
not mechanical.

---

# Part 2: `toSource` throws on a static code literal

## What you see

```ts
import { toSource } from "std::agency"

static const s = [| print("hi") |]

node main() {
  print(toSource(s))
}
```

```
TypeError: Cannot assign to read only property 'nodes' of object '#<Object>'
    at AgencyGenerator.generate (lib/backends/agencyGenerator.js:130)
    at _toSource (lib/stdlib/template.js:27)
```

The same literal declared as a local `const` prints fine. Only `static const`
fails.

## Why

`AgencyGenerator.generate` writes to the program it was given
(`lib/backends/agencyGenerator.ts:223`):

```ts
if (!this.preserveOrder) {
  program.nodes = this.partitionImports(program.nodes);
}
```

`partitionImports` pulls the header and import statements out of the node
stream so the import block can be sorted, and assigns the result back over the
caller's field. For a program parsed from a file that is harmless — the tree
is scratch data the caller owns.

A `Code` value from a `static const` is not scratch data. Statics are
`__deepFreeze`d at initialization on purpose: they are shared across runs, and
freezing is what makes "a static is immutable" true rather than merely
documented (`lib/typeChecker/staticInitRules.ts:114-124`). Writing to a frozen
object throws in strict mode, which all generated modules are.

The printer's private bookkeeping is escaping into a value it does not own.

## Why the guide's example does not hit it

Every worked example calls `fill` before `toSource`, and `fill` substitutes
over a deep clone, so `toSource` receives a fresh unfrozen tree. The bug only
appears when you print a template you have not filled — which is exactly what
someone does while learning, to see what a template looks like.

## The fix

Stop mutating the input. Keep the partitioned stream in a local:

```ts
const nodes = this.preserveOrder ? program.nodes : this.partitionImports(program.nodes);
```

**Each pass must keep reading the stream it reads today.** The partition sits
at line 223. Passes 1 and 2 (type aliases at line 202, node names at line 209)
run before it and read `program.nodes`. Passes 3, 4 and 5 (node imports at
227, tools at 233, printing at 252) run after it and must read the partitioned
local. Getting this wrong changes the order tool code lands in
`generatedStatements` and shifts formatter output.

This is the right place for the fix, for three reasons:

- Freezing statics is a deliberate safety property. Unfreezing them, or
  special-casing `Code`, trades a correctness guarantee for a printer's
  convenience.
- Cloning inside `_toSource` hides the mutation rather than removing it, and
  leaves the next caller who passes a shared tree to trip over it.
- The mutation is not needed. Nothing outside `generate` reads the field.

While in there: `this.program = program` at line 201 is written and never read
— no other reference exists in the file. Removing the dead field is optional
cleanup, worth doing only if it does not grow the diff.

## Tests

- `generateAgency` on a deep-frozen program returns source and does not throw.
  Freezing the input expresses the bug directly and does not depend on statics.
- `generateAgency` does not modify the program it was given: capture node types
  before and after and compare. This is the invariant; the frozen case is one
  way to violate it.
- Output is byte-identical to today's for a program with imports, a header
  comment and declarations — the partitioning must still happen, just not in
  place.
- An execution fixture under `tests/agency/templates/` calling `toSource` on a
  `static const` literal with no `fill` in between. That is the user-visible
  shape, and every current fixture skips past it.

---

# Out of scope

Named so review does not have to guess whether they were forgotten:

- Fill-time validation of record shapes (the missing-`age` report).
- Name resolution inside code literal bodies.
- Kind inference for declaration-only literals (the `type` question above).
- Making keywords reserved in expression position — a language change.
- The splice `AG8005` message.
- Top-level `if`/`while`/`for`/`match`/`thread` crashing the builder — filed
  as issue #713.

# Risk

Change 1 narrows what the body grammar accepts. The shape check is restricted
to `node`/`def` followed by an identifier, and every keyword-as-variable form
was verified unaffected, so the intended blast radius is: bodies that today
mis-parse a declaration, plus the one accepted regression named above.

Change 2 widens what code literals accept — bodies that hard-fail today will
parse. It cannot change the result for any body that already parses, because
the converted throw only ever occurs on an attempt that was going to fail.

Part 2 is contained to one function and guarded by the byte-exactness of the
existing formatter goldens. The corpus round-trip gate
(`lib/backends/agencyGenerator.roundtrip.test.ts`) covers the whole fixture
corpus in both parse modes and is the backstop for both parts.

---

# Response to review

Review: `2026-07-28-code-literal-parse-and-print-fixes-design-REVIEW.md`. All
five findings were re-verified against the code before acting; all five held.

- **Finding 1 (routing breaks keyword-as-identifier bodies): accepted, and it
  led to dropping routing entirely.** Verified that `[| node |]`,
  `[| node.run() |]` and `[| node + 1 |]` parse as expressions today. The
  review's suggested repair (peek for declaration shape) works, but chasing it
  surfaced that the same mis-parse happens in ordinary node bodies with no
  literal involved — which routing cannot reach. The shape check moved into
  the body grammar instead, where it fixes both.
- **Finding 2 (`effect`/`effectSet` are body-legal): accepted.** Confirmed both
  parsers are alternatives in `_bodyNodeParser`. The routing table they were in
  no longer exists; `effect` bodies are explicitly unchanged.
- **Finding 3 (Part 2 pass ordering): accepted, corrected.** Pass 4 runs at
  line 233, after the partition at 223. Passes 1 and 2 read the original
  stream; 3, 4 and 5 read the partitioned local.
- **Finding 4 (residual holes): both closed rather than documented.**
  Statement-then-declaration is fixed by Change 1, since the check fires
  wherever the statement appears, not just first. The `static const` throw is
  fixed by Change 2, generalized from the review's suggestion so any throwing
  parser is covered, not just this one.
- **Finding 5 (`type` blast radius): accepted.** Verified that
  `[| type P = ...` newline `return 1 |]` parses as statements today and would
  hard-fail if routed. `type` is now explicitly out of scope.

One fact the review flagged as unverified — that the `parseError` throw escapes
`runNested` uncaught — is confirmed by the repro in
`packages/agency-lang/investigate/`, and Change 2 depends on it.
