# The run: how runtime state reaches the code that needs it

> **User docs.** If you are writing a TypeScript helper, read
> [docs/site/guide/ts-helpers.md](../../site/guide/ts-helpers.md). This
> page is for people who change the runtime or the code generator.

A running Agency program has state that most runtime functions need: the context, the branch's state stack, its message threads, its globals. That state travels in one value, a `Run`, which is passed as an ordinary argument.

```ts
async function __greet_impl(__run: Run, name: string) {
  await runner.step(1, __run, async (runner, __run) => {
    await interruptWithHandlers(__run, "std::env", message, {}, origin);
  });
}
```

The runtime used to find this state through Node's `AsyncLocalStorage`. It does not any more, and nothing in `lib/` imports `node:async_hooks`. [running-without-node.md](./running-without-node.md) says why.

The code is in [lib/runtime/asyncContext.ts](../../../lib/runtime/asyncContext.ts). The file keeps its old name.

## What a run holds

```ts
export type Run = {
  ctx: RuntimeContext<any>;
  stack: StateStack;
  threads: ThreadStore;
  globals: GlobalStore;
  toolInvocationStack?: StateStack;
  callsite?: CallsiteLocation;
  runner?: Runner;
  decisions?: DecisionScope;
  callDepth: CallFrame | null;
  handlerChainDepth: number;
  executingHandlers: HandlerEntry[];
  activeCallbacks: object[];
  log: StatelogClient;
  state: RunState;
};
```

`globals` normally points at the same `GlobalStore` as `ctx.globals`. It is a separate field so a fork branch can hold a clone and write to it without disturbing the parent.

`callsite` is `{moduleId, scopeName, stepPath}` for the step that is executing. `Runner.runInScope` sets it, and `checkpoint()` reads it. A root run has none.

`runner` is the `Runner` driving the current step. `agency.interrupt` reads it to call `runner.halt(...)`.

`log` is the logger for the run's branch. See [Logging](#logging).

