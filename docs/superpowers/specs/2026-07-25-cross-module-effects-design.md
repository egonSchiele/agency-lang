# Effects across file boundaries

Design document for GitHub issue 680, "Interrupt effects do not propagate
across module boundaries."

Written 2026-07-25. Revised the same day after review, which is at
`/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-25-cross-module-effects-design-REVIEW.md`.

The review changed the shape of this document. It found a second way effects
go missing that has nothing to do with file boundaries, and it is larger than
the reported bug. Part 3 leads with that now.

---

# Part 1: Background

You can skip this part if you already know how the compiler works out which
effects a function has. Nothing here is new. It is written down because the
rest of the document only makes sense against it.

## What an effect is

Agency functions that do something risky are labelled. Reading a file carries
the label `std::read`. Running a shell command carries `std::exec`. The label
is called an interrupt effect, because when the function runs, it pauses and
asks for permission rather than just going ahead.

Here is a function with an effect, from the standard library:

```
export idempotent def read(filename: string, dir: string = "."): Result {
  return interrupt std::read("Are you sure you want to read this file?", {
    dir: dir,
    filename: filename,
  })
}
```

The word `interrupt` is what creates the effect. Everything else in the
language inherits effects rather than creating them. If your function calls
`read`, your function can also trigger `std::read`, even though you never
wrote the word `interrupt` yourself.

## Everything that reads the effect list

The first version of this document said four things read it. That was wrong,
and the undercount mattered, because three of the ones I missed stop a build
rather than warn.

Here is the real list. The first four report to a person. The rest are checks
inside the compiler.

**The permissions file.** `agency policy gen yourprogram.agency` reads the
effects and writes a JSON file describing what the program may do. You review
that file before you run the program. If the effect list is empty, the command
prints "No interrupt effects found in this agent. No policy needed." and writes
nothing. The command is registered as hidden, at `scripts/agency.ts:1605`.

**The warning about unhandled effects.** If a graph node calls something that
can pause for permission, and there is no `handle` block around the call, the
compiler warns you. This is diagnostic AG3009, and its severity is `warning`.
It only fires for graph nodes, not for plain functions, because plain functions
are meant to pass effects up to their caller.

**The documentation.** `agency doc` prints a "Throws" column listing what each
function can raise. That is how somebody reading the standard library
reference finds out that a function touches their filesystem.

**The running server.** `agency serve` describes each function over HTTP and to
language models through the tool protocol. The effect list becomes part of the
tool description a model reads before deciding to call something. This path
threads the list out of the compile result (`lib/cli/serve.ts:33-79`) rather
than reading the symbol directly, but the source is the same.

**Compile-time code generation.** Agency can run your code during compilation
to generate more code. You write `$( makeThing() )` and the compiler runs
`makeThing` and drops its output in. Before running your generator, the
compiler wants to know whether the generator does anything risky.

Then five checks that push errors, which fail a build:

- **AG3011, `interrupt` inside a callback.** A callback fires as a side effect
  and cannot stop to ask a question, so the compiler rejects a callback body
  whose effect list is not empty. At `lib/typeChecker/interruptAnalysis.ts:485`.
- **AG3013, a function exceeds its declared `raises`.** A function can declare
  which effects it is allowed to raise. If its real list is bigger, the build
  fails. At `lib/typeChecker/functionTypeRaises.ts:206-210`.
- **AG3014 and AG3015, a value exceeds the `raises` on its type.** The same
  check for a function passed into a slot whose type carries a `raises` clause.
- **AG3016, `interrupt` inside a `finalize` block.** At
  `lib/typeChecker/finalizeChecks.ts:156`.

And one more that shapes types rather than reporting anything:

- **Handler parameter typing.** `collectRaisableEffects`
  (`lib/typeChecker/interruptAnalysis.ts:430`) works out what a `handle` block
  can receive, which decides the type of the handler's parameter. Handlers are
  the project's safety infrastructure, so a change here deserves its own tests.

Nine consumers. Five of them can fail a build.

## How the compiler works out the list, today

It happens in two separate steps, in two separate places, and the split
between them is half the story. The other half is Part 3.

### Step one: scan for the literal word

