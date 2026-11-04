# Review of the `spawn` spec and plan

Reviewed: `docs/superpowers/specs/2026-11-04-spawn.md` and
`docs/superpowers/plans/2026-11-04-spawn.md`, with the notes in
`docs/dev/language/fire-and-forget-notes.md` and the spike commit
`24541aa12`. Written 2026-11-04.

## Short answer

The design will work. Lowering `spawn` to a `parallel` block is the right
call: fork already answers every hard question about interrupts, checkpoints,
handlers, and thread ownership, and the spike found the one runtime gap
(the main arm losing the conversation thread) and closed it in 21 lines.

Three things need to change before the plan is implemented. One is a safety
problem in the recommended usage, two are in the lowering.

1. **Handlers leak across arms.** A `handle { } with approve` that is live in
   the side call approves interrupts raised by the reply, and the other way
   round. The spec and Task 6 recommend exactly that pattern. This is an
   existing property of fork, but spawn makes it the default shape of an
   agent turn. Scope handler entries to the branch that registered them
   before shipping spawn. Details in section 1.
2. **Do not rewrite `return` statements.** The `?` operator is lowered into
   `return` statements by the hoist pass, which runs after the spawn lowering
   would, so a rewrite cannot see them. A `?` after a `spawn` would silently
   return from the arm instead of the function. Decide at the join instead:
   mark the arm's normal completion and treat any other arm result as the
   function's return value. Details in section 2.
3. **Represent `spawn` as a flag on the existing call and assignment nodes**,
   where `async` sits today, not as a new statement type. Fifteen places in
   twelve files enumerate `parallelBlock` by name, and the symbol table, the
   effect propagation, the capability check, and `agency interrupts` all walk
   calls through generic tables. A new node type that any one of them misses
   drops the side call's effects from the function's signature with no error.
   Details in section 3.

The rest of this review lists edge cases the plan does not cover yet
(section 4), smaller corrections to the plan text (section 5), and the tests
I would add (section 6).

## 1. A handler in one arm answers the other arm's interrupts

### What the runtime does today

Handlers live in one list per run, `ctx.handlers` (`RuntimeContext` in
`lib/runtime/state/context.ts`). `pushRunHandler` appends `{ fn, liveGuardIds }`
and nothing else; `HandlerEntry` (`lib/runtime/types.ts:69`) has no field
saying which stack registered it. `runHandlerChain`
(`lib/runtime/interrupts.ts:275`) walks the whole list from the newest entry
to the oldest for every raise. The only entries it skips are ones currently
executing in the raising lineage, which stops a handler from hearing its own
raises. Branches share the run's context, so a `handle` block live inside
fork arm A is consulted for every interrupt raised in fork arm B.

The test `tests/agency-js/handler-fork-isolation/agent.agency` states this
in its header comment: "Fork branches SHARE the handler chain: branch B's
handler is invoked for branch A's interrupt."

### Why spawn makes it dangerous

The spec says: "A side call that should never ask wraps itself in
`handle { } with approve` or `with reject`." Task 6 says the two BMO side
calls "wrap themselves in `handle { } with approve` so they never hold the
reply." Take that literally:

```agency
def rememberQuietly(msg: string) {
  handle {
    extractMemories(msg)
  } with approve
}

node turn(msg: string) {
  spawn rememberQuietly(msg)
  return llm(msg, tools: [writeFile])
}
```

While `extractMemories` runs, the model calls `writeFile`, which raises
`std::write`. The chain walk finds the `with approve` entry pushed by
`rememberQuietly` and it approves. No other handler rejects or propagates,
so by the rules in `docs/site/guide/handlers.md` the write is approved and
the user never sees it. The approval lasts exactly as long as the side call,
which is the window the user cares about most: the reply is being produced.

The reverse direction is milder but still wrong. A handler around the reply
that approves `std::read` for a few paths also approves the side call's
reads for the same window.

`preapprove()` and the `with approve` modifier both register through the
same list, so neither is a safer spelling.

