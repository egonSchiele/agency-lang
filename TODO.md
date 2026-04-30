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

parallel tool calls
handle multiple interrupts in debugger
better debugger test harness
make race work with interrupts
async keyword and interrupts?
`with reject` cant be used in a return statement?