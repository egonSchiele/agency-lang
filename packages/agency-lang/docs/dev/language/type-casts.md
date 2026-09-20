# Type casts: `expr as Type` and `expr as Type!`

Agents that write Agency keep writing TypeScript-style casts. Before this
existed, `const r = foo() as Person` parsed as the assignment `const r =
foo()` followed by two stray statements, `as` and `Person`, and the author
saw `AG4007 Variable 'as' is not defined`.

## The two forms

`x as Person` is the unchecked cast. It changes the type the type checker
sees and emits nothing:

```
const p = raw as Person        // p: Person
greet(raw as Person)
```

`x as Person!` is the checked cast. It validates the value against the
type's schema at runtime and gives a `Result`, the same thing a declaration
bang gives:

```
const p = raw as Person!       // p: Result<Person>
const q = raw as Person! catch { name: "fallback" }
```

The checked form always gives a `Result`. `greet(raw as Person!)` is a type
error unless `greet` takes a `Result`.

## Telling a cast from an `as` block

`as` already introduces a block argument: `map(names) as name { ... }`. A
block follows a call in one place, `blockArgumentParser` inside
`_functionCallParser`, so there is one site to guard.

The parser decides by lookahead, after `as` and whitespace:

1. `{` followed by `}`: block.
2. `{` followed by `key:`, `key?:`, or a member tag starting with `@`: a
   cast to an object type. Newlines and comments between the `{` and the key
   are skipped, because that is how an agent usually writes an object type.
3. `{` followed by anything else: block.
4. An identifier, or a parenthesized parameter list, followed by `{` on the
   same line: block.
5. Anything else: cast.

Rule 2 is what makes `foo() as { name: string }` a cast while `foo() as {
name }` stays a block: an object type needs `key: Type`, and a block body
holding the expression `name` does not have one. `foo() as {}` stays a
block, which is the one overlap; a cast to the empty object type is not
useful.

A cast to a function type, `as (x: number) => string`, starts like a
multi-parameter block, `as (x, i) { ... }`. The token after the `)` decides:
`=>` means a type, `{` means a block.

The lookahead runs before the block parser, rather than trying the block
parser first and falling back. With a fallback, a typo inside a real block
body such as `map(xs) as x { print(x }` would be reported as a bad type.

### Whitespace, and a cast on the next line

`_functionCallParser` ends with `optionalSpacesOrNewline`, so after `foo()`
the following whitespace is already gone. This is why `foo() is string` does
not parse as an `is` expression: `atomWithIs` demands whitespace before
`is`, and there is none left. A cast after a call is the main case for this
feature, so `asKeyword` does not require leading whitespace. The word
boundary is still safe, because `as` is reserved and an atom ending in an
identifier has consumed every identifier character.

A cast may start on the next line, with a blank line between:

```
const r = x
  as Person
```

Nothing else can start a line with the reserved word `as`, and after a call
the newline is already consumed, so a same-line rule could not be enforced
consistently. A comment line between ends the expression; what follows is
the stray `as` and `Person` statements the parser has always produced.
`agency fmt` joins a next-line cast onto one line.

`x is Person as boolean` parses as `(x is Person) as boolean`, because the
cast wraps `atomWithIs`. `x as Person is Person` leaves the `is` behind as
stray statements, the same junk that `node is string` has always been.

### Why the type error throws

A missing type is reported with `parseError`, which throws a positioned
`TarsecError`. `buildExpressionParser` discards a committed failure that
comes from a right operand, and `memo` hides writes to the
`committedFailure` slot, so a returned failure inside an expression
resurfaces as the unhelpful "expected node body". Throwing is safe here,
because no other reading of `expr as <not a type>` is legal by the time the
type is parsed.

## The refused position, AG1016

