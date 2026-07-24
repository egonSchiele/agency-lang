# Code templates: Agency code with typed holes

Status: design, awaiting review
Date: 2026-07-22

## Background

### The problem we are trying to solve

Agency has a good story for running untrusted code. `std::agency` gives you `run` (`stdlib/agency.agency:108`), `runFile` (`stdlib/agency.agency:208`), and `runCode` (`stdlib/agency.agency:308`), which execute Agency code in a subprocess. The subprocess inherits the parent's handlers, so whatever the child program tries to do, the parent's `handle` blocks see it and can approve it or reject it. If the parent has no handler that permits writing files, the child cannot write files, no matter what its source says.

That covers the question "what is this program allowed to *do*". It does not cover the question "what does this program *look like*". Right now, if you want to build an Agency program at runtime and hand it to `run`, your only option is to produce a string. `runCode` takes a string. That string might not parse. It might parse into something you never intended. If any part of it came from a language model, the model chose not just the values in the program but its entire shape.

So there is a gap. Handlers constrain behaviour. Nothing constrains structure.

### Why the two obvious answers are not good enough

**String templates.** You take a program with placeholders and you substitute text into the placeholders, mustache-style. This is what people reach for first, and it has two problems that get worse as programs grow.

The first is that a substitution can produce something that is not a valid program. If your template is `const x = {{value}}` and `value` is the text `1 +`, you have produced a syntax error, and you will not find out until the subprocess tries to compile it. Worse, if `value` is the text `getSecret(); deleteEverything()`, you have produced a valid program that does something you never wrote. That is code injection, and it is the same class of bug as SQL injection. The template author cannot prevent it, because the template system does not know the difference between "an expression" and "some characters".

The second problem is that string templates get hard to manage. Once a template is a hundred lines long, with conditionals deciding which chunks get concatenated, nobody can look at it and know what programs it can produce.

**Building an AST directly.** `std::agency` already exposes `walkAST` (`stdlib/agency.agency:490`) and `writeAST` (`stdlib/agency.agency:438`), backed by a single canonical source-to-AST path and a single canonical AST-to-source path (`lib/stdlib/agency.ts:192-232`). You could build up an `AgencyProgram` value by hand and write it out.

This fixes the injection problem completely, because you are assembling tree nodes and there is no text to inject into. But it trades that for a readability problem. The AST for a ten-line program is a hundred lines of nested JSON. Nobody can read it, nobody can review it, and a small change to the program you want to generate is a large and error-prone change to the code that generates it.

### What we want

We want the structure of the AST approach with the readability of the string approach. You should be able to write the program you want to generate as *actual Agency code*, with clearly marked gaps in it, and fill those gaps with values that are checked before they land.

That is an old idea. It is called quasiquotation, and it exists in Lisp (backquote and comma), Template Haskell (`[| |]` and `$( )`), MetaOCaml, Scala 3, Julia, and Rust's `quote!` macro. The version closest to what we are building is babel-template in the JavaScript world, where you write real JavaScript containing placeholder names and fill them from an object.

## What we are building

Agency gains **templates**: Agency code containing typed holes, represented at runtime as a first-class `Code` value that you can fill, compose, and hand to `run`.

A hole is written `#name`. A hole that expands into a sequence is written `#...name`.

```
node main() {
  #setup
  const prompt: string = #text
  #...toolCalls
}
```

You fill the holes, you get back a complete program, and you run it. A fill that does not match the hole's type or its syntactic category is an error at fill time, in the parent process, with a good error message. It is not a syntax error discovered later inside a subprocess.

The safety argument is worth stating precisely, because it is the reason to build this. Today `runCode` accepts an arbitrary string, about which nothing is known. That is an unanalysable boundary at maximum width. Templates do not open a new hole in the language's analysability; they narrow one that is already wide open. After this change, you can hand `run` a value whose skeleton was checked when it compiled, whose gaps have declared types, and whose overall shape you wrote by hand.

## Where this sits, and what we are deliberately not doing

It helps to think of code-generation systems as a ladder, where each rung makes a class of bug impossible.