When the compiler first reads a file, it walks each function body looking for
the word `interrupt`. Whatever labels it finds become that function's list.
This lives in `collectDirectInterruptEffects`, at `lib/symbolTable.ts:523`.

This step never follows calls. It reads one body and looks for one keyword.

The result gets attached to the function's entry in the symbol table, which is
the compiler's index of every name in every file of your program.

### Step two: follow calls, inside one file

Later, when the compiler type-checks a file, it does a second and richer pass.
It builds a small graph of which function calls which, then repeats this until
nothing changes: give every function the effects of everything it calls. This
lives in `analyzeInterruptsFromScopes`, at
`lib/typeChecker/interruptAnalysis.ts:74`.

This is the step that makes `read` flow outward. If your `main` calls `read`,
step one gives `main` an empty list, and step two adds `std::read` to it.

### How the two steps meet at a file boundary

Step two only sees the file it is checking. It has the bodies of that file's
own functions and nothing else. When it meets a call to a function from
another file, it has no body to look at, so it asks the symbol table.

The symbol table answers with the step-one list.

That handoff happens in `buildCompilationUnit`, at
`lib/compilationUnit.ts:342-364`.

---

# Part 2: The reported bug

Step one's list is a direct list. It says "this body contains the word
`interrupt`, followed by these labels." Step two treats that answer as
complete. It is not complete. It is the answer before any calls were followed.

So a function from another file arrives at step two as a dead end.

## The reproduction

Two files.

```
// helper.agency
export def h(): string {
  return read("data.txt")
}
```

```
// main.agency
import { h } from "./helper.agency"

node main() {
  let contents = h()
}
```

`h` reads a file. `main` calls `h`. So `main` reads a file.

I ran the compiler's effect lookup on both files:

```
helper.agency  →  { h: ["std::read"] }      correct
main.agency    →  { main: [] }              wrong
```

`helper.agency` is right because step two ran inside that file and followed the
call from `h` to `read`. `main.agency` is wrong because step two asked the
symbol table about `h`, and the symbol table gave it the step-one answer, which
is empty. `h` contains no literal `interrupt`.

## Why this is not obvious in daily use

Every risky operation in the standard library is written with a literal
`interrupt` in its body. So for standard library functions, step one's answer
happens to be correct and complete. The gap never shows.

It shows the moment a person writes their own function that wraps one.

I confirmed this with three helpers in one file, imported by one caller:

| what the helper does | its own file says | the importer says |
|---|---|---|
| contains `interrupt std::read(...)` | `["std::read"]` | `["std::read"]` ✅ |
| calls `read("data.txt")` | `["std::read"]` | `[]` ❌ |
| calls the helper above | `["std::read"]` | `[]` ❌ |

All three are correct in the file that defines them. Only crossing into
another file loses them.

## A second way it goes wrong

Agency has a `guard` block for capping how much a piece of code can spend:

```
export def usesGuard(): string {
  guard(maxCost: 1.0) {
    return "hi"
  }
}
```

That block carries the effect `std::guard`. Measured:

```
ghelper.agency  →  { usesGuard: ["std::guard"] }
guse.agency     →  { callsIt: [] }
```

Same shape of failure, different cause. The `guard` block is rewritten into a
call to an internal function named `_guard`, and that rewrite happens inside
the TypeChecker's constructor. Step one runs long before that, so when step one
looks at `usesGuard`, it sees a `guardBlock` node and no call at all.

Part 4 has a table covering every rewriting pass, because this is one instance
of a general problem rather than a one-off.

---

# Part 3: The bigger bug, which is not about files at all

The review found this and I confirmed it. It matters more than Part 2.

Agency lets you call a function two ways:

```
read("a.txt")
read.invoke("a.txt")
```

The project's own style guide prefers the second one.

These parse into completely different shapes. The plain form becomes a
`functionCall` node whose `functionName` is `read`. The `.invoke()` form
becomes a property access on the variable `read`, with a method call hanging
off it, and that method call is itself a `functionCall` node whose
`functionName` is the string `"invoke"`.

Every effect walk in the codebase looks for `functionCall` nodes and reads
`functionName`. For `read.invoke(...)` it therefore records a call to something
named `invoke`, finds nothing under that name, and moves on. The call to `read`
is never seen.

