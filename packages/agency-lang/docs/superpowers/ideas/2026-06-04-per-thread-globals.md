# Per-Branch Isolation for Globals and Threads

## The Idea

Make globals and the per-run message-thread state isolated per *branch* instead of per *run*. Today, every concurrent agent run gets its own copy of the globals and its own `ThreadStore` (good), but branches spawned within a single run — via `fork`, `parallel`, `race`, `thread { ... }` — share both with the parent (bad, in different shapes for each). Move the isolation boundary down one level: each branch spawned by a fork/parallel/race primitive sees its own snapshot of the per-run state and any branch-local writes are confined to that branch.

The two halves of the fix:

- **Globals**: each branch gets a snapshotted clone of the parent's `GlobalStore`. Writes inside the branch never leak out; the parent's globals are untouched regardless of what branches did.
- **Threads**: each branch gets its own `activeStack` (so the "current thread" pointer is per-branch). The `threads` registry and `sessions` map stay shared across branches so explicit cross-branch coordination (named sessions, `thread(continue: id)`) keeps working. Each branch's `activeStack` is seeded with a fresh subthread of the parent's active thread so unguarded `llm()` calls inside a branch don't pollute the parent's conversation.

## Why It Matters

Agency's run-level isolation is what makes the stdlib's todo-list pattern (`stdlib/agent.agency`) ergonomic: a tool stores per-run state in a global and the user doesn't have to thread it through every call. The "no shared state by default" property is part of what makes Agency safe and pleasant to write.

That property silently breaks the moment a user introduces `fork` or `parallel`. Concrete example:

```
// Each sub-agent uses the built-in todo-list tools internally.
parallel {
  researchAgent("topic A")
  researchAgent("topic B")
}
```

Both branches now write to the *same* todo list **and** the *same* active message thread. The user didn't write any code touching globals or threads — they just wrapped two existing agents in `parallel` — and now the agents corrupt each other's state. The failure modes are subtle: nothing crashes, the todos just interleave in confusing ways and the LLM transcripts from the two agents get mixed into one conversation.

The current workaround is "audit every sub-agent's globals and thread usage before you fork it." This is exactly the kind of thread-safety reasoning Agency was supposed to spare users from.

After the change, the rule becomes: **branches are isolated for everything that's already isolated per-run.** Globals and the active-thread pointer join locals and the state stack as things that "just work" when you parallelize. Explicit cross-branch coordination (named sessions, `thread(continue: id)`) still works because the threads/sessions registry stays shared — that's the channel for *intentional* sharing.

## How It Would Work

### Semantics — globals

- **At fork time:** each spawned branch receives a snapshot of the parent's `GlobalStore`. The snapshot captures all currently-initialized modules and their values. Module initializers do **not** re-run — the branch inherits the already-initialized world (the cloned `initializedModules` set ensures `__initializeGlobals` is a no-op for everything the parent already initialized; see `docs/dev/init-topsort.md` for the once-per-execution guard).
- **During branch execution:** the branch reads and writes its own copy. Sibling branches are invisible to each other. The parent's globals are frozen from the branch's perspective.
- **At join time:** the branch's globals are discarded. The parent's globals are untouched regardless of what branches did. Only return values cross the join boundary.
- **Statics are unchanged.** Statics are explicitly cross-everything shared state; they keep their current semantics. Only globals are affected.

### Semantics — threads

The `ThreadStore` carries three things that need different treatment:

| State | Treatment | Rationale |
| --- | --- | --- |
| `activeStack: string[]` | **Per-branch.** Cloned at fork, seeded with a fresh subthread of parent's active, discarded at join. | The push/pop discipline assumes a single owner. Concurrent push/pop is a structural bug — there is no semantic interpretation where sharing this makes sense. Per-branch ensures unguarded `llm()` calls in a branch write to a branch-local thread, not the parent's. |
| `threads: Record<id, MessageThread>` | **Shared.** Pointer-shared with the parent registry. Writes (new threads, new messages) are visible across branches. | This is the registry that lets cross-branch coordination work. Two branches writing different keys don't conflict; two branches writing the same thread by explicit id is the user's intent. |
| `sessions: Record<name, id>` | **Shared.** Pointer-shared. Concurrent writes to the same session name race; first-create wins, others resume. | This is what makes the `popData`/`sizeData` pattern (multiple forks coordinating via named sessions) work without language changes. |

