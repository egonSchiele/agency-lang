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

#### The import restriction that makes this hold

The effect check is only meaningful if every dangerous operation actually goes through an interrupt. That is true of Agency code and false of TypeScript, which raises nothing. And there is a live path to TypeScript today: a plain JS or TS package like `zod` "passes through untouched" when imported (`docs/dev/pkg-imports.md:14`).

So the rule that makes the guarantee hold is a restriction on what a generator may import:

**A generator's transitive import graph may contain only `std::` imports and relative `.agency` files.**

Transitive is the operative word. Checking the generator's own file is not enough, because a local `.agency` file it imports could pull in `zod` one level down.

`pkg::` imports are excluded from v1. They are Agency code, so effects are tracked, but they are third-party and can themselves reach JavaScript. Allowing them later is additive.

This converts the safety argument from "audit an invariant" into a graph check with a definite answer.

#### How much this needs to worry us

Worth stating plainly, because it is easy to over-weight. Compile-time code execution is a real escalation, but a modest one. The generator is code already in your project, and both compiling and running a program already execute your code. The genuinely new exposure is that code runs at *build* time, when a user might expect only analysis. That is the npm `postinstall` problem: real, old, and well understood.

The comparison is favorable. npm `postinstall` has no check at all. Template Haskell's `runIO` has no check at all. Rust proc macros have no check at all. With the static effect check plus the import restriction above, Agency would be the strictest of the group by a wide margin.

The right response is therefore this one rule plus a test, not a standing risk item.

The static check is the primary one because it is better in every way that matters: it fires before any code runs, it fires even when the dangerous branch would not have been taken on this particular input, and it can point at the generator rather than at a stack.

The `"unknown"` sentinel makes this fail-closed. A generator containing a bare `interrupt(...)` reports `"unknown"` in its effect list, which is non-empty, which is a refusal.

### Rule 4: the result is pasted in and compiled as part of your file

The generator returns a `Code` value. The compiler splices that value's nodes into the AST at the splice site and continues compiling. From that point on there is no distinction: the generated `greet` is a function in your file, callable, type-checked, and compiled with everything else.

#### What generated code may refer to

Pasting code into a file raises a capture question, and it bites hardest in expression position. A declaration splice is mostly safe by accident: if a generator emits a top-level `const config` and the file already has one, that is a duplicate declaration, which is a loud and correct failure. But pasting an *expression* into a function body drops it next to local variables, and if the generated expression happens to mention `tmp`, it silently reads the local `tmp`.

The rule:

**Generated code may reference only names it declares itself and names it imports. Referencing a name from the splice site's scope is a name-resolution error.**

This is the templates rule "bindings are local to the hole" (`docs/dev/template-agency.md`) applied to splices. It fails closed: the bad case is a compile error rather than a silent capture.

Note this is a *checking* rule and not runtime isolation, exactly as it is for holes. A generated `const` genuinely shares the enclosing scope once pasted. The rule prevents a generator from *reaching into* the splice site, which is the direction the capture bug runs.

Implementation needs cross-checking against `lib/runtime/template/hygiene.ts`, which solves a related but distinct problem: that machinery renames to avoid collisions, whereas this rule refuses instead of renaming. Renaming would be wrong here, since the whole point of a declaration splice is that `greet` keeps the name the generator gave it.

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

### Caching and incremental builds: nothing new is needed

The obvious worry is that a file containing a splice depends on the generator's module, and that if the build manifest does not know about that edge, editing a generator will silently fail to rebuild its consumers. That worry is already handled.

The generator arrives as an **ordinary relative Agency import**. The manifest records `deps` plus `depsHash`, covering transitive Agency imports (`docs/dev/incremental-builds.md:21`). So editing `gen.agency` changes `depsHash` on `main.agency`, which invalidates it, which re-runs the splice. No new manifest field, no new edge type.

Caching falls out of the same place. If nothing relevant changed, `main.agency` is skipped entirely, so the splice never re-runs and its expanded output is already baked into the emitted JavaScript. There is no separate splice-output cache and no cache key to design, because the unit being cached is the compiled file and the existing machinery already caches that.

A splice's inputs are exactly two things, and both are covered: the arguments, which are written in the file's own source and therefore in `sourceHash`, and the generator's behavior, which is in `depsHash`.

This works **because of Rule 3**. A generator that could call `llm()` or read the clock would produce different output from identical inputs, and caching it would be silently wrong. Determinism is not only a safety property here; it is the thing that makes the cache free.

One constraint follows for the implementation: splice expansion must happen inside the normal per-file compile that the manifest guards. Hoisting expansion somewhere outside that path would break the guarantee.

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