Measured, in a single file, with no imports anywhere:

```
export def plain(): string     { return read("a.txt") }
export def viaInvoke(): string { return read.invoke("a.txt") }

→ { plain: ["std::read"], viaInvoke: [] }
```

And the warning behaves the same way:

```
node main() { let y = read("a.txt")        }   →  AG3009 warning
node main() { let y = read.invoke("a.txt") }   →  no diagnostics at all
```

So the headline from Part 2 is understated. A program that reads your
filesystem can report needing no permissions without any imports being
involved, purely by being written the way the project prefers.

This is in scope. Fixing it is small, and leaving it out would mean the
cross-module fix only works for one of the two ways to write a call.

The fix: when a walk meets a `functionCall` node named `invoke`, and that node
sits inside a property access whose base is a plain variable, record the base
name as the callee. The information needed is already available. The walker
hands each node its ancestors, and `lib/typeChecker/functionTypeRaises.ts:106`
already inspects them for exactly this shape.

---

# Part 4: How far the file-boundary bug spreads

## The permissions file says no permissions are needed

`lib/cli/policy.ts` type-checks only the entry file, then reads that file's
effects. I replicated exactly what it does:

```
node main() { read("data.txt") }              →  ["std::read"]
node main() { h() }   // h reads, elsewhere   →  []
```

An empty list makes the command print **"No interrupt effects found in this
agent. No policy needed."** and exit without writing a file.

So a program that reads your filesystem reports that it needs no permissions,
as long as the reading happens in an imported file.

There is a comment at `lib/cli/policy.ts:17-19` explaining that the symbol
table records only direct interrupts and that the type checker supplies the
transitive ones. That reasoning is correct within one file. It is silently
wrong across two, and the comment is what makes the mistake look considered.

## The warning goes quiet

I compiled a graph node that calls the wrapping helper, with no `handle` block
anywhere. The compiler produced no errors and no warnings. The same node
calling a helper with a literal `interrupt` warns as expected.

## The standard library's own documentation is wrong in five places

I compared, for every exported function in every standard library file, the
list step one produces against the correct list. Of 72 functions that have
effects, 5 report the wrong list when imported:

```
agency.agency:run              says ["std::run"]  really ["std::guard","std::run"]
agency.agency:runFile          says []            really ["std::guard","std::run"]
agency.agency:runCode          says []            really ["std::guard","std::run"]
policy.agency:parsePolicyFile  says []            really ["std::read"]
supervise.agency:supervise     says []            really ["std::guard"]
```

`runFile` and `runCode` run arbitrary Agency code. They currently report that
they do nothing at all.

That number, 5 out of 72, is also a useful estimate of how much churn the fix
will cause in the generated documentation. It is small.

## The API that takes source as text

There are two ways to ask for a function's effects. One takes a file path.
The other takes source code as a string, and agents can call it through the
standard library's `std::agency` module.

I tested the string version. It behaves differently depending on the import:

```
import { h } from "./helper.agency"    →  throws ImportResolutionError
import { runFile } from "std::agency"  →  { f: [] }
export def f() { read("x") }           →  { f: ["std::read"] }
```

The first case is fine. It fails loudly rather than answering short, because
there is no directory to resolve `./helper.agency` against. That matches what
its documentation promises.

The second case is the live hole. `runFile` runs arbitrary Agency code, and
this returns an empty list for it. The documentation warns about relative
imports and says nothing about this, because nobody expected a standard
library function to be wrong about itself.

---

# Part 5: The design

Fix step one. Make it follow calls.

Everything in Part 1's list reads step one's answer, directly or through the
handoff in `buildCompilationUnit`. If step one's answer becomes correct, all
nine consumers become correct without being touched.

## Why not fix it in the type checker instead

The type checker is where the following-calls logic already lives, so putting
it there is the obvious first idea. It does not work well.

To give the type checker correct answers about imported functions, it would
have to type-check those files too, and their imports, and so on. But
type-checking a file is exactly what needs the answer. The work depends on its
own output.

