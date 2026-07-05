
Use https://www.npmjs.com/package/code-block-writer for writing ts code instead?

config for max messages in thread - smoltalk

https://www.npmjs.com/package/replace-in-file

event log for replays?

things that aren't supported:
- modifying an imported value (eg `import { foo } from "file.agency"; foo = 5` doesn't work yet)

## Derive safe-ness
Currently only TypeScript functions can be marked safe. We should be able to derive whether an agency-defined function is safe by looking at whether it calls any unsafe functions, such as those imported from TypeScript and not marked safe, or certain built-in functions like write.

---

users should not be able to create a type named `Result`, that is a builtin type.

handle multiple interrupts in debugger

Need to add cron agent jobs that periodically check for out-of-date documentation and to check for files in the standard library that are missing from the docs-new config.

tool-retry test skipped - one test failing



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


If multiple tool calls in parallel, throw an interrupt, they mess up the display because they are all printing interleaved output to the terminal. I think I need a mutex system for something like this.

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

---

allow a match expression as an obj value?