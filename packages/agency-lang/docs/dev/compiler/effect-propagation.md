# How a function's interrupt effects are computed

An Agency function that does something risky carries a label. Reading a file
carries `std::read`. Running a shell command carries `std::exec`. The label is
called an interrupt effect, because when the function runs it pauses and asks
for permission rather than going ahead.

Only one thing in the language creates an effect: the `interrupt` keyword.
Everything else inherits. If your function calls `read`, your function can also
trigger `std::read`, even though you never wrote `interrupt` yourself.

Nine parts of the toolchain read the resulting list. Four report to a person:
`agency policy gen`, which writes the permissions file you review before running
a program; the AG3009 warning about an unhandled effect; the "Throws" column in
`agency doc`; and the tool descriptions `agency serve` hands to language models.
Five are checks that fail a build: AG3011 for a callback that may interrupt,
AG3013 through AG3015 for a `raises` clause that is exceeded, and AG3016 for a
`finalize` block. Handler parameter typing reads it too, which is how a
`handle` block knows what its parameter can be.

## The two steps, and where they used to meet

The list is built in two places.

When the compiler first crawls your program, it walks each function body looking
for the `interrupt` keyword. That is `collectDirectInterruptEffects` in
`lib/symbolTable.ts`, and it never follows calls.

Later, when the compiler type-checks a file, it follows calls within that file:
build a small graph of who calls whom, then repeat "give every function the
effects of everything it calls" until nothing changes.

The second step only ever saw one file. When it met a call to something
imported, it asked the symbol table, and the symbol table answered with the
first step's list. So an imported function arrived as a dead end.

That was GitHub issue 680. Two files were enough to show it:

```
// helper.agency
export def h(): string {
  return read("data.txt")
}

// main.agency
import { h } from "./helper.agency"
node main() {
  const x = h()
}
```

`helper.agency` reported `{ h: ["std::read"] }`, correctly. `main.agency`
reported `{ main: [] }`. And because `agency policy gen` reads that list, it
printed "No interrupt effects found in this agent. No policy needed." for a
program that reads your filesystem.

It stayed hidden for a long time because every risky function in the standard
library is written with a literal `interrupt` in its body, so the first step's
answer happens to be right for all of them. The gap opens the moment somebody
writes their own function that wraps one.

## Method calls in a chain

`f.partial(method: "GET")`, `f.rename("x")` and `xs.map(...)` all parse as a
method-call link inside an access chain. The name on the call node is
`partial`, `rename` or `map`, none of which is a global function.

So a walk that reads the name off the call node records a phantom callee, and
if any function in the program happens to share that name, its effects get
attributed to a call site that never touches it. `calledName` returns null for
these. The type checker excludes them for the same reason
(`lib/typeChecker/functionTypeRaises.ts`).

What a method call actually reaches needs the receiver's type, which this walk
does not have. That makes it one of the blind spots the splice eligibility
check refuses on.

A note for anyone who finds `.invoke()` in the runtime and assumes it is a call
form: it is not. `AgencyFunction.invoke(descriptor)` is a TypeScript method that
generated code calls, and it takes a `CallType` descriptor. Writing
`f.invoke(x)` in Agency source type-checks and then crashes at runtime, because
`__callMethod` has no `invoke` branch and hands the raw argument to
`resolveArgs`. No `.agency` file in the repo uses it.

## Why `_guard` is read, not walked

The propagation pass does not recompute a function's direct effects by walking
its body. It reads them off the symbol the crawl already produced. That looks
redundant next to a body walk sitting right there, and it is load-bearing.

`_guard` in `stdlib/index.agency` is the lowering target of the `guard(...)`
construct. Its body contains no `interrupt` at all — it calls three TypeScript
helpers, and the trip is raised on the TypeScript side at runtime. Its
`std::guard` label comes entirely from a seed table, `TS_SIDE_EFFECT_SEEDS` in
`lib/symbolTable.ts`.

A body walk gives `_guard` an empty list. Writing that back would erase
`std::guard` from every function in the program that uses a cost cap, silently,
including from the permissions file.

## The pass

`propagateEffects` runs once, at the end of `SymbolTable.build`, over the parse
trees the crawl has already produced. It does three things.