You can untangle that by processing files in dependency order, and by looping
when there are cycles. It terminates. It is also roughly fifteen times slower,
and the cost lands on the editor, which rebuilds the symbol table constantly.

Measured, on a small program that imports the standard library and one local
helper, with the parse cache warm:

```
walking every reachable file's syntax tree      ~2ms
type-checking every reachable file             ~20ms
```

Neither is large. But the first one is free in a way the second is not: the
compiler has already parsed those files and is holding the results in memory.
Walking them again costs nothing but the walk.

## The new pass

Add a step at the end of building the symbol table.

The symbol table is already built by crawling every file your program can
reach, parsing each one, and recording what it declares. That crawl is at
`lib/symbolTable.ts:144`. By the time it finishes, every reachable file has
been parsed and every parse tree is in hand.

The new pass runs over those trees and does three things.

**First, summarise each function.** For every function and graph node in every
file, record two lists. Its direct effects, which is what step one already
computes. And the names of everything it calls, including calls written with
`.invoke()`, per Part 3.

**Second, turn each callee name into something unambiguous.** A name like `h`
means nothing on its own, because two files can both define an `h`, and an
import can rename one. So each callee is recorded as a pair of the file it is
defined in and the name it is defined under. Written out, that is
`/path/to/helper.agency:h`.

This is not a new idea in the codebase. `lib/typeChecker/interruptAnalysis.ts`
already does exactly this for a different analysis, with a helper called
`qualifyName` and a resolver called `makeCalleeResolver`. The rules there are:
a name that the file defines itself belongs to that file; a name the file
imports belongs to the file it was imported from, under its original name
before any renaming; anything else, such as a built-in, stays attached to the
current file and simply finds no match later.

**Third, repeat until nothing changes.** Go through every function. For each
one, add the effects of everything it calls. If anything changed, go through
them all again. Stop when a full pass changes nothing.

That loop handles chains of any length, and it handles import cycles without
special-casing them, because a cycle simply means the loop needs one more pass
before it settles.

Then write the results back onto each function's symbol table entry.

## Re-exported names need one more hop

A barrel file is a file that exists to re-export other files' contents:

```
// barrel.agency
export { h } from "./helper.agency"
```

The symbol table's `resolveImport` (`lib/symbolTable.ts:361`) resolves an
import path to a file and looks the name up there. For an importer of
`barrel.agency`, that produces the key `barrel.agency:h`.

But `barrel.agency` defines no `h`. The new pass builds its summaries from
function definitions, so it has no entry under that key, the lookup finds
nothing, and the effect is dropped. That is this same bug one hop further out.

The symbol table already records where a re-exported name really lives, in a
field called `reExportedFrom` holding the source file and the original name
(`lib/symbolTable.ts:674`). So when the pass qualifies a callee, it follows
that field to the origin, and follows it repeatedly, because a barrel can
re-export a barrel.

This will not show up in a test that only uses the standard library, because
`stdlib/index.agency` defines `read` itself rather than re-exporting it. It
will show up in user code and in npm packages, where a barrel file is the
normal way to organise a library.

## Replacing the field rather than adding one

The symbol table entry has a field called `interruptEffects`. Today it holds
the direct list. After this change it holds the followed-through list.

I checked every place that reads it:

- `lib/compilationUnit.ts` hands it to the type checker. Wants the followed list.
- `lib/lsp/semantics.ts` shows it on hover in the editor. Better with the followed list.
- `lib/serve/http/adapter.ts` reports it over HTTP. Better with the followed list.
- `lib/serve/mcp/adapter.ts` puts it in tool descriptions given to language models. Better with the followed list.

Nothing wants the direct list, so the field changes meaning and no second field
is introduced.

One consequence worth saying out loud: the tool descriptions language models
read will start listing more effects per tool. That is more accurate and it is
also a visible change in what models are told.

## Which tree the pass is looking at

The `guard` problem from Part 2 is not a one-off. The symbol table walks trees
straight from the parser. The type checker walks trees that several rewriting
passes have already been through. Any pass that creates, moves, or renames a
call is a place the two can disagree.

Here is every such pass, where it runs, and what this design does about it.

