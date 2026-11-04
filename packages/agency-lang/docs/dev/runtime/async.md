# `async` calls

`async f()` runs `f` beside the statements that follow it in the same block.
The compiler rewrites the block into a `parallel` block, which the existing
parallel desugar turns into a `fork`. `async` adds two things to fork and
nothing else: one arm keeps the parent's conversation thread, and the join
returns an early `return` from the arm. Everything else is fork's
behaviour, so interrupts are batched and resumable and the checkpoint is
always complete.

The user guide is the `async` section of `docs/site/guide/concurrency.md`.
The design discussion, the alternatives set aside, and the spike results are
in `docs/dev/language/fire-and-forget-notes.md`.

## The lowering

`lib/preprocessors/asyncDesugar.ts` runs in `TypescriptPreprocessor.preprocess`
just before `desugarParallelBlocks`. It rewrites

```agency
let name = async nameConversation(msg)
const reply = llm(msg)
print(reply)
print(name)
```

into

```agency
const __async_arg_0 = msg
parallel(shared: true) {          // origin: "async"
  let name = nameConversation(__async_arg_0)
  seq {
    const reply = llm(msg)
    print(reply)
  }
}
print(name)
```

and `desugarOneParallel` (`lib/preprocessors/parallelDesugar.ts`) turns that
into

```agency
const __async_arg_0 = msg
let __arms_0 = fork(["arm_0", "arm_1"], shared: true) as __arm_0 {   // mainThread: 1
  if (__arm_0 == "arm_0") {
    let name = nameConversation(__async_arg_0)
    return { name: name }
  }
  if (__arm_0 == "arm_1") {
    const reply = llm(msg)
    print(reply)
    return __asyncDone({ reply: reply })
  }
}
if (!__asyncFinished(__arms_0[1])) {
  return __arms_0[1]
}
let name = __arms_0[0].name
let reply = __arms_0[1].reply
print(name)
```

The pieces, in the order they appear:

1. **The snapshot temporaries.** Each argument of the call that names
   anything, the receiver of a method call, and the callee when it is a
   function value in a local are copied into `const __async_arg_N` before
   the block. Without them, arm 0 would read them inside its first step,
   after several awaits, and a write in arm 1's first statements could land
   first. Literals are left in place. Objects stay aliased, as for any call.
   A block argument stays on the call.
2. **`shared: true`.** Globals stay shared, as they are between a plain call
   and the code after it.
3. **`mainThread: 1` on the fork.** A field on the synthesized `fork` call
   node (`FunctionCall.mainThread`), set by `forkCall` when the block has
   `origin: "async"`. There is no syntax for it: `fork(xs, mainThread: 1)`
   is the ordinary unknown-named-argument error. The builder passes it as
   the trailing argument of `runner.fork`, and `runForkAll` sets
   `shareThreads` on that one child (`BatchChild.shareThreads` in
   `runBatch.ts`). That child's run gets the parent's thread view, so the
   reply an `llm()` call makes in arm 1 lands in the conversation. Arm 0
   gets a subthread seeded from a copy of the active thread, as any fork
   branch does, so the side call's model messages stay off the
   conversation.
4. **The marked completion.** Arm 1 ends with
   `return __asyncDone({ ...bindings })` instead of the plain bindings
   object.
5. **The join check.** `if (!__asyncFinished(__arms_N[1])) { return
   __arms_N[1] }`, between the fork and the binding hoists.

## Why returns are decided at the join

A fork arm's value is whatever the arm returned: the bindings object, or a
value an earlier `return` carried (`forkBlockSetup.mustache` returns
`runner.haltResult`, and `Runner.handle`, `ifElse`, loops, and `thread`
blocks propagate a halt). So the join only has to ask whether arm 1 reached
its end. If it did not, the value it returned is the enclosing function's
return value.

That covers a user `return` at any depth, a bare `return` (the value is
`undefined`), and the failure of an interrupt rejected directly in the arm.
It also covers the `return` statements the hoist pass writes for `?`. The
hoist pass runs after this lowering, so a pass that rewrote `return`
statements could not see those. A `return` inside a block argument still
returns from the block, because the block is its own closure, and the
check needs no list of closure boundaries.

The check has to be written by `desugarOneParallel`, because only that
function knows the `__arms_N` name, and because the hoists after it read
properties off the marked object.

`__asyncDone` and `__asyncFinished` live in `lib/runtime/asyncJoin.ts`. The
marker is a string key starting with `__`, which no Agency program can
write. It is not a Symbol, because a branch that finished while its sibling
waits on an interrupt has its result saved in the checkpoint as JSON.

## Where the join is

`asyncArm(list, index)` in `asyncDesugar.ts` decides it, and the type
checker's refusals read the arm through the same function.

- `let x = async f()`: just before the first later statement that mentions
  `x`. "Mentions" is `namesMentioned` in `parallelDesugar.ts`: every
  variable read, called function name, and assignment target that
  `walkNodes` reaches. `walkNodes` is the descent template hygiene and scope
  resolution already depend on, so a name inside a `with` statement, a
  `match` arm, a cast, or an interrupt's arguments is found.
