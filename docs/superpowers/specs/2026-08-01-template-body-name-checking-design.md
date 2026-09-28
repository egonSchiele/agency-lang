# Templates can only use names they declare themselves

## The problem

A template can read a name that no code in the template defines. Nothing complains.

```ts
static const mainNode = [|
  node main(): string {
  #mainBody
    print(res)
    return res
  }
|]

static const llmCall = [|
  const res = llm(#prompt)
|]
```

Fill `#mainBody` with `llmCall` and it works. The `res` came from the filler.

That is not supposed to work. The internals doc already says so:

> "Bindings are local to the hole" is a checking rule, not runtime isolation. The checker cannot see into a hole, so template code referencing a filler-introduced name fails ordinary name resolution at template-check time.

The rule is written down. It is not enforced.

## Why this is worth fixing

Fillers usually come from a model. If the template reads `res`, then the model decides what `res` holds. The template author thought that name was theirs.

Agency already guards the opposite direction. When a filler mentions `tmp`, and the template has its own `const tmp = getApiKey()`, `fill` renames the template's `tmp`. That machinery exists because a name collision between template and filler is dangerous. Reading a filler's binding is the same collision, pointed the other way.

The second reason is simpler. Today the mistake shows up at run time, inside generated source the author never wrote:

```
ERROR Node main crashed: res is not defined
```

## What other languages do

Most macro systems prevent this outright. Scheme, Racket, Rust, Nim, Julia and Elixir are hygienic by default. A name in a macro body means what it meant where the macro was written. Inserted code cannot supply it.

Template Haskell allows it, but treats it as the unsafe path. A quote's names resolve at the quotation site. An unbound name becomes an `UnboundVarE` that a splice can capture later. The Template Haskell tutorial calls this "quite fragile". TH also has two name constructors that make the choice explicit. `newName` cannot be captured. `mkName` can.

Racket handles the cases where hygiene is genuinely too strict with syntax parameters. The macro declares the name it exposes. The capture is deliberate and visible at both ends.

So: nobody allows this silently.

## The rule

**A template can only use names it declares or imports itself, plus the prelude.**

A hole is opaque. Code around a hole cannot see what the hole will supply.

This holds for every kind of hole, including declaration holes. It holds for template files and for code literals.

The prelude part is not a footnote. `llm` and `print` come from `stdlib/index.agency`, which Agency auto-imports into every file. Leave them out and the recommended fix below gets rejected by its own rule.

## Two gaps to close

### Gap 1: code literals are never checked

The type checker treats a code literal as a value. It reads the literal, gives it the type `Code`, and never looks inside. So no setting reports anything about a literal's body.

### Gap 2: template files are checked, but only if you opt in

A `.agency` template file does report the problem, but only when `undefinedVariables` is set to `error` or `warn`. The default is `silent`.

```
tplfile.agency:4:10 - error AG4007: Variable 'res' is not defined.
```

So closing gap 1 alone changes nothing for most people. They would still see silence.

## The design

### Check literal bodies

Walk the body of a code literal in its own scope. That scope has three parts:

- the prelude and the builtins
- whatever the literal declares
- whatever the literal imports

A literal can import. Verified: an `import` inside a literal body parses, and the body infers as a program fragment.

Nothing the host file adds is in scope.

`resolveVariable` already resolves a name against several sources. For a literal body, drop the file-local ones, which are the host's `functionDefs`, its `nodeDefs` and its imports. Keep the prelude and builtin ones. Getting this backwards is the strict-side mistake, and it rejects correct templates.

### A literal cannot use the host file's declarations, on purpose

This is a separate decision from hole opacity, so it gets its own name.

```ts
def helper(): string { return "hi" }

static const t = [| node main(): string { return helper() } |]
```

Hole opacity is unarguable. Nobody can see into a hole, so depending on one is always wrong. This is different. Someone could reasonably expect to build a literal out of the helpers in the file they are writing.

The reason to forbid it anyway: `helper` will not exist in the generated program. `toSource` prints the literal, `runCode` compiles what was printed, and the host file is not there. So the call fails at run time in generated source, which is the failure this whole spec exists to move earlier.

### A separate pass, always on

An undefined name in ordinary code might be a style question. Some codebases turn it off.

An undefined name in a template is not a style question. The template is going to be printed, compiled and run somewhere else. Nothing downstream will catch it earlier than run time.