| pass | runs | touches calls? | what the new pass does |
|---|---|---|---|
| comprehensions | in the parser | rewrites loops, calls survive | nothing needed, pass sees the same tree |
| pattern lowering | in the parser | no | nothing needed |
| splice expansion | before the symbol table, in memory | creates whole declarations | cannot see it, see the blind spots below |
| lifting callbacks | after imports resolve | moves a block into a new top-level function | measured, no divergence, see below |
| `guard` lowering | in the TypeChecker constructor, again in the TypescriptPreprocessor | creates a `_guard` call | pass treats a `guardBlock` node as a call to `_guard` |
| parallel blocks | in the TypescriptPreprocessor | creates calls | runs after every effect analysis, so neither side sees it |
| prelude shadow pruning | in the TypescriptPreprocessor | removes declarations | runs after every effect analysis |
| schema injection | in the TypescriptPreprocessor | adds arguments | runs after every effect analysis |
| call hoisting | in the TypescriptPreprocessor | moves calls, does not create them | runs after every effect analysis |

On lifting callbacks, the review flagged a possible attribution difference and
said it was unverified. I checked it. A function containing a `callback` block
whose body raises reports the same list on both sides:

```
symbol table, before lifting  →  { outer: ["std::read"] }
type checker, after lifting   →  { outer: ["std::read"] }
```

They agree by different routes. Before lifting, the walk descends into the
block and finds the effect there. After lifting, the block has become a
separate function, and the type checker recovers the effect through the
reference to that function passed as an argument. No change needed.

Splice expansion appears twice in this document as a blind spot, and it is the
only pass in the table the design cannot handle.

There is a larger question here about where lowering should happen in the
pipeline. It is out of scope for this work and worth its own discussion.

## Not missing any part of a function body

If the pass fails to look inside some part of a function body, it misses the
calls in there, and a function that does something risky comes out looking
clean. That failure is silent.

The codebase already has an answer. `lib/utils/bodySlots.ts` is the single
list of which fields on which nodes hold statements. The walker `walkNodes`
reads that list rather than hand-listing node types. Its header comment records
why: before it existed, each consumer hand-listed the types, they drifted, and
lowering steps were silently skipped.

The new pass uses `walkNodes`. New body-bearing constructs are then picked up
without anyone remembering to update this pass.

## Sharing with the type checker, and what sharing does not cover

There is a real risk in this design. The type checker has its own version of
"what does this body do," in a function called `collectFromBody`. Adding a
second one written separately means the two can drift apart, and then effects
mean different things depending on which side of an import you are standing
on. That is the bug we are fixing, in a new costume.

Sharing the walk is necessary. The review's point, which is correct, is that
it is not sufficient. There are three places the two sides can disagree, and
sharing only the first makes the other two easier to miss.

**The walk itself.** The three parts of `collectFromBody` that need no type
information get pulled out into one function both sides call: finding
`interrupt` statements, finding calls including the `.invoke()` form, and
finding `goto` targets.

**Which units get summarised.** The type checker iterates over scopes and skips
the one named `top-level`, with a comment at
`lib/typeChecker/interruptAnalysis.ts:96-98` explaining that skipping is
necessary because the walker descends into nested function bodies and would
otherwise count them twice. The new pass would naturally iterate top-level
declarations instead. Those are not the same set. Nested functions, block
arguments, and lifted callbacks all land differently. The enumeration is shared
too, or the plan says in writing why the two produce the same answer.

**How a callee name becomes an identity.** The type checker resolves through
its own imported-function map. The new pass resolves through the symbol table.
Two resolvers doing one job, and the re-export problem above is already an
example of them differing. The plan extracts the resolver, or at minimum adds a
test that asserts both produce the same key for the same source.

The completeness tripwire goes on the shared function, not on the new pass. A
tripwire guarding a copy is worth much less than one guarding the original.

**The invariant that makes this safe.** The type checker may find more effects
than the shared walk does, never fewer. Its extra work reads type information
the shared walk does not have, and that can only add. Stating this is what
makes "the new pass under-reports" a known limit rather than an inconsistency
between two analyses.

## What the pass cannot see

The pass reads syntax. It has no type information, because types are worked
out later. Three things are therefore invisible to it.