- **Level 0, strings.** Nothing is guaranteed. Injection is possible. This is mustache.
- **Level 1, tokens.** The output is a well-formed token stream but may not parse. This is Rust's `quote!`.
- **Level 2, trees with sorted holes.** The output always parses, and a hole knows what category of thing goes in it. This is babel-template.
- **Level 3, hygiene.** Names mean what they meant where they were written. A filler cannot accidentally bind to a template's local variable. This is Racket's `syntax-case`.
- **Level 4, typed.** A code value carries the type of what it produces, so you cannot build one that fails to typecheck. This is Template Haskell's typed splices and MetaOCaml.
- **Level 5, effect-typed.** The code value's type also records which effects the generated program can raise.

This design targets levels 2 and 3 in full, and adds fill-time type validation. It does not reach level 4, and it skips level 5 on purpose.

Being precise about level 4 matters, because it is easy to overclaim. Level 4 as defined above is a *compile-time* guarantee: the type system makes an ill-typed code value unconstructable. What this design delivers is type validation when a hole is filled, plus a complete typecheck when the program is compiled at `run` time. A completed program can still fail that final check, for instance if a deferred definite-return turns out to be missing. That is a reasonable place to land, and it catches the errors people actually make, but it is validation rather than a guarantee and the spec should not pretend otherwise.

**Why we skip level 5.** Encoding "this hole may raise at most these effects" in the type system requires effect polymorphism, which is a substantially larger piece of type theory than anything currently in the checker. And we do not need it. Effects raised by generated code become interrupts, and interrupts cross the subprocess boundary to the parent's handlers. If the parent has no handler for an effect, the effect is rejected. The safety property we want is already delivered by machinery that exists. Declaring effects on holes would be a convenience, not a guarantee, and it is not worth its cost right now.

For what it is worth, the pieces for level 5 do exist if we ever want it. `raises` is already part of function types (`lib/types/function.ts:72-74`), the checker already enforces that a function value may not flow into a function type that declares fewer effects (`lib/types/typeHints.ts:193-196`), and `getEffects` (`stdlib/agency.agency:381`, backed by `lib/stdlib/agency.ts:176`) already computes the effect set of a source file per export. A future version could compare a filler's computed effects against a declared bound at fill time, without any new type theory. That is a follow-up, not part of this work.

## Design

### Syntax

A hole is a `#` immediately followed by an identifier.

```
#name
```

A splice is `#...` immediately followed by an identifier. It expands to a sequence rather than a single item.

```
#...items
```

A hole name may also be written as a quoted string, which allows names that are not legal identifiers:

```
#"hi-there"
#..."tool-imports"
```

The quoted form permits any characters except whitespace and the quote character. Names with spaces are rejected. This exists because hole names are frequently derived from external data such as schema field names, which routinely contain hyphens.

The quotes are around the hole's **name** and nothing else. `#"hi-there"` is an ordinary hole whose name happens to be `hi-there`; you fill it with `fill(t, { "hi-there": value })`. Quoting the name does not change the hole's sort, does not change its type, and in particular does not relax what may fill an `identifier` hole. An `identifier` hole named `#"field-name"` still requires its filler to be a legal Agency identifier, because the filler becomes a name in the generated program while the hole's own name never appears there.

**Why `#`.** The two characters that would have read more naturally are both taken. `%` is the modulo operator (`lib/parsers/parsers.ts:2936`), so `a %b% c` already parses today as `(a % b) % c`. `${...}` is string interpolation (`lib/parsers/literals.test.ts:19-24`), so reusing `$` would put two very different mechanisms next to each other with nearly identical syntax, one running at generation time and one at run time.

`#` currently introduces an object property description (`lib/parsers/parsers.ts:1224-1231`). That syntax is deprecated and is being removed as part of this work. See "Removing the deprecated `#` description syntax" below.

### Sorts

A hole's **sort** is the syntactic category of thing that can fill it. The sort is never written down. It is determined by where the hole appears.

