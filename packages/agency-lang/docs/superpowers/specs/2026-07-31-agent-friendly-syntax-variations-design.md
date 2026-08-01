# Accepting the syntax variations agents actually write

## Background

Agency is a language for writing agents, and it is also a language meant to be
written *by* agents. Those two goals pull in different directions in one
specific way.

When a model writes Python or TypeScript, it has seen millions of examples and
knows the syntax cold. When it writes Agency, it has seen almost none. So it
falls back on the nearest thing it does know, and guesses. It writes `function`
where Agency wants `def`. It writes `-> string` where Agency wants `: string`.
It writes `=>` where Agency wants `->`, and `->` where Agency wants `=>`. Every
one of those guesses costs a compile error, a re-read of the docs, and another
turn — and each turn costs money and time.

The fix we are choosing is to stop treating those guesses as mistakes. Where a
guess is unambiguous — where there is exactly one thing the author could have
meant — the parser should simply accept it and build the same tree it would
have built for the canonical spelling. `agency fmt` then rewrites the file into
canonical form, so the code that gets committed and read later is still
consistent.

### This is not a new idea in this codebase

The `await` and `sync` keywords already work this way. Everything in Agency is
awaited by default, so `await` has no meaning — but agents write it constantly
out of JavaScript habit, so the parser accepts and discards it
(`lib/parsers/parsers.ts:2857`). `const x = await llm("hi")` produces an AST
byte-identical to `const x = llm("hi")`.

That precedent settles the question of whether this approach fits the language.
It already is the language. What follows extends it to four more cases.

### What we checked before writing this

Several things that look like they would break agents already work. Probing the
parser directly:

| Written by an agent | Parses today? |
|---|---|
| `const x = 5 // trailing comment` | yes, correctly |
| `const x = await llm("hi")` | yes, `await` discarded |
| `for (x of xs)` | yes |
| `for (const x in xs)` | yes |
| `type F = { a: string; b: number }` (semicolons) | yes |
| `cond ? a : b` | no |
| `map(xs, (n) => n * 2)` | no |
| `interface Foo { }` | no |

Two findings from that pass are worth recording:

**The trailing-comment documentation is wrong.** `docs/site/guide/basic-syntax.md`
states that a comment cannot follow code on the same line and gives
`const x = 5 // this is a comment` as an example of what is *not* allowed. It
parses fine, and has for some time. An agent reading the guide is being told to
avoid something that works. This spec fixes the doc.

**`[3..6]` silently misparses today.** It does not error. `numberParser`
(`lib/parsers/parsers.ts:600`) builds a number's text from
`many1WithJoin(or(char("-"), char("."), char("_"), digit))`, which accepts any
number of dots. So `[3..6]` parses as a one-element array holding a number
whose text is the string `"3..6"`:

```json
"items": [ { "type": "number", "value": "3..6" } ]
```

No parse error, no typecheck error. This is worse than a failure, because
nothing tells the author anything is wrong. Fixing it is part of this work
regardless of whether ranges land.

## The approach

The parser accepts each variation as a first-class alternative producing the
same AST as the canonical spelling. The AST records *meaning, not spelling* —
it does not remember which keyword or which arrow the author typed. `agency fmt`
therefore normalizes for free, because `AgencyGenerator` has only one spelling
available to emit.

The alternative we considered and rejected was keeping one strict grammar and
adding a recovery pass: on a parse failure, re-parse tolerantly, and if that
succeeds, emit a diagnostic naming the canonical form for the agent to fix. That
has a real advantage — it teaches, and it keeps one spelling in the grammar —
but it means maintaining a second parse path forever, and it still costs the
agent a turn. Accepting the syntax costs zero turns.

The trade-off we are taking on knowingly: **`agency fmt` becomes lossy.** A
hand-written `function` becomes `def`, and a hand-written `[3..6]` becomes
`range(3, 6)`, with no way to ask for the original back. That is the intended
behavior, but it is a behavior change for anyone who expected `fmt` to preserve
their choices.

## Scope

Four variations. Each is either a single-token alternative or a small lowering
onto an AST node that already exists.