1. **Combining fragments.** The boilerplate example needs to turn `Code[]` into one `program` fragment, and no primitive does this today.

   Settled shape: a function in `std::agency`, `combine(codes: Code[]): Result<Code>`, rather than an overloaded `+`. Combining can fail, because an expression fragment and a program fragment cannot merge, and a function returning `Result` has somewhere to report that while an operator would have to throw or silently guess. Agency also has no operator overloading today, and introducing it for one stdlib type is a larger language change than this feature needs.

   Remaining: the exact name, and the merge rules for each kind pair.

2. **Nested splices.** May a generator module itself contain splices? Haskell allows this. Allowing it means recursion and needs a depth cap; forbidding it in v1 is simpler and additive to relax.

3. **Which argument expressions are legal.** `$( gen(["a"]) )` is clearly fine. Is `$( gen(SOME_CONST) )` fine, where `SOME_CONST` is defined in the file being compiled? That reintroduces the staging cycle. Simplest v1 rule: arguments may be literals, code literals, and references to imported names only.

4. **Detecting nondeterminism.** The effect half is free via `getEffectsFromSource`. The `llm()`/clock/randomness half needs new tracking. All transitive effect propagation runs through `analyzeInterruptsFromScopes` (`lib/typeChecker/index.ts:300`), which is a single chokepoint, so an internal marker riding that existing propagation looks plausible. Needs confirming by reading it.

5. **Which positions holes cannot reach.** Filed as #678. Does not block v1, since v1 generators take hand-supplied arguments, but it shapes what the introspection follow-up can deliver. Summarized here because it was found during this design work.

   Where holes **do** work is broad. The battery at `lib/parsers/hole.test.ts:157-175` pins fifteen expression positions: assignment value, binop operand, if and while conditions, call argument, named argument, guard head argument, return value, array element, object value, string interpolation, for-loop iterable, match scrutinee, try expression, and is-expression operand. That breadth comes from a single wiring point, `exprHoleParser` as the first alternative in `baseAtom`. Statement holes, top-level declaration holes, and splices in statement and argument positions work too. Anywhere a value goes, a hole goes.

   The gaps are in the other categories:

   - **Names**: only three sites (def names, node names, import specifiers). Not property names, so a generator cannot emit `p.#field`. Not parameter names. Not object-literal keys.
   - **Types**: none. There is no type sort, so `const x: #T = ...` is impossible.
   - **Patterns**: none, in match arms or destructuring.

   Template Haskell parameterizes all four categories, since it has expression, declaration, type, and pattern quotes and nested splices work in each. So relative to TH we are missing types and patterns. Notably TH has no name holes either.

   The sharper difference is that **TH always has a fallback**: build the syntax tree by hand. `makeLenses` constructs `Dec` values programmatically and quotes only small pieces. Quotes are a convenience there, not the only road. We have no typed equivalent. If a position has no hole, templates cannot reach it, and the only escape is `parseStatements` on a string, which is exactly the injection surface the feature exists to avoid. (`Code` is a plain record a caller can hand-build, which `isCode` validates for, but no typed API exists for doing so.)

   So each missing position is a hard wall rather than an inconvenience. The property-name gap in particular blocks `makeLenses`, since seeing that `Person` has a field called `name` is useless if you cannot then generate `p.name`. Resolve it with the introspection work rather than leaving it implicit.

   Two candidate approaches for property names: widen identifier holes to that position, or generate `p[#field]` index access, which may parse today but changes typing and routes through `__nn` null-normalization. Neither is verified.

6. **Diagnostic codes.** `AG8001` and `AG8002` are taken by templates, so splices start at `AG8003`. Note that `diagnosticExplanations.ts` is exhaustive by type, so every new code needs prose or the build fails (`docs/dev/template-agency.md`). Codes needed, at minimum: generator has effects, generator is nondeterministic, generator not imported from another file, returned fragment kind does not match splice position, generator failed at runtime.

## Testing

Mirroring how #665 was tested.

- **Parser tests** for `$( )` in both positions, and for the positions where it is rejected.
- **Refusal tests** via `compileSource`, asserting the `code` field rather than thrown text, covering: a generator that raises an effect, one that calls `llm()`, one defined in the same file, one returning the wrong fragment kind, one that imports a JS/TS package directly, and one that imports a local `.agency` file which in turn imports a JS/TS package. The last is the one that proves the import check is transitive rather than shallow.
- **Execution fixtures** in `tests/agency/templates/` for the end-to-end cases: declaration splice producing a callable function, expression splice producing a value, and a generator built with `fill` and code literals.
- **A resource-limit test** proving a looping generator produces a bounded error rather than hanging.
- **An error-attribution test** proving that when generated code fails to compile, the message names the generator.

Per project convention these need no LLM calls.

## Risks

**Build times.** A subprocess per splice is slow, and without caching this could be very slow. Caching is listed as an open question but should probably be in v1 rather than a follow-up.

**Debuggability.** Haskell's experience is that generated code is hard to debug because you cannot see it. Origin stamps help. A way to dump what a splice expanded to, equivalent to `-ddump-splices`, is probably not optional for long, though it can follow v1.
