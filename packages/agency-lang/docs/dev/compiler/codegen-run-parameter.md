# Generated code and the run parameter

Generated code receives the run as its first parameter, named `__run`, and passes it to every runtime function it calls. This doc covers what the code generator emits, where it emits it, and what to check when you add a new place that emits code.

Read [docs/dev/runtime/async-context.md](../runtime/async-context.md) first. It describes the `Run` type and the runtime functions named here.

## What a function compiles to

```
def greet(name: string, age: number): string {
  return interrupt("Agent wants to call greet")
}
```

```ts
async function __greet_impl(__run: __Run, name: string, age: number) {
  const __setupData = setupFunction(__run);
  const __ctx = __run.ctx;
  const runner = new Runner(__ctx, __stack, {
    state: __stack,
    moduleId: "greet.agency",
    scopeName: "greet",
    stack: __run.stack,
    threads: __setupData.threads,
  });
  try {
    await __withChildRun(__run, { ... }, "its body", async (__run) => {
      await runner.step(1, __run, async (runner, __run) => {
        const __response = __run.ctx.getInterruptResponse(__self.__interruptId_1);
        ...
        await interruptWithHandlers(__run, "unknown", message, {}, origin);
      });
    });
  } finally {
    __run.stack.pop();
  }
}
```

`tests/typescriptGenerator/interrupt-2-deep-in-function.mjs` is a checked-in fixture with this shape.

## The four rules

1. **Every generated function takes the run first.** That covers functions, nodes, blocks, handler functions, the init function, and finalize closures. A node gets its run from `GraphState.run`.
2. **Every body the runtime calls back declares a parameter named `__run`.** That covers steps, hooks, conditions, loop bodies, pipe stages, fork blocks, and handler functions. The inner name hides the outer one, so code inside a fork block cannot name the outer function's run.
3. **Every runner method that takes a body also takes the run it is called under.** `runner.step(id, __run, body)` checks that run, makes a child, and hands the child to the body.
4. **`__call` and `AgencyFunction.invoke` take the run first.** `__call(__run, target, descriptor)` decides when it runs whether `target` takes a run. See "Functions that do not take a run" in the runtime doc.

Rule 2 is checked by a test, `lib/backends/generatedRunParameter.test.ts`. It reads every generated fixture in `tests/typescriptGenerator/` and fails when a body is handed to a call alongside `__run` and does not declare `__run` itself. A new language feature adds a fixture, so a body that forgets the parameter fails there.

The check is a test and not a compiler pass, so compiling does not get slower. Here is what happens if a body without `__run` gets past it:

- **The body starts work**, such as a nested step or a call. It hands over the outer run, which is waiting, and the wrong-run check throws `RunInUseError`.
- **The body only reads**, such as `__run.globals` inside a fork block. It reads the outer function's globals and not the branch's, with no error. This is the case the test exists for.

## How generated code reads runtime values

Each value is a field of the run in scope.

| Value | What generated code emits | In the builder |
| --- | --- | --- |
| The run | `__run` | `ts.runtime.run` |
| The context | `__run.ctx` | `ts.runtime.ctx` |
| The thread store | `__run.threads` | `ts.runtime.threads` |
| The branch's state stack | `__run.stack` | `ts.runtime.stateStack` |
| The globals | `__run.globals` | `ts.runtime.globals` |
| The logger | `__run.log` | |

Because the name `__run` is redeclared by each body, the same emitted text reads the right run at every depth. Inside a fork block `__run.globals` is the branch's clone, and outside it is the function's.

A function body also declares `const __ctx = __run.ctx`. The `Runner` constructor and the checkpoint call use that local.

## The two runs generated code makes itself

Almost every child run is made by a runner method. Generated code makes two directly.

