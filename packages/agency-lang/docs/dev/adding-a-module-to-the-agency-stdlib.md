# Adding a new module to the agency standard library

Adding a new module to the agency standard library follows a general pattern.
1. All new agency standard library modules go into the stdlib/ directory and require an agency file. A typescript file may also be necessary for some of the backing functionality, but is not required.
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

## More on writing docs

### How to write a good docstring

1. remove any implementation-specific details, such as "done as part of plan X" or "was broken but works now". The doc string will be sent as the tool description to an LLM, so think about what information about this tool the LLM will care about.

2. Remove any information that is not specific to this tool. For example, "Branch-scoped: a fork/race/parallel branch can change it without affecting the parent." This is true of every tool, not specific to this tool, so we shouldn't include it in the tool description

3. Use active voice instead of passive voice, and say what the tool does, not what the tool is.

Bad:
```
A tool for printing an object as formatted JSON to the console.
```

Good:
```
Print an object as formatted JSON to the console.
```

Bad:
```
A tool for prompting the user for input and returning their response.
```

Good:
```
Prompt the user for input and return their response.
```

4. Make sure all the parameters are documented in the format expected by PFA: https://agency-lang.com/guide/partial-application.html.

Bad:
```
export safe def input(prompt: string): string {
  """
  Prompt the user for input by printing the `prompt` string
  """
}
```

Good:
```
export safe def input(prompt: string): string {
  """
  Prompt the user for input.

  @param prompt - The string to print for the prompt
  """
}
```

5. Try to avoid mentioning the parameters Outside the PFA format if possible Because if the user uses PFA, the parameters Mentioned in the PFA format will get stripped out, but other parameters in the description won't, which could be confusing for the LLM.

Bad:
```
export safe def read(
  filename: string,
  dir: string = ".",
  offset: number = 0,
  limit: number = 0,
  useAgentCwd: boolean = false,
): Result {
  """
  A tool for reading the contents of a file and returning it as a string. The filename is resolved relative to dir.

  By default the full file is returned. Pass `offset` (1-indexed) and/or
  `limit` to paginate a large file — when either is set, a truncation
  note is appended naming the line range and total line count. `0` for
  either argument means "unset" (Agency does not have undefined
  arguments).
```

Good:
```
export safe def read(
  filename: string,
  dir: string = ".",
  offset: number = 0,
  limit: number = 0,
  useAgentCwd: boolean = false,
): Result {
  """
  A tool for reading the contents of a file and returning it as a string. The filename is resolved relative to dir.

  @param filename - The file to read
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param offset - 1-indexed line to start at (0 means start of file)
  @param limit - Maximum number of lines to return (0 means read to end of file)
```

6. If a parameter should be an enum, set an enum as its type instead of putting enum information in the doc string.

Bad:
```
export def write(
  filename: string,
  dir: string = ".",
  mode: string = "overwrite",
): Result {
  """
  Write data to a file

  @param filename - The file to write
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param mode - How to handle an existing file: "overwrite" | "append" | "create-only"

```

Good:
```
export type WriteMode = "overwrite" | "append" | "create-only"

export def write(
  filename: string,
  dir: string = ".",
  mode: WriteMode = "overwrite",
): Result {
  """
  Write data to a file

  @param filename - The file to write
  @param dir - The directory to resolve the filename against (defaults to ".")
  @param mode - How to handle an existing file
```

7. Don't mention other functions in the doc string as the agent may not have access to them.

8. Remove unnecessary words. Keep the docstring readable and easy to understand, but concise.

Bad:
```
export def filter(arr: any[], func: (any) -> any): any[] {
  """
  Return a new array containing only the elements for which the function returns true.

  @param arr - The array to filter
  @param func - The function that returns true for elements to keep
  """
```

Good:
```
export def filter(arr: any[], func: (any) -> any): any[] {
  """
  Return a new array containing only the elements for which the function returns true.

  @param arr - The array to filter
  @param func - The filter function
  """
```

Remember that all the parameter names and types in the function name will get sent to the LLM as well, so try to make those descriptive enough that the LLM can understand what the function does without needing too much text in the docstring. Any text you add takes up space in the context and we don't want to bloat the context unnecessarily.

9. Try to narrow your types where possible. Don't use `any` where a more specific type will do. Don't use `string` where you actually need a union of strings.

### Move information to the doc comment.
If there are any details that would be good for a *developer* using Agency to know, as opposed to information that the *tool* needs to know, please put that information in doc comments instead.

Also read the [general writing tips](./general-writing-tips.md) and [anti-patterns](./anti-patterns.md) guides for more information on writing good documentation and code.