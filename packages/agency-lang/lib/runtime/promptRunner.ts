import type { Run } from "./asyncContext.js";
import type { StatelogClient } from "../statelogClient.js";
import { debugStep, whileBusy, type StopLocation } from "./debugger.js";
import { isInsideCallback } from "./hooks.js";
import type { MessageJSON } from "smoltalk";
import type { MessageThreadJSON } from "./state/messageThread.js";
import { hasInterrupts, type Interrupt } from "./interrupts.js";
import { runBatch, type RunBatchResult } from "./runBatch.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { LoopStopKind } from "./state/sourceLocation.js";
import {
  seedBranchCost,
  propagateBranchCost,
  type State,
  type StateStack,
} from "./state/stateStack.js";

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
  /** The step whose body raised the interrupts the frame paused on
   *  (`bailOut`), so the resume knows which step it re-enters. */
  pendingStep?: string;
};

/** Which model request of the tool loop a step is: the first one, the
 *  one after a round of tool calls, or a validation retry. The runner
 *  derives the step's key and the debugger's label from it. */
export type WhichLlmCall =
  { first: true } | { afterToolRound: number } | { validationRetry: number };

/** The step key of a model request. Keys are recorded in checkpoints
 *  (`runnerState.completedSteps`), so they keep the names they had before
 *  the runner derived them. The tool loop uses them in the keys of the
 *  gate steps it runs around a request. */
export function llmCallKey(which: WhichLlmCall): string {
  if ("first" in which) return "initialLlmCall";
  if ("afterToolRound" in which) return `round.${which.afterToolRound}.nextLlmCall`;
  return `validation.${which.validationRetry}.llmCall`;
}

/** The debugger's label for a stop before a model request. The round the
 *  person sees counts from 1; `afterToolRound` counts the tool rounds that
 *  came before, from 0. */
function llmCallLabel(which: WhichLlmCall): string {
  if ("first" in which) return "round 1";
  if ("afterToolRound" in which) return `round ${which.afterToolRound + 2}`;
  return `validation retry ${which.validationRetry + 1}`;
}

/** The debugger's label for a stop before a tool call, and for the wait
 *  while it runs: the call as the activity log prints it, with each
 *  argument cut to a readable length. */
function toolStopLabel(name: string, args: Record<string, unknown>): string {
  const shown = Object.entries(args).map(([key, value]) => {
    const text = JSON.stringify(value) ?? "undefined";
    const cut = text.length > TOOL_STOP_ARG_CHARS ? text.slice(0, TOOL_STOP_ARG_CHARS) + "…" : text;
    return `${key}: ${cut}`;
  });
  return `${name}(${shown.join(", ")})`;
}

const TOOL_STOP_ARG_CHARS = 40;

/** The step path of the statement a runner step is under: the part of
 *  the step's path before the slash that introduces the runner's key
 *  (see `step`). For a path with no key, the path itself. */
export function statementStepPath(stepPath: string): string {
  const slash = stepPath.indexOf("/");
  return slash === -1 ? stepPath : stepPath.slice(0, slash);
}

/** One of the tool loop's own debugger stops: what kind, and the label
 *  the debugger shows in place of a source line. */
type LoopStop = {
  loopStop: LoopStopKind;
  label: string;
};

