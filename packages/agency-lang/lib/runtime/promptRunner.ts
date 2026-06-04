import type { MessageJSON } from "smoltalk";
import { hasInterrupts, type Interrupt } from "./interrupts.js";
import { runBatch, type RunBatchResult } from "./runBatch.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { State, StateStack } from "./state/stateStack.js";

/**
 * Thrown by {@link PromptRunner.step} when a step body returns interrupts.
 *
 * Caught only at the top of `runPrompt`, which extracts the batched
 * `interrupts` and returns them as `runPrompt`'s result so the generated
 * caller can checkpoint and propagate them. NEVER propagates outside
 * `lib/runtime/prompt.ts`.
 */
export class PromptBailout extends Error {
  constructor(public readonly interrupts: Interrupt[]) {
    super("PromptBailout");
    this.name = "PromptBailout";
  }
}

/**
 * Frame-backed completion tracking. Lives on `self.runnerState` so it
 * survives checkpoint/restore the same way `self.messagesJSON` does:
 * the frame's `locals` object is what gets serialized. An array (used
 * as a set) keeps the format JSON-safe and matches the project's
 * "arrays instead of sets" convention.
 */
export type RunnerState = {
  completedSteps: string[];
};

export type PromptRunnerOpts = {
  /** Frame-local `self` object (== the function's locals bag). */
  self: any;
  ctx: RuntimeContext<any>;
  stateStack: StateStack;
  /** The runPrompt frame (== `stateStack.lastFrame()`). Used by
   * `parallel()` as `runBatch`'s `parentFrame` for per-tool branch
   * lifecycle. Defaulted from `stateStack.lastFrame()` for callers that
   * don't pass it explicitly. */
  parentFrame?: State;
  /** Source location of the surrounding generated call site. Used as the
   *  base `stepPath` when stamping a checkpoint on bailout — see
   *  `step()` for the per-key suffix.  */
  checkpointInfo: SourceLocationOpts | undefined;
  /** Callback that snapshots the current message thread JSON. Called only
   *  on bailout so it doesn't pay the cost on the happy path. */
  snapshotMessages: () => MessageJSON[];
};

/**
 * Control-flow helper for `runPrompt`. Owns the idempotent-step +
 * checkpoint-on-interrupt machinery so the surrounding `runPrompt`
 * body can be a linear script.
 *
 * See `docs/superpowers/plans/2026-05-22-prompt-runner.md`.
 */
export class PromptRunner {
  constructor(private opts: PromptRunnerOpts) {
    // Defensive init: an older / partially-restored frame may have a
    // `runnerState` object that lacks `completedSteps` (e.g. a checkpoint
    // taken before this field existed). Initialize both fields
    // independently so `step()` doesn't blow up when reading
    // `runnerState.completedSteps` on resume.
    this.opts.self.runnerState ??= {};
    this.opts.self.runnerState.completedSteps ??= [];
  }