| Sort | Where it appears | What fills it |
| --- | --- | --- |
| `expr` | Anywhere an expression is allowed | An expression |
| `statements` | Anywhere a statement is allowed | Zero or more statements |
| `identifier` | Where a name is expected: a declaration name such as `def #name()`, or an import specifier such as `import std::fs { #tool }` | An identifier |
| `decl` | At the top level of a program or module body | Any top-level form: a function, node, or type declaration, or an import statement |

The `identifier` sort matters more than it looks. Generating `def #name()` is how you produce a program with a function whose name comes from data, and no expression hole can do that job.

`decl` covers imports because generating one import per selected tool is a primary use case. It does not cover bare top-level statements, `static` blocks, or top-level callbacks. Those are excluded because each one has ordering and initialisation semantics that a generated program should not be able to reach into, and none of them is needed by the use cases driving this work. If that turns out to be wrong, widening the sort later is additive.

**Tie-break for bare holes in statement position.** A hole standing alone as an entire statement is ambiguous, because an expression alone on a line is also a legal statement. The rule: a bare hole or splice occupying an entire statement has sort `statements`. A hole has sort `expr` only when it appears inside a larger expression. So `#setup` on its own line is a `statements` hole, while `f(#setup)` is an `expr` hole. This needs a parser test, since the ambiguity is real rather than theoretical.

A `type` sort, for holes standing in for types, is listed under open questions. It is needed for generating record types from schemas, and it is not needed for the primary use case.

### Typing

Holes are **checked, never inferred**. A hole takes its type from the type expected at its position. This falls out of the checker already being bidirectional.

Where the position supplies an expected type, no annotation is needed:

```
const prompt: string = #text     // the declaration supplies `string`
greet(#name)                     // the parameter type supplies it
return #result                   // the declared return type supplies it
```

Where the position does not supply one, annotate the hole inline:

```
const prompt = #text: string
```

The important consequence is that a hole's contract is about its **type**, not its shape. A template author holding a `Code` value of type `string` may fill a `string` hole with `code`"hello"``, with `code`getPrompt()``, or with `code`a + b``. All three are expressions of type `string`, and the template does not care which one was chosen.

That freedom belongs to the template author, not to whoever supplies data. See the next section, which is the one that makes the difference.

`statements`, `identifier`, and `decl` holes carry no type, because nothing consumes a value from them.

### What a filler value is

This is the section the safety argument rests on, so it is worth being exact.

**Plain values are lifted to literals. They are never parsed as source.** If you fill an `expr` hole with the string `"readFile(\"/etc/passwd\")"`, the generated program contains a string literal whose contents are those twenty-eight characters. It does not contain a call to `readFile`. The same holds for numbers, booleans, `null`, and arrays or records built from those: each becomes the corresponding literal node.

This is the whole point. A model that fills a hole is supplying **inert data**, not source text. There is no parse step for it to escape through, so there is nothing to inject into. The claim in the first worked example, that the model cannot add a tool call, depends entirely on this rule.

**`Code` values are grafted as trees.** The only way to put a *computation* into a hole is to supply a `Code` value, and the only way to get a `Code` value is from a template literal or a template file, both of which a human wrote. Putting a call into a generated program therefore requires a template author to have deliberately built one. It is not something a filler can arrange.

**`identifier` holes are the exception, and need validation.** An identifier hole cannot take a literal node, because a name is not a value. Filling one with a plain string is the natural thing to want, and it is how the splice example generates one import per selected tool. So an `identifier` hole accepts a string, but only after validating it against the identifier grammar: a letter or underscore, then characters from `varNameChar` (`lib/parsers/parsers.ts:184-186`, `lib/parsers/parsers.ts:842-849`). Anything else is rejected at fill time.

Without that check, `fill(t, { tool: "x } import evil" })` would inject through the identifier hole, which would defeat the entire feature. The validation is not an optimisation or a nicety; it is what makes the identifier sort safe to have at all.

**Summary of the rule.** Data goes in as data. Code goes in as `Code`. Names go in as validated strings. Nothing supplied to `fill` is ever parsed as Agency source.

