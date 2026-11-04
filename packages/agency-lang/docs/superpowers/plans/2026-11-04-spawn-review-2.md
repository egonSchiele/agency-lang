# Review of the `spawn` plan, second draft

Reviewed: `docs/superpowers/plans/2026-11-04-spawn.md` (the revised draft in
the main checkout), against the spec, the first review
(`2026-11-04-spawn-review.md` beside this file), and the code on `main`.
Written 2026-11-04.

## Short answer

The revision took in everything the first review asked for, and the overall
shape is right. Eight problems remain. Two would make the lowering miscompile
without any error, and two weaken the handler fix in Task 0b. All eight fit
inside the existing task structure. None of them needs a new task.

Must fix before implementing:

1. **The join check cannot be emitted where the plan puts it.** The spawn
   pass does not know the `__arms_n` name, and anything it places after the
   `parallelBlock` ends up after the binding hoists. `desugarOneParallel`
   has to emit the check itself.
2. **The first-use search misses references.** `collectReferences` has no
   case for `with` modifiers, `match`, casts, interrupts, and several more
   node kinds. I reproduced this: `print(x) with approve` in a `seq` arm
   reads `undefined` with no error. With `spawn`, the arm is ordinary code,
   so this hole will be hit often.
3. **`.preapprove()` keeps leaking across branches.** Task 0b exempts it,
   but it is exactly the blanket approve the task exists to scope.
4. **The handler skip should fail closed.** If any raise path passes the
   wrong stack, the plan's rule would silently skip a handler that should
   run. A slightly different rule gives the same scoping without that risk.
5. **The two-spawn order loses the overlap.** Processing spawns from last
   to first makes the first spawned call run alone, before the second
   spawn's block, in the most common two-spawn shape.

Should fix:

6. `let x = spawn f()?` loses the failure.
7. A `spawn` at the top level of a `parallel` block has no sensible join.
8. Task 0's fixture cannot be written as described, and the "parser test"
   for `fork(..., mainThread: 1)` tests the wrong layer.

Smaller notes are at the end.

## 1. The join check must come from `desugarOneParallel`

Task 2 step 4 says the spawn lowering emits this right after the fork,
before the binding hoists:

```agency
if (!__spawnFinished(__arms_n[1])) {
  return __arms_n[1]
}
```

The spawn pass cannot produce that statement in that position. Here is what
`desugarOneParallel` (`lib/preprocessors/parallelDesugar.ts:485`) does:

- It picks the suffix itself, with `nextSuffix()`, while it runs, so
  `__arms_n` does not exist yet when the spawn pass runs.
- It returns `[let __arms_n = fork(...), let X = __arms_n[i].X, ...]` in
  place of the one `parallelBlock` statement.

So a statement the spawn pass puts after the `parallelBlock` lands after
every hoist. The hoists then read `.x` off a failure or `undefined` before
the check ever runs, which is the ordering problem the first review raised.

The fix is small. When `pb.origin === "spawn"`, `desugarOneParallel`
appends the marked completion to arm 1, as the plan already says, and
pushes the join check between `letAssign(armsVar, fork)` and the hoist
loop. The spawn pass then emits only the `parallelBlock`. Step 4 should say
this. The snapshot test in Task 2 already pins the order.

## 2. The first-use search needs a complete walker

Task 2 step 1 finds the join with `collectReferences`. That function is a
hand-written switch (`parallelDesugar.ts:188`). Its cases are
`variableName`, `assignment`, `functionCall`, `binOpExpression`,
`valueAccess`, arrays, objects, strings, `ifElse`, the two loops,
`returnStatement`, `seqBlock`, `parallelBlock`, `messageThread`, and
`handleBlock`. Everything else falls through to `default: return`, and that
includes `withModifier`, `matchBlock`, `castExpression`, `comprehension`,
`interruptStatement`, `isExpression`, `typeTestExpression`,
`tryExpression`, `newExpression`, `gotoStatement`, and `nodeCall`.

I checked what happens today with a hand-written `parallel` block:

```agency
def g(): number {
  parallel {
    let x = h()
    seq {
      print(x) with approve
    }
  }
  return x
}
```

This compiles and prints `undefined`. Without the `with approve`, the same
code is refused with the cross-arm error. The cross-arm check uses the same
walker, so it misses the reference too.

For `parallel`, arms are short and this has gone unnoticed. For `spawn`,
the arm is the rest of the block, written as ordinary code. Here is the
same failure with `spawn`:

```agency
let name = spawn nameConversation(msg)
saveTitle(name) with approve
```

The walker does not see `name` inside the `with` statement, so the join
moves to the end of the block. `saveTitle` then runs inside the arm, before
`name` is assigned, and receives `undefined`. The typechecker cannot catch
it, because it checks the code before the lowering.

`lib/utils/identifierSlots.ts` was built for this. Its registry is a
`Record<AgencyNode["type"], …>`, so the compiler refuses a new node kind
that is not registered. Find the join with `walkNodes` and `identifierSlots`.
Check whether it reports an assignment's left-hand side, since step 1 wants
that counted as a use. Use the same walk for the cross-arm check, which
fixes the `parallel` hole as well. Add `value-in-with-statement` and
`value-in-match-arm` to the fixture list.

