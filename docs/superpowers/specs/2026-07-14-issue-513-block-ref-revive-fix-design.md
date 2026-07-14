# Fix #513: block references must survive cross-process resume

**Date:** 2026-07-14
**Issue:** https://github.com/egonSchiele/agency-lang/issues/513
**Status:** Design approved in discussion; ready for implementation planning.
**Supersedes:** `docs/superpowers/specs/2026-07-13-issue-513-guard-block-subprocess-resume-investigation.md`. That document's root-cause theory (subprocess payload saved on an ephemeral block frame that gets popped before serialization) is **wrong**. This spec records the verified mechanism and the fix. The old document should be updated to point here as part of this work.

---

## 1. Symptom

A subprocess pauses on a bubbled interrupt while a `guard(...) as { ... }` block wraps the paused `run()` call. After the approval resumes the tree, `run()` returns a failure instead of the child's result. The caller then crashes with `Cannot read properties of undefined` when it touches `result.value`.

This breaks `run(maxCost: ...)` on any nested run that pauses, because `run()` wraps `_run` in a guard block internally. It equally breaks a user-written `guard(...) as { return run(...) }`.

## 2. Verified root cause

Empirically verified on 2026-07-14 by running both repro variants (see section 5).

**Blocks register themselves at creation time.** Every compiled block is an `AgencyFunction` created like this:

```ts
__AgencyFunction.create(
  { name: "__block_0", module: "stdlib/agency.agency", fn: ..., ... },
  __toolRegistry,   // create() adds the block to the function-ref registry
)
```

**Frames serialize function values as name references.** The guard's frame holds the block as an argument. `State.toJSON` clones args through `nativeTypeReplacer`, which writes an `AgencyFunction` as:

```json
{ "__nativeType": "FunctionRef", "module": "stdlib/agency.agency", "name": "__block_0" }
```

**Revival is eager, and it happens before any code runs.** When the paused process is re-forked, it parses the checkpoint JSON with `nativeTypeReviver` during restore. `FunctionRefReviver.findInRegistry` (`lib/runtime/revivers/functionRefReviver.ts:110`) looks each reference up in the registry and **throws** on a miss:

```
FunctionRefReviver: function "__block_0" from module "stdlib/agency.agency"
not found in registry. The function may have been renamed or removed since
this state was serialized.
```

In a fresh process, no code has executed yet, so no block has registered itself. The lookup misses, the restore throws, the resumed process dies, and the outer `run()` returns a failure.

**The revived value was garbage anyway.** On replay, every function body rebinds its block arguments unconditionally at entry:

```ts
__stack.args["block"] = block;   // fresh block, overwrites whatever restore put there
```

So the restore dies fetching a value the replay was about to throw away. This was proven directly: with a stub in place of the throw, the stub was never invoked across the full repro and regression runs.

**Why in-process pause/resume never hit this:** in one process, the block-creating line has always executed before any checkpoint of it exists, so the block is already in the registry and revival succeeds.

**Why the test suite never hit this.** The bug needs three conditions at once:

1. A block-taking function (like `guard`) mid-execution on the stack at pause time, so a block reference sits in a serialized frame.
2. The pause crosses a process boundary (subprocess pause), so the state round-trips through JSON in a fresh process.
3. No handler resolves the interrupt in-process, so the middle process actually dies and gets re-forked.

Each existing test family misses exactly one: `tests/agency/guards/*` are single-process (no 2); `nested-pause-resume` and friends hold no block in any frame (no 1); `run-max-cost` approves everything in-process so nothing pauses mid-guard (no 3). The two-call-site workaround in `run()` (section 4.3) kept the default subprocess path guard-free, which kept most tests out of the danger zone.

## 3. Design decisions already made (with the owner)

- **Fix the pattern, not just `guard`.** Any user-written function that takes an `as { }` block must be pause-safe across process boundaries. This keeps guard-like constructs buildable in userland with no runtime changes, which is an explicit goal.
- **No `runner.guard()` language construct.** Considered and rejected: it would fix only `guard`, and it would make guard-like constructs require runtime changes forever.
- **Blocks keep their own frames.** The frame layer is not broken: checkpoints are stamped while block frames are live, and positional replay realigns them. Verified empirically.

