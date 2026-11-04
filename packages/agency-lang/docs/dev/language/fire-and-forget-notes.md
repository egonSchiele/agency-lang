# Fire-and-forget work: design notes

Status: decided and implemented as the `async` lowering (proposal 1 below),
under the existing `async` keyword. See `docs/dev/runtime/async.md`. Written
2026-11-04.

## The need

Some agent work should run beside the main reply without delaying it:

- naming a conversation (the agency agent does this)
- compacting a thread or extracting memories from it (memory is off in the
  agency agent today because it added too much latency)
- in BMO, the same two, and possibly subagent work whose result is not
  needed for the reply

The constraint that makes this hard is durability. When a run raises an
interrupt or pauses, its checkpoint must hold the whole execution state, so a
host can store it and resume months later in another process. Work that is
still running when the checkpoint is taken is work the checkpoint does not
hold.

The constraint that must not be weakened is composability of interrupts. Any
function may raise an interrupt, callers never need to know, and the user
always gets to answer. A construct whose call tree cannot raise would break
every standard-library function that raises.

## Existing constructs

`async` is a relic and is being removed. It runs a call concurrently, stores
the promise in a frame local, awaits it before first use, and drains every
pending promise at four boundaries: node return, interrupt return,
`checkpoint()`, and handler exit. An interrupt raised inside an `async` call
throws `ConcurrentInterruptError`. Its concurrency and interrupt handling
predate `fork`, `parallel`, `race`, and concurrent interrupts, so nothing
about it should guide the design.

`fork`, `parallel`, and `race` run branches inside the parent's checkpoint
tree. Each branch has its own `BranchState` under the parent frame. An
interrupt in one branch is batched with interrupts from siblings, one shared
checkpoint is stamped, and one `respondToInterrupts` resumes all of them.
Completed branches cache their result and are not re-run. `runBatch` in
`lib/runtime/runBatch.ts` owns this. See
`docs/dev/runtime/concurrent-interrupts.md`.

`run()` from `std::agency` executes a compiled program in a subprocess. The
parent is blocked inside `_run`, a one-child `runBatch`. When no handler
resolves a child interrupt, the child checkpoints itself and exits, and the
parent stores that checkpoint as an opaque payload in a frame local. If
`run()` sits in a fork beside a branch that interrupts, `allSettled` waits
for the child to finish or pause before the batch stamps its checkpoint. So
`run()` never leaves anything executing. See
`docs/dev/runtime/subprocess-ipc.md`.

External pause (`pauseSignal`) stops a run at its next statement boundary and
returns a `PausedCheckpoint`. It cannot land inside a branch or a tool call
today; issue #1046 tracks that. See `docs/dev/runtime/pause.md`.

## Proposals considered

### 1. Lower `async f()` to a parallel block

The rest of the enclosing node body becomes the sibling arm:

```agency
node main() {
  let userMessage = input("> ")
  parallel {
    nameConversation(userMessage)
    seq {
      const response = llm("Respond to: ${userMessage}")
      func2()
      return response
    }
  }
}
```

What it inherits from fork, for free: concurrent interrupts from either arm
are batched and resumable, handlers enclosing the block apply inside both
arms, branch threads go to subthreads, and locals are shared by reference.

What it costs:

- An interrupt in the main arm waits for the side arm to settle before it
  surfaces, because `"all"` mode is `allSettled`.
- An interrupt in the side arm halts the whole block, so the node cannot
  return the reply until the user answers the side arm's question.
