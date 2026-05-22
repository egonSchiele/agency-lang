import type { MessageJSON } from "smoltalk";
import { hasInterrupts, type Interrupt } from "./interrupts.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";

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
   * shared checkpoint (mirrors {@link runForkAll} semantics).
   *
   * If any branch's `step` collected interrupts, snapshot messages,
   * stamp ONE checkpoint at `${checkpointInfo.stepPath}/${keyPrefix}`,
   * attach it to every collected interrupt, and throw `PromptBailout` so
   * `runPrompt` returns the merged batch up the stack.
   *
   * IMPORTANT: do NOT call `pr.step(...)` (which throws) from inside a
   * branch — use `b.step(...)` instead. A throw from `branchFn` is not
   * caught and will propagate out of `Promise.all`.
   */
  async parallel<T>(
    keyPrefix: string,
    items: T[],
    branchFn: (item: T, b: BranchRunner) => Promise<void>,
  ): Promise<void> {
    const branches = items.map(() => new BranchRunner(this.opts.self));
    // Snapshot once before scheduling, then run each branch inside its own
    // ALS-backed span context seeded from that snapshot. Without this,
    // sibling branches share the root span stack and concurrent
    // startSpan/endSpan calls interleave (mirrors Runner.runForkAll).
    const parentStack = this.opts.ctx.statelogClient.snapshotStack();
    await Promise.all(
      items.map((item, i) =>
        this.opts.ctx.statelogClient.runInBranchContext(parentStack, () =>
          branchFn(item, branches[i]),
        ),
      ),
    );
    const merged: Interrupt[] = [];
    for (const b of branches) if (b.interrupts) merged.push(...b.interrupts);
    if (merged.length === 0) return;

    this.opts.self.messagesJSON = this.opts.snapshotMessages();
    const basePath = this.opts.checkpointInfo?.stepPath ?? "";
    const stepPath = basePath ? `${basePath}/${keyPrefix}` : keyPrefix;
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
    for (const intr of merged) {
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
    throw new PromptBailout(merged);
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
