# Sequential Multi-Callback Fork-Style Resume Implementation Plan

> **Status: superseded by [2026-05-22-runbatch-concurrent-interrupt-primitive.md](2026-05-22-runbatch-concurrent-interrupt-primitive.md).**
> The runBatch refactor solves this plan's use case as Task 6 (Sequential multi-callback hook via `runBatch` `mode: "sequential"`). Do not implement this plan directly.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When multiple callbacks registered on the same hook (e.g. two top-level `callback("onNodeStart", ...)`) each raise `interrupt(...)`, the runtime must batch the interrupts AND resume each callback's frame correctly — so each callback's pre-interrupt side effects fire exactly once across the resume cycle.

**Architecture:** Today `Runner.hook` (`lib/runtime/runner.ts:405`) fires `callHook` and halts with the merged `Interrupt[]`, but each interrupt's `checkpoint` was stamped by its own callback's interrupt site capturing only that callback's frame. `respondToInterrupts` uses `interrupts[0].checkpoint`, so only callback A's frame is reused from the deserialize queue on resume — callback B's body re-runs from the top. The fix mirrors `Runner.runForkAll` (`runner.ts:777`): treat each callback invocation as a branch, stamp ONE shared hook-level checkpoint capturing all branches' state at the moment of hook firing, record each branch's interrupt id via `setInterruptOnBranch`, and on resume re-enter only the branches whose interrupt id has not been responded to. The branches here are sequential (not concurrent), but the bookkeeping is the same shape.

**Tech Stack:** TypeScript runtime (`lib/runtime/runner.ts`, `lib/runtime/hooks.ts`, `lib/runtime/state/stateStack.ts`, `lib/runtime/interrupts.ts`), Agency execution tests (`tests/agency/`), Vitest.

---

### Task 1: Document the empirical contradiction and write the diagnostic test

**Files:**
- Create: `tests/agency/callback-multi-interrupt-resume.agency`
- Create: `tests/agency/callback-multi-interrupt-resume.test.json`
- Create: `tests/agency/callback-multi-interrupt-resume.js`

- [ ] **Step 1: Read the existing single-callback resume fixtures**

Read `tests/agency/callback-interrupt-resume-onnodestart.agency` and `callback-interrupt-resume-onfunctionstart.agency` end-to-end. These document the working single-callback exactly-once invariant. The multi-callback version must hold the same shape: each callback body that increments a counter before the interrupt must increment exactly once across the resume cycle.

- [ ] **Step 2: Write the diagnostic fixture**

Register two top-level `callback("onNodeStart", ...)` callbacks. Each one:
- increments a uniquely-named global counter (`countA`, `countB`),
- calls `interrupt("approve", { which: "A" | "B" })`,
- increments a second uniquely-named global counter (`postA`, `postB`).

The node body just runs. The driver resumes with `{ A: "ok", B: "ok" }`.