1. `function` as a second spelling of `def`
2. `->` as a second spelling of the `:` before a return type
3. `=>` and `->` interchangeable in match arms and inline blocks
4. `[3..6]` range literals, lowering to `range(3, 6)`

Deliberately **not** in this spec, and why, is in the last section.

---

## 1. `function` as a second spelling of `def`

An agent writes:

```ts
function add(a: number, b: number): number { return a + b }
```

### Changes

**`_baseFunctionParser` (`lib/parsers/parsers.ts:5730`).** Change
`capture(str("def"), "keyword")` to
`capture(oneOfStr(["def", "function"]), "keyword")`.

Nothing else is needed to make the AST match. That capture is already
destructured away and thrown out at line 5848:

```ts
const { keyword: _keyword, returnTypeValidated: _rtv, raises: _raises, ...rest } = ...
```

So the keyword the author typed is already not part of the tree.

**`bodyDeclarationParser` (`lib/parsers/parsers.ts:4584`).** Change
`or(str("node"), str("def"))` to `or(str("node"), str("def"), str("function"))`.

This one is not optional, and skipping it would reintroduce a bug that was
already fixed once. `bodyDeclarationParser` is a probe added when fixing the
"declaration parses as a name plus a call" bug. In Agency a call may take a
trailing block, and keywords are not reserved in expression position, so a
declaration written inside a function body can be read as a variable name
followed by a call with a block attached:

```ts
node main() {
  function inner() { print(1) }   // reads as: name `function`, call `inner() { ... }`
  print("x")
}
```

That parses, compiles to TypeScript that looks plausible, and dies at run time
with a `ReferenceError`. The probe exists to catch the shape and produce a real
error instead. It must learn the new keyword at the same time the function
parser does.

**`RESERVED_WORDS` (`lib/parsers/parsers.ts:215`).** Add `"function"`.

This list does not govern general identifier parsing. Its only consumer is
identifier-hole filling in Template Agency, where it stops
`fill(t, { name: "if" })` from producing source that explodes at re-parse far
from its cause. Its doc comment says to extend it when a new keyword lands.
`async`, `sync`, and `await` are already in it, which is the precedent.

### Ambiguity

None. `function` is followed by a name and `(`, the same shape as `def`.

---

## 2. `->` as a second spelling of the return-type `:`

An agent writes:

```ts
def add(a: number, b: number) -> number { return a + b }
node main() -> string { ... }
```

### Change

**`functionReturnTypeParser` (`lib/parsers/parsers.ts:5703`).** Change
`char(":")` to `or(char(":"), str("->"))`.

One edit covers both `def` and `node`: `functionParser` and `graphNodeParser`
both delegate to this parser (lines 5757 and 5918).

### Ambiguity

None. At that position the parser has just consumed the closing `)` of the
parameter list. The only things that may legally follow a return type are `!`
(the validation bang), a `raises` clause, or `{`.

Note that `->` is *already* the arrow in function type annotations —
`type Callback = (string) -> string` — so this makes the two consistent rather
than introducing a new meaning for the token.

---

## 3. `=>` and `->` interchangeable

An agent writes either arrow in either place:

```ts
match (x) { 1 -> "one" }          // canonical: =>
const ys = map(xs, \n => n * 2)   // canonical: ->
```

### Changes

**Match arms (`lib/parsers/parsers.ts:3968`).** Change `str("=>")` to
`or(str("=>"), str("->"))`.

**Inline blocks (`lib/parsers/parsers.ts:3795`).** Change `str("->")` to
`or(str("->"), str("=>"))`.

Block *types* at line 1765 already accept both arrows:

```ts
or(str("->"), str("=>")),
```

So two of the three arrow positions in the grammar disagree with the third.
This makes them agree.

### Ambiguity

One case to pin with a test rather than assume: a match guard ending in a
comparison against a negative number, where `>` and `-` sit adjacent to the
arrow.

```ts
match (x) {
  _ if (a >-3) -> "yes"
}
```

The guard's closing `)` should keep the tokens apart, since the arrow is only
looked for after the guard has been fully consumed. The test exists to prove
that, not because we expect it to fail.

---

## 4. Range literals

An agent writes:

```ts
for (i in [3..6]) { print(i) }
```