### Where templates come from

Two places.

**`.agency` files containing holes — this is the whole of v1.** You write `template.agency` with holes in it, load it, and fill it. The template is a real file that the formatter, the linter, and the editor all understand.

**Source literals are deferred to v2.** A `` code`...` `` block inside a `.agency` file would evaluate to a `Code` value. It is more parser work, and files are the better route for anything longer than a couple of lines, so v1 does without it. Examples in this document that use `` code`...` `` illustrate the eventual shape; in v1 the equivalent is a small template file loaded from disk.

Because templates live in real files, hole syntax is part of the real grammar, not a sub-grammar that only exists inside a quoted block. That has consequences, all of which are work:

- `agency run` on a file containing holes must fail with a clear message saying the file has unfilled holes. It must not produce a confusing type error.
- The formatter must print holes back out unchanged. This matters because `_writeAST` (`lib/stdlib/agency.ts:216`) round-trips through `generateAgency`, and that round-trip is load-bearing.
- The LSP must not report holes as errors.
- The linter must know what holes are.

### `Code` is a first-class value

This is the load-bearing architectural decision, and it should be made now even though most of what it enables is out of scope for this version.

`Code` is an ordinary value with an ordinary type. It is not an opaque handle, not a compiler-internal thing that only exists between a `` code`...` `` literal and a `fill` call. You can put a `Code` value in a list. You can return one from a function. You can pass one as an argument. You can splice one into another template.

The reason to commit to this now is that everything we are deferring becomes *additive* if `Code` is a value, and becomes a *rewrite* if it is not. Generating a variable number of declarations from a runtime list, composing a program out of independently built pieces, and deriving code from reflection on existing code are all just programming, provided the thing being manipulated is a value. Template Haskell gets all of its power from `Q Exp` being a normal value; the quotation syntax is only a convenient way to construct one.

Splicing a `Code` value into a template is also how we avoid nested templates entirely. See "Out of scope" below.

### Hygiene

**The bug.** Consider this template:

```
node main() {
  const tmp = getApiKey()
  const result = #userExpr
  print(result)
}
```

Someone fills `#userExpr` with the expression `tmp`. Plain substitution produces:

```
const tmp = getApiKey()
const result = tmp
print(result)          // prints the API key
```

Nobody intended this. The template author picked `tmp` as a throwaway name. Whoever wrote the filler wrote `tmp` meaning something else entirely, or meaning nothing at all. The two collided because substitution matches names by spelling, and spelling is a coincidence. In a language whose selling point is safety, and in a feature whose purpose is constraining code that a model wrote, this is a security bug rather than a papercut.

The bug runs in both directions. A filler that declares its own `tmp` would shadow the template's, breaking the template.

**The fix.** Before grafting anything, rename the names that would collide.

There are two standard approaches. One is to attach scope information to every identifier, recording where it was written, and to compare those tags during name resolution. Racket does this, calls it scope sets, and it is the more precise approach. It also keeps the output readable, because names are unchanged.

The other is to rename binders into a namespace reserved for the renamer, so that a collision becomes impossible by construction. After renaming, the example above produces:

```
node main() {
  const __hyg1_tmp = getApiKey()
  const result = tmp
  print(result)
}
```

and `tmp` in the filler now refers to nothing, producing exactly the right error: `tmp` is not defined. The filler referenced a name that was not in scope where it was written, and that is what the error says.

Note that `result` is untouched. Only `tmp` appeared on both sides, so only `tmp` is renamed.

**The renamed names must be legal Agency identifiers.** This constraint is easy to miss and it rules out the obvious choice. Identifiers in this language are ASCII only: `varNameChar` is `oneOf("a…zA…Z0…9_")` (`lib/parsers/parsers.ts:184-186`) and the leading character must be a letter or an underscore (`lib/parsers/parsers.ts:842-849`). A name like `tmp·1`, picked precisely because nobody could type it, would fail to lex. And since the whole reason we rename rather than track scope metadata is that code values get printed to source and re-parsed by the subprocess, a name that does not lex would break every program that needed renaming, at exactly the point renaming was supposed to help.