Net result:

- **At fork time:** the branch's ALS frame gets a fresh `activeStack` seeded with one push: a fresh subthread of the parent's currently-active thread. The `threads` and `sessions` references continue to point at the parent's registry.
- **During branch execution:** unguarded `llm()` and `userMessage()` calls write to the branch's implicit subthread. Explicit `thread(session: "X")` consults the shared `sessions` map; if "X" exists from any earlier branch or from the parent, it resumes; otherwise it creates a new top-level thread that future branches can resume. Explicit `thread(continue: id)` appends to the named thread, which is the documented escape hatch for "write into the parent's thread from inside a branch."
- **At join time:** the per-branch `activeStack` is discarded. Threads created in the branch (including its implicit subthread) stay in the registry, visible in `listThreads()` and resumable by id or session.

The existing rule "sessions are always top-level threads — they cannot map to subthreads" is unchanged. `thread(session: ...)` inside a branch still creates a top-level thread regardless of where lexically it appears; the rule constrains what sessions resolve to, not where the call may be written.

### If a user genuinely wants to share state across branches

The existing tools cover every case I could think of:

- **Cross-branch globals**: return values from branches and reduce in the parent (the functional pattern). For the rare case of accumulating into a shared counter / cache / progress meter, this is what `static` exists for, with the caveat that statics also leak across runs. If a real workload needs cross-branch but not cross-run sharing, the right primitive is probably a stdlib `Shared<T>` type with explicit `.read()` / `.write()` / `.update(fn)` methods — making the sharing visible at every use site — rather than a third variable modifier. Hold off on building it until users ask.
- **Cross-branch threads**: name them with `thread(session: ...)` or capture the parent thread id with `currentThreadId()` and append via `thread(continue: id)`. Both already work.

### Implementation sketch

The plumbing already exists for per-branch state — `BranchState` already carries an isolated `StateStack` through fork/interrupt/resume. The change is to add two more per-branch fields (`globals: GlobalStore`, plus a `ThreadView` wrapping the shared registry with a per-branch `activeStack`) that follow the same lifecycle.

Build it in four stages, each independently testable:

1. **Move globals and thread-store access to the ALS frame.**
   Today generated code reads `__ctx.globals.…` directly from the RuntimeContext, and `__threads()` returns the per-run `ThreadStore` from the ALS frame. Add `globals: GlobalStore` to `AgencyStore` (`lib/runtime/asyncContext.ts`) and a new `__globals()` accessor (matching the existing `__threads()` / `__stateStack()` pattern at `lib/runtime/asyncContext.ts:185-201`). Change the code generator to emit `__globals()!.set(modId, name, value)` everywhere it currently emits `__ctx.globals.set(...)`. Seed `globals` in every frame builder: `runNode`, `Runner.runInScope`, `runInBranchAlsFrame`, and `runInBootstrapFrame` (so module-level `__initializeGlobals` writes go to the canonical store). At this stage every frame still inherits the same `GlobalStore` instance from its parent — no semantic change yet. Run the full test suite; behavior should be identical because pointer-sharing preserves today's semantics. Ship this as a standalone commit so any regressions are easy to bisect.

   Decision: rewrite codegen rather than turning `__ctx.globals` into a runtime accessor on `RuntimeContext`. The rewrite is greppable, the diff is reviewable, and it matches the pattern that already exists for threads and stack. An accessor on `RuntimeContext` would hide which globals you're reading from at any given site, which makes debugging the step-2 semantic flip much harder.