## 3. `.preapprove()` must record its stack too

Task 0b step 1 lists the registrations that keep applying everywhere: "the
`--policy` handler, `withPushedHandler` from TypeScript, the init wrappers,
and `preapprove()`". Two of those four are the problem the task exists to
fix.

`AgencyFunction.preapprove()` (`lib/runtime/agencyFunction.ts:468`) wraps
every call of the function in `withPushedHandler(run.ctx, autoApprove, …)`,
which approves every interrupt except guard trips. The guide documents it as
"Auto-approve every interrupt this function raises"
(`docs/site/guide/builtins.md:66`). What it actually approves is every
interrupt raised anywhere in the run while the call is in flight. For
example:

```agency
const quietRemember = rememberFacts.preapprove()

node turn(msg: string) {
  spawn quietRemember(msg)
  return llm(msg, tools: [writeFile])
}
```

While `rememberFacts` runs, the reply's `std::write` is approved. This is
the same leak as `handle { } with approve`, written differently. It also
happens today between two tool calls in the same model round, because the
tool loop runs each call as a branch.

Both TypeScript paths can pass a stack. The wrapped body receives `run`, so
`preapprove` can pass `run.stack`. `agency.withHandler`
(`lib/runtime/agency.ts:294`) already calls `currentRun()`, so it can pass
`run.stack` too. When either one is registered at the root, the root stack
is an ancestor of every branch, so its reach does not change. Only the
`--policy` handler and the global-init wrapper have no stack to record. Add
a fixture where a preapproved function runs in one fork arm and the other
arm's raise reaches the host.

## 4. Make the handler skip fail closed

Step 3 skips an entry "whose `stack` is set and is neither the raising
`stack` nor one of its ancestors". This is correct when every raise passes
the stack it is running on. If one path passes an ancestor instead, the
rule fails open. For example, `interruptWithHandlers` falls back to
`opts?.stack ?? run.stack`, so a run whose `stack` is the root while the
code runs in a branch would pass the root. A `with reject` registered inside
that branch is then not an ancestor of the raiser, so it is skipped, and the
raise goes ahead on another handler's approval. The project rules say a
skipped handler is a critical issue, so the rule should not depend on every
caller being right.

A rule with the same intended effect that fails closed: skip an entry only
when its stack and the raising stack sit in separate subtrees. That means
the entry's stack is not the raiser's stack or an ancestor of it, **and**
the raiser's stack is not an ancestor of the entry's stack. Sibling arms
are still isolated from each other. A raise that reports an ancestor stack
still consults the branch's handlers, as it does today. A raiser can only
be an ancestor of a live handler's stack through a bug, because a parent
stack is suspended while its branches run, so the second condition costs
nothing.

Also add to step 4 the list of every caller of `interruptWithHandlers` and
`gatherChainOutcome`, with the stack each one passes:

- generated code
- the TypeScript `interrupt()` in `agencyInterrupt.ts`
- `guardTripInterrupt.ts`
- `ipc.ts`, which passes `s.stateStack`, the stack `_run` was called on

Then add a fixture for the TypeScript path: a helper raises through
`agencyInterrupt.ts` inside a fork arm, a `with reject` sits in the same
arm, and the raise must be rejected.

Two consequences belong in the plan:

- **Tool calls in one `llm()` round stop sharing handlers.** The tool loop
  runs each call as a branch. After 0b, a handler inside one tool no longer
  answers a sibling tool's raise. This is the fix, but it can surface
  prompts that were silently approved before, including in `agency agent`.
  The changelog should say so. Task 0b's verification should run
  `tests/agency/fork/llm-tools` and include a short `agency agent` session.
- **`parent` is live-only.** `rehydrateInheritedGuards` sets
  `branch.stack.parent` on every entry (`runBatch.ts:326`), so a resumed
  branch has it before it runs any code. Say this in step 4, because it is
  why the resume half of the argument holds.

## 5. Process spawns from first to last

Step 2 of the lowering goes "from the last `spawn` to the first so nested
joins come out right". Take the BMO shape:

```agency
let name = spawn nameConversation(msg)
let facts = spawn extractMemories(msg)
const reply = llm(msg)
saveTitle(name)
saveFacts(facts)
```

Last to first: `facts` joins at `saveFacts`, so its arm is
`[reply, saveTitle(name)]` and that becomes a `parallelBlock`. Then `name`
looks for its first use. `saveTitle(name)` is now inside that block, so the
join is the block itself and `name`'s arm is empty. Step 7 turns it into a
plain call. `nameConversation` runs alone, first, and the reply waits for
it.

First to last: `name` joins at `saveTitle`, so its arm is
`[spawn extractMemories, reply]`. Lowering that arm recursively, `facts` is
not used inside it, so its join is the end of the arm. The result is
`nameConversation ‖ (extractMemories ‖ reply)`. That is the overlap the
feature exists for. It also matches the spec's own sentence: "The second
spawn's join is bounded by the first spawn's arm."