So the scheme is a reserved ASCII prefix: `__hyg<n>_<original>`.

That trades one guarantee for another. Users *can* type `__hyg1_tmp`, so "impossible by construction" is no longer free. We restore it with a rule: **`fill` rejects any template or filler containing an identifier that matches the reserved prefix.** A name cannot collide with the renamer's output if the renamer refuses inputs that use its namespace. The rejection message should say the prefix is reserved for hygiene.

The alternative was extending the lexer to accept a non-ASCII character in identifiers. That changes the identifier grammar of the entire language to serve one feature, and it does not actually deliver impossibility either, since users could then type the character too. The reserved prefix is cheaper and touches nothing outside this feature.

**We use renaming.** The reason is specific to Agency. Code values have to become text, because `run` ships a program to a subprocess as source. Scope metadata lives on AST nodes, so it disappears the moment you print. It would disappear silently, and it would disappear at precisely the boundary where a capture bug is most dangerous. Renamed identifiers are just names. They survive printing, serialisation, the subprocess, the debugger, and anything else that happens downstream.

**Selective renaming.** Renaming everything would make generated code unpleasant to read and debug. Instead, at fill time, compute the set of names that collide and rename only those. In the common case where a filler and a template share no names, nothing is renamed and the generated code reads exactly as written. The generated names appear only where there was a real collision to resolve.

**The collision set is computed jointly, not pairwise.** It is tempting to think of this as template versus filler, but two fillers can collide with each other while neither collides with the template. If `#setup` and `#cleanup` both graft into the same scope and both declare `const tmp`, a pairwise check against the template finds nothing wrong and the generated program has a duplicate declaration. So the collision set must be computed across the template and all grafted pieces together, in one pass.

### Scoping and control flow

These are two separate questions and they get two different answers.

**Bindings are local to the hole.** A `statements` hole is a block. Whatever it declares is invisible after it. This means the code following a hole stays checkable:

```
node main() {
  #setup
  print(x)     // error: `x` is not defined, regardless of what `#setup` declares
}
```

Without this rule, the checker would have to give up on everything after a hole, since it cannot know what the hole will introduce. The rule also happens to be exactly what hygiene wants, so we get it for free.

**Control flow is transparent.** A `return` inside a `statements` hole returns from the enclosing function. This is what anyone would expect, and forbidding it would make the most obvious template of all useless:

```
node main() {
  #nodeBody
}
```

**Definite returns are deferred.** A function containing a `statements` hole is exempt from the definite-return check. The template is not required to be a complete, valid program on its own. The completed program is checked in full when it compiles, and that is where a missing return gets caught.

### The three checking points

A template is checked for what can be checked. A completed program is checked completely.

1. **Template compile time.** The skeleton parses. Holes are in legal positions. Every hole either sits in a position that supplies a type or carries an inline annotation. Whole-program checks that a hole could invalidate, such as definite returns, are skipped for functions containing holes.
2. **Fill time.** The value supplied for a hole matches the hole's sort and, for `expr` holes, its type. Hygienic renaming happens here.
3. **Run time.** `run` compiles the completed program and typechecks it in full, exactly as it does for any other program today.

A program with unfilled holes refuses to run.

### `fill` semantics

`fill` takes a `Code` value and a record mapping hole names to values, and returns a new `Code` value. It never mutates its input.

Supplying a name that is not a hole in the template is an error.

**A partial fill is allowed and returns a template with fewer holes.** This composes with the "build pieces, then splice" pattern that this design recommends everywhere else, and it lets a program fill holes in stages as information arrives. The risk it appears to introduce, a typo silently leaving a hole unfilled, is already covered twice over: supplying an unknown name is an error, and a program that reaches `run` with holes left in it refuses to run.

**What a filler may reference, and what it is checked against.** Hygiene guarantees a filler's names cannot bind to the template's local variables. So the environment a filler is checked in is the **module scope of the completed program**: its imports, its top-level declarations, and the prelude. That is knowable at fill time, because the template owns the skeleton and therefore owns the imports and top-level declarations.

Fill-time expression checking runs against exactly that environment. This is also what produces the error in the hygiene example above: the filler's `tmp` is not in module scope, so fill-time checking rejects it and names the unknown identifier. The error surfaces at fill time, in the parent process, not later inside a subprocess.

### Error attribution

Every node in a filled program has two possible authors: the template and the filler. Source spans must carry both, so an error in generated code can say which one is responsible.

This is not a nice-to-have. The single most-cited complaint about Template Haskell in practice is that errors point into generated code that the user never wrote, with no way to trace them back. It is much cheaper to design this in than to add it later, because it means the span representation has to accommodate two origins from the start.

## Worked examples

### Constraining a model to fill in one value

The shape of the program is fixed by a human. The model supplies one string.

```
const template = loadTemplate("summarize.agency")
const userPrompt: string = askModelForPrompt(request)
const program = fill(template, { text: userPrompt })
run(program)
```

`summarize.agency`:

```
node main() {
  const prompt: string = #text
  const result = llm(prompt)
  print(result)
}
```

The model cannot change the structure. It cannot add a tool call, add a loop, or write four hundred lines. It supplies a string expression, and if it supplies something that is not a string expression, `fill` rejects it before anything runs.

### Generating a variable number of things

This is why splices are in this version rather than the next one. The very first realistic template needs them.

```
const chosen: string[] = selectTools(request)     // e.g. ["readFile", "grep"]