### Two changes

**First, fix the silent misparse.** `numberParser`
(`lib/parsers/parsers.ts:600`) must reject a numeric literal containing more
than one `.`. Today it accepts any number of them and hands downstream code a
malformed number, as described in the Background. This is a bug fix that stands
on its own: after it, `[3..6]` produces a real parse error even before range
support lands.

**Second, add the range parser.** `a..b` produces an ordinary `range(a, b)`
`functionCall` node. This follows the pattern in
`lib/lowering/comprehensionDesugar.ts`, which rewrites comprehensions into real
`map`, `filter`, and `fork` calls specifically so that "the rest of the compiler
cannot tell the construct existed, so typing, codegen, interrupts, and fork
branch semantics are inherited rather than reimplemented." The same reasoning
applies here: a range that is a `range()` call needs no new typing rules, no new
codegen, and no new runtime support.

### `..` is exclusive

`[3..6]` means `range(3, 6)`, which is `3, 4, 5`. The end is not included.
`[a..b]` is `range(a, b)` — a pure spelling change with no arithmetic.

This decision deserves its reasoning recorded, because the failure mode if we
choose wrong is a silent off-by-one rather than an error, and because the
majority convention in other languages points the other way.

**What other languages do.** `..` means *inclusive* in Ruby, Kotlin, Haskell,
Perl, Raku, Pascal, Nim, Elixir, Crystal, F#, CoffeeScript, and bash brace
expansion. It means *exclusive* in Rust, Zig, D, and C#. On a straight count of
languages, inclusive wins comfortably.

**Why we chose exclusive anyway.** Agency's existing endpoints are all
half-open, and they all came from Python:

- `range(start, end)` is Python's, and is exclusive. `stdlib/index.agency:281`
  documents `end` as "the exclusive end number."
- Slices are Python's, and are exclusive. `arr[1:4]` on `[1,2,3,4,5]` gives
  `[2, 3, 4]` — indices 1, 2, 3, stopping before 4.

So an inclusive `..` would not be one isolated inconsistency. It would break a
convention the language has adopted twice, from a single source, in constructs
that an agent can see in the same file it is editing.

There is also a version of the "meet agents where they are" argument that points
this way. That argument says to follow what a model pattern-matches on. Python
is the largest single influence on how models write code, so a model's prior for
"a start and an end" is Python's half-open one — and Agency has already
committed to that prior twice, visibly.

**No inclusive spelling.** We are not adding `..=`, `...`, or `..<`. An author
who wants an inclusive range writes `[3..7]` or `range(3, 7)`, exactly as they
would today. Rationale: `...` differs from `..` by a single character for the
opposite meaning, which is a well-known source of bugs in Ruby and precisely the
kind of near-invisible distinction a model gets wrong; `..=` and `..<` are both
extra syntax to learn in service of a case the language already handles.

**One thing to document.** `range` is auto-imported through the standard-library
prelude. A file that shadows `range` with its own definition would silently
retarget every range literal in that file. This is rare, but it should be
mentioned in the guide.

---

## Why normalization needs no work

`AgencyGenerator` requires no changes. It already emits `def` unconditionally
(`lib/backends/agencyGenerator.ts:1176`) and `:` before a return type
(`:1129`), because those were the only spellings that existed when it was
written. Since none of the four variations is recorded in the AST, the generator
has nothing to choose between and canonical output falls out.

This is the load-bearing property of the whole design, and it is worth stating
as a rule for anything added later: **a variation belongs in this program only
if the AST can forget which spelling was used.** A variation that needs to be
remembered — because the two spellings mean different things, or because the
formatter would have to preserve the author's choice — is a different feature
with different costs, and does not belong here.

## Testing

Each variation gets a round-trip test in the co-located parser test files
(`lib/parsers/function.test.ts`, `matchBlock.test.ts`, `blockArgument.test.ts`,
and a new `range.test.ts`). The shape of each test:

1. Parse the source written in the new spelling.
2. Assert the AST equals the AST from the canonical spelling, exactly.
3. Generate with `AgencyGenerator` and assert the canonical text comes out.

Step 2 is the important one. It is what proves the variation is genuinely a
spelling and not a second construct.

