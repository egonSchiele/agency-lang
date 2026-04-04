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


## chained property access doesn't work

foo.bar.baz()

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

---

agency tests for builtin functions

should llm calls be allowed at the top level (not inside a node)? -- if so, what message thread are they put on? And what state stack ... because there isn't a global one

## things you still can't write

```
users[0 + 1].name
users[obj.x].name
```

add the ability to export and import types from other files so I can use the type from another file as the response type for an llm call

config for max messages in thread - smoltalk

https://www.npmjs.com/package/replace-in-file

request timeout - smoltalk - support abortsignal?

save agency agent generated code to file?

thoroughly read the code in lib/typeChecker.ts
read code in lib/runtime

event log for replays?

- do message threads get restored after interrupts?
- should tool calls have message threads passed in to them?
- users passing initial messages to node calls from ts
- is thread id retained after an interrupt?


onNodeEnd and onFunctionEnd hooks don't fire if the user returns early from the function or node

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
  3. Regenerate fixtures and run full test suite (make fixtures && pnpm test:run)
  4. The streaming.agency test fixture was reverted to the old stream llm(...) syntax — needs updating since that parser was removed
  5. skill() and mcp() functions (future, not part of this PR)


  Use zod schemas in statestack fromjson func.

  Currently, multi-line comments seem to strip all leading whitespace from every line, which means there is no way to put a code snippet inside the comment without the formatting getting all messed up. The same thing seems to be true for multi-line strings, weirdly enough.

  Update the override functionality in rewinds and interrupts to support overriding not only the values of local variables, but also the values of global variables, and arguments to functions.

-----

expand stdlib
propagate and die keywords for handlers
interrupt tests (assign interrupt reject)
write docs
write post
evals
probabilistic exec
variadic args
better typechecker / better typing
llm func general interface
llm statement doesn't work correctly in debugger
  - rewind seems to break too
  - what about other interrupts?

  make selected pane bigger?
  print tokens/cost in debugger?
  - also capture in trace?

  cant seem to step after tabbing around