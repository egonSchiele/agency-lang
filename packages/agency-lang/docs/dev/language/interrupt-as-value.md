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

Parsing as a value and working as a value are different. The answer arrives in
three positions:

1. The right side of an assignment: `const mood = raise feel("How?")`.
2. A match arm: `1 => raise feel("How?")`. The arm is lowered to an assignment
   to a temporary, so this is the first case again.
3. A `return`, with a difference described below.

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

## Nested positions do not compile

Inside a call argument or a string, an interrupt parses and then compiles to
broken JavaScript:

```ts
const labelled = label(interrupt feel("q"))
const text = "x ${interrupt feel("q")}"
```

The hoist pass lifts a nested call into a temporary but leaves a nested
interrupt where it is (`walk` in `lib/preprocessors/hoistCalls.ts`), so the
interrupt's generated statements land in the middle of an expression. Issue
#1412 tracks this. Until it is fixed, assign the interrupt to a variable first.

## A function named `raise` or `interrupt` cannot be called

`raise(...)` and `interrupt(...)` are always interrupts. If a program imports
or defines a function named `raise`, the text `raise()` does not call it:

```ts
import { raise } from "./helper.js"

node main() {
  return raise()   // an interrupt with no effect name, not a call to the helper
}
```

Nothing refuses the import or the `def` today, so the program compiles and
does something else. Issue #1413 tracks refusing those names.

## The keyword and its effect name share a line

After `raise` or `interrupt`, the parser reads spaces and tabs but not a line
break (`sameLineSpaces` in `lib/parsers/parsers.ts`). Without that rule, a
variable named like the keyword would swallow the next line:

```ts
const raise = 2
const c = raise
print(c)
```

The second and third lines would read as `const c = raise print(c)`, an
interrupt with the effect `print`. With the rule they are two statements, which
is what a statement ending at the end of its line means
(`docs/dev/compiler/statement-boundaries.md`).