### The fix

Record the registering stack on the entry and skip entries that are not on
the raiser's ancestor chain. The pieces exist:

- `Runner.handle` has `this.stack` at registration time.
- `StateStack.parent` (`lib/runtime/state/stateStack.ts:492`) links a branch
  stack to the stack it branched from. `runBatch` sets it when the branch
  starts.
- `runHandlerChain` already receives the raising `stack`.

So `pushRunHandler(fn, liveGuardIds, stack?)` stores the stack, and the walk
skips an entry whose stack is set and is neither the raising stack nor one
of its ancestors. Entries registered with no stack (the `--policy` handler,
`withPushedHandler` from TypeScript, the init wrappers) keep applying
everywhere, which is what they mean today.

Resume is fine: handlers are rebuilt by replaying frames, and a replayed
`Runner.handle` runs on the resumed branch's stack, so the recorded stack is
the live one. The subprocess chain is fine too: a child's interrupts are
forwarded from the `_run` branch, and that branch is an ancestor of
everything the child does.

The `handler-fork-isolation` test asserts the sharing (each tag "ASKED"
once by the sibling's handler). It becomes a test that asserts zero
cross-arm asks.

I would make this Task 0b and land it before the lowering. If it has to wait,
the spec must stop recommending `with approve` on the side call and Task 6
must not do it, because the agent's reply is the main arm.

## 2. The `return` rewrite cannot see every return

### What the plan proposes

Task 2 step 3 walks the arm for `return` statements and rewrites each to
`return { __returned: true, value: e }`, then emits
`if (__spawn_n.__returned) { return __spawn_n.value }` after the join.

### Why it is not enough

Pass order in `TypescriptPreprocessor.preprocess`
(`lib/preprocessors/typescriptPreprocessor.ts:337`): decorators, guards,
`desugarParallelBlocks`, then `hoistCallsInProgram`. The plan puts the spawn
lowering just before `desugarParallelBlocks`. The hoist pass runs after it,
and the hoist pass is what lowers the `?` operator (`lowerUnwraps`,
`lib/preprocessors/hoistCalls.ts:504`):

```agency
const x = a()?
```

becomes

```agency
const __hoist_0 = a()
const __hoist_1 = isFailure(__hoist_0)
if (__hoist_1) { return __hoist_0 }
const x = __hoist_0.value
```

Those `return` statements are created after the spawn rewrite ran, inside
the fork body. At runtime they return from the arm. The arm's value is then
a failure object instead of the bindings object; the hoisted
`let x = __arms_n[1].x` reads `undefined`; the `__returned` check reads
`undefined`; and the function keeps going past the join with nothing wrong
reported. Any `?` after a `spawn` in the same block miscompiles silently.

The type checker does not catch it either. It refuses `?` at the top level
of a `parallel` arm (AG1024, `atTopLevelOfArm` in
`lib/typeChecker/unwrapChecks.ts:86`), but it runs before the lowering and
sees `spawn`, not `parallel`. If the lowering ran first, every `?` after a
spawn would be an AG1024 error instead, which is not what anyone wants
either: the reply code in an agent uses `?` freely.

A walking rewrite also has to know every closure boundary. `bodySlots`
(`lib/utils/bodySlots.ts`) marks the slots where a `return` yields to its
own closure (`retargetsReturn`: block arguments, inline handler functions,
finalize bodies), and the guard desugar keys on it. The plan lists "nested
`def`, `node`, and lambda bodies", and Agency has no lambdas
(`docs/dev/language/closures-and-lambdas.md`). Match-expression yields are a
separate node type (`matchYield`), so they are safe, but a rewrite that
misses a block argument would turn a decorator's block return into a
function return.

### Do it at the join instead

A fork arm's value is whatever the arm returned: the bindings object that
`desugarOneParallel` appends, or whatever an earlier `return` carried
(`forkBlockSetup.mustache` returns `runner.haltResult`). So mark the normal
completion and treat everything else as the function's return:

```agency
let __arms_0 = fork(["arm_0", "arm_1"], shared: true, mainThread: 1) as __arm_0 {
  if (__arm_0 == "arm_0") {
    let name = nameConversation(msg)
    return { name: name }
  }
  if (__arm_0 == "arm_1") {
    const reply = llm(msg)
    print(reply)
    return { __spawnDone: true, reply: reply }
  }
}
if (!__spawnFinished(__arms_0[1])) {
  return __arms_0[1]
}
let name = __arms_0[0].name
let reply = __arms_0[1].reply
```

`__spawnFinished` is a runtime helper, not generated code, because the value
can be `undefined` (a bare `return`), a failure (`?`, or a rejected
interrupt raised directly in the arm), or any user value. This handles the
`?` returns the hoist pass makes later, user returns at any depth, `return`
with no value, and a rejection in the arm, with no walk and no knowledge of
closure boundaries. `desugarOneParallel` needs to know the block came from a
spawn so it appends the marked object for that arm; an `origin: "spawn"`
field on `ParallelBlock` does that, and section 5 wants the same field for
error wording.

Nodes need the same check. A node's `return` is its result, so the join
returns it the same way.

## 3. Represent `spawn` where `async` sits today

The plan adds a `SpawnStatement` node and then lists walkers to update:
`descendIntoSubstructures`, `walkScopeBody`, `flowBuilder`,
`finalizeChecks`, the formatter. That list is short because most walkers do
not name node types. They go through `bodySlots` and `expressionSlots`
(`lib/utils/`), which the comment in `bodySlots.ts` describes as the one
place to add a body-bearing node: `mapBodies`, `walkNodes`, the lift pass,
the guard desugar, the unwrap checks, and `hoistPositions` all read them.
The symbol table credits callees and computes effects by walking calls; the
capability propagation and `agency interrupts` do the same. A statement
type whose call lives in a field none of those tables know is a call none
of them see. The result is a function that spawns an interrupting call and
whose signature says it raises nothing. Nothing reports that.

The old `async` keyword avoided this by being a flag: `async?: boolean` on
`FunctionCall` (`lib/types/function.ts:337`), `ValueAccess`
(`lib/types/access.ts:19`), and the literal (`lib/types/literals.ts:69`), with
the binding form being an ordinary `assignment` whose value carries the
flag. Every walker already sees an assignment and a call. Only three
consumers need to know the flag exists: the parser (set it, refuse it in
expression position), the formatter (print it), and the lowering (act on it
and clear it). The builder never sees it because the lowering runs first.

That also turns Task 5 from a removal into a rename, since the slots are
the same ones.

The one thing a flag cannot do is carry the `with` suffix as part of the
spawned call, but the parser already produces a `withModifier` node
wrapping the statement, and the lowering can look through it.

## 4. Edge cases

### `spawn f() with approve` is not a legal parallel arm

`ALLOWED_ARM_TYPES` (`lib/preprocessors/parallelDesugar.ts:55`) lists
`assignment`, `functionCall`, `valueAccess`, `seqBlock`, `parallelBlock`,
and comments. A `withModifier` is not on it, so the lowering's arm 0 for
`let x = spawn f() with approve` is rejected with a message about
`parallel`. Wrap the side call in `seq { }` in the lowering, or add
`withModifier` to the allowlist.

### The side call's arguments can see the main arm's writes

```agency
let n = 1
let x = spawn f(n)
n = 2
```

Locals are shared by reference between the arms (the fork body reads the
parent frame through the closure, which is what case 39 in the notes
relied on). Arm 0 evaluates `n` inside its first step, after several
awaits; arm 1 reaches `n = 2` after the same number of awaits. Which runs
first is decided by microtask order, not by the program. A plain call
would have read `1`. Evaluate the side call's arguments before the fork,
into temps, so `spawn f(n)` snapshots what a call would have seen; objects
stay aliased, as they do for any call. The same race exists for `parallel`
today, but there the author chose to write two arms.

### A trailing `goto` makes the statement form unusable in nodes

For `spawn f()` the join is the end of the block, and a `goto` in the arm
is a compile error. So a node whose body ends in `goto` cannot use the
statement form at all, and a node that ends in `return` only works because
of section 2. Bound the join before a trailing `goto`, `break`, or
`continue` at the top level of the block. A `goto` nested inside an `if`
mid-block stays an error.

The plan's loop rule and the spec's loop rule do not say the same thing.
The spec rejects a spawn in a loop body only when the value is used in the
body or a `break`/`continue` follows. The plan rejects "if the enclosing
list is a loop body and the join is inside it", and for a spawn in a loop
body the join is always inside it. Pick one. If the spec's version wins,
say that each iteration joins at the end of its body, so the side calls of
two iterations never overlap.

### An external pause waits for the whole turn

`docs/dev/runtime/pause.md` says a pause cannot land on a branch stack and
waits for the join. With `spawn` as the first statement of a turn, the join
is the end of the turn, so `pauseSignal` can never land during it. The spec
puts #1046 out of scope, which is fine, but the user-facing docs should say
that a pause requested during a spawned block lands after the block.

The debugger stops inside branches, but `set` is refused at a stop on a
branch stack (`docs/dev/cli/debugger.md`). After a `spawn`, `set` is
refused for the rest of the block.

### The first interrupt in the main arm waits for the side call

The spec says a slow side call "delays the reply by the difference". It
also delays the first approval prompt: `"all"` mode is `allSettled`, so an
interrupt raised by the reply's first tool call surfaces only once the
side call has settled. After that the side arm is cached and later
interrupts surface at once. For memory extraction that is one model call
of delay on the first `std::write` prompt of every turn. Worth a sentence
in the user docs.

### `restore()` inside the main arm leaves the side call running

The notes' case 4 says "restore unwinds it like any branch". It does not
unwind it; it abandons it. `RestoreSignal` thrown in the main arm leaves
`runBatch` through the rethrow path, the run loop restores the checkpoint
and re-enters the node, and the fork step re-enters `runBatch`. If the
checkpoint was taken inside the arm, the side branch's saved stack is a
mid-execution slice with no result, so the side call is re-run from its
step counters while the first invocation's promise is still in flight. Two
side calls, one of them a zombie writing its result into a discarded
`BranchState`. Fork has the same property, and the plan's
`restore-before-spawn` test covers the other shape. Add
`restore-inside-arm` and either document the double call or refuse
`restore()` from a spawn arm.

### A side call that throws abandons the reply's interrupt

`runBatch` rethrows the first JS error and drops sibling interrupts. A side
call written in TypeScript that throws while the reply is waiting on a
user's approval kills the turn and the prompt. Agency functions convert
throws to failures, so this only bites TypeScript helpers called directly.
Inherited from fork; a line in the docs is enough.

### Decision models batch the two arms together

`runForkAll` installs one decision collector per block, and a round fires
when the block is idle (`docs/dev/llm/decision-models.md`). Under a
decision-model provider the reply's calls and the side call's calls are
batched into shared rounds, so each waits for the other to be idle. Niche,
but it is a behavior the plain code did not have.

### The side subthread copies the whole conversation

`forkBranchView` seeds the side arm with a subthread of the active thread,
which deep-clones every message. A side call that calls `llm()` pays the
full conversation's context, and a side call that never calls `llm()`
still emits a `threadCreated` event. For naming a conversation that is
more context than needed; a `thread { }` inside the side function gets a
blank one. Say so in the docs.

### Cross-arm reference errors name `parallel` and `seq`

```agency
let x = spawn f(msg)
let msg = 2
```

The arm binds `msg` and the side call references it, so `desugarOneParallel`
reports "Parallel arm references `msg`, which is declared by a sibling arm.
Wrap both arms in a single `seq { ... }` block." The plan's constraint says
errors name the construct the user wrote. The `origin: "spawn"` field from
section 2 lets the desugar word it as a spawn error.

### Where `let` inside a `handle` body lands

The spec says the enclosing block of a spawn can be a `handle` body. A
`seq` outside `parallel` does not open a scope, so names leak. Confirm the
same for `handle` bodies before relying on "the join is the end of the
enclosing block" there, or the hoisted `let x` lands in a scope the code
after the handle cannot see.

## 5. Corrections to the plan text

- **Task 0 step 3 exposes `mainThread:` on user `fork()`.** Nothing stops a
  user from writing `fork(items, mainThread: 1)` over a dynamic list, or
  from nesting two forks that both claim it. Keep it internal: a field on
  the synthesized fork node that only the spawn lowering sets, and a parse
  error if a user types it. The runtime change (per-child `shareThreads`)
  is fine as is.
- **Task 2 step 2 and Task 3 step 2.** The lowering runs in the
  preprocessor, after type checking. The editor and `agency tc` never run
  the preprocessor, so "goto after spawn" and the loop errors would only
  appear at compile time. Follow the `unwrapRefusals` pattern in
  `lib/typeChecker/unwrapChecks.ts`: tree-only checks that the checker and
  the compile path both call. That is the "one place" the plan asks for.
- **Task 2 mentions "lambda bodies".** There are none. The closures are
  block arguments, inline handler functions, finalize bodies, and callback
  bodies, which `bodySlots` already lists.
- **Task 2 step 3, "the fork form is simpler if `parallel` has no way to
  return a value from an arm".** With the join check from section 2 there
  is no need to return a value from an arm; the arm's result is the arm's
  return value already.
- **Task 2, hoisting after an early return.** The hoisted
  `let x = __arms_n[i].x` statements run before the join check reads the
  marker, so they read properties off a failure or `undefined`. Emit the
  join check first, right after the fork, so the hoists never run on a
  non-completion value.
- **The spec's "Semantics to document" list** should gain the pause
  deferral, the first-interrupt delay, and the subthread copy from
  section 4, and should drop the `with approve` advice until section 1
  lands.
- **The two build problems** noted in Background (AG2009 at
  `stdlib/index.agency:704` and the `tool-multi-cycle` fixture) should be
  fixed or tracked before Task 0, or the task's verification cannot be
  trusted.

## 6. Tests to add

Beyond the plan's list:

- `side-handler-does-not-approve-main`: the side call has
  `handle { } with approve` and the main arm raises `std::write` with no
  other handler; the interrupt must reach the host. The reverse,
  `main-handler-does-not-approve-side`.
- `unwrap-after-spawn`: `let x = spawn f()` then `const y = g()?` where `g`
  fails; the function returns the failure and nothing after the join runs.
- `return-no-value` and `reject-in-arm` (an `interrupt` raised directly in
  the arm and rejected; the function returns the failure).
- `with-suffix-on-side-call`.
- `args-snapshot`: the example from section 4 returns a value computed
  from `1`.
- `goto-at-end-of-node` once the join bound is in.
- `restore-inside-arm`.
- A `tests/typescriptGenerator` snapshot of the lowered fork, so the shape
  (`mainThread`, `shared`, the marked completion, the join check before the
  hoists) is pinned.
- An `agency interrupts` case: a function that spawns an interrupting call
  lists that interrupt, which is the check that the walkers see the call.

## Is there a better way?

Not for the runtime. The notes compare the detached task with the lowering
honestly, and a third shape I considered, a branch that stays on the parent
frame while the parent keeps stepping, needs the parent to re-enter the
spawn step on resume, which the linear step counter cannot express without
new machinery. The lowering gets the join for free as the fork's own step.

Within the lowering, the three changes above are the better way: scope
handlers to the stack that registered them, decide returns at the join
instead of rewriting them, and carry `spawn` as a flag so no walker can
miss it. With those, I expect the plan to work.
