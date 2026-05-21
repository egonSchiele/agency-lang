# Thread Builtins and `std::thread` Module

## Summary

Add low-level `__internal_*` builtins for thread state manipulation (messages, cost, tokens) and expose them through a new `std::thread` stdlib module with user-friendly wrappers. Rename the existing `system()` builder macro to `__internal_systemMessage()` (breaking change). Track LLM cost and tokens **per concurrent branch**, with branch totals propagating to the parent on join.

## Motivation

Agency accumulates message history and cost/token data behind the scenes, but users have no way to interact with this state from Agency code. They can't add user or assistant messages to the conversation, and they can't read how much they've spent mid-execution. The only access points today are the return value of running a node from TypeScript (for the run-level token stats) and the `system()` builder macro (for system messages).

Additionally, the existing `system()` function is a magic global that doesn't follow any naming convention and pollutes the global namespace. Moving it to a stdlib module alongside related functions is cleaner.

## Design

### Naming convention

All five builtins live in `CONTEXT_INJECTED_BUILTINS` and follow that registry's existing rule: names MUST start with `__internal_` (see [lib/codegenBuiltins/contextInjected.ts](../../../lib/codegenBuiltins/contextInjected.ts), `ContextInjectedBuiltin.name` JSDoc and `looksLikeInternalBuiltin()` typo guard). The user-visible names live in `std::thread` and have no prefix.

### Layer 1: `__internal_*` builtins (compiler-level)

Registered in `CONTEXT_INJECTED_BUILTINS`. The compiler prepends `__ctx` as the first argument automatically. Cost-aware builtins additionally receive the caller's local `__stateStack` (see "Per-branch stack threading" below). Users cannot call these directly (`__` prefix is reserved).

| Builtin                                | Behavior                                                                 | Return type |
|----------------------------------------|--------------------------------------------------------------------------|-------------|
| `__internal_systemMessage(msg)`        | Push a system message onto the active thread. Replaces `system()` macro. | `void`      |
| `__internal_userMessage(msg)`          | Push a user message onto the active thread.                              | `void`      |
| `__internal_assistantMessage(msg)`     | Push an assistant message onto the active thread.                        | `void`      |
| `__internal_getCost()`                 | Cumulative cost (USD) for the current branch chain.                      | `number`    |
| `__internal_getTokens()`               | Cumulative total tokens for the current branch chain.                    | `number`    |

The TS implementations live in `stdlib/lib/thread.js`, importable from generated code as `agency-lang/stdlib-lib/thread.js` (mirroring the `MEMORY_FROM = "agency-lang/stdlib-lib/memory.js"` constant in the registry). The package's `exports` map in `package.json` must expose the new path.

#### Per-branch stack threading

Today every context-injected builtin emits `await __internal_foo(__ctx, ...args)`. The cost builtins need the caller's local `__stateStack` (the per-branch stack that `forkBlockSetup.mustache` installs as `__forkBranchStack`) so that `getCost()` can read the current branch's accumulator. `ctx.stateStack` is the root — not the branch's stack — so the local must be threaded from the call site.

Rather than introduce a per-entry flag, change codegen for *every* context-injected builtin to always emit:

```ts
await __internal_foo(__ctx, __stateStack, ...args)
```

`__stateStack` is always in scope inside generated function/node bodies (the function-frame setup template binds it), so this is a pure codegen change.

The implication is that the 9 existing memory builtins (`__internal_setMemoryId`, `__internal_shouldRunMemory`, etc.) gain an unused `_stack` parameter as their second arg. Their JS signatures change from `(ctx, ...args)` to `(ctx, _stack, ...args)`. This is a one-line edit per builtin and keeps the registry uniform — no `needsStack` flag, no codegen branch.

Codegen in [lib/backends/typescriptBuilder.ts](../../../lib/backends/typescriptBuilder.ts) at the `isContextInjectedBuiltin` branch (currently line 1893):

```ts
if (isContextInjectedBuiltin(node.functionName)) {
  return this.emitDirectFunctionCall(node, functionName, shouldAwait, [
    ts.id("__ctx"),
    ts.id("__stateStack"),
  ]);
}
```

The two message builtins still accept `(ctx, _stack, msg)` even though they don't use the stack — they operate on `ctx.threads.active()` (one thread store per runtime context). That matches today's `system()` macro which inlines `__threads.active().push(...)`, where `__threads` is bound to `ctx.threads` at function-frame setup.

#### Implementation notes for messages

- Add `pushMessage(role: "system" | "user" | "assistant", content: string): void` to `RuntimeContext` ([lib/runtime/state/context.ts](../../../lib/runtime/state/context.ts)). It calls `this.threads.active().push(smoltalk.systemMessage(content))` (or `userMessage`/`assistantMessage`).
- The three `__internal_*Message` functions in `stdlib/lib/thread.js` are one-line wrappers that call `ctx.pushMessage(...)`.
- The existing `system()` builder macro special case at `typescriptBuilder.ts:1879-1886` is deleted.
- After removal, `system` becomes a free identifier — verify the parser/lexer does not treat it as a reserved word (we believe it is not, since the special case is purely in the codegen builder).