## 4. The fix

### 4.1 Reviver: lazy stub for unregistered block references

In `FunctionRefReviver.findInRegistry`, when the lookup misses **and the name is a compiler-generated block name**, return a placeholder instead of throwing:

```ts
// Compiler-generated blocks (steps.nextBlockName() → "__block_<n>") register
// themselves only when their creating line executes. A fresh process restoring
// a checkpoint has not executed anything yet, so a miss here is EXPECTED.
// Replay rebinds block args at function entry before anything can call them.
// The stub is a tripwire: if some path invokes a block that replay failed to
// rebind, we get a precise error at the call instead of a dead restore.
if (/^__block_\d+$/.test(name)) {
  return new AgencyFunction({
    name,
    module,
    fn: () => {
      throw new Error(
        `Block "${name}" from module "${module}" crossed a serialization ` +
        `boundary and was invoked before replay rebound it. This is a ` +
        `runtime bug — please report it.`,
      );
    },
    params: [],
    toolDefinition: null,
  });
}
throw new Error(/* existing message, unchanged */);
```

Named functions keep the eager throw. For them, a registry miss means the program really changed between pause and resume (a renamed or removed function), and no replay will fix it. The user needs that error immediately.

The existing unit test that asserts the throw (`functionRefReviver.test.ts:85`) splits in two: block-named refs get a stub whose invocation throws; other refs keep the eager throw.

### 4.2 Regression fixtures

Promote the two verified repros (currently in `packages/agency-lang/tmp/`) to fixtures in `tests/agency/subprocess/`:

- `nested-pause-maxcost.agency` — `nested-pause-resume` with the middle hop's run as `run(compiled: ..., node: "main", maxCost: 1.0)`. This is condition 1 via `run()`'s internal guard block.
- `nested-pause-user-guard.agency` — same, but the middle hop wraps a plain `run(...)` in a user-level `guard(cost: 1.0) as { ... }`. This is condition 1 via a user block, proving the fix covers the pattern and not just `run()`.

Both: the grandchild's `bash` interrupt is unhandled everywhere, surfaces to the harness, one approval resumes the whole tree, expected output `"OK: deep-ok\n"` exact. Both currently fail; both passed with the experimental fix.

### 4.3 Collapse `run()` to a single call site

`run()` in `stdlib/agency.agency:161` currently contains the identical ten-argument `_run` call twice — a deliberate workaround for this bug, with a comment warning to keep the copies in sync. `pushGuardImpl` already supports negative-as-disabled, added specifically for this collapse (see its comment). Replace both call sites with one:

```ts
// maxCost null = no cap. guard() disables a dimension on a negative
// value, so map null to -1 and keep a single guarded call site.
let cap = -1.0
if (maxCost != null) {
  cap = maxCost
}
const guarded = guard(cost: cap) as {
  return try _run(compiled, node, args, wallClock, memory,
                  ipcPayload, stdout, configOverrides, cwd, maxDepth)
}
```

The existing `guardFailure → limit_exceeded` translation below it stays unchanged. Delete the two-call-sites comment; its explanation is the superseded wrong theory.

Note: `guard(cost: null, time: null)` **throws** ("guard() requires at least one of: cost, time"). The disable value is negative, never null. Get this right in every snippet.

This collapse is also the regression alarm: after it, every `run()` call in the entire subprocess suite exercises the guarded path.

### 4.4 Check the sibling case: scoped callbacks holding blocks

`State.toJSON` also serializes `scopedCallbacks` function values as FunctionRefs. A callback registered with a block (`callback("onEmit") as { ... }`) that sits on a serialized frame likely hits the same eager throw at restore today. Unlike block *arguments*, scoped callbacks are **not** obviously rebound by replay (their registration step is skipped by the step counter on resume, by design).