const imports = [fill(code`import std::fs { #tool }`, { tool: name }) for name in chosen]

const withImports = fill(code`
  #...imports

  node main() {
    #body
  }
`, { imports: imports })

const program = fill(withImports, { body: code`print("done")` })
run(program)
```

The generated program has exactly as many imports as the runtime list has entries. No fixed skeleton could encode that, because a hole is a position and positions cannot multiply.

Note that `#tool` here is an `identifier` hole, and the way to vary it per iteration is to fill a small template once per item and collect the results. That is the general pattern: build pieces as `Code` values, then splice the collection. The example also shows partial filling: `withImports` is a `Code` value that still has `#body` in it, and it is a perfectly ordinary value until the second `fill` completes it.

The `chosen` strings pass through the `identifier` validation described above, so a tool name containing anything outside the identifier grammar is rejected here rather than becoming part of the generated source.

**`${...}` inside a template is not a hole.** String interpolation keeps its normal meaning and belongs to the generated program, not to the generation step. In a template containing `print("hi ${name}")`, the `${name}` is interpolated when the *generated* program runs, using whatever `name` is in scope there. Anything you want substituted at generation time must be a hole. These two mechanisms look similar and run at completely different times, which is the main reason `$` was not chosen as the hole sigil.

## Out of scope, and why

**Nested template literals.** A `` code`...` `` literal inside another `` code`...` `` literal is forbidden.

The reason is that a hole inside a nested template has two plausible owners, and both readings are reasonable. Given a template that generates a function that itself returns a template, a hole in the inner one might belong to the outer template, to be filled now, or to the inner one, to be filled later by the generated program at its own runtime. Template Haskell resolves this with numeric levels, where quoting raises the level and splicing lowers it, and using a name at the wrong level is a "stage error". This is the single most common thing people bounce off in Template Haskell, and the error messages are famously hard to decode.

We do not need it, because `Code` values compose. Build the inner piece as a value and splice it:

```
const inner = code`Hello, #who`
const outer = code`
  def makeGreeting(): Code {
    return #inner
  }
`
```

Now `#who` unambiguously belongs to `inner`, and you fill it whenever you like, before or after splicing. Ownership is as clear as ordinary variable scope. There is also a purely practical benefit: nested template literals would need escaping rules for backticks and `#` inside them, and by two levels deep nobody can count the escapes.

**Reify.** Template Haskell's most-used feature is `reify`, which lets a generator ask the compiler about existing definitions and emit code shaped by the answer. Every `deriving` library works this way. The Agency version would answer questions like: what does this module export, what is each function's signature, what is its docstring, which effects does it raise, what nodes exist.