### Per-branch cost and token tracking

This is the core design decision. Cost and tokens are tracked per-branch (per `StateStack`). When a branch is created, it inherits the parent's running total. When branches join, each branch's *delta* (what it accumulated past the inherited starting point) is added back to the parent.

#### Data model

Add two serialized fields to `StateStack` ([lib/runtime/state/stateStack.ts](../../../lib/runtime/state/stateStack.ts)):

```ts
class StateStack {
  // ... existing fields ...
  localCost: number = 0;
  localTokens: number = 0;
}
```

Both `localCost` and `localTokens` are added to `StateStackJSON` so they survive checkpoints and resume. No parent pointer is needed — each branch holds its own running total, inherited from the parent at creation time.

#### Branch creation: copy parent's running total

In `Runner.runForkAll` and `Runner.runRace`, where today we set `existing.stack.abortSignal`, also seed the branch's accumulators from the outer stack:

```ts
const existing = this.frame.getOrCreateBranch(branchKey);
if (!existing.result && existing.stack.localCost === 0 && existing.stack.localTokens === 0) {
  // first time we're seeing this branch — copy parent totals as the inherited baseline.
  existing.stack.localCost = stateStack.localCost;
  existing.stack.localTokens = stateStack.localTokens;
}
```

The conditional guards against overwriting a restored branch on resume (where `localCost` is already populated from the saved checkpoint). `stateStack` here is the outer (parent-frame) stack — the same one we capture checkpoints against.

A cleaner alternative: change `State.newBranch(key)` to take optional `seedCost`/`seedTokens` params, and call it from the runner. That keeps the copy logic next to the branch construction. Either is fine; the runner-side version is shorter.

#### Write path: LLM completion

In [lib/runtime/prompt.ts](../../../lib/runtime/prompt.ts), after `updateTokenStats({ globals, usage, cost })` (line 153), also update the per-stack accumulator:

```ts
const targetStack = stateStack ?? ctx.stateStack;
targetStack.localCost += completion.cost?.totalCost ?? 0;
targetStack.localTokens += completion.usage?.totalTokens ?? 0;
```

The existing global `__tokenStats` accumulator on `GlobalStore` is kept untouched — it powers the run-level total in `runNodeResultToJSON()` and `tokenStatsFromJSON()` and is part of the public TypeScript-side API. The per-stack values are a new, parallel accumulator.

#### Read path: `__internal_getCost` / `__internal_getTokens`

A direct read — no walking, no summing:

```ts
export function __internal_getCost(_ctx: RuntimeContext, stack: StateStack): number {
  return stack.localCost;
}

export function __internal_getTokens(_ctx: RuntimeContext, stack: StateStack): number {
  return stack.localTokens;
}
```

Because the branch was seeded with the parent's total at creation and accumulates its own LLM cost into the same number, `stack.localCost` IS "parent's running total plus everything I've spent so far."

#### Join path: branch → parent propagation

Both `runForkAll` and `runRace` use the same formula. Let `forkStartCost = stateStack.localCost` immediately before launching branches. Each branch ends with `branch.stack.localCost = forkStartCost + branchDelta`. The parent doesn't run any other LLM work while awaiting branches (the runner is blocked on `Promise.allSettled`/`Promise.race`), so its `localCost` is still `forkStartCost` when control returns. To merge:

```ts
// Just before popBranches() / branch teardown:
const forkStartCost = stateStack.localCost;
const forkStartTokens = stateStack.localTokens;
let costDelta = 0;
let tokensDelta = 0;
for (const branch of branchesToPropagate) {
  costDelta += branch.stack.localCost - forkStartCost;
  tokensDelta += branch.stack.localTokens - forkStartTokens;
}
stateStack.localCost += costDelta;
stateStack.localTokens += tokensDelta;
```

For both fork **and** race, `branchesToPropagate` is **every branch that ran**, including race losers. Losers' LLM calls really happened and really cost money, so dropping them from `getCost()` would understate spend. The race winner-only semantics applies to *results*, not to *cost reporting*.