Assertions after resume completes:
- `countA == 1 && countB == 1` (each callback's pre-interrupt side effect fires exactly once),
- `postA == 1 && postB == 1` (each callback's post-interrupt side effect fires exactly once),
- the user only needed ONE round of `respondToInterrupts` (no cascading extra interrupts).

- [ ] **Step 3: Run and capture failure**

```bash
pnpm run agency test tests/agency/callback-multi-interrupt-resume.agency > /tmp/multi-cb-resume.log 2>&1
```

Record the actual counter values seen (will likely contradict both the dev doc's claim AND naive expectations — the user has observed the interrupter re-runs while pure observers don't re-fire; document the precise observed behavior).

- [ ] **Step 4: Commit as failing fixture**

```bash
git add tests/agency/callback-multi-interrupt-resume.*
git commit -F .git/COMMIT_MSG.txt   # "test: add failing fixture for multi-callback same-hook resume"
```

---

### Task 2: Audit `Runner.runForkAll` and `setInterruptOnBranch`

**Files:**
- Read only: `lib/runtime/runner.ts:777-983` (runForkAll), `lib/runtime/state/stateStack.ts` (BranchState, setInterruptOnBranch, getOrCreateBranch, deleteBranch)
- Read only: `docs/dev/concurrent-interrupts.md`

- [ ] **Step 1: Build a notes file enumerating the fork-style primitives**

`docs/notes/fork-style-primitives.md` (delete after task 5). Capture:
- the exact shape of `BranchState` and what fields persist across resume,
- how `setInterruptOnBranch` writes `interruptId` / `interruptData` / `checkpoint` to the branch,
- how `runForkAll` decides which branches to re-enter on resume (via "if branch has cached result, skip; if branch has pending interrupt id with a now-available response, resume; if neither, run from scratch"),
- the shared-checkpoint stamping pattern (`ctx.checkpoints.create(stateStack, ...)`).

This is reference material for Task 3 — having it written down prevents off-by-one errors in the new hook branching code.

---

### Task 3: Implement branched `Runner.hook`

**Files:**
- Modify: `lib/runtime/runner.ts:405-443` (`hook` method)
- Modify: `lib/runtime/hooks.ts` (factor `callHook` to expose a "fire one callback" primitive)
- Modify (maybe): `lib/runtime/state/stateStack.ts` (if the hook-branch needs a new branch-key namespace)

- [ ] **Step 1: Factor `callHook` into `gatherCallbacks` + `invokeOneCallback`**

`Runner.hook` must invoke each callback individually so it can wrap each invocation in branch bookkeeping. Add to `lib/runtime/hooks.ts`:

```ts
export async function invokeOneCallback<K extends keyof CallbackMap>(args: {
  ctx: RuntimeContext<any>;
  name: K;
  fn: any;
  data: CallbackMap[K];
}): Promise<Interrupt[] | undefined> {
  return await fireWithGuard(args.fn, args.data, args.ctx, args.name);
}

export function listCallbacks<K extends keyof CallbackMap>(
  ctx: RuntimeContext<any>,
  name: K,
): Array<{ source: "global" | "scoped" | "topLevel" | "ts"; fn: any }> {
  // Returns same order as gatherCallbacks but tagged with source so the
  // caller can construct stable branch keys.
}
```

`callHook` keeps working for the sequential `callHookAndDrop` path; the new primitives are for `Runner.hook`.

- [ ] **Step 2: Rewrite `Runner.hook` to use per-callback branches**

```ts
async hook(id: number, hookName: CallbackName, data: unknown): Promise<void> {
  if (this.shouldSkip()) return;
  if (this.getCounter() > id) return;
  if (await this.maybeDebugHook(id)) return;
  this.ctx.coverageCollector?.hit(this.moduleId, this.scopeName, this.stepPath(id));

  this.path.push(id);
  try {
    const callbacks = listCallbacks(this.ctx, hookName as keyof CallbackMap);
    const collected: Interrupt[] = [];

    for (let i = 0; i < callbacks.length; i++) {
      const branchKey = this.hookBranchKey(id, i);
      const existing = this.frame.getBranch(branchKey);

      // Resume path: branch already completed cleanly → skip.
      if (existing?.result !== undefined) continue;

      // Resume path: branch has pending interrupt id with a response → re-enter.
      // Pure-firing path: no branch exists yet → create one, fire callback.
      const branch = existing ?? this.frame.getOrCreateBranch(branchKey);

      const result = await invokeOneCallback({
        ctx: this.ctx,
        name: hookName as keyof CallbackMap,
        fn: callbacks[i].fn,
        data: data as CallbackMap[keyof CallbackMap],
      });

      if (result && hasInterrupts(result)) {
        this.frame.setInterruptOnBranch(
          branchKey,
          result[0].interruptId,
          result[0].interruptData,
          undefined, // checkpoint stamped below, after all branches fire
        );
        collected.push(...result);
        // Do NOT short-circuit: sibling callbacks must still run.
        continue;
      }

      // Mark branch as completed cleanly.
      this.frame.setResultOnBranch(branchKey, undefined);
    }

    if (collected.length > 0) {
      // Stamp ONE shared hook-level checkpoint capturing all branches at once.
      const cpId = this.ctx.checkpoints.create(this.stack ?? this.ctx.stateStack, this.ctx, {
        moduleId: this.moduleId,
        scopeName: this.scopeName,
        stepPath: this.stepPath(id),
      });
      const cp = this.ctx.checkpoints.get(cpId)!;
      this.ctx.statelogClient.checkpointCreated({
        checkpointId: cpId,
        reason: "interrupt",
        sourceLocation: { moduleId: cp.moduleId, scopeName: cp.scopeName, stepPath: cp.stepPath },
      });
      for (const intr of collected) {
        intr.checkpoint = cp;
        intr.checkpointId = cpId;
      }

      // onAgentStart/End defense-in-depth (preserve current behavior).
      if (hookName === "onAgentStart" || hookName === "onAgentEnd") {
        throw new Error(/* same message as in callHook */);
      }

      if (this.nodeContext) {
        this.halt({ ...this.state, data: collected });
      } else {
        this.halt(collected);
      }
      return;
    }
  } finally {
    this.path.pop();
  }

  if (this.halted) return;
  this.clearDebugFlag(id);
  this.setCounter(id + 1);
}

private hookBranchKey(id: number, callbackIndex: number): string {
  return this.path.length === 0
    ? `hook_${id}_${callbackIndex}`
    : `hook_${this.key()}_${id}_${callbackIndex}`;
}
```

**Capture-time slice rule:** the `ctx.checkpoints.create` call MUST use the runner's `this.stack` (the local branch stack if we are running inside fork/race), not `ctx.stateStack`. See `docs/dev/concurrent-interrupts.md`.

**Handlers are safety infrastructure:** if a callback's interrupt is caught by a `handle` block on the live stack at invocation time, `invokeOneCallback` returns `undefined` (no interrupt surfaces), exactly as `callHook` does today. Verify by reading `fireWithGuard` and the handler walk inside `AgencyFunction.invoke`.

- [ ] **Step 3: Wire `onAgentStart` / `onAgentEnd` defense-in-depth**

The thrown error currently lives in `callHook`. With branched firing, replicate it in `Runner.hook` after `collected` is built (or factor it out into a small helper called from both sites). Don't drop it — it's the loud-failure surface for a misuse pattern.

- [ ] **Step 4: Run the diagnostic fixture from Task 1**

```bash
pnpm run agency test tests/agency/callback-multi-interrupt-resume.agency > /tmp/multi-cb-resume-fixed.log 2>&1
```

Must pass: both counters == 1, both post-counters == 1, single resume cycle.

- [ ] **Step 5: Run the full callback test family**

```bash
pnpm test:run -- callback > /tmp/cb-all.log 2>&1
```

Zero regressions. Existing single-callback tests still pass.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/ tests/agency/
git commit -F .git/COMMIT_MSG.txt   # "feat: branched per-callback resume for same-hook multi-callback interrupts"
```

---

### Task 4: Coverage for the corner cases

**Files:**
- Create: `tests/agency/callback-multi-interrupt-one-only.agency` (+ `.test.json`, `.js`)
- Create: `tests/agency/callback-multi-interrupt-mixed-observer.agency` (+ `.test.json`, `.js`)
- Create: `tests/agency/callback-multi-interrupt-handler-catches-one.agency` (+ `.test.json`, `.js`)
- Create: `tests/agency/callback-multi-interrupt-inside-fork.agency` (+ `.test.json`, `.js`)

- [ ] **Step 1: One-interrupts-one-doesn't fixture**

Two callbacks on `onFunctionStart`; only the first calls `interrupt(...)`. Assert single interrupt surfaces, the non-interrupting callback's frame is marked done and is skipped on resume.

- [ ] **Step 2: Pure-observer mixed with interrupter**

Three callbacks: observer, interrupter, observer. After resume, each callback's side effects fired exactly once.

- [ ] **Step 3: Handler catches one branch's interrupt**

Wrap one of the two callback bodies in `handle { ... } catch { ... }`. That branch's interrupt is caught inside the callback and never surfaces; the other branch's interrupt does surface. After resume, the caught branch is marked complete (no extra interrupt cycles for it).

- [ ] **Step 4: Multi-callback hook inside a `fork` branch**

`fork(items) as item { helper() }` with two top-level `onFunctionStart` callbacks both interrupting. Each fork branch independently runs the hook with two callback branches → 2N interrupts in the outer batch. Assert nested branch-key composition doesn't collide.

- [ ] **Step 5: Run all four, capture output**

```bash
pnpm test:run -- callback fork > /tmp/cb-corners.log 2>&1
```

- [ ] **Step 6: Commit**

---

### Task 5: Documentation cleanup

**Files:**
- Modify: `docs/dev/callback-hooks.md`
- Modify: `docs/site/appendix/callbacks.md`
- Delete: `docs/notes/fork-style-primitives.md` (Task 2 scratch file)

- [ ] **Step 1: Rewrite the "Resume limitation when multiple callbacks raise interrupts" section in `callback-hooks.md`**

Replace it with a "Multi-callback resume" section describing the branched implementation. Note the parallel with `runForkAll`. Note the empirical observation from Task 1 was correct — the old code was worse than the dev doc admitted.

- [ ] **Step 2: Update the per-hook table in `callbacks.md`**

Change `onNodeStart`, `onNodeEnd`, `onFunctionStart`, `onEmit` rows from `⚠️ Batched, but resume is partial` to `✅ Batched`. Remove the "Single-callback constraint" subsection or rewrite it as a footnote noting the historical limitation.

- [ ] **Step 3: Remove the scratch notes file**

- [ ] **Step 4: Commit docs**

---

### Validation checklist

- [ ] All new fixtures pass.
- [ ] All existing `callback-*` and `fork/*` tests pass.
- [ ] `pnpm run lint:structure` clean.
- [ ] `make` succeeds.
- [ ] `make fixtures` no-op (no codegen change in this plan — only runtime).
- [ ] Docs updated.
- [ ] `onAgentStart/End` defense-in-depth error still throws when triggered (manual smoke or a tiny test fixture if one doesn't exist).