It summarises each callable: its direct effects, read from the symbol, and the
names of everything it calls, from `collectBodyFacts`.

It turns each callee name into an identity. A bare name is not enough, because
two files can define the same name and an import can rename one, so each callee
becomes a file-and-name pair. Imports resolve through the symbol table, and the
result is followed through `reExportedFrom` to wherever the name is really
defined — repeatedly, because a barrel file can re-export a barrel.

Then it runs a worklist: give every entry the effects of everything it calls,
and whenever an entry grows, re-queue only its callers. Sweeping the whole set
until it stops changing was measurably quadratic, because on a chain of N
functions where only the last one raises, each sweep moves the effect one link.
`lib/perf/symbolTable.perf.test.ts` measures that shape on purpose.

It terminates because effect lists only grow and the label set is finite, so an
entry can be re-queued only finitely often. An import cycle costs nothing
special. The result is written back onto every symbol, resolved through
re-exports so a barrel's own copy is correct too.

## Which tree each side sees

The symbol table walks trees straight from the parser. The type checker walks
trees that several rewriting passes have already been through. Any pass that
creates, moves, or renames a call is somewhere the two can disagree.

| pass | runs | what the propagation pass does |
|---|---|---|
| comprehensions | in the parser | nothing needed, both sides see the same tree |
| pattern lowering | in the parser | nothing needed |
| splice expansion | before the symbol table, in memory | cannot see it; one of the blind spots |
| lifting callbacks | after imports resolve | nothing needed, measured: both sides agree |
| `guard` lowering | in the TypeChecker constructor | treats a `guardBlock` node as a call to `_guard` |
| parallel blocks | in the TypescriptPreprocessor | runs after every effect analysis |
| prelude shadow pruning | in the TypescriptPreprocessor | runs after every effect analysis |
| schema injection | in the TypescriptPreprocessor | runs after every effect analysis |
| call hoisting | in the TypescriptPreprocessor | runs after every effect analysis |

## The invariant

The type checker may find more effects than the shared walk. It may never find
fewer.

Its extra work reads type information the walk does not have: a `raises` clause
on a function-typed parameter, and function references resolved through type
synthesis. Both can only add. That is what makes "the walk under-reports" a
known limit rather than a disagreement between two analyses, and there is a test
pinning it in `lib/analysis/effects.test.ts`.

## What the walk cannot see

Five things, and they all under-report.

A method call in an access chain, per the section above.

A file that does not parse. The crawl is deliberately best-effort, because the
editor hits half-typed files constantly.

Code generated by a compile-time splice. The crawl does not run generators, so
it sees a file with a hole where the generated declarations would be. That is a
performance decision rather than a safety one — type-checking already expands
splices, and so does the editor.

A function received as a parameter and then called. And a function reference
stored in a variable before being passed on. Both need types.

For the reporting consumers an under-report is a wrong answer. For compile-time
code generation it is a hazard, which is what the next section is for.

## Checking a generator before it runs

`lib/compiler/splice/eligibility.ts` refuses a generator whose effects are not
empty (AG8003), and refuses one whose effects could not be read at all (AG8004),
naming which of the four blind spots it hit.

The second half is the load-bearing one: an empty list from a reading that could
not see everything is not evidence of safety.

The rules are scoped to what the generator can reach **by calling**, not to the
files it can reach. Every file reaches the prelude, and passing a function as a
value is ordinary Agency, so a file-scoped rule would refuse every generator ever
written. A generator that calls one clean helper from an otherwise messy file
still runs.

This does not replace the runtime backstop. Compilation installs no interrupt
handlers, so a risky operation cannot complete even if it somehow started.
Checking first means the error names the effect and arrives before any work
happens.

## The other cross-file analysis

`lib/analysis/interrupts.ts` also works across files, by type-checking every
reachable file and merging the per-file call graphs. It is roughly fifteen times
more expensive, and this pass cannot reuse it: the pass runs inside
`SymbolTable.build`, where calling the type checker would be circular.

That difference makes it useful as a test oracle. It reaches its answer without
ever reading `sym.interruptEffects`, so comparing the two is a real second
opinion rather than reading back what the pass just wrote. See
`lib/analysis/effectsOracle.test.ts`, which also explains why comparing against
`getEffectsFromFile` proves nothing for an imported function.