  /**
   * Run `body` as an idempotent step, identified by `key`.
   *
   * If `key` is already recorded as completed (resume case), this is a
   * no-op. Otherwise the body runs:
   *   - if it returns `Interrupt[]`, snapshot messages, stamp a
   *     checkpoint (non-pinned, matching `Runner`'s interrupt
   *     checkpoints), attach the checkpoint id to every interrupt, and
   *     throw `PromptBailout` so `runPrompt` can return the batch up
   *     the stack. The key is NOT marked completed — on resume, the
   *     step re-enters, the body re-runs, and the saved
   *     `__interruptId_N` matches the user's response.
   *   - if it returns nothing (the happy path), the key is marked
   *     completed so the next resume skips this step.
   *
   * The checkpoint's `stepPath` is `${checkpointInfo.stepPath}/${key}`
   * so multiple steps within one `runPrompt` produce distinct
   * checkpoints. Without this they would all share the runPrompt-level
   * `stepPath` and the checkpoint store could not tell them apart on
   * resume.
   */
  async step(
    key: string,
    body: () => Promise<Interrupt[] | void>,
  ): Promise<void> {
    if (this.opts.self.runnerState.completedSteps.includes(key)) return;
    const result = await body();
    if (result && hasInterrupts(result)) {
      this.opts.self.messagesJSON = this.opts.snapshotMessages();
      const basePath = this.opts.checkpointInfo?.stepPath ?? "";
      const stepPath = basePath ? `${basePath}/${key}` : key;
      const cpId = this.opts.ctx.checkpoints.create(
        this.opts.stateStack,
        this.opts.ctx,
        {
          moduleId: this.opts.checkpointInfo?.moduleId ?? "",
          scopeName: this.opts.checkpointInfo?.scopeName ?? "",
          stepPath,
        },
      );
      const cp = this.opts.ctx.checkpoints.get(cpId)!;
      for (const intr of result) {
        intr.checkpoint = cp;
        intr.checkpointId = cpId;
      }
      this.opts.ctx.statelogClient.checkpointCreated({
        checkpointId: cpId,
        reason: "interrupt",
        sourceLocation: {
          moduleId: cp.moduleId,
          scopeName: cp.scopeName,
          stepPath: cp.stepPath,
        },
      });
      throw new PromptBailout(result);
    }
    this.opts.self.runnerState.completedSteps.push(key);
  }