- The node's return waits for the side arm to finish.
- Lowering constraints: `return` inside the arm returns from the branch, so
  the node's returns must be rewritten; `break` and `continue` cannot cross
  the block, so the construct cannot sit inside a loop body; globals are
  isolated per arm unless `shared: true`; an external pause cannot land until
  the join (#1046). Lower inline into the arm, not into a separate `def`, so
  locals stay in scope.

### 2. `spawn` as a detached run that may not raise

Rejected. It breaks the composability guarantee.

### 3. `spawn` as a self-pausing task with its own checkpoint

Modelled on `run()`: the task is its own run, raises through its own handler
chain, and when nothing resolves an interrupt it checkpoints itself. At every
parent boundary (interrupt, return, external pause, `checkpoint()`), the
runtime pauses live tasks at their next statement and carries their
checkpoints inside the parent's checkpoint as opaque payloads.

This keeps the checkpoint complete and keeps every raise reachable. The
experiments below show what it costs: because the task is outside the
parent's frame tree, each thing fork gets for free needs its own rule. Those
rules are listed under each case. Taken together they are a set of special
cases rather than one mechanism, which is the reason to prefer proposal 1.

## Edge cases

The six most likely to force design changes were tested first. Programs are
in `scratch-spawn/` at the package root, one folder per case, each with an
`agent.agency` and a `test.js`. Compile with `agency compile agent.agency`
and run with `node test.js`. Each was run with fork standing in for the task,
since no task construct exists.

### Case 4: `restore()` to a checkpoint from before the spawn

```agency
node main() {
  const cp = checkpoint()
  bump()                      // stands in for a spawn
  if (bumpCount() < 2) {
    restore(cp, {})
  }
  return bumpCount()
}
```

Result: 2. Replay re-executes everything after the checkpoint. A detached
task would be spawned twice, with the first still running. Under proposal 3
this needs a rule: checkpoints record a task sequence number and `restore` or
`rewind` cancels tasks spawned after it. Under proposal 1 the side arm is a
branch and restore unwinds it like any branch.

### Case 17: the node returns a value while a task has a pending interrupt

A node run returns `{ data, messages, usage, traceId }`, where `data` is one
of the return value, an `Interrupt[]`, or a `PausedCheckpoint`
(`lib/runtime/types.ts`). There is no shape for a value and interrupts
together. Under proposal 3 task interrupts would need a separate `detached`
field with their own resume call. Under proposal 1 a side-arm interrupt means
the node is not done, which is the existing semantic, and the reply can reach
the host as a partial result before the join.

### Case 19: a handler that enclosed the spawn must apply inside the task

```agency
node main() {
  handle {
    spawn summarizeAndText()
  } with (intr) {
    if (intr.effect == "std::text") { return reject() }
    return pass()
  }
}
```

Handlers are live closures on `ctx.handlers` (`HandlerEntry` in
`lib/runtime/types.ts`), pushed when the `handle` statement executes and
never serialized. Resume rebuilds them by replaying the enclosing frames,
which re-enter any open `handle` block. A detached task with its own
checkpoint has no enclosing frames to replay, so the handler would be gone.
The only design found that keeps the guarantee under proposal 3 copies the
parent's frame slice from root to the spawn statement into the task's
checkpoint and replays it with a new "stop after this step" runner mode.
Under proposal 1 branches inherit the chain today
(`tests/agency-js/handler-fork-isolation`).

### Case 26: spawn inside a fork branch that then completes

```agency
node main() {
  const r = fork(["a", "b"]) as tag {
    return "branch-local-${tag}"
  }
  const x = interrupt("after fork")
  return { r: r, x: x }
}
```

The checkpoint stamped at the interrupt has `branches: {}`. Branch frames are
discarded at the join. Under proposal 3 a task's state cannot live in the
branch that spawned it and needs a run-level registry at the checkpoint
root. Under proposal 1 a nested parallel block inside a branch is a nested
fork, which is supported.

### Case 38: where the task's messages go

```agency
node main() {
  assistantMessage("from parent before fork")
  const r = fork(["a"]) as tag {
    assistantMessage("from branch ${tag}")
    return currentThreadId()
  }
  const x = interrupt("after fork")
  ...
}
```

The branch wrote to subthread `t1` with parent `t0`. The main thread kept
only the parent's message. Both threads are in the shared registry and in
the checkpoint. This works for either proposal; a detached task would carry
its own registry copy.

### Case 39: the parent mutates an object it passed to the task

```agency
node main() {
  const o = { n: 0 }
  const results = fork(["a"]) as tag {
    o.n = o.n + 1
    interrupt("pause in branch")
    o.n = o.n + 10
    return o.n
  }
  return { branch: results[0], parent: o.n }
}
```

Both sides ended at 11 after the interrupt and resume. The branch reads `o`
through the parent's frame, so there is one copy in the checkpoint. A
detached task cannot alias across a resume and would need snapshot-at-spawn
argument semantics. Under proposal 1 aliasing is the existing fork behaviour.

### Summary

| Case | Proposal 3 (own checkpoint) | Proposal 1 (lower to parallel) |
|---|---|---|
| 4 restore past spawn | new rule: cancel later tasks | existing branch unwind |
| 17 value plus interrupts | new `detached` result field | node not done until answered |
| 19 enclosing handlers | copy parent frames into task checkpoint | inherited today |
| 26 spawn inside a branch | new run-level task registry | nested fork, supported |
| 38 thread ownership | works, duplicate registry copy | works |
| 39 mutated arguments | snapshot at spawn | works |

### Remaining cases, not yet tested

Grouped as listed in the discussion.

Parent boundaries while a task is live: external pause; a parent interrupt
that a handler approves; node transition; parent throws, fails, or is
cancelled; task already finished; task mid `sleep()` or mid model call;
task inside a tool loop (#1046); two tasks of different speed; task finishing
between pause request and pause landing.

Task interrupts: no handler anywhere; task and parent both interrupt; task's
own `handle` resolves it; parent handler propagates; user rejects; multi-cycle;
raise inside a handler function; host answers only the parent's interrupts.

Where the spawn sits: inside a tool called by `llm()`; inside a loop; inside
a race loser; inside a handler function; at module top level; inside an
exported function called without a node; task spawns a task; task forks
internally; task calls `run()`; interrupt while evaluating the spawn's
arguments.

State: globals; memory store and `session:` threads; locks held by the parent.

Cost, guards, observability, host: cost charged to the parent's budget; time
guards; task failure reaching the host; host ignoring pending tasks; host
resuming a task after the parent completed; one trace in statelog; resuming
twice from one stored checkpoint.

## Where this stands

Proposal 3 keeps the checkpoint complete and keeps interrupts composable,
but only by adding a rule per case. Proposal 1 inherits the answers from
fork, and its costs are latency, not correctness:

- the main arm's interrupt waits for the side arm to settle
- the side arm's interrupt delays the node's return
- the node's return waits for the side arm

Two general runtime changes would remove most of that latency and would
benefit every concurrency construct, not only this one:

1. Let an external pause land inside a branch (#1046). A host that has the
   reply can then pause the run and resume it in the background, which is
   fire-and-forget at the host level using existing pause and resume.
2. When one branch interrupts, pause its siblings at their next statement
   boundary instead of waiting for them to finish. The paused branches
   already have a place in `BranchState` (a checkpoint with no `interruptId`)
   and resume re-invokes any branch without a cached result.

With those, a `spawn` or `async` keyword becomes sugar for the parallel
lowering, carrying the lowering constraints listed under proposal 1 and no
runtime semantics of its own.

## Spike results (2026-11-04)

The user accepted the join semantic: the main request waits for the side
request when the side request is longer. That removes every runtime change
except one, found by the spikes below. Programs are in `scratch-spawn/` in the
main checkout and in `worktrees/spawn-spike/packages/agency-lang/scratch-spawn/`.

| Spike | Program | Result |
|---|---|---|
| `llm()` inside a fork arm | `llmthread` | The arm's reply went to subthread `t2`. After the join, the parent's next `llm()` did not see it. The main conversation would lose its own reply. |
| Same, with the arm sharing the parent's active thread | `mainthread` on branch `spawn-spike` | With `fork(items, mainThread: 1)` the arm's reply landed on `t0`, survived an interrupt in the arm and a resume, and the parent's follow-up call saw it. The side arm still wrote to its own subthread. |
| `endTurn()` from a tool inside a fork arm | `endturn` | Works. One model call, tool result used as the answer. |
| `goto` inside a fork arm | `goto` | Crashes the runtime with a stack overflow in checkpoint serialization. Must be a compile error inside a spawn arm. |
| `return` inside a fork body | `return` | Returns from the arm only. Code after the block runs. The lowering must rewrite returns. |

The one runtime change is a per-branch option that lets one fork arm write
to the parent's active thread. `runBatch` already has a batch-level
`shareThreads` used by the tool loop; the spike made it per child and
exposed it as `mainThread: <index>` on `fork()`. The diff is 21 lines across
`runBatch.ts`, `runner.ts`, `typescriptBuilder.ts`, and
`typeChecker/builtins.ts`. The fork, parallel, and `runBatch` test suites
pass with it.

The spec is `docs/superpowers/specs/2026-11-04-spawn.md` and the plan is
`docs/superpowers/plans/2026-11-04-spawn.md`.