Practically:
- **`runForkAll`**: propagate from every branch. This happens just before `popBranches()` in the no-interrupts success path.
- **`runRace`**: propagate from the winner AND every loser branch. Losers are still in the `branches` map at this point (they get `deleteBranch`'d immediately after, before the saved checkpoint is created), so the propagation reads them directly.

For race, the propagation must run **before** `frame.deleteBranch(...)` so the loser stacks are still reachable.

#### What `getCost()` returns from each scope

Using the example (main thread A at $7 spawns four branches B/C/D/E that each cost $1 more):

| Scope                              | `getCost()` returns | Why                                                          |
|------------------------------------|---------------------|--------------------------------------------------------------|
| Inside A before the fork           | 7                   | A's `localCost = 7`                                          |
| Inside B at branch entry           | 7                   | B was seeded with parent's localCost                         |
| Inside B after its $1 LLM call     | 8                   | 7 (inherited) + 1 (own)                                      |
| Inside A after fork joins          | 11                  | 7 + sum of deltas: (8−7) + (8−7) + (8−7) + (8−7) = 4         |

For a race where A=$7 forks 3 branches, the winner costs $2, losers cost $1 and $0.50:
- Inside A after race joins: `7 + (9−7) + (8−7) + (7.5−7) = 10.5`. Loser costs are included.

#### Checkpoints and resume

`localCost` and `localTokens` are serialized in `StateStackJSON`, so:

- An LLM call that runs, then interrupts, then resumes does **not** double-count: on resume, the saved `localCost` is restored, and the runner skips the already-executed step via its substep counter.
- An LLM call that runs *during* a re-execution after restore (a step not reached pre-interrupt) adds to the restored `localCost` — correct.
- On multi-cycle resume of a fork, the seed-on-creation guard (the `localCost === 0` check above) prevents re-seeding from the parent: branches keep their persisted accumulators across cycles.

The "fork-start snapshot" used by the join formula is computed fresh each time control reaches the join point. On resume, since the parent stack's `localCost` is restored to exactly its pre-fork value (the parent did nothing between fork-start and now), the snapshot is correct.

### Concurrency story for messages

Message builtins push onto `ctx.threads.active()`. The active thread is governed by the existing `thread { ... }` block mechanism, which is shared across branches (it's a property of the execution context, not the branch). This means:

- Inside a `fork`, calling `userMessage("...")` mutates the same thread that the caller of `fork` was in. Two branches calling `userMessage` concurrently both push to that one thread — order is nondeterministic.
- This matches today's behavior for `system()` inside a fork (no change in semantics).
- If users want per-branch threads, they wrap the branch body in a `thread { ... }` block — same workflow as today.

This is documented as-is; we are not adding per-branch thread isolation in this spec.

### Layer 2: `std::thread` stdlib module

A new stdlib module at `stdlib/thread.agency` that wraps the builtins. None of the message functions are `safe` (pushing user/assistant turns alters the next LLM call's behavior and should be treated as a policy-relevant side effect; `safe` would inappropriately exempt them from permission checks).

```
def systemMessage(msg: string): void {
  """
  Add a system message to the current thread's message history.
  @param msg - The system message content
  """
  __internal_systemMessage(msg)
}

def userMessage(msg: string): void {
  """
  Add a user message to the current thread's message history.
  @param msg - The user message content
  """
  __internal_userMessage(msg)
}

def assistantMessage(msg: string): void {
  """
  Add an assistant message to the current thread's message history.
  @param msg - The assistant message content
  """
  __internal_assistantMessage(msg)
}

export safe def getCost(): number {
  """
  Get the cumulative cost (USD, floating point) of all LLM calls
  contributing to the current execution branch.

  Inside a fork/race branch, this returns the parent's accumulated
  cost plus the cost incurred so far inside this branch. After all
  branches join, the parent sees the sum of its own cost plus every
  branch's cost.

  To measure a specific section, capture getCost() before and after:
    const before = getCost()
    // ... do work ...
    const sectionCost = getCost() - before
  """
  return __internal_getCost()
}

export safe def getTokens(): number {
  """
  Get the cumulative token count for the current execution branch.
  Same per-branch semantics as getCost().
  """
  return __internal_getTokens()
}
```

(`getCost`/`getTokens` are `safe` because they are pure reads with no side effects.)

#### Usage

```
import { systemMessage, userMessage, getCost } from "std::thread"

node main() {
  systemMessage("You are a helpful assistant.")
  userMessage("The user previously said they prefer concise answers.")

  const result = llm("Summarize this document: ...")
  print("Cost so far: ${getCost()}")
  return result
}
```

### What `getCost()` includes and excludes

- **Includes**: all LLM calls made from Agency code (via `llm()`) on the path through the current branch chain.
- **Excludes (for now)**: memory layer LLM calls (`memory.text`, `memory.embed`). These go through a separate code path in [lib/runtime/memory/manager.ts](../../../lib/runtime/memory/manager.ts) that calls smoltalk directly without touching the per-stack accumulator. Wiring them through is a future enhancement; they are also currently excluded from the per-branch propagation logic.
- **Race losers**: included. Their LLM calls really happened and cost real money; reporting them is the honest behavior. Only the *result* of a loser branch is discarded.

### Out of scope

- **Reading messages** (`getMessages()`): not included. The current need is write-only. Could be added later if there's a concrete use case.
- **Clearing messages** (`clearMessages()`): not included. Users can use `thread {}` blocks to start fresh.
- **Memory-layer cost rollup**: not in this spec.
- **Per-branch message threads**: not in this spec; use `thread {}` if you need isolation.

## Files to modify

### New files
- `stdlib/thread.agency` — the new stdlib module
- `stdlib/lib/thread.js` — JS backing file with `__internal_systemMessage`, `__internal_userMessage`, `__internal_assistantMessage`, `__internal_getCost`, `__internal_getTokens` implementations

### Modified files
- `lib/codegenBuiltins/contextInjected.ts` — register the five new builtins; add optional `needsStack` field; add a new `THREAD_FROM = "agency-lang/stdlib-lib/thread.js"` constant
- `lib/backends/typescriptBuilder.ts` — at the `isContextInjectedBuiltin` branch, also push `__stateStack` when `entry.needsStack` is set; delete the `system()` builder macro special case
- `lib/runtime/state/context.ts` — add `pushMessage(role, content)` method
- `lib/runtime/state/stateStack.ts` — add `localCost`, `localTokens` (serialized) and `parent` (runtime-only) fields; update `toJSON`/`fromJSON`/`StateStackJSON`
- `lib/runtime/prompt.ts` — after `updateTokenStats`, also add to `(stateStack ?? ctx.stateStack).localCost` / `.localTokens`
- `lib/runtime/runner.ts` — in `runForkAll` set `branch.stack.parent` at creation; on successful resolve, sum branch accumulators into parent before `popBranches()`. In `runRace`, same `parent` assignment; on winner resolve, propagate only the winner's accumulators
- `package.json` — add `./stdlib-lib/thread.js` to the `exports` map
- `lib/config.ts` — register `std::thread` as a stdlib module
- All Agency files using `system()`:
  - `lib/agents/review/agent.agency`
  - `lib/agents/policy/agent.agency`
  - `lib/agents/agency-agent/agent.agency`
  - `examples/etsyFees.agency`
  - `examples/coding-agent.agency`
- Run `make fixtures` after the migration to refresh integration test fixtures that include the previously-emitted `system()` codegen.

### New tests
- `tests/agency/thread/messages.test.json` — round-trip for `systemMessage`/`userMessage`/`assistantMessage`
- `tests/agency/thread/cost-sequential.test.json` — verify `getCost()` grows after each `llm()` call (deterministic client provides fixed cost per call)
- `tests/agency/thread/cost-fork-join.test.json` — verify the A=$7, B/C/D/E=$1 each scenario: getCost inside branches sees parent + own; after join, A sees full sum
- `tests/agency/thread/cost-race-includes-losers.test.json` — verify all branches (winner + losers) propagate their cost to the parent, even though loser results are discarded
- `tests/agency/thread/cost-interrupt-resume.test.json` — verify `localCost` survives interrupt/resume without double-counting
- `tests/agency/thread/__internal_*` registry parity — existing `contextInjected.test.ts` arity check should pick up the new entries automatically; add `needsStack` arity verification

## Implementation notes / divergence from spec

During implementation a few details shifted; recording them here for accuracy.

- Codegen injection contract. The original spec proposed injecting only
  `(__ctx, __stateStack)` for stack-using builtins (option 2). Once the
  thread-message builtins (`systemMessage`/`userMessage`/`assistantMessage`)
  landed, they also needed access to the current thread store, which is not
  reachable from `ctx` alone. Rather than adding a second injection toggle,
  the contract for *all* context-injected builtins was unified to
  `(__ctx, __stateStack, __threads, ...args)`. Memory builtins accept and
  ignore the extra parameters.
- `parent` field on `StateStack`. The seeding model the spec proposed
  ("copy parent's running total into the branch at creation time, on join
  parent reabsorbs the delta") was kept, but the runtime does *not* need a
  `parent` back-pointer on `StateStack`. The parent reference lives only
  inside `runner.ts` while a fork/race is in flight (`runForkAll` /
  `runRace` hold the parent stack in a local). Two small helpers were added
  to `Runner`:
  - `seedBranchCost(branchStack, parentStack)` — copies parent totals into a
    freshly created branch.
  - `propagateBranchCost(branches, parentStack)` — on join, adds
    `(branch.localCost - parent.localCost_at_seed)` back into the parent.
- Race losers. `runRace` now propagates losing branches' completed-call
  spend back to the parent before deleting them. Only the *result* of
  losers is discarded; their cost is not. `resumeRaceWinner` separately
  propagates the winner's post-resume delta when the race resolves
  after an interrupt.
- No `needsStack` flag. The simpler "always inject" approach (option 2)
  was kept. There is no per-builtin opt-in for stack/thread access.