- **Around a function body.** `__withChildRun(__run, {...}, "its body", async (__run) => { ... })` gives the body a run with the function's own stack and threads. It is emitted from `ts.withAlsFrame` in `lib/ir/builders.ts`.
- **For the `async` keyword on a call.** `__detachedRun(__run, {...})` makes a run the caller does not wait for. Agency does not support this keyword. The parser still accepts it and three old tests use it, so the code path stays.

## File layout

| File | What it holds |
| --- | --- |
| [lib/runtime/asyncContext.ts](../../../lib/runtime/asyncContext.ts) | `Run`, `withChildRun`, `detachedRun`, `callPlain`, `currentRun` |
| [lib/runtime/index.ts](../../../lib/runtime/index.ts) | The exports generated code imports |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | The import line, which renames `withChildRun` to `__withChildRun` and so on |
| [lib/ir/builders.ts](../../../lib/ir/builders.ts) | `ts.runtime.*`, and the builders for the body wrap and the setup block |
| [lib/backends/typescriptBuilder.ts](../../../lib/backends/typescriptBuilder.ts) | The call sites that pass `ts.runtime.run` |
| `lib/templates/backends/typescriptGenerator/*.mustache` | Templates that name `__run` in text: `blockSetup`, `forkBlockSetup`, `interruptAssignment`, `interruptReturn`, `resultCheckpointSetup`, `functionCatchFailure`, `finalizeClosure`, `withHandlerWrapper`, and the files under `builtinFunctions/` |

The `.ts` files next to the templates are generated by `pnpm run templates`. Do not edit them by hand.

## Adding a place that emits code

1. If the new code calls a runtime function, pass `ts.runtime.run` as its first argument. The runtime function should take `run: Run` first.
2. If the new code hands the runtime a body to call back, give the body a `__run` parameter, and have the runtime function pass the body its run. Use `withChildRun` inside the runtime function when the body is something the caller waits for.
3. If the new code needs a value from the run, read it as a field of `__run`. Do not add a local for it in the setup block.
4. Run `pnpm run templates`, then `make`, then `make fixtures`. Commit the rebuilt fixtures in their own commit.
5. Recompile each package's entry file, because a package's compiled `index.js` calls the runtime with whatever argument order the compiler had when it was built. From inside each of `email`, `github`, `kokoro`, `lora`, `mcp`, `tesseract-local`, `web-fetch`, and `whisper-local`, run `node ../agency-lang/dist/scripts/agency.js compile index.agency`.

## Adding a field to `Run`

Make the field required when a missing value would be wrong and not only absent. The compiler then reports every place that builds a run without it. The four lineage values work this way.

Three places build a run from nothing: `runNode` in `lib/runtime/node.ts`, and `runInBootstrapFrame` and `runInTestContext` in `lib/runtime/asyncContext.ts`. Every other run is a copy of an outer one, and a copy keeps the field without any change.

## Things that go wrong

**"Expected a run as the first argument" from new generated code.** A call to a runtime function left the run out, so its next argument landed in the run's place. Generated code is compiled without a type check, which is why this is found when the code runs. Pass `ts.runtime.run` first.

**`RunInUseError` in a test or in new generated code.** A body used an outer run. Find the nearest body around the failing call and use the run it was handed.

**"No run is current here" from a stdlib helper.** The helper read `currentRun()` after an `await`, or called another helper after one. Take the run on the first line and pass it down. `pnpm run lint:structure` reports most of these before they run.

**`tsc` passes and a fixture comparison fails.** The fixtures are stale. Run `make fixtures`.

**A `Runner` built by hand in a test throws from `runner.thread(...)`.** Pass `threads:` to the constructor. The Runner takes its thread store from there.

## Related docs

- [docs/dev/runtime/async-context.md](../runtime/async-context.md): the `Run` type and the runtime side.
- [docs/dev/compiler/typescript-ir.md](./typescript-ir.md): the `TsNode` tree the builders produce.
- [docs/dev/runtime/threads.md](../runtime/threads.md): `ThreadStore` and `MessageThread`.
