  Flaws and contradictions

  1. Task 6 silently changes hook callbacks from sequential → parallel

  This is the biggest issue. Today Runner.hook calls callHook once, which iterates callbacks sequentially. The plan wraps them in runBatch({mode: "all",
  children: callbacks.map(...)} → Promise.allSettled. That makes N callbacks fire concurrently, which is a user-visible semantic change (ordering of
  logs/side-effects, races on shared state, etc.).

  It's also inconsistent with the docs you'd update in Task 8 — concurrent-interrupts.md carefully calls out which constructs are "parallel branches," and
  hook callbacks aren't one of them.

  If the goal is just resumable batched interrupts across N callbacks, you can do that with runBatch sequentially (mode: "sequential", or just await children
  in a loop while still using the batch checkpoint + branch slot machinery). I'd add a third mode rather than promote sequential callbacks to concurrent
  silently.

  2. Task 5's title vs. body don't match

  The task header says "parallel-branch callback interrupts" but the body says no new runBatch is added at this layer — callbacks fire sequentially inside the
   existing tool-call batch, and the only fix is threading branchStack into invokeCallbacks. That's a one-line slice-rule fix, not a runBatch use case. The
  task is mislabeled and inflates the perceived value of the primitive — it's really just "Task 5: thread branchStack through callHook." Worth being honest
  about this; otherwise the migration story ("5 hand-rolled instances → 1 primitive") doesn't add up to 5.

  3. Race-mode locals key changes silently

  Existing code uses frame.locals[__race_winner_<id>] (Runner step id). The plan's snippet uses __race_winner_${stepPath}. Different key, different shape. Any
   in-flight checkpoint serialized before the migration won't be found on resume; you'll silently re-race instead of re-entering the winner. Either keep the
  existing key or note this as a breaking checkpoint-format change in Task 8 + a migration shim.

  4. Task 1 Step 5 tests something Task 1 Step 4 explicitly defers

  Step 4: "Defer the resume-winner path until the migration task."
  Step 5: "mode race resume: with __race_winner_X set, only the winner is invoked."

  You can't test resume in Task 1 if the dispatch lives in Task 3. Either fold the resume dispatch into Task 1, or drop that test bullet from Task 1.

  5. BatchChild.invoke "MUST NOT throw Interrupt[]" is a contract change

  PromptRunner.parallel today bails out by throwing PromptBailout carrying the interrupts. Task 4 explicitly replaces this with the tagged return — fine. But
  the contract puts the burden of "no-throw" on every caller of runBatch. interruptWithHandlers in particular has historically thrown in some paths
  (handler.invoke with isForked: true was the workaround). When you migrate the tool loop in Task 4, you need to actually verify no path under handler.invoke
  throws Interrupt[] once isForked is removed (the plan removes isForked casually — "isForked is dead" — without auditing what else relied on the
  throw-vs-return discipline).

  6. Statelog event regression for cached branches

  In the sketch, cached branches are pushed as {startedAt: 0, promise: Promise.resolve(branch.result.result)} and then onBranchEnd("success", 0) fires for
  them. Today's runForkAll has the same flaw, but the plan codifies it as a permanent shape via the hook callbacks. After a resume cycle, statelog will show
  duplicate forkBranchEnd success events for any cached branch. Worth either fixing in the migration or explicitly documenting that the hook fires only for
  not-cached branches.

  7. parentStack discipline is not "structurally impossible" to break

  The plan claims: "slice-rule violation becomes structurally impossible for runBatch users." It doesn't. The caller still passes parentStack explicitly and
  can still pass ctx.stateStack instead of the local branch stack — exactly the parallel-callback Bug 2 reproduced one layer up. What runBatch actually buys
  is one place to audit instead of five. That's worth saying honestly; "structurally impossible" overpromises and lulls future work into assuming the
  discipline is enforced when it isn't.

  If you want it structurally enforced, you'd have to derive parentStack from a non-caller source — e.g. require a RunnerContext arg that owns stack lookup.
  That's a bigger refactor but actually delivers the promise.

  8. Runner.hook rewrite drops information

  parentStack: this.stack ?? this.ctx.stateStack,

  this.stack is undefined on the root runner; only forkBlockSetup sets it. For top-level hook fires this falls back to ctx.stateStack — correct today. But if
  Runner.hook is called from inside a runPrompt-tool-branch runner that hasn't been wired to set this.stack, this silently captures the wrong slice. Worth an
  assertion or an audit of who instantiates Runner with stack undefined and whether any of those paths can hit hook.

  Also: scoped callbacks (State.scopedCallbacks) require walking the stack, not ctx. gatherCallbacks(this.ctx, ...) in the plan's snippet can't access them
  without a stack arg. The signature in Task 6 is missing this parameter.

  9. Cost propagation for race losers under mode="race"

  Today runRace propagates loser cost before returning interrupts and lets the winner's cost propagate later via resumeRaceWinner. The plan never spells out
  that the race path in runBatch must replicate this asymmetry (losers eagerly, winner deferred). A naïve implementation that just calls
  propagateBranchCost(all) once will double-count or miss cost depending on ordering. Add this to Task 1 Step 4 or Task 3.

  10. On-disk checkpoint format change for callbacks

  Today a single-callback interrupt at a hook site produces a leaf checkpoint whose stack ends with the callback's frame, no branches map involved. After Task
   6 it goes into branches[hook_<key>_<i>]. Old checkpoints won't resume on the new code, and vice versa. The plan never mentions checkpoint forward/backward
  compatibility. If the user has any persisted/serialized agent state from before the migration, it breaks. At minimum add a "migration note" or a version
  stamp.

  11. Subprocess handoff is dismissed too quickly

  The validation checklist says subprocess "can be modeled as a single-child batch in a future iteration." Subprocess IPC has its own interrupt-propagation
  rules (your in-flight plan) and goes through a serialization boundary the in-process runBatch never crosses. Calling it "a single-child batch" hand-waves
  the per-child invoke returning T | Interrupt[] via promise — across a subprocess that's RPC, not a function call. It's fine to defer, but the framing makes
  it sound easier than it is.

  Edge cases not covered

  - A branch that errors (rejected, not interrupted) while siblings interrupt. Today runForkAll throws the error and abandons the in-flight interrupts (no
  checkpoint stamped). Plan does the same. But this means the interrupts from sibling branches that successfully halted are silently lost. Is that the desired
   behavior? It's the current behavior, so OK to preserve, but the plan should call it out as an explicit invariant rather than inheriting it accidentally.
  - Empty children: []. Plan returns {kind: "values", values: []} after Promise.allSettled([]). Fine, but propagateBranchCost([]) and popBranches() on an
  already-empty branches map should be verified as no-ops.
  - Same child.key used twice in one batch. getOrCreateBranch returns the same branch; both children run on the same stack → corruption. Plan says "Caller is
  responsible for uniqueness." A Set check in runBatch would be cheap insurance.
  - Resume where mode flipped. What if a checkpoint was stamped under mode "all" but on resume the caller passes mode "race"? Should never happen but no
  defensive check. Worth at minimum an invariant assert when __race_winner_* is set vs. mode.