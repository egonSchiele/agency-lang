# Passing the run explicitly: implementation plan

**Status:** approved on 2026-10-04, then revised the same day after the
review in `2026-10-04-explicit-run-passing-REVIEW.md`. All seven of the
review's findings were checked against the code and accepted, and one was
later found to rest on a wrong premise: see
[Code that runs with no frame today](#code-that-runs-with-no-frame-today). Phase 1 is built.

**Branch:** `explicit-run`, based on main. This work replaces PR
[#1167](https://github.com/egonSchiele/agency-lang/pull/1167). It is not
stacked on it.

**This work is exploratory.** The point of building it is to see how large
the change is, and nothing here is meant to merge yet. So the three PRs
stack: Phase 2 is based on the Phase 1 branch, and Phase 3 on the Phase 2
branch. Each PR says so in its first line. Phase 1 is PR
[#1169](https://github.com/egonSchiele/agency-lang/pull/1169).

**Read first:** the interrupts section of `CLAUDE.md`, then
`docs/dev/runtime/async-context.md`,
`docs/dev/compiler/codegen-als-accessors.md`,
`docs/dev/runtime/concurrent-interrupts.md`,
`docs/dev/runtime/subprocess-ipc.md`, and
`docs/dev/contributing/anti-patterns.md`.

## Goal

Agency code runs anywhere JavaScript runs, starting with an iPad web view.
The one Node feature with no replacement in a browser is
`AsyncLocalStorage`, which the runtime uses to find the current run.

This plan removes it by passing the run to every function that needs it, as
an ordinary argument. After the change:

- Nothing imports `node:async_hooks`.
- No build step rewrites `async` functions, and no global is replaced.
- Every `await` is a real `await`, so stack traces and speed on Node do not
  change.
- A runtime function that needs the run and was not given one is a type
  error. A hand-written helper that asks for the run after an `await` fails
  when it runs, with an error that names the fix. A lint rule catches that
  case in this repo's own helpers.

Interrupts, handlers, checkpoints, and fork branches must behave exactly as
they do today. [How we know nothing broke](#how-we-know-nothing-broke)
describes the check that makes this change safe to do.

## Safety features that must remain

The review lists every safety feature the guide describes and sorts them
into two groups. The first group does not read the frame, so this work
cannot affect it: the handler walk where one reject wins, policies, effect
sets, checkpoints and their checksum, the rule that a run cannot pause
inside a handler, and each run having its own globals.

The second group reads the frame. The design keeps each one. Each is also a
place where a mistake weakens the feature without an error, so each has a
named test that must pass at the end of every phase.

| Feature | What it reads | What protects it |
| --- | --- | --- |
| A handler does not hear its own raises | The executing-handler list | Required fields (Task 2). `tests/agency/handlers/handler-raises-outer-approves`, and a unit test that a step keeps the list |
| The handler recursion limit | The handler chain depth | Required fields (Task 2). `tests/agency/handlers` |
| `maxCallDepth` | The call depth | Required fields (Task 2). `tests/agency/call-depth-bounded`, and a unit test that a step keeps the depth |
| A callback does not call itself again | The active-callback list | Required fields (Task 2). `tests/agency/callback-recursion` |
| A pause waits until a callback has finished | The active-callback list | `isInsideCallback` asks whether the list is empty (Task 2). The "external pause" tests in `lib/runtime/runner.test.ts` |
| A parent's handlers answer a subprocess's interrupts | The frame from when the subprocess was started | `tests/agency/subprocess`, and `handler-function-starts-child` for a subprocess started in a handler function (Decision 7). Phase 3 gives the listener a stored run |
| Each fork branch has its own globals | The frame's `globals` | `sameRun` in Phase 2. `tests/agency/fork` |
| A cost or time guard applies to its branch | The frame's `stack` | `sameRun` in Phase 2. `tests/agency/guards` |
| Memory spending counts against a cost guard | The frame's `stack`, after an `await` | The two memory functions take a run and never accept a missing one (Task 8). Test in Task 17 |
| A tool body has its own message thread | The frame's `threads` | `sameRun` in Phase 2. `tests/agency/threads` |
| Redaction of values tagged in a branch | The frame's `globals` | `run.log` and its test (Task 6) |
| One request cannot read another request's run | One frame per chain of `await`s today | `callPlain` restores in a `finally` (Task 10). Test: a helper throws, and the variable is back to its old value |

The last row is new with this design. Today each request's frame follows
its own chain of `await`s. Under this plan one module variable serves the
whole process. It is safe because it is set and restored inside one
synchronous call. If a throw skipped the restore, the next helper to run
would read another request's run: its globals, its thread, and its
handlers. So the restore lives in one function, in a `finally`, with its
own test.

## Why not PR #1167

PR #1167 keeps the hidden variable and makes it work without Node. It
rewrites every `async` function into promise code and replaces
`Promise.prototype.then`. It passes all three test suites today.

What it costs, permanently:

- Code behaves differently depending on whether a build step rewrote it. A
  helper can work under `agency run` and fail under `agency serve`.
- A lost context is found at run time, and some reads treat a lost context
  as a normal answer.
- Stack traces on Node lose function names and callers across an `await`.
- No file Agency builds may have a top-level `await`.
- Every new event listener and every new place that emits code needs a
  decision that nothing reminds the author to make.

This plan costs more once and less afterwards.

## What the audit found

A script walked `lib/` on main at `ad1d7ec9b` with the TypeScript compiler
and followed every call. The script is not committed anywhere. It is an
untracked file in another worktree:

```
.worktrees/explicit-context/packages/agency-lang/scripts/explicit-context-spike/audit.mjs
```

The prototype is in the same folder. Cleaning up that worktree deletes
both. Task 1 copies the script into this branch.

| | Count |
| --- | --- |
| `AsyncLocalStorage` instances | 6 |
| Places that read a context variable directly | 53, in 49 functions |
| Functions that install a frame | 18 |
| Functions that reach a read through their calls | 595 |
| ...of which reach it only through logging | about 200 |
| ...of which reach it only for a warning, a config flag, or the clock | about 55 |
| ...of which need the run for real work | 339 |
| Uses of the run after an `await`, in those 339 | 208, in 114 functions |
| Uses inside a nested callback | 33 |
| Calls to `statelogClient` | 123 |
| Calls to `getRuntimeContext()` in `lib/stdlib` | 70 |
| References in the code generator and templates | about 113 |

About 55 functions need thought: the 49 readers, the 18 installers (13 are
also readers), and 11 places that store a callback and call it later. The
other functions only hand the run to something they call, and the type
checker finds each of them.

## The design

### One value: `Run`

Today the runtime keeps six context variables. This plan folds them into one
type. A `Run` is what the code calls an `AgencyStore` today, plus the values
of the five small variables.

```ts
export type Run = {
  // What AgencyStore holds today.
  ctx: RuntimeContext<any>;
  stack: StateStack;
  threads: ThreadStore;
  globals: GlobalStore;
  toolInvocationStack?: StateStack;
  callsite?: CallsiteLocation;
  runner?: Runner;
  decisions?: DecisionScope;

  // What the five small context variables hold today. All five are
  // required, so a frame built without them does not compile.
  callDepth: CallFrame | null; //         callDepthALS
  handlerChainDepth: number; //           handlerChainDepthALS
  executingHandlers: HandlerEntry[]; //   executingHandlersALS
  activeCallbacks: object[]; //           _activeCallbacksALS
  spans: SpanContext[]; //                StatelogClient.spanStorage. CHANGED IN PLACE.

  log: RunLogger; //                      See "Logging".
  state: RunState; //                     See "The wrong-run check". CHANGED IN PLACE.
};
```

Going one level deeper makes a new `Run`: `{ ...run, stack: branch.stack }`.
Every field is fixed for the life of that object except two, which are
marked above:

- `spans` is an array that `startSpan` pushes onto. A child that needs its
  own span stack gets a new array. The root run's `spans` is the client's
  own `rootStack` array, because posts made after the run has ended read
  `rootStack`, and a subprocess puts its parent's span at the bottom of it.
- `state` is a small object the wrong-run check writes to. A child always
  gets a new one. It is never copied by the spread.

### The five values survive every frame

Eight places build a frame from scratch today. They name the fields they
want and copy nothing else. That is harmless while the five small values
live in their own variables. Once they are fields of the frame, a frame
built from scratch drops them, and nothing fails where the value is lost:

- A handler function that calls another function would lose the executing-handler
  list at that function's first step. An interrupt raised below would go
  back to the handler that is running.
- The handler chain depth would restart at 0, so the limit of 10 would not
  stop that recursion.
- The call depth would restart at every step, so `maxCallDepth` would never
  trip.

Each of the eight must carry the five values from the outer frame. Today
every one of them keeps the values, so that is what "no behaviour change"
means here.

| Where | Line | The five values |
| --- | --- | --- |
| `Runner.runInScope` | `lib/runtime/runner.ts:190` | From the outer frame |
| `runInBranchAlsFrame` | `lib/runtime/runBatch.ts:471` | From the parent frame. `spans` is the branch's own array, as `runInBranchContext` gives it today |
| `withResumableScope` | `lib/runtime/resumableScope.ts:181` | From the outer frame |
| `runNode`, three frames | `lib/runtime/node.ts:295`, `448`, `500` | Fresh: these are the root. `spans` is `rootStack` |
| `runInTestContext` | `lib/runtime/asyncContext.ts:270` | Fresh |
| `runInBootstrapFrame` | `lib/runtime/asyncContext.ts:300` | Fresh. `spans` is `rootStack` |

Making the five fields required is what finds these: the compiler reports
every frame that leaves one out.

Two details:

- `runInBranchContext` does nothing when observability is off
  (`statelogClient.ts:275`). That stays.
- `isInsideCallback()` asks today whether the variable has a value
  (`hooks.ts:158`). An `activeCallbacks` array is always present, so it
  asks whether the array is empty. The runner uses the answer to put off an
  external pause.

### Code that runs with no frame today

None was found. Before any read was made strict, a temporary trace recorded
every read of the small variables that happened with no frame. It ran over
the unit tests, the Agency-js suite, and the `handlers`, `fork`,
`subprocess`, `guards`, `threads`, `substeps`, and `ts-helpers` folders of
the Agency suite. The unit tests produced about 210 frameless reads, all
from tests that call a runtime function directly. The Agency tests produced
none.

The review expected the listener for a subprocess's messages to be one
(`handleInterruptMessage`, `ipc.ts:877`). It is not. `AsyncLocalStorage`
carries a frame into the listeners of a child process, so that listener
runs in the frame that was current when the subprocess was started. The
comment at `ipc.ts:1124` that says otherwise is wrong.

That has two consequences.

**Phase 1 needs no new frame for it.** The handler chain finds a frame
there today and keeps finding one.

**Phase 3 has to supply one.** With `AsyncLocalStorage` gone the listener
has no frame of its own. It gets the stored run of the code that started
the subprocess, which is `s.parentStore`. See Decision 7 for which
executing-handler list that run carries.

Six fallbacks skip the frame when there is no outer one:
`runBatch.ts:438`, `toolInvocation.ts:58`, `:82`, `:107`, `runner.ts:187`,
and `agencyFunction.ts:297`. Only unit tests reach them. They stay as they
are in Phase 1 and go away in Phase 2, when each takes a run.

### Generated code

Today generated code asks for the run each time it needs it:

```ts
async function __greet_impl(name: string, age: number) {
  const __setupData = setupFunction();
  const __ctx = getRuntimeContext().ctx;
  const runner = new Runner(__ctx, __stack, { ... });
  await agencyStore.run({ ...getRuntimeContext(), ctx: __ctx, stack, threads }, async () => {
    await runner.step(1, async (runner) => {
      const __response = getRuntimeContext().ctx.getInterruptResponse(__self.__interruptId_1);
      ...
      await interruptWithHandlers("unknown", message, {}, origin, __ctx, __stateStack());
    });
  });
}
```

After the change the run is the first parameter. Each step is given the run
it runs under, and hands its body the run for that step:

```ts
async function __greet_impl(__run: Run, name: string, age: number) {
  const __setupData = setupFunction(__run);
  __run = __setupData.run;
  const runner = new Runner(__run, __stack, { ... });
  await runner.step(1, __run, async (runner, __run) => {
    const __response = __run.ctx.getInterruptResponse(__self.__interruptId_1);
    ...
    await interruptWithHandlers(__run, "unknown", message, {}, origin);
  });
}
```

Four rules for the code generator:

1. Every generated function, node, block, and handler function takes the
   run as its first parameter.
2. Every body the runtime calls back declares a parameter named `__run`:
   steps, hooks, conditions, loop bodies, pipe stages, fork blocks, and
   handler functions. The inner name hides the outer one, so code inside a
   fork block cannot reach the outer function's run by accident. The code
   generator checks this when it emits a body, and fails the compile if a
   body handed to the runtime has no `__run`.
3. Every runner method that takes a body also takes the run it is called
   under: `runner.step(id, __run, body)`. The Runner does not keep track of
   a current run. A body that forgot rule 2 then passes the outer run to
   its first nested step, and the check in Phase 2 fails there.
4. `__call(run, target, descriptor)` and `AgencyFunction.invoke(run, ...)`
   take the run first.

Generated code installs two frames of its own today: one around each
function body (`lib/ir/builders.ts:588`) and one around an `async` call
(`lib/backends/typescriptBuilder.ts:2761`). In Phase 2 both stay, and each
installs the same object it passes on. Phase 3 removes them. The fixtures
are therefore rebuilt twice, once in each phase.

The `async` keyword on a call is not a supported part of Agency. The guide
does not document it, and says Agency has no async/await: concurrency is
`fork`, `race`, `parallel`, and `seq`. The parser and code generator still
accept the keyword and a few older tests use it, so this work keeps that
code path compiling and keeps those tests passing. It adds no behaviour and
no new tests for it.

### Calling a function the compiler did not write

The compiler cannot tell which imported TypeScript functions want the run.
The old design solved that with a table of names, which is why it was
dropped in May (`docs/dev/runtime/async-context.md`, "What was wrong with
the previous mechanism"). This plan uses no table.

When the runtime calls a function that does not take a run, it sets one
plain module variable to the run, calls the function, and puts the previous
value back in a `finally` once the call has returned its promise.
JavaScript runs one thing at a time, and a promise continuation never runs
inside another call's synchronous part, so the variable holds the right run
from the start of the call to the function's first `await`.

One function does this, `callPlain(run, fn, args)`. The runtime calls a
plain function from five places, and all five use it:

| Where | Line | What it calls |
| --- | --- | --- |
| `__call` | `lib/runtime/call.ts:124` | An imported function |
| `__callMethod` | `lib/runtime/call.ts:222` | A method on a JavaScript object |
| `invokeCallback` | `lib/runtime/hooks.ts:198` | A callback passed from TypeScript, or a global hook from a package |
| `runHandlerChain` | `lib/runtime/interrupts.ts:308` | A handler registered from TypeScript with `agency.withHandler` |
| `AgencyFunction.invoke` | `lib/runtime/agencyFunction.ts:214` | `_fn`, when it is hand-written |

How the runtime knows which kind it has:

- **`AgencyFunction`.** Generated code passes `takesRun: true` to
  `AgencyFunction.create`. The functions built by hand in
  `functionRefReviver.ts` and `lib/stdlib/agency.ts:92` do not, and go
  through `callPlain`.
- **Handlers.** A handler entry records whether its function takes the run.
  `Runner.handle` registers generated handler functions, which do. A
  handler written in TypeScript and registered with `agency.withHandler`
  keeps its shape, `(interrupt) => verdict`, and goes through `callPlain`.
  See Decision 8.

### Hand-written helpers

```ts
// A stdlib helper today
export async function _fetch(url: string) {
  const { ctx, stack } = getRuntimeContext();
  ...
}

// After. The first line is the same line, with a new name.
export async function _fetch(url: string) {
  const run = currentRun();
  ...
  await runHttp(run, ...); // runtime functions take the run
}
```

`currentRun()` throws after the helper's first `await`. Every runtime
function requires a run, so a helper that needs one after an `await` has to
have taken it at the top. The 280 uses that already sit before a function's
first `await` need no change beyond the rename.

`getRuntimeContext` stays exported for one release as an alias of
`currentRun`, with a deprecation note (Decision 5). The published `kokoro`
and `lora` packages import it, and their peer ranges accept any newer
runtime. All three of their reads are on a function's first line.

For users' own helpers the public form is `agency.current()`, which returns
a handle with the same functions as `agency` and one more, `call`:

```ts
export async function fakeRepl(onSubmit) {
  const run = agency.current();
  for (const line of lines) {
    await run.call(onSubmit, line);
  }
}
```

`run.call` works for both kinds of function. For an Agency function it
passes the run. For a plain function it goes through `callPlain`, so a
helper that awaits and then calls a second helper uses `run.call(second)`,
and the second helper's `currentRun()` works. `run.call(fn, ...args)` takes
positional arguments. `run.callWith(fn, descriptor)` takes the descriptor
`__call` takes today, for named arguments and a trailing block.

The handle works the same way in every file and under every command,
because nothing depends on who built the file.

### `agency.*` functions that take a callback

Several functions in the `agency` namespace run a function the helper
passes in: `withHandler(handler, fn)`, `withCostGuard(max, fn)`,
`withTimeGuard(max, fn)`, `withLock(name, fn)`, `withCallsite(loc, fn)`,
`withResumableScope(opts, body)`, `thread.with(id, fn)`, and
`withTestContext(deps, fn)`. The guide's examples await inside these
callbacks and then call `agency.*` again:

```ts
await agency.withCostGuard(0.05, async () => {
  await agency.llm("Be brief: " + question);
  await agency.llm("Now elaborate slightly: " + question); // after an await
});
```

Each of these installs a frame today, so each is an installer, and its
callback needs the run it installed. The callback is handed a handle for
that run as its argument:

```ts
await run.withCostGuard(0.05, async (run) => {
  await run.llm("Be brief: " + question);
  await run.llm("Now elaborate slightly: " + question);
});
```

`withResumableScope` already hands its body a scope object, `s`. The handle
is reachable from it as `s.run`. `withTestContext` stays the way a test gets
a frame, and hands its callback a handle the same way.

### Reads that accept a missing run

About 30 reads treat "no frame" as a normal answer today. Examples:
`agency.ctxMaybe()` returns `undefined`, `StatelogClient.post` falls back
to the top-level globals, and `withPushedHandler` registers a handler with
no live guards.

After `AsyncLocalStorage` is gone, a helper that has passed its first
`await` looks the same to these reads as code outside any run. That is the
fault this plan holds against PR #1167, so it has to be closed here.

Phase 2 is the only time the two cases can be told apart: a lost run shows
up as a frame in `AsyncLocalStorage` with the module variable unset. During
Phase 2, `currentRun()` and its lenient form both throw in that case. The
suites then find each such read. Every one a helper can reach ends Phase 2
either strict or taking a run.

### Logging

`StatelogClient.post` reads the current branch's globals so that each
branch redacts its own secret-tagged values, and `currentStack()` reads the
branch's span stack. About 200 functions log, through 123 call sites.

Each `Run` has a logger that already knows its branch:
`run.log.toolCall({ ... })` in place of
`ctx.statelogClient.toolCall({ ... })`. `run.log` holds the client, the
run's globals, and the run's span stack.

Some posts are made after the run's frame has ended, such as `agentEnd`.
They use a named root logger, `ctx.rootLog`, which redacts with the
top-level globals as those posts do today.

Once the call sites have moved, the posting methods come off
`ctx.statelogClient`'s public type. A call site that was missed is then a
compile error. Left in place, it would post with the top-level globals and
skip the branch's redaction tags.

### Stored callbacks

Eleven places keep a function and call it later. There is no single rule
for them. Today each reads the frame that is current when it is called. For
some the right run is the one that was current when the callback was
stored, and for others it is the caller's.

| Where | Which run | What Phase 2 compares |
| --- | --- | --- |
| Subprocess session handlers, `ipc.ts:1262` and the two beside it | Stored: the run that started the subprocess | The stored run is `s.parentStore` |
| `handleCallbackMessage`, `ipc.ts:1145` | Stored. It already uses `s.parentStore` | Same |
| `invokeSubprocess` closure in `_run`, `ipc.ts:1549` | Stored | Same |
| `makeLazyCallbackRef`, `functionRefReviver.ts:236` | The caller's. It is built during a restore, in a bootstrap frame whose thread store throws. It passes on the run its caller gives it | `sameRun` on the caller's run |
| `makeRawInvoker`, `serve/discovery.ts:47` | The caller's | `sameRun` on the caller's run |
| Memory manager `get` and `set`, `state/context.ts:601`, `:606` | The caller's. One manager serves every fork branch, so each method takes the run per call | The stack read equals `agencyStore.getStore()?.stack` |
| Console capture, five overrides, `stdlib/ui.ts:363`–`369` | Neither. See Decision 9 | None |

`sameRun` cannot check a stored run. By the time a stored callback fires,
the current frame is a deeper one, so the two are never the same object.
The third column says what each compares in its place.

`recordMemoryUsageIfInFrame` and `meteredMemoryDispatch` charge the cost
guards on the branch's stack. They take the run per call for the same
reason the manager's methods do.

### The wrong-run check

Every run has the same type, so the type checker cannot tell the right run
from the wrong one. The prototype found a rule that catches the mistake
where it happens: only the innermost run of a lineage can be used. A run
that is waiting for something it started throws if code tries to start
something else with it.

```
Wrong run: cannot call save() with "forked()". It is waiting for its fork.
Code inside that must use the run it was given.
```

The prototype is a model with no threads, guards, race, tool calls,
subprocesses, or `async` calls. The rule has not been tried on the real
runtime. These are the answers the real one needs.

1. **Which operations check.** Only the operations that start work on
   behalf of Agency code or a helper: `__call`, `__callMethod`,
   `AgencyFunction.invoke`, the runner methods that take a body, the
   interrupt site, and every function on the handle. The runtime's own use
   of a run does not check. `runBatch` logs and fires hooks with the
   parent's run while its branches are running.
2. **What a copy does.** A child run always gets a new `state`. The spread
   never carries the parent's.
3. **Two waits at once.** `state` holds a count of the things the run is
   waiting for, with the name of the latest. The run is usable when the
   count is 0.
4. **The unsupported `async` call path.** Starting an `async` call does
   not add to the caller's count, because the caller keeps running. The
   callee does not touch the caller's state when it finishes. A wrong run
   passed to an `async` call is not caught. The keyword is not supported,
   so this is only about not breaking the code path that still exists.
5. **Stored callbacks.** A stored callback does not use the stored run
   directly. It makes a child of it when it fires, with a new `state`, so
   the stored run's own state does not matter.
6. **Race losers.** A branch's run is closed when the branch's own promise
   settles. A loser that is still running after the parent has moved on
   keeps a usable run until it stops.
7. **Two calls through one handle.** Allowed. A handle's calls are not
   counted against the handle's run, so `Promise.all([run.call(a),
   run.call(b)])` works, as it does today.
8. **Work that outlives a helper.** A helper that starts work and returns
   before it ends leaves that work holding the handle. Today the frame
   keeps working. See Decision 10.

The check goes in as its own commit, after `sameRun` is in and the suites
are green, while `AsyncLocalStorage` is still in place. A failure then
points at one check. Decision 4 is confirmed again at the end of Phase 2:
it was made on the prototype's result, and if the real runtime needs more
exemptions than the eight above, the check protects less than the decision
assumed.

### How we know nothing broke

The change is done in two steps. In the first, the run is passed explicitly
**and** `AsyncLocalStorage` stays in place. Every installer checks the run
it was handed, makes one object, and gives it to both:

```ts
sameRun(run);
const child: Run = { ...run, stack: branch.stack, state: newState() };
return agencyStore.run(child, () => fn(child));
```

The first line matters. If an installer were handed the wrong run and made
its child from it, everything inside would agree with `AsyncLocalStorage`
and the check would pass. `AsyncLocalStorage` is right only while each
installer builds on the frame main would have used.

Every place that used to read the hidden variable uses its parameter, and
checks that the two agree:

```ts
function sameRun(run: Run): Run {
  if (agencyStore.getStore() !== run) throw new WrongRunError(...);
  return run;
}
```

What this covers and what it does not:

- **Covered:** every runtime function that takes a run, every installer,
  every runner method (rule 3), and every call into a helper.
- **Covered differently:** the stored callbacks, by the comparisons in
  their table.
- **Not covered one by one:** direct field reads in generated code, such as
  `__run.globals`. The run they read is the one the enclosing body was
  handed, which a runner method checked on the way in. Rule 2's compile-time
  check is what stops a body from reading an outer run.

`AsyncLocalStorage` is what main does today. With these checks on, the
existing suites test, at each covered place, that the run the code was
handed is the run it would have found. Only when all three suites pass does
the second step remove `AsyncLocalStorage`.

## Decisions

**1. One PR or three?** **Decided: three PRs, stacked.** Phase 2 is based
on Phase 1 and Phase 3 on Phase 2, because the work is being built to
measure it and not yet to merge it. Phase 2 may split in two if its diff is too
large: `getRuntimeContext()` keeps working while `AsyncLocalStorage` is in
place, so Tasks 13 and 14 can merge after Tasks 8 to 12.

**2. What happens to PR #1167?** **Decided: leave it open.** Take three
things from it: the goals and the branching rule in
`running-without-node.md`, the `CLAUDE.md` section, and the
`always-scope-over-ipc` test.

**3. How does logging find its branch?** **Decided: `run.log`.**

**4. Is the wrong-run check always on?** **Decided: always on.** To be
confirmed at the end of Phase 2, as described above.

**5. Does `getRuntimeContext()` keep its name?** **Decided: rename it to
`currentRun()` and keep the old name exported for one release as an
alias.** The first version of this plan said to leave no alias. That would
break installed copies of `kokoro` and `lora` at import, and the code the
guide shows in `guards.md` and `ts-helpers.md` for reading the abort
signal.

**6. Helper code breaks.** **Decided: accepted.** The break is wider than
`__call`. A helper that calls an Agency function uses
`run.call(fn, ...args)`. A helper that uses `agency.*` after an `await`
must take a handle first, and most examples in `ts-helpers.md` do that
today:

```ts
const { tokens, cost } = await myCustomLLM(prompt);
agency.addCost(cost); // throws, and the error names agency.current()
```

The same applies to the bodies given to `withCostGuard`,
`withResumableScope`, `thread.with`, and `withHandler`. Nothing is skipped
without an error, so no safety feature is lost.

**7. A subprocess started inside a handler function.** This entry uses
the guide's words: the block after `handle` is the handler body, and the
block after `with` is the handler function. Earlier versions of this plan, and the
review, said "a handler whose body starts a subprocess" when they meant the
handler function. That wording was wrong and made the question unclear.

There are two cases, and main treats them differently.

- **The subprocess is started in the handler body.** That handler is asked
  about the subprocess's interrupts. This is the ordinary case, and
  `tests/agency/subprocess/handler-approve` and `handler-reject` cover it.
  Nothing in this work changes it.
- **The subprocess is started in the handler function.** That handler is
  not asked about the subprocess's interrupts. Every handler outside it is.
  This matches the guide's rule that a handler function never triggers for
  an interrupt raised in itself.

```
inner handler asked about: start the child
outer handler asked about: Running agent-generated code in subprocess
outer handler asked about: child asks
outer handler asked about: start the child
```

In the third line the subprocess, which the inner handler function started,
raises "child asks". Only the outer handler is asked.

The review said the second case is asked today, and the first version of
this entry repeated that. A test on main showed otherwise. Phase 1 keeps
what main does, and `tests/agency/subprocess/handler-function-starts-child`
pins it. In Phase 3 the listener's stored run keeps the executing-handler
list from when the subprocess was started, so both cases behave as they do
today.

*Decided: keep both cases as they are.* Both follow from the guide
(`docs/site/guide/handlers.md`): a handler is asked about interrupts raised
in its body, and "a handler function never triggers for an interrupt raised
in itself". A subprocess is one more way to raise an interrupt from either
place.

**8. Handlers written in TypeScript.** `agency.withHandler(handler, fn)` is
public and its handler takes only the interrupt. **Decided: keep that shape.** The
runtime calls such a handler through `callPlain`, so it can use
`agency.current()` like any helper.

**9. Console capture with two REPLs.** `std::ui` overrides `console.log`
and sends each line to the transcript of the REPL whose frame is current. A
`console.log` call from arbitrary code carries no run, so without the
hidden variable two REPLs in one process cannot each capture their own
output. This behaviour is lost under this plan. **Decided: send captured
output to the transcript of the REPL that installed the capture most
recently, and say so in the `std::ui` docs.**

**10. Work that outlives its helper.** A helper that starts work and
returns before it ends leaves that work holding the handle. Today the frame
keeps working. **Decided: keep it working.** A handle stays usable
after the helper returns, and the docs say that the run may have moved on.

## Phases

### Phase 1: lineage on the frame, strict reads. No behaviour change. BUILT.

`AsyncLocalStorage` stays. This phase puts the four lineage values on the
frame and makes their reads strict.

- [x] **Task 1. Bring the audit script in.** `scripts/audit-run-reads.mjs`.
      On main at `ad1d7ec9b` it reports 53 direct reads in 49 functions and
      18 installers. `tests/agency/handlers` takes 18.0 seconds on main.
- [x] **Task 2. Fold four small variables into the frame.** `callDepth`,
      `handlerChainDepth`, `executingHandlers`, and `activeCallbacks` are
      required fields of `AgencyStore`. `lineageOf(outer)` gives a new
      frame the outer frame's values, and each of the eight frames built
      from scratch spreads it in. Four `AsyncLocalStorage` instances are
      deleted. The span stack is the fifth, and it moves in Phase 2 with
      logging: it is kept per logging client, and its natural home is
      `run.log`.
- [x] **Task 3. Make the lenient reads strict.** `withCallDepth`,
      `runHandlerChain`, `runAsHandler`, `executingHandlers`,
      `fireWithGuard`, and `isInsideCallback` call `requireFrame`, which
      throws when there is no frame. Sixteen unit test files called these
      with no frame. Each now runs its tests inside a frame, through
      `withTestFrame` in `lib/runtime/__tests__/testHelpers.ts`.
- [x] **Task 4. Tests.** Three unit tests check that a step keeps each
      lineage value, and each fails when `Runner.runInScope` drops it.
      `tests/agency/subprocess/handler-function-starts-child` pins who is
      asked when a handler function starts a subprocess (Decision 7). Three
      tests the plan asked for already exist:
      `handlers/handler-raises-outer-approves` (a handler function calls a
      function that raises), `call-depth-bounded`,
      and `callback-recursion`.
- [x] **Verify.** `pnpm run typecheck`, `pnpm run lint:structure`,
      `pnpm test:run`. Locally: the Agency-js suite, the callback tests,
      and the `handlers`, `fork`, `subprocess`, `guards`, `threads`,
      `substeps`, and `ts-helpers` folders. CI runs the full suites.

Two tasks moved from this phase to Phase 2. The small readers and
`run.log` both need callers that hold a run. In Phase 1 most callers hold
only `ctx`, so doing them here would mean threading the same call sites
twice.

### Phase 2: thread the run, with the checks on.

`AsyncLocalStorage` stays, and every read is checked against it.

#### Built so far: the seam between generated code and the runtime

Branch `explicit-run-phase-2`, stacked on `explicit-run`. This is the core
of Tasks 7, 8, and 11, and a first piece of Task 10.

- **Generated code holds the run.** Every function, block, handler
  function, init function, and finalize closure takes `__run` first, and
  every body the runtime calls back declares `__run`. Generated code no
  longer calls `getRuntimeContext()`, `__threads()`, `__stateStack()`, or
  `__globals()`. It reads `__run.ctx`, `__run.threads`, `__run.stack`, and
  `__run.globals`.
- **The Runner checks every step.** Each Runner method takes the run it is
  called under, checks it with `sameRun`, makes one child, and hands the
  child to both `AsyncLocalStorage` and the body.
- **The call path takes the run.** `__call`, `__callMethod`,
  `AgencyFunction.invoke`, `withCallDepth`, `runAsHandler`, the handler
  chain, `interruptWithHandlers`, `callHook`, `invokeCallbacks`, `runBatch`,
  `runPrompt` and its tool loop, the three tool-invocation frames, guard
  trips, and the debugger step.
- **A node gets its run from its state.** The graph engine calls a node
  with its state only, so `GraphState` has a `run` field, set where
  `graph.run` is called and carried along by `goto`.
- **`agency.current()`** returns a handle with `call` and `callWith`.

Three things differ from the design above:

1. `new Runner(ctx, frame, opts)` keeps its shape. Generated code passes
   `stack` and `threads` in `opts`, and the constructor no longer reads
   `AsyncLocalStorage`. Taking a `Run` there would have meant rebuilding 61
   test constructions for no gain.
2. `ambientRun(caller)` marks a function that still reads the current frame
   because its own caller has no run to give it yet. There are 12. Each is
   a place still to change, and Phase 3 cannot start while any remain.
3. The stage of a pipe is wrapped in a body that declares `__run`, so one
   lambda builder serves both `runner.pipe` and a bare `|>` expression.

Numbers at this point, from `scripts/audit-run-reads.mjs` and `grep`:

| | On main | Now |
| --- | --- | --- |
| Functions that install a frame through `agencyStore.run` | 18 | 2 (`withRun` and one in `statelogClient`) |
| Functions that read a context variable directly | 49 | 37 |
| Call sites that read the frame, in `lib/runtime` and `lib/serve` | | about 70 |
| ...in `lib/stdlib` | | about 95 |
| `ambientRun()` uses | | 12 |

Verified locally: the full unit suite (15,244 tests), the Agency-js suite
(190 tests), and the `handlers`, `handler-lineage`, `fork`, `subprocess`,
`guards`, `threads`, `substeps`, `ts-helpers`, `blocks`, `agents`, and
callback tests of the Agency suite. No test found a place where the
runtime handed a function the wrong run.

What broke, as Decision 6 expected: a helper that calls `__call(fn, ...)`
itself. `tests/agency-js/agent-session-resume/loop.js` did, and now uses
`agency.current()`. Every package's compiled `index.js` had to be rebuilt,
because code from the old compiler calls the runtime with the old
argument order.

Still to do in this phase: the rest of Task 8 (the remaining reads in the
runtime), and Tasks 5, 6, 9, 10, 12, 13, and 14.

- [ ] **Task 5. Give the 10 small readers their value directly.** These
      read the frame only for a log line, a config flag, or the clock:
      `ipcChildDebug`, `abortedResult.statelogClient`, `warnDroppedData`,
      `getFailurePropagationMode`, `logWarn`, `emitFunctionRefMissError`,
      `claimFrameForScope`, `DeterministicClient.resolveQueue`,
      `TimeGuard.clock`, `wallClockNow`. Each takes what it needs as an
      argument, or holds it from construction (`TimeGuard` keeps its
      clock).
- [ ] **Task 6. Add `run.log` and `ctx.rootLog`**, with the span stack on
      the logger, and move the 123 `statelogClient` call sites. Remove the
      posting methods from the client's public type, and delete the last
      small `AsyncLocalStorage`, `spanStorage`. Add a test that a value
      tagged as secret inside a fork branch is redacted in a log post made
      from that branch.
- [ ] **Task 7. `Run` and `sameRun`.** Rename `AgencyStore` to `Run`. Add
      `sameRun(run)`. Change the 18 installers to check their argument,
      make one object, and pass it both ways.
- [ ] **Task 8. The runtime, driven by the type checker.** Add a required
      `run: Run` first parameter to each of the 39 remaining readers, which
      now include `recordMemoryUsageIfInFrame` and `meteredMemoryDispatch`.
      Those two lose their "return if there is no frame" line: they run
      after an awaited provider call, and a missing run there would stop
      memory spending from counting against a cost guard.
      Compile. Each error is a caller that must pass a run: add the
      parameter there and compile again, until the errors stop. Start with
      the files where frames are installed, and read each by hand:
      `runner.ts`, `runBatch.ts`, `interrupts.ts`, `prompt.ts`,
      `promptRunner.ts`, `toolInvocation.ts`, `hooks.ts`,
      `resumableScope.ts`, `node.ts`, `ipc.ts`, `agencyFunction.ts`,
      `call.ts`.
- [ ] **Task 9. The stored callbacks.** Apply the table under "Stored
      callbacks", with the comparison each row names. Bring the
      `always-scope-over-ipc` test from PR #1167. Console capture follows
      Decision 9.
- [ ] **Task 10. `callPlain` and the handle.** This includes the
      callback-taking `agency.*` functions, each of which hands its
      callback a handle. Add `callPlain` and use it
      in the five places. Add `currentRun()` and the `getRuntimeContext`
      alias (Decision 5). Add `agency.current()` with `call` and
      `callWith`. Test `callPlain` with a helper that throws: the variable
      is back to its old value afterwards. `agency.*` reads `currentRun()`. Make `currentRun()` and
      its lenient form throw when `AsyncLocalStorage` has a frame and the
      variable is unset. `agency.*` used after an `await` throws an error
      that names `agency.current()`.
- [ ] **Task 11. The code generator.** Apply the four rules under
      "Generated code", including the compile-time check for rule 2.
      Files: `lib/ir/builders.ts`, `lib/backends/typescriptBuilder.ts`,
      `lib/ir/prettyPrint.ts`, and the templates that name an accessor or
      `__ctx`: `blockSetup`, `forkBlockSetup`, `interruptAssignment`,
      `interruptReturn`, `resultCheckpointSetup`, `functionCatchFailure`,
      `finalizeClosure`, `withHandlerWrapper`, `debugger`, `imports`, and
      `builtinFunctions/*`. Then `pnpm run templates`, `make`,
      `make fixtures`. Commit the fixtures separately.
- [ ] **Task 12. The wrong-run check.** Add `state` and the check, as its
      own commit, once the suites are green on Tasks 7 to 11.
- [ ] **Task 13. The stdlib helpers.** In each of the 48 stdlib functions
      that use the run after an `await`, take the run on the first line
      and pass it down. The audit script lists them. Heaviest: `ui.ts`,
      `cli.ts`, `markdown.ts`, `memory.ts`, `aws/s3.ts`. Resolve every
      read that Task 10's throw turns up.
- [ ] **Task 14. The other packages and the test helpers.**
      `packages/lora/src/agency.ts` and `packages/kokoro/src/agency.ts`
      move to `currentRun()` and raise their peer range. Update
      `tests/agency-js/agent-session-resume/loop.js` to the handle. Check
      the nine test helpers that call `agency.*`: eight under
      `tests/agency/ts-helpers/` and `tests/agency-js/queue-message/tools.js`.
- [ ] **Verify.** All three suites pass in CI with every check on. Run the
      audit script: it must report no read of `agencyStore` outside
      `sameRun`, the installers, and the comparisons in the stored-callback
      table. Time `tests/agency/handlers` again and put both numbers in the
      PR. Confirm Decision 4.

### Phase 3: remove `AsyncLocalStorage`.

- [ ] **Task 15. Delete it.** Remove `agencyStore`, the `agencyStore.run`
      half of each installer, `sameRun`, the stored-callback comparisons,
      and the two frames generated code installs. Nothing imports
      `node:async_hooks`. `runInTestContext` builds a `Run` and passes it.
      Rebuild the fixtures and commit them separately.
- [ ] **Task 16. The lint rule.** Turn the audit script into a check that
      fails the build when a function reaches `currentRun()` after an
      `await`. It follows calls, so it also catches a function that awaits
      and then calls a helper whose first line is `currentRun()`. Add it
      to `pnpm run lint:structure`.
- [ ] **Task 17. Tests.**
      1. A hand-written `.js` helper awaits a timer, then raises an
         interrupt through the handle. A `handle` block approves it.
      2. The same helper under `agency serve`.
      3. A handler function calls a TypeScript helper. The helper awaits a
         timer and then raises the handler's own effect through the
         handle. The handler is skipped, as it is today.
      4. A helper makes two `run.call`s at once.
      5. A fork block writes a global and calls nothing. The parent's
         global is unchanged.
      6. One test per wrong-run mistake from the prototype.
      7. Two runs paused and resumed at the same time keep their own
         globals.
      8. A memory call inside `withCostGuard` charges the guard, and an
         over-budget one trips it.
- [ ] **Task 18. Docs.** Rewrite `docs/dev/runtime/async-context.md` and
      `docs/dev/compiler/codegen-als-accessors.md` for the `Run` parameter.
      `async-context.md` says today that a helper calling another helper
      does nothing about the frame. After an `await` that is no longer
      true, and the doc says to use `run.call`. Add
      `docs/dev/runtime/running-without-node.md` with the goals and the
      branching rule from PR #1167, and this decision in place of that
      one. Update `docs/site/guide/ts-helpers.md` and
      `docs/site/guide/guards.md`, which both show `getRuntimeContext()`
      and `agency.*` after an `await`. Update the `std::ui` docs
      (Decision 9), the `CLAUDE.md` index, and the matching skill.
- [ ] **Verify.** All three suites in CI. `grep -r "async_hooks" lib` finds
      nothing. Bundle the built runtime's context module with esbuild for
      the browser platform and check that it resolves with no Node module.

## What this plan does not do

- **It does not make Agency run in a browser.** The runtime still imports
  `fs`, `path`, and other Node modules. The next steps for that are in
  `promise-context-storage.md` on the PR #1167 branch, under "Next steps",
  and none of them depend on which design is chosen here.
- **It does not fix the dropped interrupt found while building the
  prototype.** On main, `out.push(save(name))` loses the interrupt that
  `save` raises: the node finishes, `save` never runs, and nobody is asked.
  `const saved = save(name)` followed by `out.push(saved)` pauses
  correctly. This needs its own issue.

## Risks

- **A wrong run where the checks cannot see it.** After Phase 3 the
  comparison against `AsyncLocalStorage` is gone. What remains is the
  innermost-run rule, which does not cover the unsupported `async` call
  path, and rule 2's
  compile-time check. A new installer written after this change gets no
  automatic check.
- **The wrong-run check may need more exemptions than planned.** It has
  only run on a model. Task 12 is its own commit so it can be dropped
  without disturbing the rest.
- **Phase 1, Task 3 may break unit tests** that call runtime functions with
  no frame. Each needs `runInTestContext`. The count is not known.
- **The diff is large.** Phase 2 changes about 340 functions and every
  fixture. Other branches will conflict until it merges.
- **Calls through dynamic dispatch.** The audit script cannot follow them.
  The type checker can, so they surface in Task 8 as compile errors. The
  lint rule in Task 16 will miss them.
- **Speed.** A `Run` is made on every call and every step, with 15 fields
  and a logger. The timings in Task 1 and the Phase 2 verify step measure
  it. If the logger shows up, make it lazily.
- **Code outside this repo that calls an Agency function with no frame.**
  Phase 1 made that throw. Two unit tests in `packages/mcp` did it and
  failed in CI; they now build a frame with `agency.withTestContext`. No
  production path was found: only nodes can be imported into TypeScript,
  and `agency serve` installs a frame before it calls an exported function.
- **The audit's counts were not rechecked.** The review confirmed the file
  and function names in this plan against the code. It did not rerun the
  script, so 595, 339, 208, 114, and 33 rest on one run of it.