TypeScript gives `as` the precedence of the relational operators, so `a + b
as T` means `(a + b) as T`. In Agency the cast attaches to the atom, so the
same text means `a + (b as T)`. Rather than let the two disagree silently,
Agency refuses a cast on the right of an operator that binds at least as
tightly as `<`: `**`, `*`, `/`, `%`, `+`, `-`, `<`, `>`, `<=`, `>=`, `in`,
and `instanceof`. Parentheses say which grouping is meant. Issue
[#1088](https://github.com/egonSchiele/agency-lang/issues/1088) tracks
giving `as` TypeScript's precedence and removing the rule.

`bindsTighterThanCast` in `lib/types/binop.ts` is the one home for that
comparison. The formatter and the check both ask it.

Prefix operators are exempt. `!x as boolean` already groups as `(!x) as
boolean`, which is TypeScript's grouping, because a prefix operator takes a
bare atom as its operand. Compound assignments are exempt for the same
reason: `n += a as number` has nothing on the right of `+=` but the cast.

A cast that parentheses directly wrap carries `parenthesized: true`, set by
the parser, and the check skips it. Code that builds a `castExpression` by
hand must set that field, or a hand-built `a + (b as T)` will be refused.

`agency fmt` rewrites `!x as boolean` to `(!x) as boolean`. Both spellings
parse to the same node, and the printer parenthesizes a `binOpExpression`
inside a cast, which a unary operator is.

## Hoisting, AG1017, and AG1019

A checked cast to a type with no `@validate` tags compiles to
`__validateType`, a synchronous schema check that cannot pause. A checked
cast to a tagged type runs the validators, and a validator is an Agency
function that can raise an interrupt.

A declaration bang is always its own statement. A cast is not:

```
greet(x as Asked!, fetchThing())
```

If the validator pauses here, the resume must not run the validator again
and must not call `fetchThing()` twice. The hoist pass gives calls that
guarantee by lifting each into a temp on its own line, and it now does the
same for a checked cast. See `docs/dev/compiler/hoist-calls.md`. A hoisted
cast lands immediately before its original statement in the same block, so
it stays inside every `handle` block that enclosed it, and those handlers
are consulted when its validator raises. `tests/agency/casts/` tests that
directly.

Where the pass does not lift, the type checker refuses a cast that can
pause. `lib/preprocessors/hoistPositions.ts` models the three layers that
decide where the pass lifts from:

1. Which top-level nodes it enters: `function` and `graphNode` bodies only.
2. Which statement kinds it extracts from, which is
   `EXTRACTING_STATEMENT_KINDS`. A bare method-call statement such as
   `xs.push(a as Asked!)` is not one of them.
3. Which slots it skips: a slot whose eval mode is `opaque` or
   `conditional`, skipped without being walked, so nothing beneath it is
   lifted, block bodies included.

It reads the AST the type checker holds, with guards desugared and
`parallel` and `seq` blocks still present. The pass runs later, after a
parallel block has become a fork call. Its agreement test runs the
production desugars before the pass and asserts that "liftable" matches what
the pass actually lifted, so that difference is checked rather than assumed.

Two things the word "liftable" does not mean. It says the pass MAY lift from
the position: the last value of an assignment or `return` is liftable and
still not lifted, because it is already the statement's own step. And a cast
inside a template hole or a code literal is never examined, because those
are leaves in `expressionSlots`; that cast is checked when the completed
program compiles.

The check is then a filter over that list. A `stuck` cast gets AG1017, which
says to move it to its own line. A cast in a module-level initializer or a
parameter default is `outsideBodies` and gets AG1019, which says to do the
cast inside a node or a def, because there is no line to move to.

`typeRunsValidators` in `validationDescriptor.ts` is the one answer to "does
validating this type run validators?". The builder's `validateExpr` asks it
to pick the emit path, and the check asks it to decide whether a cast can
pause. If the two asked the question differently, the check could stay
silent while codegen emitted the pausing path.

The refusal covers tagged casts only. The most common use of a checked cast
is `raw as Person! catch fallback`, and the left side of `catch` is opaque.
With no tags that cast is a synchronous check, so it stays legal.

## An unchecked cast runs no validator

`x as Asked`, where `Asked` carries `@validate` tags, runs nothing. That
matches TypeScript and is intended.

## Open question: validators in handler bodies

The pass never touches a handler body, because it compiles to plain
JavaScript that cannot pause. `const b: Asked! = 6` inside a handler body,
where `Asked` has an interrupting validator, compiles today with no
diagnostic to an awaited `__validateChainRecursive` call inside
`runner.handle`. The same question applies to any Agency function call in a
handler body, so it is not specific to casts. A tagged cast in a handler
body follows whatever the declaration bang does, and AG1017 says nothing
about handler bodies. AG1016 still applies there.

## Files

- `lib/types/castExpression.ts` — the node.
- `lib/parsers/parsers.ts` — `castStart`, `castSuffixParser`, `castable`,
  and the `not(castStart)` guard at the block site.
- `lib/typeChecker/synthesizer.ts` — the cast's type, AG1014, AG1015,
  AG1018.
- `lib/typeChecker/castPositions.ts` — AG1016, AG1017, AG1019.
- `lib/preprocessors/hoistPositions.ts` — where the pass can lift from.
- `lib/preprocessors/hoistCalls.ts` — checked casts become temps.
- `lib/backends/typescriptBuilder.ts` — `processCastExpression`.
- `lib/backends/agencyGenerator.ts` — printing a cast.
- `lib/types/binop.ts` — `bindsTighterThanCast`.