Beyond the four round trips:

- **Nested `function` in a body.** `function inner() { }` inside a node body
  must produce the same targeted error `def` does, not a name-plus-call
  misparse. This is a regression guard on an already-fixed bug.
- **Match-guard arrow adjacency.** The `_ if (a >-3) -> "yes"` case above.
- **Multi-dot number literal.** `1.2.3` must be a parse error, not a number.
- **Range in the positions that matter.** In a `for` header, as a standalone
  expression, and with non-literal endpoints (`[a..b]`).
- **Formatter idempotence.** Formatting an already-formatted file that
  originally used the variations changes nothing on the second pass.

Agency execution tests are not needed. None of this changes runtime behavior —
a range becomes a `range()` call that already works, and the other three produce
byte-identical trees.

## Documentation

- `docs/site/guide/basic-syntax.md` — add the accepted variations, and **remove
  the incorrect claim that a comment cannot follow code on the same line.**
- `docs/site/guide/functions.md` — mention `function` and `->` as accepted
  spellings that `agency fmt` normalizes.
- `docs/site/guide/blocks.md` and `match-expressions.md` — note that both arrows
  work.
- Range literals need a home. `basic-syntax.md` alongside the slice syntax is
  the natural place, since they are the two half-open constructs and the
  exclusive-end behavior is best explained once, for both.

Each doc addition should say plainly that the canonical form is what `fmt`
produces. The goal is not to present two equal options; it is to tell a reader
that their guess will work while showing them what the language prefers.

## Out of scope, and why

These came up while brainstorming and were deliberately deferred:

- **Arrow functions as block arguments** (`map(xs, (n) => n * 2)`) and
  **ternaries** (`cond ? a : b`). Both are high-value — probably higher than
  anything in this spec — but both are lowerings rather than token swaps, and
  the ternary has a genuine ambiguity to resolve against the `?` in optional
  parameters and properties. They deserve their own spec.
- **Keyword aliases**: `interface` to `type`, `elif` to `else if`, `undefined`
  to `null`, capitalized `String`/`Number`/`Boolean`. Each is trivial alone but
  together they widen the surface a lot in one change. Note that `undefined`
  currently parses as a bare variable reference and passes the typechecker, so
  it fails at run time rather than compile time — that is worth its own look.
- **C-style `for (let i = 0; i < n; i++)`.** Lowers to a `while` loop. Common
  from agents, but a larger transform.
- **`switch`/`case`.** Rejected, not deferred. The semantics differ from `match`
  (fallthrough, exhaustiveness), so an agent reaching for `switch` is probably
  reasoning about the wrong construct and should be told so.
- **`handle { } catch (e) { }`.** Rejected. `catch` already means "default value
  on failure" in Agency, and overloading it would degrade error messages for
  everyone.

## The measurement we are not doing

This list came from intuition — mine and the owner's — not from data. The repo
now has an eval framework and statelog traces from the self-writing-agent work,
and every parse failure in those runs is a recorded instance of a model guessing
wrong at Agency syntax. Ranking variations by observed frequency would beat both
our guesses, and I would not be surprised if it reordered this list.

We are proceeding without it because these four are cheap and the pattern they
establish is what makes later additions mechanical. But the measurement should
happen before the second batch, and it is the right way to decide what goes in
that batch.

## Risks

**Parse error quality.** `lib/parsers/parsers.ts` is a 6,400-line file built
largely from `or(...)` alternatives, and it already fights to give specific
errors — the `parseError` commit points inside `_baseFunctionParser` exist
precisely because more alternatives make failure messages vaguer. Every accepted
variation makes the "what did you mean" problem harder for syntax that is still
genuinely wrong. Four is a small enough number that this should not bite, but it
is a cost that compounds, and it is the main reason to measure before batch two.

**Corpus consistency.** If the language has two spellings for everything, the
Agency code models read to learn the language becomes less consistent, which may
make them worse at it over time. `agency fmt` is the mitigation — canonical form
is what gets committed — but only for code that is actually formatted.

**`fmt` is now lossy.** Stated above under the approach. Worth a changelog line
so it does not surprise anyone.