export type PromptRunnerOpts = {
  /** Frame-local `self` object (== the function's locals bag). */
  self: any;
  ctx: RuntimeContext<any>;
  /** The run `runPrompt` was called under, for the debugger's stops. */
  run: Run;
  /** The logger of the run `runPrompt` was called under. `step()` runs in
   *  that run's own flow, never inside a tool branch. */
  log: StatelogClient;
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
   *  on bailout so it doesn't pay the cost on the happy path.
   *
   *  Returns the FULL `MessageThreadJSON` so per-message debug labels
   *  survive the round-trip; `MessageThread.fromJSON` also still accepts
   *  the bare `MessageJSON[]` that older checkpoints hold. */
  snapshotMessages: () => MessageThreadJSON | MessageJSON[];
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
  async step(key: string, body: () => Promise<Interrupt[] | void>): Promise<void> {
    if (this.opts.self.runnerState.completedSteps.includes(key)) return;
    this.forgetPendingStep(key);
    const result = await body();
    if (result && hasInterrupts(result)) {
      this.bailOut(key, result);
    }
    this.opts.self.runnerState.completedSteps.push(key);
  }

  /**
   * Run `body`, a model request, as a step. With a debugger attached the
   * step stops before the request, labelled `round N` or `validation
   * retry N`, so a person can change the thread before the model sees
   * it. See `docs/dev/cli/debugger.md`, "Stops between tool calls".
   */
  async llmCall(which: WhichLlmCall, body: () => Promise<Interrupt[] | void>): Promise<void> {
    const key = llmCallKey(which);
    const label = llmCallLabel(which);
    // The stop comes before the body and the wait covers the body alone,
    // so a person stopped before a request is not shown waiting on it.
    await this.stepWithStop(key, { loopStop: "round", label }, () =>
      whileBusy(
        this.opts.run,
        this.opts.stateStack,
        { kind: "model", label, location: this.loopLocation(key, this.opts.run) },
        body,
      ),
    );
  }

  /** Run `body` as the invoke step `key` of the tool call `call` on its
   *  branch runner, shown to the debugger as a wait while it runs
   *  (`whileBusy`), as `llmCall` runs a request. The invoke step is the
   *  one that re-runs when the tool's own interrupt is answered, so a
   *  resumed tool is reported again; a step skipped on a resume opens
   *  nothing. */
  async invokeTool(
    branch: BranchRunner,
    key: string,
    call: {
      /** The run and the stack of the tool's branch. */
      run: Run;
      branchStack: StateStack;
      handler: { name: string };
      namedArgs: Record<string, unknown>;
      /** The tool round, counted from 0 after the first request. */
      round: number;
    },
    body: () => Promise<Interrupt[] | void>,
  ): Promise<void> {
    const { run, branchStack, handler, namedArgs } = call;
    const label = toolStopLabel(handler.name, namedArgs);
    const location = this.loopLocation(key, run);
    // The person counts rounds from the first request, so the calls of
    // tool round 0 are in round 1, as `llmCallLabel` counts them.
    const wait = { kind: "tool" as const, label, location, round: call.round + 1 };
    await branch.step(key, () => whileBusy(run, branchStack, wait, body));
  }

  /** Where one of the loop's steps is, for a stop before it and for the
   *  wait while it runs: under the `llm()` statement, at the statement's
   *  path plus the step's key, on `run`'s branch and at its depth. */
  loopLocation(key: string, run: Run): StopLocation {
    return {
      moduleId: this.opts.checkpointInfo?.moduleId ?? "",
      scopeName: this.opts.checkpointInfo?.scopeName ?? "",
      stepPath: this.stepPathFor(key),
      branchPath: run.stack.branchPath(),
      depth: run.callDepth?.depth ?? 0,
    };
  }

  /**
   * The debugger's stop before the tool call `invocationKey` names,
   * labelled with the call and its arguments. Nothing happens without a
   * debugger: the stop is a step of its own, `${invocationKey}.before`,
   * and recording it would cost every run a key per call. `branchKey` is
   * the branch the call runs on, for a call that was already running when
   * the frame was restored; see `resumesInto`.
   */
  async beforeToolCall(
    invocationKey: string,
    toolCall: { name: string; arguments: Record<string, unknown> },
    branchKey?: string,
  ): Promise<void> {
    if (!this.opts.ctx.hasDebugger()) return;
    await this.stepWithStop(
      `${invocationKey}.before`,
      { loopStop: "tool", label: toolStopLabel(toolCall.name, toolCall.arguments) },
      async () => undefined,
      branchKey,
    );
  }

  /** A step with one of the loop's own debugger stops before its body. */
  private async stepWithStop(
    key: string,
    stop: LoopStop,
    body: () => Promise<Interrupt[] | void>,
    branchKey?: string,
  ): Promise<void> {
    if (this.opts.self.runnerState.completedSteps.includes(key)) return;
    if (!this.resumesInto(key, branchKey)) {
      const halted = await this.debugStop(key, stop);
      if (halted) {
        // debugStep stamped the stop's checkpoint on this stack already.
        this.halt(halted, halted[0].checkpointId!);
      }
    }
    const result = await body();
    if (result && hasInterrupts(result)) {
      this.bailOut(key, result);
    }
    delete this.opts.self[debugFlagKey(key)];
    this.opts.self.runnerState.completedSteps.push(key);
  }

  /** Whether the resume that restored this frame re-enters the step
   *  `key`: the step was in progress at the pause, so the leg before
   *  passed its stop already, and this leg starts its body again with the
   *  interrupt's answer rather than stopping before it. The same rule as
   *  `Runner.maybeDebugHook`, which a frame restored from a checkpoint
   *  taken with no debugger needs, since it has no flag. Two signs: the
   *  frame paused inside the step's own body (`pendingStep`), or a tool
   *  call's branch, `branchKey`, was restored with the frame and waits to
   *  be claimed. A rewind restores no reentry mark, so it stops as
   *  before. */
  private resumesInto(key: string, branchKey: string | undefined): boolean {
    const frame = this.opts.parentFrame ?? this.opts.stateStack.lastFrame();
    if (!frame.wasReentered()) {
      return false;
    }
    if (this.opts.self.runnerState.pendingStep === key) {
      this.forgetPendingStep(key);
      return true;
    }
    return branchKey !== undefined && frame.getBranch(branchKey) !== undefined;
  }

  private forgetPendingStep(key: string): void {
    if (this.opts.self.runnerState.pendingStep === key) {
      delete this.opts.self.runnerState.pendingStep;
    }
  }

  /** Snapshot the thread, stamp a checkpoint against the runPrompt frame's
   *  stack at this step, attach it to every interrupt, and throw
   *  `PromptBailout` so `runPrompt` returns the batch. */
  private bailOut(key: string, interrupts: Interrupt[]): never {
    this.opts.self.runnerState.pendingStep = key;
    this.opts.self.messagesJSON = this.opts.snapshotMessages();
    const cpId = this.opts.ctx.checkpoints.create(this.opts.stateStack, this.opts.ctx, {
      moduleId: this.opts.checkpointInfo?.moduleId ?? "",
      scopeName: this.opts.checkpointInfo?.scopeName ?? "",
      stepPath: this.stepPathFor(key),
    });
    this.halt(interrupts, cpId);
  }

  /** Attach the checkpoint `cpId` to every interrupt and throw
   *  `PromptBailout`. */
  private halt(interrupts: Interrupt[], cpId: number): never {
    this.opts.stateStack.assertNoExecutingHandlers();
    const cp = this.opts.ctx.checkpoints.get(cpId)!;
    for (const intr of interrupts) {
      intr.checkpoint = cp;
      intr.checkpointId = cpId;
    }
    this.opts.log.checkpointCreated({
      checkpointId: cpId,
      reason: "interrupt",
      sourceLocation: {
        moduleId: cp.moduleId,
        scopeName: cp.scopeName,
        stepPath: cp.stepPath,
      },
    });
    throw new PromptBailout(interrupts);
  }

  /** The debugger's stop before a step's body, when a debugger is
   *  attached. Works like `Runner.maybeDebugHook`: it skips a handler
   *  body and a callback body, which have no step address a resume could
   *  re-enter; and a flag in the runPrompt frame's locals is set before
   *  the hook fires, so a resume that re-enters the same step finds it
   *  and skips the stop; `stepWithStop` clears it once the body
   *  completes. The stop is located under the `llm()` statement, in its
   *  module and scope, at the statement's path plus the step's key, and
   *  marked `loopStop`, which is how the debugger knows it has no source
   *  line of its own. It runs on the runPrompt frame, one call deeper
   *  than the statement, so `next` at the statement runs the whole call
   *  and `next` at a stop moves to the loop's next stop over a tool's
   *  body. */
  private async debugStop(key: string, stop: LoopStop): Promise<Interrupt[] | undefined> {
    if (!this.opts.ctx.hasDebugger()) return undefined;
    if (this.opts.stateStack.hasExecutingHandlers() || isInsideCallback(this.opts.run)) {
      return undefined;
    }
    const flag = debugFlagKey(key);
    if (this.opts.self[flag]) return undefined;
    this.opts.self[flag] = true;
    const halted = await debugStep(
      this.opts.run,
      {
        moduleId: this.opts.checkpointInfo?.moduleId ?? "",
        scopeName: this.opts.checkpointInfo?.scopeName ?? "",
        stepPath: this.stepPathFor(key),
        label: stop.label,
        loopStop: stop.loopStop,
        nodeContext: false,
        isUserAdded: false,
      },
      this.opts.stateStack,
    );
    if (halted) return halted;
    delete this.opts.self[flag];
    return undefined;
  }

  /** `${checkpointInfo.stepPath}/${key}`, so every step of one `runPrompt`
   *  has its own checkpoint location. */
  private stepPathFor(key: string): string {
    const basePath = this.opts.checkpointInfo?.stepPath ?? "";
    return basePath ? `${basePath}/${key}` : key;
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
    run: Run,
    keyPrefix: string,
    items: T[],
    keyFor: (item: T, index: number) => string,
    branchFn: (item: T, b: BranchRunner, index: number, branchRun: Run) => Promise<void>,
  ): Promise<RunBatchResult<void>> {
    const branches = items.map(() => new BranchRunner(this.opts.self));
    const parentFrame = this.opts.parentFrame ?? this.opts.stateStack.lastFrame();
    const stepPath = this.stepPathFor(keyPrefix);

    const result = await runBatch<void>({
      run,
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
      // Pointer-share BOTH state slots so tool dispatches behave
      // like sequential function invocations.
      shareGlobals: true,
      shareThreads: true,
      children: items.map((item, i) => ({
        key: keyFor(item, i),
        invoke: async (branchRun) => {
          await branchFn(item, branches[i], i, branchRun);
          // Surface the branch's collected interrupts (if any) as the
          // invoke's return value. runBatch will batch them with sibling
          // interrupts and stamp the shared checkpoint.
          return branches[i].interrupts ?? undefined;
        },
      })),
      hooks: {
        // Roll each tool branch's LLM cost/tokens up to the parent stack,
        // just like fork/parallel/race do (see Runner). Subagents run as
        // tools in their own branch stacks; without these hooks their
        // spend (e.g. an oracle on a pricier model) never propagated back,
        // so `getCost()`/`getTokens()` under-reported the turn. seed is
        // idempotent across interrupt/resume; propagate fires only on the
        // no-interrupt completion path (runBatch.ts), and the delta math
        // is correct across resume because the seed baseline is per-branch.
        seedBranchCost: (childStack, parentStack) => seedBranchCost(childStack, parentStack),
        propagateBranchCost: (branches, parentStack) => propagateBranchCost(branches, parentStack),
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
          run.log.checkpointCreated({
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

/** The same `__dbg_` prefix `Runner` uses, so `removeDebugFlagsFor` strips
 *  the loop's flags from a rolling checkpoint as it strips a statement's. */
function debugFlagKey(key: string): string {
  return `__dbg_${key}`;
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

  async step(key: string, body: () => Promise<Interrupt[] | void>): Promise<void> {
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
