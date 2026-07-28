---
name: Template Agency
description: A guide to using the Template Agency to generate code.
---

# Template Agency

## Demo

```ts
import { fill, toSource, runCode } from "std::agency"

static const template = [|
  node main(): string {
    const topic: string = #topic
    return llm("Write a 100 word essay on the topic ${topic}.")
  }
|]

node main() {
  const filled = fill(template, {
    topic: "Indian musical instruments"
  })
  if (isFailure(filled)) {
    print("fill failed: ${filled.error}")
  } else {
    const res = runCode(toSource(filled.value)) with approve
    printJSON(res)
  }
}
```

Template Agency is a way to generate code. It's sort of like using mustache templates to generate code, except everything gets statically typechecked, and composes really well.

Here are the main components.

## Templates

### .agency files

You can think of the template like a mustache template – it's some pre-written code you want to execute. The template can be a file you read, or some inline code. If it's an agency file, you can load it using `loadTemplate`:

```ts
import { loadTemplate } from "std::agency"

node main() {
  const tpl = loadTemplate(__dirname, "summarize.agency")
  match(tpl) {
    success(template) => print("loaded template")
    failure(e) => print("failed to load template: ${e}")
  }
}
```

### Inline code literals

If it is inline code, you can use a code literal:

```ts
static const template = [|
  node main(): string {
    const topic: string = #topic
    return llm("Write a 100 word essay on the topic ${topic}.")
  }
|]
```

Notice that it's not a string. It's a code literal, which uses the `[|` and `|]` delimiters. The code inside is parsed at compile time, so if you make a syntax error or type error, you'll see it in real time.

In both cases, the template is of type `Code`.

Some other things to know about inline code literals:

- You can't use `${...}` to interpolate values from the host program into the template. The only way to get values into a template is through holes (see below).
- Literals don't nest.
- `agency fmt` will format the code in your code literal too, which I think is pretty neat.

## Running a template

1. Use `toSource` to convert the `Code` value into a string of Agency code.
2. Use `runCode` to run the code in a subprocess.

Example:

```ts
const res = runCode(toSource(template)) with approve
```

## Holes

Templates can have holes, which is where you can insert code. Holes are prefixed with `#` (like `#topic` in the example above).

Lets fill a hole with a value. We will fill the `template` var above. It has one hole, `#topic`, which is a string:

```ts
node main() {
  const filled = fill(template, {
    topic: "Indian musical instruments"
  })
}
```

`filled` is a `Result<Code>`. If the fill fails, it will be a failure with an error message. If it succeeds, it will be a success with the filled code.

### Hole types
In the example above, `topic` wanted a `string`, and so we supplied a `string`. What if we had supplied a `number` instead? In that case, `filled` would be a failure, with an error like this:

```
The hole `#topic` expects `string`, but the fill supplies `number`.
```

This is a runtime failure.

One more example. This time the hole is an object:

```ts
import { fill, toSource, runCode, holesOf } from "std::agency"

static const template = [|
  // The hole is a Person type
  type Person = {
    name: string;
    age: number
  }

  node main(): string {
    const person: Person = #person
    return llm(
      "Write a 10 word story featuring a person named ${person.name} of age ${person.age}.",
    )
  }
|]

node main() {
  const filled = fill(template, {
    // We supply a person object to fill the hole
    person: {
      name: "Alice",
      age: 30
    }
  })
  if (isFailure(filled)) {
    print("fill failed: ${filled.error}")
  } else {
    const res = runCode(toSource(filled.value)) with approve
    printJSON(res)
  }
}
```

### holesOf

`holesOf(template)` tells you what still needs filling. For each hole, it tells you the hole's name and type amongst other things:

```json
[
  {
    "name": "topic",
    "sort": "expr",
    "splice": false,
    "type": "string",
    "origin": null
  }
]
```

## Fillers are never parsed

When you fill a hole with a plain value, that value becomes a literal in the generated program. It is **never** parsed as code. Suppose a model supplies something that looks like code:

```ts
const filled = fill(tpl.value, { topic: "readFile(\"/etc/passwd\")" })
```

The generated program gets the string literal `"readFile(\"/etc/passwd\")"` — those exact characters, as data. It does not get a function call.

The one exception is identifier holes (below), where the filler becomes a name — and is validated hard for exactly that reason.

## The four sorts of holes

### Expression holes

A hole where a value goes:

```ts
const greeting: string = #greeting
```

### Statement holes

A statement hole is a bare `#name` on its own line:

```ts
node main() {
  #setup
  return "done"
}
```

### Identifier holes

A hole that stands where a *name* goes — a function name, node name, or import specifier:

```ts
import { #tool } from "std::fs"

def #helperName(): number {
  return 1
}
```

