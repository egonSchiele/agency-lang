# Compile-time splices for Template Agency

Status: design, awaiting review
Date: 2026-07-24
Follows: #665 (Template Agency), #673 (code literals), #671 (`describe`)

## Summary

Add `$( ... )` to Agency. It runs a function while the compiler is compiling your file, and pastes the code that function returns into the file, as if you had typed it.

The function is called a **generator**. It is an ordinary Agency function that returns a `Code` value, which is what `fill` and code literals already produce.

The whole feature is one new piece of syntax. Everything it operates on already exists.

## Background

You do not need to have read the Template Haskell literature to follow this. This section explains the problem, what Haskell does about it, and why we can do something Haskell cannot.

### What we shipped, and the half that is missing

Template Agency (#665) lets you build Agency code as a value. You write a skeleton with gaps, fill the gaps, and get back a `Code` value:

```ts
const tpl = [| def greet(): string { return #msg } |]
const filled = fill(tpl, { msg: "hello" })
```

Now you are holding a small function called `greet`. The only thing you can do with it is turn it back into text and hand it to `runCode`:

```ts
return runCode(toSource(filled.value))
```

`runCode` compiles that text and runs it in a separate process. Your own program never gains a `greet`. You cannot call it. The code you built stays outside your program, forever.

That is fine when the goal is to run a program a model wrote, which is what the feature was built for. It is useless when the goal is to avoid writing repetitive code in the program you are working on right now.

So we have the half that **makes** code and not the half that **installs** it.

### What Template Haskell does

Haskell has both halves.

The making half is quotation brackets, `[| ... |]`, which produce a syntax tree as a value. We copied this deliberately, down to the brackets.

The installing half is the **splice**, written `$( ... )`. When GHC's renamer reaches a splice, it does something surprising: it compiles the expression inside the splice, links the result into the running compiler, and **executes it**. Whatever syntax tree comes back is inserted into the file at that spot and compiled as ordinary code.

That is what makes this line work:

```haskell
data Person = Person { _name :: String, _age :: Int }

makeLenses ''Person
```

After that line, `name` and `age` exist as functions in the module, as though they had been typed out.

### How `reify` works, and why it matters

A generator that returns a fixed answer is pointless, because you could have typed the answer. Generators earn their keep by being **shaped by something already in your program**.

Haskell's mechanism for that is `reify`:

```haskell
reify :: Name -> Q Info
```

You hand it a name and it returns what the compiler knows about that name. For a record type, that includes the list of fields and their types. `makeLenses` calls `reify` on `Person`, gets back `[("_name", String), ("_age", Int)]`, and writes one accessor per entry. Add a field to `Person` later and the accessors follow, because nobody maintained a list.

`reify` only works because your code is running **inside the compiler**, with the compiler's symbol table in reach. Run the same code outside GHC and `reify` fails. There is no compiler to ask.

The `Q` monad that `reify` lives in is not just a name supply. It is a handle on the compiler, offering fresh names, the current source location, the ability to declare a build dependency on a data file, and `runIO`, which runs arbitrary IO during compilation.

### What Template Haskell costs

These are real, well documented, and they shape our design:

- **The stage restriction.** A splice cannot call a function defined in the same module. The function must already be compiled, which in practice means a separate file. This is the most complained-about part of the feature, and it is why TH-using projects all have a `TH.hs`.
- **Declaration groups.** Top-level splices cut a module into segments, and `reify` sees only earlier segments. `makeLenses ''Person` must appear after `data Person`. Not a style rule; a hard error.
- **Arbitrary IO at build time.** `runIO` means compiling a module can do anything. This breaks cross-compilation, slows builds, and means a dependency can run code on your machine when you build.
- **Opacity.** Errors point at code you never wrote and cannot see. `-ddump-splices` exists because reading the generated output is the only way to debug it.

### Why Agency can be safer than Haskell here

The third cost is the serious one, and it is the one we do not have to pay.

GHC cannot tell the difference between `makeLenses` walking a datatype and a splice that reads your SSH keys and POSTs them somewhere. Both have type `Q [Dec]`. Haskell has no effect system, so `runIO` is opaque by construction. The only defense is trusting the package author.

Agency is different in a way that matters exactly here:

1. Dangerous operations in Agency are **effects**. Reading a file raises `std::read` (`stdlib/index.agency:183`). Writing raises `std::write`. Network, shell, and the rest follow the same pattern.
2. Effects are **statically trackable**. `getEffectsFromSource` (`lib/compiler/typecheck.ts:161`) returns, for every exported function, the transitive list of effects it can raise. Bare `interrupt(...)` sites surface as the sentinel `"unknown"`, so the answer is fail-closed rather than optimistic.
3. Therefore the compiler can decide **before running a single line** whether a generator is safe to run.

So the check is not "trust the author." It is a static property of the code, computed by machinery we already ship for other reasons.

There is also a runtime backstop. The compile phase installs no handlers, so if an effect somehow reaches execution, it is unhandled, and an unhandled interrupt prints a message and exits nonzero (`lib/runtime/interrupts.ts:145`, pinned at `lib/runtime/interrupts.test.ts:247`). Belt and suspenders, and the belt costs nothing.

### The gap in the effect argument

The effect system gates things that are **dangerous**. It does not gate things that are **nondeterministic**, and at build time those are different problems.

`llm()` is the case that matters. `stdlib/llm.agency` contains zero `interrupt` sites, and `llm()` is a language builtin rather than a gated stdlib function. A generator calling `llm("write the accessors")` would pass a naive effect check while making a network call, spending money, and producing a different program on every build. Same source, different output. That is disqualifying for a compiler.

Clock and randomness have the same shape with smaller stakes.

So the v1 rule is stricter than "no effects." It is **no effects and no nondeterminism**.

One rejected alternative, recorded because it looks attractive: make `llm()` raise a `std::llm` effect so the existing machinery covers it. This is much worse than it sounds. Unhandled interrupts surface to the user and exit nonzero, so every existing program would prompt on every LLM call. That is a language-wide breaking change wearing a compile-time-feature costume. The useful half survives without it: track `llm()` in the effect analysis for *checking* purposes without making it *raise*.

## The design

Four rules.

### Rule 1: `$( expr )` goes anywhere a declaration or an expression goes

Both positions are supported from the start.

Declaration position, at the top level of a file:

```ts
$( makeGetters(["name", "age", "email"]) )

node main(): string {
  return getName(person)
}
```

Expression position, anywhere a value goes:

```ts
node main(): number {
  const table = $( buildTable(["a", "b", "c"]) )
  return table.length
}
```

The generator returns a `Code` value, and the fragment kind of that value has to match the position. A `program` fragment fills a declaration splice; an `expr` fragment fills an expression splice. This is the same admissibility rule `fill` already applies to holes (`assertKindMatchesSort`, described in `docs/dev/template-agency.md`), so the concept is not new and the implementation should reuse it.

### Rule 2: the generator must be imported from another file

```ts
// gen.agency
export def makeGetters(fields: string[]): Code { ... }

// main.agency
import { makeGetters } from "./gen.agency"

$( makeGetters(["name", "age"]) )
```

This is Haskell's stage restriction, and we adopt it for the same reason. To compile a file containing a splice, the compiler has to run the generator. To run the generator, the generator has to already be compiled. If it lives in the file currently being compiled, that is a cycle, and breaking it requires dependency analysis we do not need to build yet.

Requiring a separate file makes the cycle impossible instead of solvable. It is a restriction rather than an analysis, which is why it is cheap.

The ceremony cost is real but small, because generators are rare and tend to be reused across files.

### Rule 3: the generator must be effect-free and deterministic, checked before it runs

Two checks, in this order:

**Static, before execution.** Take the generator's transitive effect list from `getEffectsFromSource`. If it is non-empty, refuse to compile, and name the effect and the generator in the message. Separately, refuse if the generator transitively reaches `llm()`, the clock, or randomness.

**Dynamic, as a backstop.** The compile phase installs no handlers, so anything that slips past the static check hits an unhandled interrupt and fails loudly.

The static check is the primary one because it is better in every way that matters: it fires before any code runs, it fires even when the dangerous branch would not have been taken on this particular input, and it can point at the generator rather than at a stack.

The `"unknown"` sentinel makes this fail-closed. A generator containing a bare `interrupt(...)` reports `"unknown"` in its effect list, which is non-empty, which is a refusal.

### Rule 4: the result is pasted in and compiled as part of your file

The generator returns a `Code` value. The compiler splices that value's nodes into the AST at the splice site and continues compiling. From that point on there is no distinction: the generated `greet` is a function in your file, callable, type-checked, and compiled with everything else.

## Worked examples

### Repetitive boilerplate from a list

```ts
// gen.agency
import { Code, fill } from "std::agency"

export def makeGreeters(names: string[]): Code {
  let out = []
  for (n in names) {
    const one = fill(
      [| def #fnName(): string { return #greeting: string } |],
      { fnName: "greet_${n}", greeting: "hello ${n}" }
    )
    if (isSuccess(one)) {
      out = [...out, one.value]
    }
  }
  return combine(out)
}
```

```ts
// main.agency
import { makeGreeters } from "./gen.agency"

$( makeGreeters(["ada", "grace"]) )

node main(): string {
  return greet_ada()
}
```

You maintain one list instead of N near-identical functions.

Two things in this example are load-bearing and worth reading carefully.

`#fnName` is an **identifier hole**, which is legal in a def-name position. `#greeting: string` is an **expression hole with an inline annotation**, and the annotation is required rather than stylistic: position-inferred types currently cover the annotated-assignment position only, so a bare `return #greeting` would be refused by AG8002 for having nothing to constrain it.

Note also what this example carefully does *not* do. It does not generate a field access like `p.#field`, because a hole cannot currently appear in a property-name position. See open questions.

Finally, the `combine(out)` call. Turning an array of `Code` values into one `program` fragment is a primitive we do not currently have, and it is listed under open questions below.

### Rewriting code you hand it

```ts
$( withRetries([| def fetchPage(): string { ... } |], 3) )
```

The generator receives a code literal, wraps the body in retry logic, and returns the wrapped version. No introspection is involved, because the input is sitting in the file.

## Where this fits in the pipeline

The current pipeline is:

```
parse → SymbolTable.build → buildCompilationUnit → TypescriptPreprocessor → TypeScriptBuilder.build() → printTs()
```

Splice expansion has to sit **after parse and before `SymbolTable.build`**. The reason is Rule 4: generated declarations introduce names that the rest of the file refers to, so those names must exist before name resolution runs. Expanding any later means `getName` is unresolved when `main` calls it.

### How the compiler runs a generator

Proposal: reuse the existing compile-and-run-in-a-subprocess machinery, the same path `runCode` takes.

For a splice like `$( makeGetters(["name", "age"]) )`, the compiler synthesizes a tiny program:

```ts
import { makeGetters } from "./gen.agency"

node __splice(): Code {
  return makeGetters(["name", "age"])
}
```

then compiles and runs it, and takes the returned value.

Three properties make this fit better than it might look:

- **`Code` is plain JSON.** Serialization needed no code when `Code` values had to survive interrupt checkpoints (`docs/dev/template-agency.md`, Serialization). The same property means a `Code` value crosses the subprocess IPC boundary with nothing new written.
- **Resource limits come free.** `run` already takes `wallClock` and `memory`. A generator that loops forever becomes a bounded compile error instead of a hung compiler. This closes a hole the effect check does not cover, and it is a hole Haskell has and does not close.
- **The unhandled-interrupt backstop is already implemented** on that path.

The cost is speed. Forking a process per splice is not free, and this needs a cache keyed on the generator module plus the splice's arguments. See open questions.

### Error attribution, and a follow-up this unblocks

`fill` already stamps every node of a grafted fragment with `loc.origin` (`docs/dev/template-agency.md`, Origin stamping). Today that stamp dies at the subprocess boundary, because `toSource` prints and `runCode` re-parses, and locations do not survive printing. The dev doc records this as blocked on an AST-in compile entry point that does not exist.

Splices paste an AST directly rather than printing it, so origin stamps survive into the compile. That means "this generated line failed to compile, and it came from generator X" is achievable here in a way it is not for `runCode`. It also means this feature builds the AST-in entry point that the fragment-checker follow-up has been waiting on.

## Out of scope for v1

Each of these is deliberately excluded, and each is additive later.

**Introspection (`reify`).** In v1 the generator's arguments are supplied by hand: plain values and code literals. There is no way to ask "what fields does `Person` have."

This is the biggest exclusion and it deserves its rationale spelled out. Everything genuinely hard about splices is in the half we are building: running user code inside the compiler, refusing effectful generators, pasting an AST into a file mid-compile, and attributing errors. None of that needs introspection. Conversely, introspection without splices is useless, because there would be nowhere to put what you learned. So this ordering is forced.

When introspection lands, it changes only where the argument comes from. `makeGetters(["name", "age"])` becomes `makeGetters(fieldsOf(Person))`. The splice machinery underneath does not change.

Two future levels were discussed and both are wanted eventually:

- *Seeing inside types*, so a generator can read that `Person` has a `name: string` and an `age: number`. This is what `makeLenses` needs. It requires a stable public encoding of a type as data. Note that `ExportInfo.signature` is currently a **string** (`stdlib/agency.agency:416`), so `describe` today cannot support this without extension.
- *Looking up any single name*, including imported ones, which is closest to Haskell's `reify` and additionally needs syntax for writing a name without evaluating it.

There is also a wrinkle any introspection design must handle. `describe` takes a source **string** (`stdlib/agency.agency:434`), and at runtime you get that string by calling `read`. A generator cannot call `read`, because that is an effect. So introspection has to be **compiler-supplied**: the generator names a module and the compiler reads it. The compiler is allowed to touch the filesystem; the generator is not. This is the same reason `reify` is a `Q` operation in Haskell rather than a pure function.

**Effects at compile time.** No compile-time file reads, no network, nothing. If we later want a generator to read a schema file, the shape is a build policy with a default of deny, and files read get recorded as build-manifest inputs so incremental builds invalidate correctly (`docs/dev/incremental-builds.md`). Not now.

**Generators in the same file as the splice.** Rule 2. Relaxing this later means either GHC-style declaration groups or real dependency ordering.

## Open questions for the implementation plan

These are genuinely unsettled and should be resolved while writing the plan.

1. **Combining fragments.** The boilerplate example needs to turn `Code[]` into one `program` fragment. Does a primitive for this exist, and if not, what is it called and where does it live? This is small but it is on the critical path for the motivating example.

2. **Hygiene for expression splices.** Declaration splices are mostly safe by accident: if a generator emits a top-level `const config` and the file already has one, that is a duplicate-declaration error, which is a loud correct failure. Expression splices are different. Pasting an expression into a function body puts it next to local variables, and if the generated expression mentions `tmp`, it captures the local `tmp`.

   Proposed answer: generated code may reference only names it declares itself and names it imports. Referencing a name from the splice site's scope is a name-resolution error. This is the templates rule "bindings are local to the hole" (`docs/dev/template-agency.md`) applied to splices, and it fails closed.

   Needs checking against the existing hygiene machinery in `lib/runtime/template/hygiene.ts`, which solves a related but distinct problem.

3. **Caching and incremental builds.** A file containing a splice depends on the generator's module. That edge has to reach the build manifest, or editing a generator will not rebuild its consumers. What is the cache key: generator module content hash plus the splice's evaluated arguments?

4. **Nested splices.** May a generator module itself contain splices? Haskell allows this. Allowing it means recursion and needs a depth cap; forbidding it in v1 is simpler and additive to relax.

5. **Which argument expressions are legal.** `$( gen(["a"]) )` is clearly fine. Is `$( gen(SOME_CONST) )` fine, where `SOME_CONST` is defined in the file being compiled? That reintroduces the staging cycle. Simplest v1 rule: arguments may be literals, code literals, and references to imported names only.

6. **Detecting nondeterminism.** The effect half is free via `getEffectsFromSource`. The `llm()`/clock/randomness half needs new tracking. All transitive effect propagation runs through `analyzeInterruptsFromScopes` (`lib/typeChecker/index.ts:300`), which is a single chokepoint, so an internal marker riding that existing propagation looks plausible. Needs confirming by reading it.

7. **Holes in property-name position.** A hole cannot currently appear where a field name goes, so a generator cannot emit `p.#field`. Identifier holes are wired to exactly three sites: def names, node names, and import specifiers (`identifierHoleParser` in `lib/parsers/parsers.ts`).

   This does not block v1, since v1 generators take hand-supplied arguments and the worked example above avoids it. It does block the `makeLenses` use case, which is the entire point of the introspection follow-up: seeing that `Person` has a field called `name` is useless if you cannot then generate `p.name`. So this should be resolved as part of the introspection work rather than left implicit.

   Two candidate approaches: widen identifier holes to property-name position, or generate `p[#field]` index access instead, which likely parses today but changes typing and goes through `__nn` null-normalization. Neither is verified; both need checking.

8. **Diagnostic codes.** `AG8001` and `AG8002` are taken by templates, so splices start at `AG8003`. Note that `diagnosticExplanations.ts` is exhaustive by type, so every new code needs prose or the build fails (`docs/dev/template-agency.md`). Codes needed, at minimum: generator has effects, generator is nondeterministic, generator not imported from another file, returned fragment kind does not match splice position, generator failed at runtime.

## Testing

Mirroring how #665 was tested.

- **Parser tests** for `$( )` in both positions, and for the positions where it is rejected.
- **Refusal tests** via `compileSource`, asserting the `code` field rather than thrown text, covering: a generator that raises an effect, one that calls `llm()`, one defined in the same file, and one returning the wrong fragment kind.
- **Execution fixtures** in `tests/agency/templates/` for the end-to-end cases: declaration splice producing a callable function, expression splice producing a value, and a generator built with `fill` and code literals.
- **A resource-limit test** proving a looping generator produces a bounded error rather than hanging.
- **An error-attribution test** proving that when generated code fails to compile, the message names the generator.

Per project convention these need no LLM calls.

## Risks

**Compile-time code execution is a genuine escalation**, even effect-checked. The static check is only as good as the effect analysis, and the analysis is only as good as the invariant that dangerous operations go through interrupts. Anything that reaches a `_`-prefixed TypeScript builtin without an interrupt wrapper is outside the guarantee. This should be audited during planning rather than assumed, since the whole safety argument rests on it.

**Build times.** A subprocess per splice is slow, and without caching this could be very slow. Caching is listed as an open question but should probably be in v1 rather than a follow-up.

**Debuggability.** Haskell's experience is that generated code is hard to debug because you cannot see it. Origin stamps help. A way to dump what a splice expanded to, equivalent to `-ddump-splices`, is probably not optional for long, though it can follow v1.