  /**
   * Run `branchFn` concurrently for every item in `items`. Each call
   * receives a {@link BranchRunner} which exposes its own `step()` that
   * COLLECTS interrupts rather than throwing — siblings keep running
   * even when one halts so we can batch all interrupts into a single
   * shared checkpoint.
   *
   * Thin adapter over {@link runBatch} with `mode: "all"` and
   * `recordBranchOutcomes: false` (the caller's `branchFn` body manages
   * branch state itself via `stack.setResultOnBranch` / `deleteBranch`).
   * `runBatch` owns: per-branch abort composition, ALS-isolated invoke,
   * settle, shared checkpoint stamp at
   * `${checkpointInfo.stepPath}/${keyPrefix}` with
   * `intr.checkpoint`/`checkpointId` overwrite, and `popBranches` on
   * the no-interrupt success path. Returns a {@link RunBatchResult}
   * tagged union — `"interrupts"` if any branch halted (the caller
   * bails out of runPrompt with `result.interrupts`), `"values"`
   * otherwise.
   *
   * `keyFor(item, i)` MUST produce the same branch key the `branchFn`
   * body uses for its `stack.getOrCreateBranch(...)` — otherwise
   * `runBatch` would allocate a separate branch from the one the body
   * manages, and the leaf-checkpoint vehicle into State.toJSON's
   * branches walk would be lost.
   *
   * IMPORTANT: do NOT call `pr.step(...)` (which throws `PromptBailout`)
   * from inside a branch — use `b.step(...)` instead. A throw from
   * `branchFn` propagates out of `runBatch` and aborts the whole batch.
   */
  async parallel<T>(
    keyPrefix: string,
    items: T[],
    keyFor: (item: T, index: number) => string,
    branchFn: (item: T, b: BranchRunner) => Promise<void>,
  ): Promise<RunBatchResult<void>> {
    const branches = items.map(() => new BranchRunner(this.opts.self));
    const parentFrame = this.opts.parentFrame ?? this.opts.stateStack.lastFrame();
    const basePath = this.opts.checkpointInfo?.stepPath ?? "";
    const stepPath = basePath ? `${basePath}/${keyPrefix}` : keyPrefix;

    const result = await runBatch<void>({
      ctx: this.opts.ctx,
      parentStack: this.opts.stateStack,
      parentFrame,
      checkpointLocation: {
        moduleId: this.opts.checkpointInfo?.moduleId ?? "",
        scopeName: this.opts.checkpointInfo?.scopeName ?? "",
        stepPath,
      },
      mode: "all",
      // The branchFn body sets branch.result / interrupt info itself via
      // `stack.setResultOnBranch` / `setInterruptOnBranch` in
      // runInvokeStep. runBatch must NOT also call these — letting it
      // overwrite branch.result with the body's `undefined` return value
      // would destroy the meaningful tool result that runPrompt needs to
      // read on resume (e.g. line 723 of prompt.ts).
      recordBranchOutcomes: false,
      // Tool dispatches are NOT a user-facing concurrency primitive —
      // the user wrote `llm({tools: [foo]})` expecting `foo` to be
      // called like a normal function. Per-branch globals/threads
      // isolation would silently drop any global mutation a tool
      // makes (counters, caches, per-run accumulators) and confine
      // each tool call's active-thread pointer to its own subthread.
      // Pointer-share the parent's state instead so tool dispatches
      // behave like sequential function invocations.
      isolateState: false,
      children: items.map((item, i) => ({
        key: keyFor(item, i),
        invoke: async () => {
          await branchFn(item, branches[i]);
          // Surface the branch's collected interrupts (if any) as the
          // invoke's return value. runBatch will batch them with sibling
          // interrupts and stamp the shared checkpoint.
          return branches[i].interrupts ?? undefined;
        },
      })),
      hooks: {
        // Snapshot the message thread INTO `self.messagesJSON` BEFORE
        // runBatch calls `ctx.checkpoints.create`. The checkpoint deep-
        // clones `self.locals` synchronously, so mutating messagesJSON
        // after `create` would NOT be visible in the captured state.
        //
        // This matters because each tool branch's body pushes its
        // `tool` response onto the shared `MessageThread` via
        // `messages.push(...)` during the batch — but those pushes
        // never refresh `self.messagesJSON`. If we let runBatch stamp
        // the checkpoint with stale messagesJSON, every successful
        // sibling's tool response is lost on resume (the resumed run
        // restores from messagesJSON and skips the completed branches,
        // so their messages.push doesn't re-fire). The next LLM call
        // then receives an assistant message with N tool_calls but
        // only M < N matching tool responses, which real APIs reject.
        // See tests/agency-js/parallel-tools-resume-messages-intact.
        beforeCheckpoint: () => {
          this.opts.self.messagesJSON = this.opts.snapshotMessages();
        },
        onCheckpoint: (cpId) => {
          const cp = this.opts.ctx.checkpoints.get(cpId)!;
          this.opts.ctx.statelogClient.checkpointCreated({
            checkpointId: cpId,
            reason: "interrupt",
            sourceLocation: {
              moduleId: cp.moduleId,
              scopeName: cp.scopeName,
              stepPath: cp.stepPath,
            },
          });
        },
      },
    });

    return result;
  }
}

/**
 * Branch-local step runner produced by {@link PromptRunner.parallel}.
 *
 * Differs from `PromptRunner.step` in two ways:
 *   - On interrupt, collects them on `this.interrupts` rather than
 *     throwing. The parallel orchestrator merges across siblings.
 *   - All subsequent `step()` calls on the same branch short-circuit
 *     once `interrupts` is set — the branch is effectively halted.
 *
 * Completion keys live on the same `self.runnerState.completedSteps`
 * map as the outer runner, so callers must pick keys that are unique
 * per-branch (e.g. include the per-item id in the key).
 */
export class BranchRunner {
  public interrupts: Interrupt[] | null = null;

  constructor(private self: any) {
    // Same defensive init as PromptRunner — see comment there.
    this.self.runnerState ??= {};
    this.self.runnerState.completedSteps ??= [];
  }

  async step(
    key: string,
    body: () => Promise<Interrupt[] | void>,
  ): Promise<void> {
    if (this.interrupts) return;
    if (this.self.runnerState.completedSteps.includes(key)) return;
    const result = await body();
    if (result && hasInterrupts(result)) {
      this.interrupts = result;
      return;
    }
    this.self.runnerState.completedSteps.push(key);
  }
}
