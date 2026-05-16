# Adding a new module to the agency standard library

Adding a new module to the agency standard library follows a general pattern.
1. All new agency standard library modules go into the stdlib/ directory and require an agency file. A typescript file may also be necessary for much of the backing functionality, which would otherwise be harder to write in Agency. 
2. For functions that require multiple optional options with defaults, please use Agency's default args when writing these function definitions. Agency supports named parameters, so it's easy for users to override only the options that they want. 
3. Please include doc comments explaining usage where it makes sense. There are two ways to document your functions: one is with docstrings, and the other is with doc comments. Docstrings also get sent to the LLM as part of the tool description if an LLM calls this function as a tool. Doc comments, on the other hand, are just documentation for users. If you think it would be helpful, add usage examples in doc comment for the functions you add. You can also add an overall doc comment section to the top of the file that documents the overall file. This is a good place to explain generally what this module is useful for, including basic usage, examples to get the user started, and gotchas to be aware of, if there are any.
4. Be aware that in agency, all functions are also tools that can be used by an LLM. There are a couple of pieces of functionality that agency has to make tool calls safer. One is the `safe` keyword. If a function can be called multiple times without any side effects, you can go ahead and mark it `safe`. This tells the LLM that this tool is safe to rerun if it gets an intermittent error.
5. The other concept is interrupts. Interrupts are a way to ensure that before a tool is executed, you get confirmation from a user that it's okay to execute that tool. You can read more about interrupts here: https://agency-lang.com/guide/interrupts.html. You should throw an interrupt before any functionality that is either destructive or exposes sensitive data. Check out the calendar and OAuth standard library files to see examples of how and where interrupts are thrown. When you throw an interrupt, you specify a type, a message, and, optionally additional data. Make sure that if you do set additional data, it doesn't include any sensitive information. For example, if a user wanted to access a password, it would be a bad idea to include the password itself in the data for the interrupt.
6. We automatically generate documentation for any code in the agency standard library. To generate the documentation, run the `make` or `make doc` commands. If you are adding a new file to the agency standard library, you will need to make sure its documentation is linked in docs-new/.vitepress/config.mts as well. All the agency stdlib modules are documented here, listed in alphabetical order.

## Accessing runtime state from a TS binding

If a stdlib TS helper needs to read or mutate per-run state (memory manager, statelog client, abort controller, etc.) it MUST take the `RuntimeContext` as its first argument. Do not reach for a module-level singleton — multiple `runNode` calls can share a Node.js process and would race on it.

The runtime context is threaded into the call site by codegen via the **context-injected builtins** mechanism. Add an entry to the registry in `lib/codegenBuiltins/contextInjected.ts`, export the TS implementation under the same `__internal_*` name, and the agency-side wrapper can call it as if `__ctx` weren't a parameter:

```ts
// lib/stdlib/foo.ts
import type { RuntimeContext } from "../runtime/state/context.js";

export async function __internal_doThing(
  ctx: RuntimeContext<any>,
  arg: string,
): Promise<void> {
  if (!ctx?.someResource) return; // tolerate missing config
  await ctx.someResource.handle(arg);
}
```

```ts
// lib/codegenBuiltins/contextInjected.ts (add to the registry)
__internal_doThing: {
  name: "__internal_doThing",
  params: [string],
  returnType: voidT,
},
```

```agency
// stdlib/foo.agency — no `import` needed; __internal_* are builtins
export def doThing(arg: string) {
  __internal_doThing(arg)
}
```

The TypeScript builder rewrites every call to `__internal_doThing(arg)` as `await __internal_doThing(__ctx, arg)`, so user code never holds a reference to the runtime context. Type the TS parameter as `RuntimeContext<any>` so the implementation retains access to internal fields the agency type system intentionally hides.

Names beginning with `__internal_` are reserved for this mechanism. The typechecker rejects any reference to a `__internal_*` identifier outside the callee position of a function call (e.g. `let f = __internal_doThing` is an error), and any `__internal_*` name not in the registry is reported as an unknown internal builtin.