**Generated code.** The file crawl does not run compile-time generators. Doing
so would put generator execution behind every caller of the crawl, of which
there are thirteen outside tests. This is a performance decision. So the pass
sees a file with a hole where generated declarations would be.

**A function passed in as a parameter, then called.** If a helper takes a
function as an argument and calls it, the pass sees a call to a name that is
not defined anywhere, finds no match, and adds nothing. The type checker
handles this case by reading the parameter's declared effects off its type.

**A function reference held in a variable before being passed on.** The type
checker resolves these by working out the expression's type. The pass can spot
a bare name used as an argument, which covers the common shape
`llm(..., { tools: [deploy] })`, but not one stored in a variable first.

In all three cases the pass reports fewer effects than really exist. Risky
code can look clean.

For the reporting consumers that is a wrong answer, and the answers are already
wrong today in a larger way. For compile-time code generation it is a hazard,
and Part 6 deals with it there.

---

# Part 6: The check before running a generator

## What exists today

I need to correct something, because the issue description says otherwise and
I repeated it before checking.

`lib/compiler/splice/eligibility.ts` has **no effect check at all**. It has two
rules. A generator may not contain a generator call of its own, or the
recursion has no floor. And a generator's imports must stay inside Agency code,
because the safety argument does not survive a hop into JavaScript.

The comment at line 188 says the effect check was deliberately left out,
because this bug makes a precise one impossible, and that it is tracked
separately as issue 691.

So there is no cautious check to replace. Safety today rests on stopping the
generator while it runs: compilation installs no permission handlers, so a
risky operation cannot complete.

## What gets built

Once effects cross file boundaries, the check becomes possible. Build it.

Before running a generator, look up its effects. If the list is not empty,
refuse, and say which effect caused the refusal.

Also refuse when the pass could not see the whole picture, since an empty list
from an incomplete reading means nothing. Refuse if the generator reaches a
compile-time generator call of its own, calls a function it received as a
parameter, or passes a function around as a value.

## Reaches, through the call graph, not through files

The first version of this document scoped those refusal rules to "the
generator, or any file it reaches." That is wrong, and the review is right
about why. Every file reaches the prelude, and passing a function as a value is
ordinary Agency. One occurrence anywhere in the reachable files would refuse
every generator in the program, forever, citing a file the user never opened.

That is the same over-broad test the existing comment in `eligibility.ts`
rejects, applied to a different thing.

So the rules are scoped to the functions the generator can actually reach by
calling them, which is the graph the new pass builds anyway. A generator that
calls one clean helper from an otherwise messy file still runs.

## Why refusing before running is worth having at all

Stopping a generator while it runs already works. Checking first is better for
two reasons.

The error arrives before any work happens, so it can name the effect and point
at the generator rather than surfacing as a failure partway through.

And it is checkable by reading, which is what makes the safety argument
something a person can verify rather than trust.

---

# Part 7: The knock-on work

Correct effects make the compiler notice things it used to miss. All of it is
in scope.

The first version of this document bounded the breakage by pointing out that
the unhandled-effect warning only fires for graph nodes. That bound was wrong,
because five of the nine consumers push errors, and an error fails a build. The
count below has to be done per consumer, separating errors from warnings.

## Errors that will newly fire

**Callbacks that may interrupt (AG3011).** A callback whose body calls an
imported wrapper looks clean today and compiles. After this change it will not.
That is the correct behaviour and it is a hard error appearing in code that
builds today.

**Declared `raises` exceeded (AG3013, AG3014, AG3015).** A function whose true
list grows will newly exceed a declaration that used to fit. An imported
function passed into a slot typed with a `raises` clause will newly be
rejected.

**`finalize` blocks that may interrupt (AG3016).** Same shape.

## Warnings that will newly fire

Graph nodes calling risky things through imported helpers, and, because of
Part 3, graph nodes calling them with `.invoke()` in the same file. The second
group may be larger than the first, since `.invoke()` is the preferred style.

## Handler parameter types will change

More effects reaching a `handle` block means the block's parameter is typed
differently. Handlers are safety infrastructure, so this gets its own tests
rather than being inherited.

## What I will do about the count

Measure it before fixing anything, per consumer, errors separated from
warnings, and report the numbers. If it is large, that is a conversation about
scope rather than something I quietly absorb.

