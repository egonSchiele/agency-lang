# Adding a new module to the agency standard library

Adding a new module to the agency standard library follows a general pattern.
1. All new agency standard library modules go into the stdlib/ directory and require an agency file. A typescript file may also be necessary for much of the backing functionality, which would otherwise be harder to write in Agency. 
2. For functions that require multiple optional options with defaults, please use Agency's default args when writing these function definitions. Agency supports named parameters, so it's easy for users to override only the options that they want. 
3. Please include doc comments explaining usage where it makes sense. There are two ways to document your functions: one is with docstrings, and the other is with doc comments. Docstrings also get sent to the LLM as part of the tool description if an LLM calls this function as a tool. Doc comments, on the other hand, are just documentation for users. If you think it would be helpful, add usage examples in doc comment for the functions you add. You can also add an overall doc comment section to the top of the file that documents the overall file. This is a good place to explain generally what this module is useful for, including basic usage, examples to get the user started, and gotchas to be aware of, if there are any.
4. Be aware that in agency, all functions are also tools that can be used by an LLM. There are a couple of pieces of functionality that agency has to make tool calls safer. One is the `safe` keyword. If a function can be called multiple times without any side effects, you can go ahead and mark it `safe`. This tells the LLM that this tool is safe to rerun if it gets an intermittent error.
5. The other concept is interrupts. Interrupts are a way to ensure that before a tool is executed, you get confirmation from a user that it's okay to execute that tool. You can read more about interrupts here: https://agency-lang.com/guide/interrupts.html. You should throw an interrupt before any functionality that is either destructive or exposes sensitive data. Check out the calendar and OAuth standard library files to see examples of how and where interrupts are thrown. When you throw an interrupt, you specify a type, a message, and, optionally additional data. Make sure that if you do set additional data, it doesn't include any sensitive information. For example, if a user wanted to access a password, it would be a bad idea to include the password itself in the data for the interrupt.
6. We automatically generate documentation for any code in the agency standard library. To generate the documentation, run the `make` or `make doc` commands. If you are adding a new file to the agency standard library, you will need to make sure its documentation is linked in docs-new/.vitepress/config.mts as well. All the agency stdlib modules are documented here, listed in alphabetical order.

## Accessing runtime state from a TS binding

If a stdlib TS helper needs to read or mutate per-run state (memory manager, statelog client, abort controller, etc.) it MUST read the `RuntimeContext` from the active `AsyncLocalStorage` frame. Do not reach for a module-level singleton — multiple `runNode` calls can share a Node.js process and would race on it.

The runtime context is exposed via `getRuntimeContext()`, which returns the `{ctx, stack, threads}` triple of the currently-running Agency scope. Frames are installed by the runtime at three points: `runNode` (top of each agent run), `Runner.runInScope` (every step/hook/pipe), and `runBatch`'s branch wrapper (each fork/race branch). Stdlib helpers don't need to know which frame they're in — `getRuntimeContext()` always returns the innermost one.

```ts
// lib/stdlib/foo.ts
import { getRuntimeContext } from "../runtime/asyncContext.js";

export async function _doThing(arg: string): Promise<void> {
  const { ctx, stack } = getRuntimeContext();
  const signal = ctx.getAbortSignal(stack);
  await ctx.someResource.handle(arg, { signal });
}
```

```agency
// stdlib/foo.agency
import { _doThing } from "agency-lang/stdlib-lib/foo.js"

export def doThing(arg: string) {
  _doThing(arg)
}
```

That's it — `_doThing` is an ordinary imported function from the codegen's perspective. The convention is to prefix the JS export with a single underscore (`_doThing`) so it's clearly a stdlib JS helper that's only meant to be called from a corresponding `.agency` wrapper. The single-underscore name is just a convention; the codegen treats it like any other imported function.

If you call `_doThing` directly from another stdlib TS file (e.g. one stdlib helper delegates to another), it works automatically — the ALS frame established by the outermost Agency call is inherited through every `await`.

For tests that call `_doThing` from non-Agency code (e.g. vitest), wrap the call in `runInTestContext`:

```ts
import { runInTestContext } from "agency-lang/runtime/asyncContext.js";
import { RuntimeContext } from "agency-lang/runtime/state/context.js";
import { StateStack } from "agency-lang/runtime/state/stateStack.js";
import { ThreadStore } from "agency-lang/runtime/state/threadStore.js";

it("works", async () => {
  const ctx = new RuntimeContext({ /* ... */ });
  await runInTestContext(ctx, new StateStack(), new ThreadStore(), () =>
    _doThing("hello"),
  );
});
```
