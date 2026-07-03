- objects don't support `obj[key]` syntax yet, just `obj.key`

can't have nested match blocks, eg:

```agency

// Nested match blocks
userRole = "admin"
userStatus = "active"

match(userRole) {
  "admin" => {
    match(userStatus) {
      "active" => print("Active admin user")
      "inactive" => print("Inactive admin user")
    }
  }
  "user" => {
    match(userStatus) {
      "active" => print("Active regular user")
      "inactive" => print("Inactive regular user")
    }
  }
  _ => print("Unknown role")
}
```



## semicolons
should allow spaces before semicolons

```
        input: '  @model  =  "gpt-4"  ;  ',
```

## parens around types

Can't do this yet:

```

type ListIngredientsParams = {
  includePublicIngredients: boolean;
  attributes: (name | serving_size)[] | undefined
}
```

- match blocks don't support blocks

Use https://www.npmjs.com/package/code-block-writer for writing ts code instead?


lib/templates/backends/typescriptGenerator/promptFunction.mustache is bloated and complex. Needs help

## things you still can't write

```
users[0 + 1].name
users[obj.x].name
```

config for max messages in thread - smoltalk

https://www.npmjs.com/package/replace-in-file

thoroughly read the code in lib/typeChecker.ts
read code in lib/runtime

event log for replays?

in preprocessor, verify that system() calls are only happening inside threads.

things that aren't supported:
- modifying an imported value (eg `import { foo } from "file.agency"; foo = 5` doesn't work yet)
- first class functions (eg `obj.key = funcName`)

parallel agents
memory layer
ability to switch to other packages instead of smoltalk for LLM calls, other packages for memory layer.

## Derive safe-ness
Currently only TypeScript functions can be marked safe. We should be able to derive whether an agency-defined function is safe by looking at whether it calls any unsafe functions, such as those imported from TypeScript and not marked safe, or certain built-in functions like write.

  Remaining TODOs:
  1. Re-enable removeUnusedLlmCalls (disabled, old logic commented out)
  2. Re-enable collectSkillsInFunction (disabled, old logic commented out)

-----

write post
evals
probabilistic exec
better typechecker / better typing
llm func general interface


  - also capture tokens/cost in trace?

  cant seem to step after tabbing around

make llm() work with pipe operator
  - create a generic llm interface
  - allow for tool call etc hooks from llm lib

need to make method calls on objects work in the following places: with the try keyword, with the pipe operator, and as a tool.

---

users should not be able to create a type named `Result`, that is a builtin type.
type defined in a node doesn't work

handle multiple interrupts in debugger
better debugger test harness

`with approve` cant be used in a return statement?
`with reject` seems useless

tool-retry test failure:
```
Running JS test: tool-retry
Tool call "unsafeChainTool" crashed: Unknown named argument 'action' in call to 'unsafeChainTool'
Tool call "unsafeMethodTool" crashed: Unknown named argument 'action' in call to 'unsafeMethodTool'
```

import * from std::array into every file

nested fork blocks, inner block can't access the variables of the outer block (the arg vars at least)

Need to add cron agent jobs that periodically check for out-of-date documentation and to check for files in the standard library that are missing from the docs-new config.


`+=` doesn;t work with globals:

```
let foo = 0
def func(id: string) {
  foo += 1
}
```

tool-retry test skipped - one test failing


`race` example doesn't work:

```
node main() {
  const prompt = "Write me a 100 word story about a talking dog."
  const models = ["gpt-4o-mini", "gpt-3.5-turbo", "gemini-3.1-flash-lite-preview"]
  const story = race(models) as model {
    const _story = llm(prompt, { model: model })
    print(_story)
    return { model: model, story: _story }
  }

  printJSON(story)
}
```
---

tests/integration/stdlib-sandbox/credential/browser.test.json skipped, need to get a browseruse subscription to continue running this test.

---

1. it would be great if callbacks could access any local functions inside the function its in.
2. After that, we should create an onAbort callback that gets called when a function gets aborted, maybe because a guard fires, or some other reason. Then it'd be great if onAbort had some way to abort any TypeScript functions it had called as well, which means that users would need some way to pass an abort signal into those functions. I think they could just create an abort signal object in agency and pass it through. Then when the agency function gets aborted, onAbort aborts the js calls as well. That is why you need those callbacks to be able to access local variables.

---

memory layer should use agency.llm, also add a new fun agency.embed that it can use for embeddings?

---

DOesn't work:

```
const indent = " ".repeat(amount)
```

^ intentional, document.

----

Figure out how you want to set up the agency handler so that if user chooses "always approve", you write that to the policy file. Right now, a write wouldn't be allowed inside the handler, as the write function can throw an interrupt.
Two options:
- create specific functions to read and write to the policy file that don't throw interrupts, or
- create a new std::unsafe module in the agency standard library that exposes a function that takes a block, and automatically typecheck-ignores all the interrupts inside that block. Then that could be used with the handler somehow

----

allow comments inside arrays and objects too

undefined var typecheck not triggering (`handoff` func in research agent not imported)

---

If multiple tool calls in parallel, throw an interrupt, they mess up the display because they are all printing interleaved output to the terminal. I think I need a mutex system for something like this.

---

sort imports alphabetically and group them by agency imports, std imports, and other imports.

---

clean up imports in lib/templates/backends/typescriptGenerator/imports.mustache, agency scripts shouldn't be able to access built-in node modules like path/os without explicitly importing them.

---

type checker can't handle pattern match + boolean operators:

```
// result pattern binder in pure-boolean `is` context has nowhere to bind;
// use `if (x is success(...))` to introduce variablesagency
if (a is success(aVal) && b is success(bVal)) {
  print(aVal, bVal)
}
```

---

optimizer: should `workdir` be a symlink? Right now, I can't exec a command against a local file while using the optimizer, as the workdir doesn't contain anything, so while running the optimizer, that file isn't found.

---

Along with the Result type, agency has Success and Failure types, but they are hilariously broken. For example, this code doesn't throw a type error:

```ts
import { search } from "std::wikipedia"

def half(x: number): Result {
  if (x % 2 != 0) {
    return failure("Number must be even to be halved, got ${x}")
  }
  return success(x / 2)
}

node main() {
  const foo: Success = half(5)
}
```

because these two types are just aliases for Result:

```ts
// Same as Result<any, any>
const ok: Success = success(1)

// Same as Result<number, any>
const ok: Success<number> = success(1)

// Same as Result<any, any>
const bad: Failure = failure("oops")
```

- `Success<T>` is sugar for `Result<T, any>`
- `Failure<E>` is sugar for `Result<any, E>`
- Bare `Success` and `Failure` are both sugar for `Result<any, any>`

In fact, the agency generator will actually convert the Success type to a Result type.