## The other four consumers

**The permissions file.** A test with the risky work in an imported file,
asserting `agency policy gen` lists the effect and writes a file.

**The documentation.** The "Throws" column changes for the five standard
library functions in Part 4. Regenerate with `make doc`, and add a test
covering a function whose effects come from a call rather than a literal
`interrupt`.

**The server.** A test that the tool description handed to a model lists
effects that arrive through an import.

**The API that takes source as text.** The Part 5 pass fixes the `runFile` hole
automatically. Add a test pinning it, then correct the `getEffects` docstring
in `std::agency`, which currently warns only about relative imports and should
also state the blind spots from Part 5.

## Incremental builds

The review asked whether the build manifest treats a change in a transitively
imported file as invalidating, since after this change what a file compiles to
depends on its imports in a new way.

It does. The manifest records transitive Agency import paths and a hash over
them, and re-hashes to decide whether a rebuild can be skipped
(`lib/compiler/buildManifest.ts:14-27`). Modules touching `pkg::` imports are
never skipped. No change needed, and the plan says so rather than leaving it
open.

---

# Part 8: What this does not do

**It does not follow functions passed as values.** Named in Part 5. Fixing it
needs type information, which means the slower design this document rejects.
Worth its own issue.

**It does not run generators during the file crawl.** The pass sees generated
declarations as a hole. Changing that is a performance question affecting all
thirteen callers of the crawl, tracked separately as issue 687.

**It does not reorganise when lowering happens.** Part 5's table makes the
current arrangement visible, which is the useful part. Changing it is a
separate discussion.

**It does not touch how effects work at runtime.** This is entirely about what
the compiler knows before anything runs. Permission handlers, and the guarantee
that a `handle` block is never skipped, are untouched.

---

# Part 9: How this gets tested

Every cross-file test below gets written twice, once with `h()` and once with
`h.invoke()`.

**The reported bug.** Two files, a helper that wraps `read`, a caller that
imports it. Assert the caller reports `std::read`. Assert the chained version,
where the helper calls another helper, also reports it.

**The `.invoke()` form on its own.** One file, no imports, both call forms.
Assert both report `std::read` and both produce the AG3009 warning.

**The `guard` block.** A helper containing a `guard` block, imported. Assert
`std::guard` crosses the boundary.

**Re-exports.** An effectful helper reached through one barrel file, and
through two.

**Renaming.** `import { h as g }`. Assert the effect follows the rename.

**Two files, one name.** Two files each defining `h`, one risky and one not.
Assert the effects do not leak between them. This is what the file-and-name
pairing exists for.

**Cycles.** Two files that import each other. Assert the pass finishes and
gives the right answer.

**Completeness.** A tripwire on the shared walk asserting it recognises every
node type that can contain a call.

**The two sides agree.** A fixture asserting the shared walk and the type
checker produce the same identity for the same callee, which is what guards
against the resolvers drifting.

**The standard library.** Assert the five functions from Part 4 report their
real effects.

**Refusing a generator.** A generator whose risky work is one file away, and
one for each blind spot. Assert each is refused with a message naming why.
Plus the case that motivates scoping by call graph: a generator importing one
clean function from a file whose other exports are messy, which must still run.

**Cost.** Through the scaling-ratio performance suite that just landed, which
runs informational-first. Not a wall-clock threshold against the 2ms figure,
which would flake in CI.

---

# Part 10: What could go wrong

**The two walks drift apart.** The largest risk. Addressed in Part 5 by sharing
the walk, the enumeration, and the resolver, by putting the tripwire on the
shared function, and by stating the invariant that the type checker may only
ever find more.

**More breakage than expected.** Five consumers produce errors. Counted per
consumer before anything is fixed, and reported.

**Refusing generators that were fine.** The blind-spot rules could reject a
generator that does nothing wrong. Scoping them to the call graph rather than
to files is what keeps this narrow. Each refusal names its reason, so a person
can see why. If the rules prove too eager, they can be narrowed later.

**The editor gets slower.** The measured cost is about 2ms against a symbol
table build of roughly 55ms. Confirmed through the performance suite rather
than assumed.