`state` belongs to the wrong-run check. See [The wrong-run check](#the-wrong-run-check).

### The four lineage values

| Field | What it holds | Who adds to it |
| --- | --- | --- |
| `callDepth` | The chain of calls that led here | `withCallDepth` in `lib/runtime/callDepth.ts` |
| `handlerChainDepth` | How many handler chains are running one inside another | `runHandlerChain` in `lib/runtime/interrupts.ts` |
| `executingHandlers` | The handler entries whose functions are running | `runAsHandler` in `lib/runtime/executingHandlers.ts` |
| `activeCallbacks` | The callbacks that are running | `fireWithGuard` in `lib/runtime/hooks.ts` |

These four fields are required, so a run built without them does not compile. That matters because several places build a run by naming the fields they want. If one of them dropped these values, `maxCallDepth` and the handler recursion limit would stop working, and an interrupt would go back to the handler that raised it. None of those would fail at the place where the value was lost.

`lineageOf(outer)` returns the outer run's four values, or empty ones when there is no outer run. Every place that builds a run from nothing spreads it in.

## Where runs come from

A child run is the outer run with some fields replaced:

```ts
withChildRun(run, { stack: branch.stack }, "its fork", (branchRun) => body(branchRun));
```

`withChildRun` makes the child, counts the parent as waiting until the body has finished, and calls the body with the child. Every step, call, handler function, callback, and fork branch gets its run this way.

`detachedRun(run, overrides)` makes the same kind of copy for work the caller does not wait for.

Three places build a run from nothing:

1. **`runNode`** in [lib/runtime/node.ts](../../../lib/runtime/node.ts), for a fresh agent run.
2. **`runInBootstrapFrame(ctx, fn)`**, for code that runs outside any node. See the next section.
3. **`runInTestContext(ctx, stack, threads, fn)`**, for a test.

A root run takes its lineage from `currentRunOrNone()`. So a run started from inside another run keeps counting the outer run's call depth, as long as it is started before an `await`.

## Bootstrap runs

Some code runs outside any node: module-level global initialisation, top-level callback registration, the `onAgentStart` callback, and the first part of a resume or rewind. `runInBootstrapFrame` gives that code a run whose `threads` is a `BootstrapThreadStore`.

Every user-facing method on a `BootstrapThreadStore` throws. Message threads do not work in bootstrap scope. Code that uses one at module top level gets an error there. Without the sentinel it would write into a placeholder that the runtime is about to discard.

`runInBootstrapFrame` is declared `async` on purpose. A synchronous throw inside `fn` then reaches `.catch(...)` callers as a rejected promise.

`onAgentEnd` is different. It fires after the run has finished, under a run with the real `ThreadStore`, so a callback can read the final conversation.

## Functions that do not take a run

Three kinds of function keep their own signature:

- a hand-written helper imported into Agency code,
- a callback passed from TypeScript,
- a handler registered with `agency.withHandler`.

The compiler cannot tell which imported functions want a run, so it does not try. The runtime calls every such function through `callPlain`:

```ts
export function callPlain(run, fn, args, thisArg?) {
  const previous = plainCallRun;
  plainCallRun = run;
  try {
    return fn.apply(thisArg, args);
  } finally {
    plainCallRun = previous;
  }
}
```

`plainCallRun` is one module variable. JavaScript runs one thing at a time, and a promise continuation never runs inside another call's synchronous part. So from the start of the call to the function's first `await`, the variable holds the run of that call.

`currentRun()` reads it:

```ts
export async function _fetch(url: string) {
  const run = currentRun(); // first line, before any await
  const response = await runHttp(run, url);
  ...
}
```

Three rules follow.

1. **Read the run on the first line and keep it.** After the first `await`, `currentRun()` throws. The error names both possible causes, because the function cannot tell them apart: the run was read after an `await`, or the code was not called by Agency at all.
2. **Pass the run to every runtime function you call.** They all take one.
3. **A helper that awaits and then calls a second helper uses `callPlain(run, second, args)`.** A bare call would leave the second helper with no run to read. User code does the same thing with `run.call(second, ...args)` on the handle from `agency.current()`.

The restore in `callPlain` is in a `finally`. If a throw skipped it, the next helper to run would read another request's run, with that request's globals, thread, and handlers. `lib/runtime/asyncContext.test.ts` has a test for it.

### How the runtime knows which kind it has

`__call(run, target, descriptor)` looks at the value it was handed. An `AgencyFunction` gets the run as an argument. Anything else goes through `callPlain`.

An `AgencyFunction` whose body was written by hand is the exception. Generated code passes `takesRun: true` to `AgencyFunction.create`. The functions built by hand, in `functionRefReviver.ts` and `lib/stdlib/agency.ts`, leave it off, and `invoke` calls them through `callPlain`.

A handler entry records the same flag. `Runner.handle` registers generated handler functions, which take the run. A handler given to `agency.withHandler` keeps the shape `(interrupt) => verdict`.

### The lenient read

`currentRunOrNone()` returns the same variable and does not throw:

```ts
function wallClockNow(): number {
  return (currentRunOrNone()?.ctx.clock ?? realClock).wallTime();
}
```

After a function's first `await` it returns `undefined`, which is also what it returns outside any run. The caller cannot tell those apart. So use it only where a missing run has a harmless answer, such as a default or a skipped log line. Anything that keeps a limit, charges a guard, or asks a handler must use `currentRun()` or take a run.

These read it today:

| Reader | What a missing run means |
| --- | --- |
| `agency.ctxMaybe()`, `agency.callsite()`, `agency.thread.storeMaybe()` | They return `undefined` |
| `warnDroppedData` in `result.ts` | The log line is skipped. The console line is still written |
| The function-ref reviver's miss | The log line at revive time is skipped. The stub still reports when it is called |
| `wallClockNow` in `stdlib/date.ts` | The real clock is used |
| `resolveLlmRoute` in `stdlib/llm.ts` | No model defaults from the run |
| The `stdlib/statelog.ts` helpers | Nothing is logged |
| `_attachToReply`, `_endTurn`, `_handBack`, `_insideToolCall` in `stdlib/thread.ts` | The attachment or mark is dropped |
| `_registerLocalProvider` in `stdlib/localModels.ts` | Its log line is skipped |
| `getUiState` in `stdlib/ui.ts` | A fallback state is used. Only unit tests reach it |
| The three root runs | A new lineage starts |

## The lint check

`scripts/lint-run-reads.mjs` runs as part of `pnpm run lint:structure`. It fails when code in `lib/` can read the current run after an `await`.

```ts
export async function _saveAll(paths: string[]) {
  await prepare();
  await _save(paths[0]); // reported: _save reads the run on entry
}
```

It follows calls. A function "reads on entry" when it reads the run, or calls a function that reads on entry, before its own first `await`. The check reports four things:

1. A read of the run after an `await`.
2. A call, after an `await`, to a function that reads on entry.
3. Either of those in a loop that also awaits.
4. A function handed to `setTimeout`, `.then`, `.on`, or similar that reads on entry.

A line can opt out with a comment that gives the reason:

```ts
// run-read-ok: with no run current, the log line is skipped.
void currentRunOrNone()?.log?.warn?.(...);
```

The check cannot follow a call through a callback parameter, a method chosen at run time, or a function stored in a table. Those still throw when they run.

## The wrong-run check

Every run has the same type, so the type checker cannot tell the right run from the wrong one. The mistake it cannot see looks like this:

```ts
await runner.step(0, run, async (runner, stepRun) => {
  await __call(run, save, descriptor); // should be stepRun
});
```

`assertUsable(run, what)` catches it when it happens. Only the innermost run can start work. A run that is waiting for something it started throws `RunInUseError`:

```
Wrong run: cannot call save() with a run that is waiting for its step.
Code inside that must use the run it was given.
```

`run.state` holds a count of the things the run is waiting for and the name of the latest. `withChildRun` adds to it and takes away when the body has finished. A child always gets a new `state`.

The operations that start work for Agency code or a helper call `assertUsable`: `__call`, `__callMethod`, `AgencyFunction.invoke`, the runner methods that take a body, the interrupt site, and callbacks. The runtime's own use of a run does not check. `runBatch` logs and fires hooks with the parent's run while its branches are running.

Three cases are exempt:

- Two calls made at once through one handle. Each `run.call` gets a detached copy.
- Several interrupts raised at once by one helper. Each raise gets a detached copy.
- The `async` keyword on a call, which Agency does not support. The code path still compiles and is not checked.

Generated code has a second protection. Every body the runtime calls back declares a parameter named `__run`, which hides the outer one. Code inside a fork block cannot name the outer function's run.

## Logging

`run.log` is the logging client bound to one branch's tag store and span stack. A post through it redacts with that branch's tags and nests under that branch's spans.

```ts
const spanId = run.log.startSpan("toolExecution");
```

`ctx.statelogClient` and `ctx.rootLog` are the client itself. Its type, `RootLog`, has no `startSpan` or `endSpan`. A span opened on the client goes on the root span stack, which every branch shares, so two fork branches doing it would pop each other's spans.

`ctx.rootLogWithSpans` is the whole client. Four places use it, all at the root of a run: the `agentRun` span, the graph engine, the node boundary that closes an `abortUnwind` span, and the functions that make a run's logger.

`runBatch` makes a branch's logger with `forBranch(globals, spans)`, where `spans` is a copy of the parent's stack.

## Stored callbacks

Some code keeps a function and calls it later, when the run that stored it is no longer the innermost one. Each such place stores the run it needs.

| Where | Which run it uses |
| --- | --- |
| The listener for a subprocess's messages, in `ipc.ts` | The branch run of the call that started the subprocess |
| `makeLazyCallbackRef` in `functionRefReviver.ts` | The run its caller passes |
| `makeRawInvoker` in `serve/discovery.ts` | The run its caller passes |
| The memory manager | The run each method is called with. One manager serves every fork branch |
| Console capture in `stdlib/ui.ts` | None. See below |

The subprocess listener's stored run keeps the executing-handler list from when the subprocess was started. So a subprocess started in a handler function does not have that handler asked about its interrupts, and a subprocess started in a handler body does. `tests/agency/subprocess/handler-function-starts-child` covers the first case and `handler-approve` the second.

### Console capture

A REPL replaces `console.log` so that output shows in its transcript. A `console.log` call carries no run, and any code can make one. So captured output goes to the REPL that installed its capture most recently.

With one REPL in the process, that is its own transcript. With two REPLs open at once in one process, the newer one gets the output of both until it closes.

## Testing

`lib/runtime/__tests__/testHelpers.ts` has the helpers.

```ts
import { it as baseIt } from "vitest";
const it = withTestFrame(baseIt);

it("keeps the depth", async () => {
  await runner.step(0, testRun(), async (runner, stepRun) => {
    await runner.step(0, stepRun, async () => { ... });
  });
});
```

- `withTestFrame(it)` and `inTestFrame(fn)` build a root run from a mock context.
- `inFrameOf(ctx, stack, fn)` builds one from the test's own context.
- `asRootRun(fn)` marks a run the test built itself with `runInTestContext`.
- `testRun()` returns the test's root run, also after an `await`.
- `callHelper(helper, ...args)` calls a helper under the root run.

`testRun()` is always the root run. Inside a step body, use the run the body was handed. Passing the root run there fails with `RunInUseError`.

## Conventions

- Name a stdlib JS export that reads the run with one underscore: `_recall`, `_fetch`. The code generator does not treat the prefix specially.
- A stdlib helper reads the run on its first line with `currentRun()`.
- A test that calls a `_foo` helper directly wraps the call in `runInTestContext` or uses `callHelper`.

## See also

- [running-without-node.md](./running-without-node.md): the goals behind this design, and the design it replaced.
- [docs/dev/compiler/codegen-run-parameter.md](../compiler/codegen-run-parameter.md): how generated code receives and passes the run.
- [runBatch.md](./runBatch.md): the fork and race primitive that makes branch runs.
- [subprocess-ipc.md](./subprocess-ipc.md): the subprocess listener.
- [docs/dev/stdlib/adding-a-module-to-the-agency-stdlib.md](../stdlib/adding-a-module-to-the-agency-stdlib.md): adding a stdlib module.
