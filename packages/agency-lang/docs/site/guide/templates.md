# Code Templates

A template is an Agency file with gaps in it. You write the skeleton of a program, mark the gaps with `#name`, and fill them later — usually with values a model chose. The result is a program whose structure a human wrote and whose details are checked before anything runs.

Why does this matter? `runCode` takes a string, and if a model produced that string, the model chose the entire shape of the program. With a template, the model only gets to fill the gaps you left, and every gap is validated on the way in.

## Holes

A hole is written `#name`. Here is a template with two:

```ts
node main(): string {
  const topic: string = #topic
  const maxWords: number = #maxWords
  return llm("Write a ${maxWords}-word summary of ${topic}")
}
```

A file containing holes is a template, not a program. Running it directly fails with `AG8001`. Instead you load it, fill it, and run the result:

```ts
import { loadTemplate, fill, toSource, runCode } from "std::agency"

node main(): string {
  const tpl = loadTemplate(__dirname, "summarize.agency")
  if (isFailure(tpl)) {
    return "no template"
  }
  const filled = fill(tpl.value, { topic: "Roman aqueducts", maxWords: 50 })
  if (isFailure(filled)) {
    return "fill failed"
  }
  return runCode(toSource(filled.value)) with approve
}
```

`holesOf(template)` tells you what still needs filling. Each entry carries the hole's name, its sort (what category of thing fills it), whether it is a splice, and its type when one is known — enough for a model to know what to supply:

```ts
holesOf(tpl.value)
// [{ name: "topic", sort: "expr", splice: false, type: "string" },
//  { name: "maxWords", sort: "expr", splice: false, type: "number" }]
```

## The rule everything rests on: fillers are never parsed

When you fill a hole with a plain value, that value becomes a literal in the generated program. It is **never** parsed as code. Suppose a model supplies something that looks like code:

```ts
const filled = fill(tpl.value, { topic: "readFile(\"/etc/passwd\")" })
```

The generated program gets the string literal `"readFile(\"/etc/passwd\")"` — those exact characters, as data. It does not get a function call. This is what makes it safe to pipe model output straight into `fill`.

The one exception is identifier holes (below), where the filler becomes a name — and is validated hard for exactly that reason.

## The four sorts of hole

A hole's sort comes from its position. You never write it.

**Expression holes** stand where a value goes. Their type comes from the position (`const x: string = #text` makes `#text` a string) or from an inline annotation (`#count: number`). A hole with neither is an error (`AG8002`), because nothing would constrain what fills it.

```ts
const greeting: string = #greeting
f(#count: number)
```

**Statement holes** are a bare `#name` on its own line. They accept statements, parsed by you with `parseStatements` or grafted from another template:

```ts
node main() {
  #setup
  return "done"
}
```

**Identifier holes** stand where a *name* goes — a function name, node name, or import specifier:

```ts
import { #tool } from "std::fs"

def #helperName(): number {
  return 1
}
```

The filler must be a plain string that is a legal identifier. Anything else is rejected: `fill(t, { tool: "x } import evil" })` fails, and so do reserved words like `if` and names starting with the reserved `__hyg` prefix.

**Declaration holes** are a bare `#name` at the top level of a file. They accept whole declarations — functions, nodes, types, imports.

## Splices

`#...name` expands to a sequence instead of a single item. Fill it with an array. The headline use is one import per tool a model selected:

```ts
#...imports

node main() {
  #...steps
}
```

```ts
const imports = fill(importTpl.value, { tool: name })  // one per chosen tool
const filled = fill(taskTpl.value, { imports: [imports.value], steps: steps })
```

## Quoted names

`#"field-name"` names a hole with characters that are not legal in identifiers — useful when hole names come from data like schema fields. The quotes are around the hole's *name* only; they change nothing about what may fill it.

## Filling with code: `Code` values

Sometimes a gap needs code, not data. A `Code` value holds a piece of Agency — a whole program (from `loadTemplate` or `parseAST`), a statement list (`parseStatements`), or a single expression (`parseExpr`) — and grafts into a hole as a tree:

```ts
const body = parseStatements("print(1)\nprint(2)")
const filled = fill(tpl.value, { setup: body.value })
```

The fragment kind is checked against the hole's sort: an expression fragment cannot fill a statement hole, and vice versa.

**Filling composes.** A partially filled template is an ordinary `Code` value, and grafting it into another template carries its remaining holes along. Build the shape first, parameterize last:

```ts
const guarded = fill(guardTpl.value, { body: body.value })   // #minutes still open
const program = fill(mainTpl.value, { helpers: guarded.value })
holesOf(program.value)   // [{ name: "minutes", ... }]
const done = fill(program.value, { minutes: 120000 })        // now complete
```

**The escape hatch is explicit.** `parseExpr` and `parseStatements` do parse their input — that is their job. Writing `fill(t, { v: parseExpr(modelOutput).value })` lets model-written code into the program, and a template author who writes that has chosen to. The generated program still runs in a subprocess under your `handle` blocks, so what it can *do* stays governed either way.

## Hygiene: names cannot collide by accident

Consider this template:

```ts
node main() {
  const tmp = getApiKey()
  const result = #userExpr
  print(result)
}
```

If a filler happens to mention `tmp`, plain substitution would silently hand it the API key. Instead, `fill` renames the colliding template binder to a fresh name with the reserved `__hyg` prefix, so the filler's `tmp` means whatever it meant where the filler was written. Renaming is selective — non-colliding names are left exactly as written — and scope-aware: a `tmp` in some other function is not touched. A filler that *declares* a name the template already declares gets its own binder renamed the same way. Because `__hyg` makes this scheme work, `fill` rejects any template or filler that already uses it.

One current limit: destructuring-pattern binders are not tracked for collisions. If a filler destructures into a name the template also uses, rename one of them yourself.

## What is checked, and when

Three checkpoints, from weakest to strongest:

1. **Template-check time.** A template is checkable on its own: `AG8002` catches unconstrained holes, and code after a hole that references a name only a filler could introduce fails ordinary name resolution — the checker cannot see into a hole, so a template cannot depend on what a filler declares.
2. **Fill time.** Sorts, fragment kinds, identifier validity, and primitive types are validated as each hole is filled — `fill(t, { count: "many" })` fails immediately when the hole expects a number. This is validation, not a full type check.
3. **Run time.** The completed program goes through the ordinary compile pipeline, in full, when you hand it to `runCode`. Anything the earlier checkpoints could not see is caught here.

And one refusal: a program that still has holes cannot compile or run (`AG8001` names every unfilled hole).