We already have a narrow slice of it in `getEffects` (`stdlib/agency.agency:381`), which answers one of those questions and proves the pattern end to end. The full version is genuinely valuable, and the most compelling use is generating a subprogram that has exactly one handler per effect its tools can raise, so that handler completeness becomes a property of the generator rather than something a human reviews for. Given that CLAUDE.md treats an unregistered handler as a critical bug, that is worth building.

It is not in this version, because the API will be much better designed after we have watched people write templates and seen what they actually reach for. Designing it now is guessing.

**Effect declarations on holes.** Covered above. Handlers around `run` already deliver the safety property.

**Lazy holes.** There is an appealing idea where an unfilled hole becomes an interrupt at runtime: the program runs, reaches a hole, raises with the hole's name and the values in scope, and a handler supplies the fill. This is roughly what the Hazel language does with holes, and it maps unusually well onto machinery Agency already has.

The strongest argument for it is cost. If a generated program has fifteen conditional branches and two execute, eager filling means thirteen wasted model calls. There is also a real capability argument, since a hole inside a loop might need to be filled differently per iteration, and eager filling cannot see the loop variable.

The argument against is that lazy holes mean the code you approved is not the code that ran. Every unfilled hole becomes a live injection point during execution, inside the subprocess, after the sandbox boundary. That works against the property the feature exists to provide.

We are not building it. The `Hole` AST node should be designed so that adding it later does not require a redesign.

## Removing the deprecated `#` description syntax

`#` currently introduces a free-text description on an object property, running to the next `,`, `;`, or newline (`lib/parsers/parsers.ts:1224-1231`):

```
type User = {
  name: string   # the user's full name
}
```

This syntax is deprecated. It is removed as part of this work, which frees `#` completely and means holes can appear in every position, including inside object type literals, with no ambiguity and no whitespace-sensitive disambiguation rules.

The blast radius is small. The parser wires it in at two places (`lib/parsers/parsers.ts:1270` and `lib/parsers/parsers.ts:1359`). Two test files use it:

- `tests/agency/typeHints/unionAndDescriptions.agency:3`
- `tests/agency/validation/jsonSchemaWithDescription.agency:11`

Both need migrating. **The replacement is `@jsonSchema({ description: ... })` written directly on the property**, which is confirmed to work and to produce byte-identical output:

```
// before
type Sentiment = {
  confidence: number # A confidence score from 0 to 100
}

// after
type Sentiment = {
  @jsonSchema({ description: "A confidence score from 0 to 100" })
  confidence: number
}
```

Both forms emit the same schema:

```json
{ "type": "number", "description": "A confidence score from 0 to 100" }
```

This was verified rather than assumed, because the removal only makes sense if per-property descriptions survive it. Those descriptions are functional: they are what tells a model that `confidence` is scored from 0 to 100 rather than 0 to 1. Two things were checked. First, an annotation written directly on a record property parses and attaches to that property, arriving as `tags` on the object property node rather than being rejected or floating up to the enclosing type. Second, the description reaches the emitted schema at `properties.confidence.description`, which is exactly where `#` puts it.

Note that the existing tests are not evidence for this, which is why it needed checking. Both of them attach `@jsonSchema` to a *type alias* that a property then refers to, which is a different thing. The comment at the top of `tests/agency/validation/jsonSchemaOnObjectProperty.agency` says so explicitly.

The migration costs users some characters. A one-line property with a description becomes two lines. That is the price of the sigil, and it is worth paying given the replacement is exact.

## Implementation ripple