First to last also works for the hoists. `facts` is hoisted out of the
inner block into the outer arm, and `collectBindings` then carries it out of
the outer block, because it descends into `parallelBlock` bodies.

The two-spawn fixtures only check values, and both orders give the same
values. Add one fixture that proves overlap, for example with a TypeScript
helper that records start and end order, or with the counter helper the
plan already uses for `spawn-in-loop-body`.

## 6. `?` on the spawned call

The plan does not say what `let x = spawn f()?` means. As written, the hoist
pass lowers the `?` inside arm 0 into `if (isFailure(t)) { return t }`.
Arm 0's value is then the failure. The join check only looks at arm 1, so
`let x = __arms_n[0].x` reads `undefined` and the failure is lost.

Refuse it in Task 3 with an AG code, worded like "unwrap the value after the
join: `let r = spawn f()` then `const x = r?`". The other option is to run
the check on arm 0 too. Refusing is simpler and keeps the side arm a single
call.

## 7. `spawn` directly inside a `parallel` block

The plan applies the pass to every list `bodySlots` reaches, "`seq` and
`parallel` arms" included. The body of a `parallel` block is a list of arms,
not a sequence of statements. "The rest of the block" after a top-level
spawn there would be the sibling arms. Wrapping them in a `seq` would make
them run one after another, which changes what the author wrote. Refuse
`spawn` at the top level of a `parallel` body. A `spawn` inside a `seq` arm
is fine, and `spawn-in-seq-arm` already covers it.

## 8. Task 0's tests

- "A fixture `tests/agency/fork/main-thread.agency` built from a `parallel`
  block with the field set by a test helper" cannot be written. A
  `tests/agency/` fixture is compiled from source, and no helper can set an
  AST field. Task 0 can be tested with the `runBatch.test.ts` case plus a
  builder unit test that builds the `fork` node by hand and checks the
  emitted argument. The end-to-end thread fixture then moves to Task 2,
  where `llm-in-main-arm` already covers it. The JavaScript test copied
  from `scratch-spawn/mainthread` has the same problem unless it uses the
  spike's syntax, so move it to Task 2 as well.
- "A parser test that `fork(items, mainThread: 1)` is refused": the parser
  validates named arguments only for `parallel(...)` (`parsers.ts:6964`).
  For `fork`, the typechecker's builtin table and the builder do the
  validation. So that case is a typechecker test, and only
  `parallel(mainThread: 1)` is a parser test.

## Smaller notes

- **Argument snapshot (Task 2 step 3).** Snapshot more than the arguments.
  In `spawn notes.summarize(x)`, the main arm can rebind `notes`, and in
  `spawn handler(x)` it can rebind `handler`. Snapshot the receiver of a
  method call, and the callee when it is a local. Also say that a block
  argument stays where it is. Once everything is snapshotted, the side arm
  references only temporaries, so step 6's cross-arm example cannot happen.
  In plain code, `let msg = 2` after `f(msg)` is a redeclaration anyway.
  Drop `redeclares-side-call-name`, or name the case it still covers.
- **A call in an argument runs before the overlap.** `spawn f(g())` now
  evaluates `g()` before the fork, the way a plain call would, so
  `spawn f(llm(prompt))` runs that `llm()` before the overlap starts. One
  sentence in the guide.
- **One field instead of two.** `origin: "spawn"` already implies that arm
  1 owns the thread. `ParallelBlock.mainThread` could go, with `forkCall`
  setting the fork node's field from `origin`. That leaves one marker and no
  way for the two fields to disagree. Optional.
- **Decision-model batching** (from the first review) dropped out of the
  Task 4 doc list. Under a decision-model provider, the reply's calls and
  the side call's calls share rounds.
- **The spec's lowered example** shows `parallel(shared: true, mainThread: 1)`
  as if a user could type it. Add that to the spec edits: `mainThread`
  appears there as a node field only.
- **Reserved word.** Making `spawn` reserved breaks code that imports a
  JavaScript `spawn`, such as `import { spawn } from "node:child_process"`.
  Nothing in the repository does that. Add one line to the changelog.
- **Task 0b's `handler-fork-isolation` change.** "No cross-arm asks" is the
  new assertion. Also assert that each arm's own handler still answers its
  own raise, so the test fails if the skip turns everything off.

## What I checked

- `parallelDesugar.ts`: the suffix, the output order, `collectBindings`,
  and every case in `walkForReferences`.
- `runBatch.ts:318-327`: `parent` is set on every entry into a branch,
  including after a resume.
- `interrupts.ts:275-360` and `640-680`: the chain walk and how the stack
  is chosen.
- `runner.ts:886-930` (`Runner.handle`), `asyncContext.ts:401`
  (`withPushedHandler`), `agencyFunction.ts:468` (`preapprove`),
  `agency.ts:294` (`withHandler`), `ipc.ts:688-735` (the subprocess chain),
  and `guardTripInterrupt.ts:148`.
- Ran three small programs on the current `dist`. A `let` inside an `if`
  in a `seq` arm hoists correctly. A redeclaration after the block is
  accepted. A reference inside `print(x) with approve` in a `seq` arm reads
  `undefined` and gets no cross-arm error.
