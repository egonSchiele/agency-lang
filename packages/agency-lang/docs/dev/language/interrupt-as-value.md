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

A handler function is the third such place. The hoist pass never rewrites
one (a handler never pauses, so there is nothing for a lifted temporary to
protect), so a nested interrupt inside `with (intr) { ... }` also fails the
build.

Inside a `handle` block's own body the lift is safe: the temporary is written
inside that body, so the interrupt keeps its handler, and a rejection stops
the function before the outer call runs.

This is left as it is on purpose. These are rare shapes, they fail at build
time, and refusing them with a diagnostic of their own was judged not worth
the code.

## A function cannot be named `raise` or `interrupt`

`raise(...)` and `interrupt(...)` are interrupts wherever an expression starts.
A function with either name could be declared and never called: the text
`raise()` would raise an interrupt with no effect name instead. So the parser
refuses the name on a `def`, a `node`, an import, and a re-export
(`export { raise } from "./helper.js"`):

```ts
import { raise } from "./helper.js"                  // refused
import { raise as raiseFromJs } from "./helper.js"   // fine
```

`callableNameParser` in `lib/parsers/parsers.ts` reads an import's local name
with the check, and `declNameParserFor` runs the same check on the name after
`def` or `node`. The exported name before `as` is not checked, so a JavaScript
function with either name can still be imported under another one.

A variable or a parameter with one of these names is not checked, because
handlers are commonly written `with (interrupt) { ... }`. That leaves one case
open. A variable or a parameter named `raise` can hold a function, and calling
it raises an interrupt instead:

```ts
def applyIt(raise: (x: string) => string): string {
  return raise("hi")   // an interrupt with no effect name; the function is not called
}
```

The parser does not know which names are in scope, so it cannot tell this from
an interrupt.

A template hole filled with either word is refused separately, because both
are in `RESERVED_WORDS` (`identifierFillFor` in
`lib/runtime/template/fill.ts`).

There is one position where the text is still read as a call: straight after a
string and `+`, as in `"x" + raise("q")`. `stringParser` reads that operand
with `valueAccessParser`, which does not go through `baseAtom`. The call is to
a function named `raise`. A program can no longer define or import one, so it
fails when it runs.

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
last thing on a line. Such a variable can still be declared.