2. **Snapshot at fork time.**
   In `runInBranchAlsFrame` (`lib/runtime/runBatch.ts:265`), construct the branch's frame with `globals: parent.globals.clone()` and a fresh `ThreadView` over the parent's registry seeded with a subthread of `parent.threads.activeId()`. Each branch now diverges from the parent at spawn. This is when the user-visible behavior actually flips. Add tests exercising the todo-list-across-branches case and the parallel-LLM-into-same-thread case.

3. **Plumb branch-local state through `BranchState` serialization.**
   Add `globals: GlobalStoreJSON` and `activeStack: string[]` fields to `BranchState`, written on checkpoint creation, read on resume. The existing interrupt/resume machinery for `stack` is the template — mirror it field-for-field. The shared registry (`threads`, `sessions`, `counter`) serializes once at the top-level frame as it does today. Bump the checkpoint format version if one exists; add one if not.

4. **Copy-on-write (optional, perf).**
   Replace the eager `GlobalStore.clone()` with a parent-pointer + per-cell overrides map. Reads fall through to the parent; first write to a `(moduleId, varName)` cell clones that cell into the branch. Pure perf optimization, no semantic effect. Defer until benchmarks say it's needed.

### Touch points

- `lib/runtime/state/globalStore.ts` — add `clone(): GlobalStore { return GlobalStore.fromJSON(this.toJSON()); }` (round-trips via the existing `nativeTypeReplacer`/`nativeTypeReviver` so Maps/Sets/Dates in user globals copy correctly). Add COW machinery later if needed.
- `lib/runtime/state/threadStore.ts` — split into `ThreadRegistry` (long-lived, shared: `threads`, `sessions`, `counter`, `statelogClient`) and `ThreadView` (per-branch: `activeStack` + a registry reference). All existing `ThreadStore` methods delegate to the registry except `pushActive` / `popActive` / `activeId` / `active`, which use the per-view `activeStack`.
- `lib/runtime/state/context.ts` — `RuntimeContext` still owns the top-level `GlobalStore` and `ThreadRegistry`; frame lookups read from ALS, not ctx.
- `lib/runtime/asyncContext.ts` — add `globals: GlobalStore` to `AgencyStore`; add `__globals()` accessor matching the existing `__threads()` / `__stateStack()` shape. Update `runInBootstrapFrame` to seed `globals: ctx.globals` so module-level init writes to the canonical store.
- `lib/runtime/node.ts` — seed the top-level frame with `ctx.globals` so non-fork code paths see the same object as today.
- `lib/runtime/runner.ts` — `runInScope` propagates the frame's `globals` and `threads` slots into nested step frames.
- `lib/runtime/runBatch.ts` — `runInBranchAlsFrame` builds the branch frame with `parent.globals.clone()` and a fresh `ThreadView` seeded with a subthread of the parent's active thread.
- `lib/runtime/state/checkpointStore.ts` — `BranchState` gains `globals` and `activeStack` fields; serialization shape evolves.
- Code generator (`lib/backends/typescriptBuilder/` and any template files emitting `__ctx.globals.…`) — switch every emission site to `__globals()!.…`.
- `lib/stdlib/agent.ts` and the todo-list `.agency` files — no changes needed; the behavior change is transparent.
- Docs:
  - `docs/dev/globalstore.md` and `docs/dev/threads.md` — explain the new per-branch semantics, the snapshot-and-discard model, and the rationale.
  - `docs/dev/checkpointing.md` — describe the new `BranchState.globals` and `BranchState.activeStack` fields and the format-version bump.
  - `docs/site/guide/global-vs-static.md` — add a "Concurrency" section noting that globals are per-branch and statics are cross-everything.
  - `docs/site/guide/execution-model.md` — add a section on per-branch isolation that mirrors the per-run isolation explanation.
  - `docs/site/guide/cross-thread-context.md` — note that sessions are per-run and shared across all fork branches; show the `popData`/`sizeData` worked example.
  - `docs/site/guide/concurrency.md` (if it exists or needs creating) — the fork-loop semantics worked example (see below).

## Worked Examples

### The todo-list bug, fixed