So this is a new pass, not a severity tweak on the existing one. The existing walk returns immediately when `undefinedVariables` is silent, which is the default. The resolution logic never runs at all. There is no flag to thread through it.

The new pass shares `resolveVariable`, so a name resolves by the same rules everywhere. It has its own entry point, it always runs, and it has its own diagnostic code.

### When the check runs

At the enclosing file's type-check time, while the literal still has its holes open.

That timing is what makes the check possible. At that moment `res` is genuinely unresolved, because the fill has not happened. After a fill there is nothing left to catch.

### One diagnostic, its own code

```
AG8015: `res` is not defined in this template. A template can only use
names it declares or imports itself, because a hole hides whatever fills
it. Move the code that defines `res` into this template, or move the code
that uses it into the fragment that defines it.
```

The message has to say what to do. "Not defined" alone reads like a typo, and the fix here is structural.

`AG8015` is the next free code in the template range. It also needs prose in `diagnosticExplanations.ts`. That file is exhaustive by type, so a new code without prose will not compile.

## What breaks

`tests/agency/templates/literalCompose.agency` relies on this pattern. Its template calls `guarded()`, which a `#helpers` filler supplies. Delete it.

The guide's composition section shows the same shape. Rewrite it so each fragment is self-contained:

```ts
static const llmCall = [|
  const res = llm(#prompt)
  print(res)
|]
```

The fragment now declares and uses `res` itself. Nothing reaches across the hole.

Deleting that fixture costs real coverage, so read it before deleting it. It is the only execution test for compose-then-parameterize on inline literals. It fills one template, grafts the result into a second, checks the remaining hole's origin, and runs the finished program.

The replacement has to keep that. A single self-contained fragment does not.

Sweep the rest of the repo for the same pattern before implementing. The templates under `tests/agency/templates/` and the examples are the places to look.

## Out of scope

An escape hatch, along the lines of Racket's syntax parameters. There is no evidence anyone needs one yet. If that changes, the design exists in the literature and can be added later without undoing this.

Renaming filler bindings so they are genuinely isolated at run time. The internals doc already rejected that. It would rename every filler binder and make generated code unreadable.

## Testing

The checker tests need these cases:

- A literal body reading a name a statement hole would supply. Reports.
- A literal body reading a name a declaration hole would supply. Reports.
- A literal body reading a name the host file declares. Reports.
- A literal body that declares everything it uses. Silent.
- A literal body that imports what it uses. Silent.
- A literal body that uses `llm` and `print`. Silent. This is the case that protects the recommended pattern, and the one that breaks if the base scope is built wrong.
- A template file, same cases, same results.
- The diagnostic fires with `undefinedVariables` left at its default.

One execution fixture, replacing the one that gets deleted. It has to cover the same ground: fill a fragment, graft it into a second template, then run the finished program. Every fragment declares what it uses.

## Risk

The check has to know what a literal body's scope is. Get that wrong in the strict direction and correct templates get rejected. That is the failure to watch for, and the prelude and "declares everything it uses" tests are what catch it.

---

## Response to review

Review: `2026-08-01-template-body-name-checking-design-REVIEW.md`. Every claim was checked against the code first.

**The blocking finding was right, and it was in the spec's own example.** My scope rule had two parts, the literal's declarations and its imports. `llm` and `print` are neither. They come from the prelude, which Agency auto-imports everywhere. So the fragment I held up as the fix would have been rejected by my own rule. The rule now has three parts and says why the third one matters.

**The imports question resolves to yes.** A literal body can import. An `import` inside a literal parses, the body infers as a program fragment, and the `importStatement` survives. So that half of the rule is live for literals, and the test stays.

**The always-on point was understated in my draft.** The existing walk does not downgrade to no output when silent. It returns at the top, so the resolution logic never runs. That makes this a separate pass with its own entry point, sharing `resolveVariable` for consistent resolution. The spec says that now instead of implying reuse.

**The host-declaration rule is now named as its own decision**, with the reason spelled out, rather than folded into the hole argument. It is the stricter half and the part most likely to cause friction.

**The fixture note changed what the replacement has to do.** `literalCompose.agency` is the only execution test for compose-then-parameterize on inline literals. Deleting it and replacing it with a single self-contained fragment would drop that coverage silently. The replacement has to fill, graft, and run.

**`AG8015`** is allocated, with a note that it needs `agency explain` prose or the build fails.