- **AST**: a `Hole` node carrying name, sort, optional type annotation, and location. Designed so a future "unfilled at runtime" mode is additive.
- **Parser**: hole and splice syntax in expression, statement, identifier, and declaration positions; removal of the `#` description parser.
- **Generator and formatter**: holes must print back out unchanged, preserving the round-trip that `_writeAST` depends on (`lib/stdlib/agency.ts:216`).
- **Typechecker**: check holes against expected types bidirectionally; require an annotation where the position gives no type; exempt hole-containing functions from definite-return.
- **Runtime**: the `Code` value type, `fill`, splice expansion, selective hygienic renaming, and the refusal to run a program with unfilled holes.
- **Serialization**: a `Code` value is an ordinary value, so it will end up in variables that cross checkpoints, in the GlobalStore, and possibly in `args` records crossing the subprocess IPC boundary. If it cannot round-trip through the state stack, resume breaks in any program holding one across a pause. **The serialized form is printed source.** That reuses the canonical generate and parse paths (`lib/stdlib/agency.ts:192-232`) instead of introducing a second representation, and it works only because holes are part of the real grammar: a template prints with its holes intact and re-parses to the same tree. The round-trip test for this belongs with the formatter tests, and a checkpoint-and-resume test holding a `Code` value belongs in the execution tests.
- **Stdlib**: template loading and `fill` exposed from `std::agency`, alongside the existing `run` family.
- **LSP**: holes are not errors; ideally hover shows a hole's expected type.
- **Lint**: awareness of holes so template files do not produce spurious findings.
- **Docs**: a guide page, and stdlib reference generated from docstrings per the `agency doc` conventions.

## Testing strategy

Agency execution tests do not require LLM calls, and everything here is testable without one.

- **Parser and formatter**: round-trip tests for every hole sort. Parse a template, print it, re-parse, and confirm structural equivalence. Quoted hole names round-trip too, including names that are not legal identifiers, and a quoted name containing a space is a parse error. A bare hole alone on a line parses as `statements`, while the same hole inside a call argument parses as `expr`.
- **Filler values**: an `expr` hole filled with a string produces a string literal in the output, not parsed source. The specific case matters: filling with `"readFile(\"/etc/passwd\")"` must produce a literal and must not produce a call. An `identifier` hole filled with `"x } import evil"` is rejected at fill time. An `identifier` hole filled with a legal name succeeds.
- **Typechecker**: holes in positions that supply a type; holes in positions that do not, with and without annotations; a fill whose type does not match; a fill whose sort does not match, which is the "you cannot put a function definition where an expression goes" case from the original motivation.
- **Hygiene**: the API-key capture case above, asserting that the filler's `tmp` fails to resolve rather than silently binding. The reverse direction, where a filler declares a name the template also uses. Two fillers that collide with each other but not with the template, asserting the joint collision set is computed correctly. A case with no shared names, asserting no renaming happened, so that generated code stays readable. A renamed program printed and re-parsed, asserting the generated names lex. A template or filler containing an identifier with the reserved `__hyg` prefix is rejected.
- **Scoping and control flow**: a name declared inside a `statements` hole is invisible after it; a `return` inside a hole returns from the enclosing function; a function whose only return is inside a hole compiles as a template and is checked correctly once filled.
- **Splices**: expansion counts matching the input list, including the empty list.
- **End to end**: fill a template and `run` it in a subprocess, with a handler in the parent rejecting an effect the generated code raises, confirming the existing safety story still holds through a generated program.
- **Refusal**: `agency run` on a file with holes fails with a message naming the unfilled holes.

## Open questions

1. **Is a `type` sort in this version?** Deferred. It is needed for generating record types from schemas, and nothing in the primary use case needs it. Removing the `#` description syntax makes it possible to add later without ambiguity.
2. ~~**Are `` code`...` `` literals in this version?**~~ Resolved: deferred to v2. This version handles templates loaded from `.agency` files only. Files are the ergonomic route for anything longer than a couple of lines, they get the formatter and the editor for free, and the literal path is meaningfully more parser work. Every example in this spec written as `` code`...` `` should be read as illustrating the eventual shape, not v1.
3. ~~**What does a partial fill do?**~~ Resolved: it returns a template with fewer holes. See "`fill` semantics".
4. ~~**Does `@jsonSchema` cover per-property descriptions?**~~ Resolved: yes. `@jsonSchema({ description: ... })` written directly on a record property parses, attaches to that property, and emits the same schema `#` does. The sigil choice holds. See "Removing the deprecated `#` description syntax".