```
parallel {
  researchAgent("topic A")  // pushes todos to its own copy of the global
  researchAgent("topic B")  // pushes todos to its own copy of the global
}
// Each branch's todos are discarded at join. The parent's todo list is
// untouched. If the user wants the combined results, the agents return
// them and the parent reduces.
```

### Sessions across forks (works under the new design with zero language change)

```
const cities = ["SF", "LA", "NY"]
const popData = fork(cities) as city {
  thread(session: "data-for-${city}") {
    return llm("What's the population of ${city}?")
  }
}
const sizeData = fork(cities) as city {
  thread(session: "data-for-${city}") {
    return llm("What's the size of ${city}?")
  }
}
// The SF thread now contains both the population Q/A and the size Q/A,
// because the sessions map is shared across branches and across forks.
// The first popData branch for SF creates "data-for-SF"; the second
// fork's SF branch resumes the same thread.
```

### The fork-loop pattern

Each iteration's fork captures the parent's globals at the moment the fork call runs. Branches do **not** write back to the parent:

```
let count = 0
for (i in [0, 1, 2]) {
  fork {
    count = count + 1   // writes to the branch's local copy
  }
}
print(count)   // prints 0 — branch writes were discarded
```

Users coming from JavaScript will reach for "shared global accumulator" and be surprised when their writes vanish. The idiomatic replacement is return-and-reduce:

```
const results = fork([0, 1, 2]) as i { return 1 }
const count = sum(results)   // 3
```

Worth a prominent section in the concurrency guide.

### Explicit append to the parent's thread from inside a branch

```
node main() {
  userMessage("Find some facts about cities.")
  const parentId = currentThreadId()
  fork(cities) as city {
    thread(continue: parentId) {
      const fact = llm("Tell me one fact about ${city}.")
      userMessage(fact)   // writes back to the parent thread
    }
  }
}
```

If two branches do this simultaneously the messages interleave non-deterministically. That's the user's responsibility — same as two branches concurrently appending to a shared array via a captured reference.

## Key Questions

- **Static vs global distinction.** This change deepens the difference between statics (shared across runs and branches) and globals (now isolated across branches). Worth keeping — statics are rare and explicit; globals are common and now they finally match user intuition. Revisit if static usage stays low after this lands.
- **Should we add a `shared` modifier?** No, not in v1. The existing escape hatches (statics for cross-everything, return-and-reduce for cross-branch accumulation, sessions for cross-branch threads) cover every case I can think of. Adding a third variable kind whose entire purpose is opting back into shared state cuts against the "no shared state by default" philosophy. If real demand shows up, the right primitive is probably a stdlib `Shared<T>` value type with explicit `.read()` / `.write()` / `.update(fn)` — making the sharing visible at every use site — rather than a declaration-level modifier that hides it.
- **Should the user be able to opt *out* of the new isolation?** Probably no, by symmetry with how locals work — you don't have a "shared local" keyword either. The escape hatches are statics, return-and-reduce, and named sessions / `thread(continue: id)`.
- **Init re-run.** Not a concern. `__initializeStatic` is guarded by a once-per-process promise latch and `__initializeGlobals` is guarded by `GlobalStore.initializedModules` (see `docs/dev/init-topsort.md`). As long as `clone()` copies `initializedModules` along with `store`, init does not re-run in branches — they inherit the parent's already-initialized world.
- **Compilation surface.** Step 1 (codegen rewrite to `__globals()`) is the largest mechanical change. Ship it standalone — no feature flag, no parallel-running code paths. The behavior is identical to today (pointer-shared `GlobalStore` everywhere) so the test suite either passes or surfaces a real codegen bug to fix. Step 2 (the semantic flip) is a one-line change to `runInBranchAlsFrame` and lands as a separate commit.

## Complexity Considerations