Task for the implementation plan: write a fixture (subprocess pauses while a block-based scoped callback is registered on a serialized frame; after resume, trigger the callback). Three possible outcomes:

- It already works through some path I haven't traced → keep the fixture as coverage.
- It breaks at restore today and the stub makes it break later, at fire time → decide: fix rebinding in this PR if small, or file a follow-up issue with the fixture attached.
- The situation can't occur (e.g. callbacks are re-registered another way) → document why next to the fixture.

Do not let this expand the PR silently. If it needs real work, it becomes its own issue.

### 4.5 Correct the record

- Update `docs/superpowers/specs/2026-07-13-issue-513-guard-block-subprocess-resume-investigation.md` with a banner pointing to this spec and a one-paragraph correction. Keep the old text below the banner for the paper trail (its code references are still useful).
- The `run-max-cost` fixture comment and the guards guide need no changes; the guards guide's behavior claims stay true.

## 5. Evidence collected (2026-07-14)

- Both repro variants fail on the current branch with the `FunctionRefReviver ... __block_0 not found` failure surfaced via `printJSON(result)` on the outer `run()`.
- With the reviver patched to fail soft (stub), **both variants pass end to end** (`"OK: deep-ok"`), and the stub is never invoked.
- Regression sample with the patch, all passing: `nested-pause-resume`, `pause-multi-cycle`, `callback-forwarding-nested-relay`, all four `run-max-cost` tests.
- The patch was reverted after the experiment; the working tree is clean of it.

## 6. Out of scope

- `runner.guard()` or any promotion of `guard` to a language construct (rejected, section 3).
- Changing how blocks get frames, or redirecting block-frame writes to the parent frame (not needed; frame layer verified correct).
- The subprocess-payload accessors in `lib/runtime/ipc.ts` (`saveSubprocessPayload` etc.) — they were never the problem.
- True serialization of closures (a block's captured variables). Replay-rebinding remains the mechanism; the stub is the tripwire for violations.
- The CLI cost/time guards plan (`docs/superpowers/plans/2026-07-13-cli-cost-time-guards.md`) proceeds unchanged, after this lands.

## 7. Testing

- Unit: `functionRefReviver.test.ts` — block-named miss returns a stub; stub invocation throws the "was invoked before replay rebound it" message; non-block miss still throws eagerly with the original message.
- Execution fixtures: the two new `tests/agency/subprocess/` fixtures (section 4.2), plus the scoped-callback fixture (section 4.4).
- Existing suites: `tests/agency/subprocess/` and `tests/agency/guards/` must pass untouched. CI runs the full agency suite; locally run only the fixtures named here.
- `make` after every `stdlib/*.agency` change; save test output to files.

## 8. Risks and edge cases

- **A user function named `__block_0`.** Double-underscore names should be compiler-reserved (there is a reserved-name check, AG4002). Verify during implementation that a user cannot `def __block_0`, so the regex in 4.1 can't misclassify a real user function. If users can create such names, tighten the discriminator (e.g. mark block refs explicitly at serialize time with a `isBlock: true` field — slightly bigger change, strictly more precise; acceptable fallback).
- **Stale registry entries in-process.** In one process, revival of a block ref returns whatever closure last registered under that name, which may carry stale captures. Pre-existing behavior, unchanged by this fix, papered over by replay rebinding. Noted here so nobody mistakes it for new.
- **Stub reachable through data.** A block stored in a local or a data structure (`let f = <block>` before the pause) is *not* rebound by argument rebinding; if code after the resume calls `f`, it hits the stub. Today that same program dies at restore, so the stub strictly improves it (later, precise error vs. dead process). The fixture in 4.4 probes the nearest real-world instance of this class.

## 9. Deliverables checklist

1. Reviver change + unit tests (4.1).
2. Two regression fixtures (4.2).
3. `run()` single call site + comment cleanup + `make` (4.3).
4. Scoped-callback probe fixture + decision (4.4).
5. Banner correction on the old investigation spec (4.5).
6. PR references issue #513 and unblocks the #512 review note.