The filler must be a plain string that is a legal identifier. Anything else is rejected (example: `fill(t, { tool: "x } import evil" })` fails).

### Declaration holes

A declaration hole is a bare `#name` at the top level of a file. They accept more than a statement — you can give whole declarations like functions, nodes, types, and imports.

## Composing templates

Here's a template for a main node where the body is empty:

```ts
static const mainNode = [|
  node main(): string {
  #mainBody
  }
|]
```

Here's a template for making an LLM call and printing the result:

```ts
static const llmCall = [|
  const res = llm(#prompt)
  print(res)
|]
```

First we fill the `#prompt` hole in the `llmCall` template:

```ts
const llmBody = fill(llmCall, {
  prompt: "Say hi."
})
```

Then we fill the `#mainBody` hole in the `mainNode` template with the filled `llmCall`:

```ts
const filled = fill(mainNode, {
  mainBody: llmBody catch [| print("oops") |]
})
```

Then we can run the filled code:

```ts
match(filled) {
  success(finalCode) => {
    const source = toSource(finalCode)
    print(source)
    const result = runCode(source) with approve
  }
  failure(f) => print("fill failed: ${f}")
}
```

This prints the code before running it:

```ts
node main(): string {
  const res = llm("Say hi.")
  print(res)
}
```

Pretty cool!

### The origin field

In this example, we filled in the `#prompt` for the llm call before putting it in the main node. But we didn't need to do that. We could have just put the LLM call into the main node straight away, and then there would be a new hole in the main body: `#prompt`.

```ts
const filled = fill(mainNode, {
  // whoa I didn't fill the hole in the llmCall template, but I can still use it
  mainBody: llmCall
})
```

Then we can use `holesOf` to see what holes are still open:

```ts
printJSON(holesOf(filled.value))
```

Prints:

```json
[
  {
    "name": "prompt",
    "sort": "expr",
    "splice": false,
    "type": null,
    "origin": "mainBody"
  }
]
```

The `#mainBody` hole is filled, but the `#prompt` hole is still open, and `origin` tells us that it came from the `mainBody` hole. 

The `origin` field says which fill the still-open hole most recently arrived through — here, `#minutes` rode in when `#helpers` was filled. (In a deeper composition each re-graft re-stamps, so the outermost graft is the one reported.) Errors from a later fill say the same thing: filling `minutes` with a string fails with ``expects `number` … (in code grafted by the fill for `#helpers`)``, so a model juggling several templates knows which one the complaint is about.

## parseStatements

If you need to convert a string into a statement fragment, use `parseStatements`. It returns a `Result<Code>`:

```ts
const body = parseStatements("print(1)\nprint(2)")
const filled = fill(tpl.value, { setup: body.value })
```

## combine

You can combine multiple `Code` values into one using `combine`:

```ts
import { combine } from "std::agency"
const combined = combine([code1, code2, code3])
```

## Hygiene: names cannot collide by accident

*This section is a work in progress*.

Consider this template:

```ts
node main() {
  const tmp = getApiKey()
  const result = #userExpr
  print(result)
}
```

If a filler happens to mention `tmp`, plain substitution would silently hand it the API key. Instead, `fill` renames the colliding template binder to a fresh name with the reserved `__hyg` prefix, so the filler's `tmp` means whatever it meant where the filler was written. Renaming is selective — non-colliding names are left exactly as written — and scope-aware: a `tmp` in some other function is not touched. A filler that *declares* a name the template already declares gets its own binder renamed the same way. Renamed names use the reserved `__hyg<n>_` prefix, and each fill picks fresh names above any `__hyg` index already present — so filling the output of a previous fill (the composition workflow) never collides with its renames.

Destructuring binders are tracked like any other name: `const { key } = …`, array and rest patterns, and for-loop and comprehension binders all participate in collision detection. One wrinkle worth knowing: renaming a shorthand `{ key }` in place would change which property is *read*, so a renamed shorthand expands to `{ key: __hyg1_key }` — same read, fresh binder.

Two binder forms are not yet tracked for collisions: names bound by result patterns (`if (r is success(v)) { … }` binds `v`) and names bound inside match arms. If a filler or template uses one of those names on the other side, rename it yourself.

## Asking a module what it exports

You can use `describe` to find out what is exported from some code. Suppose I pass in this code as a string:

```ts
export node main(): string {
  const res = llm("Say hi")
  print(res)
}
```

`describe` returns a `Result<ModuleInfo>`:

```ts
{
  "description": null,
  "exports": [
    {
      "name": "main",
      "kind": "node",
      "signature": "main(): string",
      "docstring": null,
      "effects": [],
      "destructive": false,
      "idempotent": false,
      "reexportedFrom": null
    }
  ]
}
```
