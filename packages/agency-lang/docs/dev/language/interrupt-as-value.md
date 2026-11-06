# An interrupt as a value

An interrupt has two spellings, `interrupt` and `raise`. Both can be written as
a statement, and both can be written where a value is expected:

```ts
const mood = raise feel("How do you feel?")
const mood = interrupt feel("How do you feel?")
```

The value is the answer the interrupt was approved with. A handler gives it
with `approve("happy")`; a person gives it when they respond interactively.

## One parser entry per spelling

`baseAtom` in `lib/parsers/parsers.ts` is the list of parsers that can start an
expression. `raiseExprParser` and `interruptExprParser` are both in it, so both
spellings parse wherever an expression can start.

They produce the same node, `interruptStatement`. The `raise` spelling sets
`viaRaise: true` on it. Only the formatter reads that field, to print the
keyword the author wrote. The type checker and the code generator treat the
two spellings as one thing.

Each spelling also has a statement parser (`raiseStatementParser`,
`interruptStatementParser`) in the statement lists. Those read the same forms
and then the end of the statement.

## Where the answer is delivered

An interrupt compiles to several statements: raise it, pause, read the answer.
So it has to be a statement of its own, or the whole value of one:

1. The right side of an assignment: `const mood = raise feel("How?")`.
2. A match arm: `1 => raise feel("How?")`. The arm is lowered to an assignment
   to a temporary, so this is the first case again.
3. A `return`, with a difference described below.

Nested anywhere else, the hoist pass (`lib/preprocessors/hoistCalls.ts`) lifts
the interrupt into a temporary on the line above, exactly as it lifts a nested
call. So this:

```ts
const labelled = label(interrupt feel("How?"))
```

compiles as if it were the first case:

```ts
const __hoist_0 = interrupt feel("How?")
const labelled = label(__hoist_0)
```

That covers a call argument, a string interpolation, a list or object literal,
an operand of `+`, an `if` condition, a `for` iterable, and a `while`
condition, which is asked again on every pass.

### `return` carries on when the interrupt is approved

```ts
def requestEnvRead(name: string): string | null {
  return interrupt std::env("Read this variable?", { name: name })
  return _env(name)
}
```

When the interrupt is rejected, the function returns the failure. When it is
approved, the function does not return the answer. It carries on to the next
line. The standard library uses this to put a permission check in front of the
work. The type checker models it in `returnStatement` in
`lib/typeChecker/flowBuilder.ts`: a `return` of an interrupt does not end the
flow, so the lines after it are still checked as reachable code.
`return raise ...` behaves the same way.

## Where a nested interrupt does not compile

The hoist pass leaves some positions alone, and a nested interrupt there still
compiles to broken JavaScript. The build fails in esbuild with
`Unexpected "const"`, so nothing runs. The positions are the ones
`docs/dev/compiler/hoist-calls.md` lists as opaque or conditional. The two a
person is most likely to write:

```ts
const answer = ready && interrupt feel("q")
const labelled = label(interrupt feel("q")) with approve
```

The right side of `&&`, `||`, or `??` may never run, so it cannot move to the
line above. A statement under `with approve` cannot have part of it moved
outside the approval. In both cases, assign the interrupt to a variable first.

This is left as it is on purpose. These are rare shapes, they fail at build
time, and refusing them with a diagnostic of their own was judged not worth
the code.

## A function named `raise` or `interrupt` cannot be called

`raise(...)` and `interrupt(...)` are interrupts wherever an expression starts.
If a program imports or defines a function named `raise`, the text `raise()`
does not call it:

```ts
import { raise } from "./helper.js"

node main() {
  return raise()   // an interrupt with no effect name, not a call to the helper
}
```

Nothing refuses the import or the `def` today, so the program compiles and
does something else. Issue #1413 tracks refusing those names.

There is one position where the text is still read as a call: straight after a
string and `+`, as in `"x" + raise("q")`. `stringParser` reads that operand
with `valueAccessParser`, which does not go through `baseAtom`. The call is to
a function named `raise`. If the program has no such function, it fails when
it runs. If the program imports one, as in the example above, this is the one
position where the import is called.

## An interrupt is written on one line

`interrupt` or `raise` with nothing after it on its line is a parse error:

```ts
interrupt
  deploy("Ship it?")
```

Read as two statements, the first line is a bare name that does nothing and the
second is a plain call to `deploy`. The interrupt that was meant to stand in
front of the call would be gone, with no error. So the parser refuses the
keyword when only a line break, a comment, or the end of the file follows it
(`interruptKeywordAloneRefusal` in `lib/parsers/parsers.ts`). Both
`_interruptExprParser` and `_raiseExprParser` ask it first, which covers the
statement and the value position of each spelling. A block comment after the
keyword is refused even when it closes on the same line, as in
`interrupt /* why */ deploy("Ship it?")`, because a block comment can hide a
line break.

The refusal also means a variable named `raise` or `interrupt` cannot be the
last thing on a line. Such a variable can still be declared; issue #1413 is
about refusing the name.