- `async f()`: the end of the block.
- Either way, never after a top-level `goto`, `break`, or `continue`: the
  join moves to just before the first one, because a node transition or a
  loop exit cannot run inside a fork arm (a `goto` in a branch crashes
  checkpoint serialization).

`identifierSlots` looks like the obvious table for "mentions", and it is the
wrong one. It answers where a name is written in the user's file, so it
drops every node without a source position, including the base of a
`valueAccess` (`name` in `name.length`) and every node the compiler
creates.

## Why the calls lower first to last

```agency
let name = async nameConversation(msg)
let facts = async extractMemories(msg)
const reply = llm(msg)
saveTitle(name)
saveFacts(facts)
```

First to last: `name` joins at `saveTitle`, so its arm is
`[async extractMemories, reply]`. Lowering that arm, `facts` is not used in
it, so its join is the end of the arm. The result is
`nameConversation ‖ (extractMemories ‖ reply)`. The bindings compose:
`facts` is hoisted out of the inner block into the outer arm, and
`collectBindings` carries it out of the outer block.

Last to first would form `facts`'s block first, with `saveTitle(name)`
inside it. `name`'s first use would then be that block, its arm would be
empty, and `nameConversation` would run alone before everything else.

## The positions refused

`lib/typeChecker/asyncChecks.ts`, `asyncRefusals`. Tree-only, like
`unwrapRefusals`, and called from both the checker and
`checkUnwrapsOrExit` in `buildSession.ts`, so `agency tc`, the editor, and a
compile with the checker off all report them. The lowering reports none of
them.

| Code | Position |
| --- | --- |
| AG1026 | inside an expression |
| AG1027 | module-level code or a parameter default (`hoistPositions` status `outsideBodies`) |
| AG1028 | a handler body (`hoistPositions` status `handlerBody`) |
| AG1029 | a callback body, which is a lifted `__cb_*` function by then |
| AG1030 | a direct arm of a `parallel` block |
| AG1031 | `?` on the async call |
| AG1032 | not a call |
| AG1033 | a `goto`, `break`, or `continue` nested inside the arm and not inside a loop that is itself in the arm |

The parser accepts `async` on any value access, as it always has, so these
errors carry a code and a location instead of a generic parse failure. The
one parse-time refusal is `async (x) => ...` as a block argument, which used
to be accepted and dropped.

The builder throws if a flagged call reaches codegen. That is a tripwire for
a toolchain bug; a user can never see it.

## Handlers in the two arms

A handler registered in one branch never answers an interrupt raised in a
sibling branch (`HandlerEntry.stack`, `inSiblingBranch` in
`lib/runtime/interrupts.ts`, and `docs/dev/runtime/interrupts.md`). Without
that rule, a side call that wraps itself in `with approve`, or is a
`preapprove()`d function, would approve the reply's interrupts for as long
as it runs. A handler around the whole block is on the parent stack, which
is an ancestor of both arms, so it answers both.

Each `handle` block removes its own entry when it ends
(`RuntimeContext.removeHandler`, by identity). The two arms enter and leave
their blocks in any order on the one shared list, so removing the newest
entry would take a sibling's handler away while it was still in its block,
and leave the caller's own handler applying after its block had ended.
`tests/agency/fork/handlers/handler-removed-by-its-own-block` covers both.

## Behaviour inherited from fork

- `runBatch` in `"all"` mode is `allSettled`. The first interrupt from one
  arm surfaces once the other arm has finished or is waiting on its own
  interrupt. After that the finished arm's result is cached, so later
  interrupts surface at once and a resume does not re-run it.
- A JavaScript error thrown by one arm is rethrown, and the other arm's
  pending interrupts are dropped. The node then returns a failure carrying
  the error, and the host sees no interrupt (`side-throws` pins this).
  Agency functions turn a throw into a failure, so this happens only for a
  TypeScript function called directly.
- An external pause cannot land on a branch stack and waits for the join
  (`docs/dev/runtime/pause.md`). The debugger stops inside branches, but its
  `set` command is refused there (`docs/dev/cli/debugger.md`).
- Under a decision-model provider, the collector is per block, so the two
  arms' decision calls share rounds (`docs/dev/llm/decision-models.md`).

## `restore()`

`RestoreSignal` thrown inside an arm leaves `runBatch` through its rethrow
path. The run loop restores the checkpoint and re-enters the fork step. A
checkpoint taken inside arm 1 holds no cached result for arm 0, even when
arm 0 had already finished, so the whole block starts again and the side
call runs a second time. `tests/agency/async/restore-inside-arm` pins this:
the side call and the main arm each run twice. A `restore()` to a checkpoint
taken before the `async` line is an ordinary restore, and also runs both
arms again (`restore-before-async`).

## What the old runtime did

Before this lowering, `async f()` compiled to a call with no `await`. The
promise was stored in a `PendingPromiseStore`, the preprocessor inserted
`awaitPending` before the first use, and every node return, interrupt
return, `checkpoint()`, and handler exit drained the store. An interrupt
raised inside the call threw `ConcurrentInterruptError`, because a
checkpoint taken while the call was in flight could not hold it, and
`async` was refused inside loops. The lowering clears the flag before
codegen, so none of that code runs any more; removing it is a separate
change. The notes file has the full comparison.