- The codegen refactor in step 1 touches every compiled module. It's mechanical but broad. Worth its own commit/PR so any regressions are easy to bisect.
- The serialization-format change for `BranchState` (adding `globals` and `activeStack` fields) is the riskiest piece for stored traces. Document loudly and bump the checkpoint version. If anyone is depending on the on-disk format, this is a breaking change.
- The "discard on join" policy is simple to explain and simple to implement, but users coming from imperative languages will reach for "shared global accumulator" and be surprised when their writes vanish. The error/warning story matters: ideally we don't warn (writes-without-reads happen for legitimate reasons too), but the documentation needs the worked fork-loop example showing "this is what changed and here's the idiomatic replacement."
- Concurrent interrupts (multiple branches interrupting at once, see `docs/dev/concurrent-interrupts.md`) get *easier* under this design — each branch's interrupt captures its own globals snapshot and its own `activeStack`, no shared mutable state to race over.

## Performance

Per-branch clone cost is dominated by other branch-spawn work (LLM round-trips, message-thread copies). Realistic per-branch `GlobalStore.clone()` is microseconds for typical agent programs. The pathological case is a global holding many MB of data (large memory graph, accumulated transcript) forked across many branches — addressed by step 4 (copy-on-write). COW is cheap to implement on top of the cloned baseline and removes the case entirely for read-heavy workloads.

The threads change has effectively zero per-branch cost: the `ThreadView` is a wrapper holding a fresh `activeStack: string[]` plus a pointer to the shared registry. No cloning of the registry or sessions map.

Serialization cost grows with the number of live branches in a checkpoint, but only proportionally. COW also lets unmodified branches serialize as `{ inherits: parent }` rather than re-emitting state.

Net: not a perf concern in any realistic case. COW is the only optimization worth pre-emptively building, and only because it's cheap.

## Dependencies

- Existing per-branch `StateStack` machinery in `runBatch.ts` / `BranchState` (the template for this change).
- Existing `GlobalStore` JSON serialization (extended, not replaced) and `ThreadStore` JSON serialization (split between registry and view).
- ALS frame infrastructure (`agencyStore`).
- Init topsort + once-per-execution guard (`docs/dev/init-topsort.md`) — relied on for "init does not re-run in branches."

No new external dependencies. No new compiler passes.

## Migration

The behavior change is observable for any program that today reads/writes globals or relies on the active-thread pointer from inside a `fork`, `parallel`, `race`, or `thread {}` branch. The semantic changes:

- **Globals.** Reads inside a branch see the parent's value *at fork time*, then track the branch's own writes. They no longer see other branches' writes. Writes never leak to the parent.
- **Threads.** Each branch's unguarded `llm()` / `userMessage()` calls write to a branch-local subthread instead of the parent's active thread. Explicit `thread(session: ...)` and `thread(continue: id)` still work and still cross branches because the registry and sessions map remain shared.

For most programs this is invisible (no cross-branch globals, no cross-branch reliance on the active thread) or an improvement (cross-branch interference was a bug). For the rare program that intentionally accumulated into a shared global from inside parallel branches, the migration is "return the contribution as a value and reduce it after the join." For the rare program that relied on parallel branches writing into the parent's active thread, the migration is `thread(continue: parentId)` — explicit, visible, and unchanged in behavior.

A migration note in the changelog with worked before/after examples for both cases should be enough.

## Related Ideas

- `docs/dev/globalstore.md` — current globals architecture
- `docs/dev/threads.md` — `ThreadStore` / `MessageThread` architecture (will need updating to describe the registry/view split)
- `docs/dev/init-topsort.md` — once-per-execution init guard that makes "no re-run in branches" correct by construction
- `docs/dev/checkpointing.md` — how branch state interacts with checkpoint state
- `docs/dev/concurrent-interrupts.md` — multi-branch interrupt handling
- `docs/site/guide/execution-model.md`, `global-vs-static.md`, `cross-thread-context.md` — user-facing docs that will need updates
- Future: a stdlib `Shared<T>` value type for the rare case where explicit cross-branch mutable state is genuinely needed. Not in scope for this work; mentioned only so we don't accidentally close the design space by adding a half-baked `shared` modifier in the meantime.
