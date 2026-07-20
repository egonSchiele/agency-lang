import * as fs from "fs";
import * as path from "path";
import { MessageJSON } from "smoltalk";
import { agencyStore, getRuntimeContext, runInBootstrapFrame } from "./asyncContext.js";
import { callHook } from "./hooks.js";
import type { AgencyCallbacks } from "./hooks.js";
import type { RuntimeContext } from "./state/context.js";
import type { AgencyFunction } from "./agencyFunction.js";
import {
  AgencyCancelledError,
  CheckpointError,
  RestoreSignal,
} from "./errors.js";
import { State, StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { __initAllRegistered, __initAllRegisteredCallbacks } from "./crossModuleInitRegistry.js";
import { loadProviderModules } from "./providerModules.js";
import { resolveTraceFilePath } from "./trace/traceWriter.js";
import { getSubprocessRunInfo } from "./subprocessRunInfo.js";
import { installRunPolicyHandler } from "./runPolicyHandler.js";
import { installRootBudget } from "./rootBudget.js";
import { GraphState, RunNodeResult } from "./types.js";
import { createReturnObject } from "./utils.js";
import { color } from "@/utils/termcolors.js";
import { nanoid } from "nanoid";
import { hasInterrupts } from "./interrupts.js";

export function setupNode(args: { state: GraphState }): {
  stack: State;
  step: number;
  self: Record<string, any>;
  threads: ThreadStore;
} {
  const { state } = args;
  // `ctx` flows through the ALS frame installed by `runNode` (or by
  // `respondToInterrupts` / `rewindFrom`). The `state.ctx` field is still
  // populated by graph.run for backwards compat, but we no longer rely on
  // it here — reading from ALS keeps every per-scope helper consistent
  // with the same source of truth.
  const ctx = getRuntimeContext().ctx;

  const stack = ctx.stateStack.getNewState();
  const step = stack.step;
  const self = stack.locals;

  // Initialize or restore the ThreadStore for dynamic message thread management
  let threads: ThreadStore;
  if (stack.threads) {
    threads = ThreadStore.fromJSON(stack.threads);
    threads.setStatelogClient(ctx.statelogClient);
  } else if (state.messages instanceof ThreadStore) {
    threads = state.messages;
    threads.setStatelogClient(ctx.statelogClient);
  } else {
    // Fallback: create a new ThreadStore with a default active thread.
    // This can happen on debugger/rewind resume paths where messages is not passed
    // and the checkpoint frame doesn't have serialized threads.
    // Pass the client so the default thread is logged.
    threads = ThreadStore.withDefaultActive(ctx.statelogClient);
  }
  stack.threads = threads;

  return { stack, step, self, threads };
}

export function setupFunction(): {
  stateStack: StateStack;
  stack: State;
  step: number;
  self: Record<string, any>;
  threads: ThreadStore;
} {
  // Post-ALS migration: `ctx` / `stack` / `threads` come from the active
  // `agencyStore` frame seeded by the caller (a `runner.step` body,
  // `runNode`'s top-level frame, or `runBatch.runInBranchAlsFrame`).
  // Tool-dispatch from the LLM also runs inside the issuing
  // `runner.step` frame, so the previously-needed "called as tool with
  // no state" fallback (fresh StateStack + empty ThreadStore) cannot
  // arise here. Direct JS callers of `__foo_impl` from outside an
  // Agency execution frame must wrap their call in `runInTestContext`
  // (see lib/runtime/asyncContext.ts).
  //
  // CRITICAL: read `stack` from ALS, not from `ctx.stateStack`. Inside
  // a fork/parallel/race branch, `runBatch.runInBranchAlsFrame` installs
  // an ALS frame whose `stack` is the per-branch StateStack — distinct
  // from `ctx.stateStack`. Pushing a new frame onto `ctx.stateStack`
  // would corrupt the parent's stack and break per-branch isolation
  // (interrupts, abort signals, restore on resume). The pre-migration
  // code preserved this with `state.stateStack ?? state.ctx.stateStack`.
  const { stack: stateStack, threads } = getRuntimeContext();
  const stack = stateStack.getNewState();
  return { stateStack, stack, step: stack.step, self: stack.locals, threads };
}

/**
 * Run the fresh-run bootstrap on a freshly created execution context:
 * cross-module statics/globals, then this module's globals, then top-level
 * callback registration — each inside a bootstrap ALS frame.
 *
 * Shared by the two fresh-run entry points (`runNode`, `runExportedFunction`).
 * The resume family (`respondToInterrupts`, `rewindFrom`) does NOT use this:
 * it restores statics/globals from a checkpoint and only re-registers
 * top-level callbacks.
 */
async function initFreshExecCtx(
  execCtx: RuntimeContext<GraphState>,
  opts: {
    initializeGlobals?: (ctx: RuntimeContext<GraphState>) => void | Promise<void>;
    registerTopLevelCallbacks?: (ctx: RuntimeContext<GraphState>) => void | Promise<void>;
    moduleDir?: string;
  },
): Promise<void> {
  const { initializeGlobals, registerTopLevelCallbacks, moduleDir } = opts;

  // initializeGlobals + registerTopLevelCallbacks both invoke Agency
  // code that goes through `__call` — and `__call` reads `ctx` /
  // `threads` / `stateStack` from the ALS frame after the
  // drop-per-call-context-plumbing migration. Without an ALS frame
  // installed here, calls to user-defined stdlib helpers (e.g. the
  // `callback(...)` wrapper that the codegen emits inside
  // `__registerTopLevelCallbacks`) would invoke `_callbackImpl(name,
  // fn, undefined)` and crash on `__state.ctx`.
  //
  // Consequences worth knowing:
  //  - `stack` in the bootstrap frame is `execCtx.stateStack` — the
  //    bare global stack with no node/function frames pushed. Globals
  //    must not push node frames, so this is correct.
  //  - `threads` is a `BootstrapThreadStore` sentinel. Any agency code
  //    in global-init scope that reaches for a thread/message builtin
  //    (e.g. `systemMessage("…")` at module top-level) now throws with
  //    a clear error instead of silently writing into a placeholder
  //    that this function discards on return.
  //  - The `insideGlobalInit` codegen branch still emits an explicit
  //    `{ ctx }` bag on `__call`, and `__call`'s merge prefers extras
  //    over the ALS-read fields — so `ctx` resolution inside generated
  //    global-init code does not depend on this frame's `ctx` either.
  //    The frame is mostly here to satisfy the "every helper must see
  //    *some* frame" contract.
  //
  // Closure-wide bootstrap (`__initAllRegistered`) MUST run BEFORE the
  // entry's own `initializeGlobals`:
  //   • A global-init expression in the entry can call a function /
  //     node whose body reads an imported `static const`. Those
  //     function-body reads don't show up in the compile-time
  //     per-variable dep graph (which only walks initializer
  //     expressions), so the foreign module's `__initializeGlobals`
  //     would not have been pulled in by the dep-driven prelude. If
  //     we ran the entry's globals init first, the read could hit
  //     `__UNINIT_STATIC` and throw — the exact failure mode this
  //     ordering exists to prevent.
  //   • Running `__initAllRegistered` first guarantees every JS-loaded
  //     module's statics and globals have been initialized before any
  //     user code (including global-init expressions) runs. The
  //     subsequent `initializeGlobals(execCtx)` call is then a no-op
  //     for current codegen (per-execCtx early-return guard) and
  //     double-call protected by the registry-level
  //     `globals.isInitialized` check baked into `__initAllRegistered`.
  // Register custom/local LLM providers before any user code or llm() call.
  // Process-global + idempotent (see loadProviderModules), so it is safe and
  // cheap to call on every fresh run.
  await loadProviderModules(execCtx);
  await runInBootstrapFrame(execCtx, () => __initAllRegistered(execCtx), { moduleDir });
  if (initializeGlobals) {
    await runInBootstrapFrame(execCtx, () => initializeGlobals(execCtx), { moduleDir });
  }
  // Re-register top-level callbacks for EVERY module in the closure (not
  // just the entry) AFTER global init, so imported-module callbacks fire
  // and any globals they read are already set up. The driver owns the
  // single topLevelCallbacks reset. Keep this in sync with the resume
  // (interrupts.ts) and rewind (rewind.ts) paths.
  await runInBootstrapFrame(execCtx, () => __initAllRegisteredCallbacks(execCtx), { moduleDir });
}

/**
 * Tear down an execution context after a fresh run: persist any cached
 * MemoryManager state, drain fire-and-forget statelog POSTs, then release
 * resources. Memory writes are best-effort — a save failure is logged,
 * never thrown — and every cached manager is iterated so a fork branch's
 * side store isn't lost. Shared by `runNode` and `runExportedFunction`;
 * callers run their own span/trace teardown around this.
 */
async function finalizeExecCtx(execCtx: RuntimeContext<GraphState>): Promise<void> {
  for (const manager of execCtx.getAllCachedMemoryManagers()) {
    try {
      await manager.save();
    } catch (err) {
      console.warn(`[memory] save failed: ${(err as Error).message}`);
    }
  }
  // Remote statelog POSTs are fire-and-forget; drain any still in flight
  // so telemetry is delivered before the context is released.
  await execCtx.statelogClient.flush();
  execCtx.cleanup();
}

/**
 * Invoke an exported Agency function from *outside* any Agency execution
 * frame — the `agency serve` path, where an HTTP/MCP request maps a
 * function name + named args to a single stateless call.
 *
 * Generated function bodies assume an ambient `agencyStore` frame: they
 * read `getRuntimeContext().ctx`, the base `StateStack`/`ThreadStore` via
 * `setupFunction()`, and globals via `__globals()`. In normal execution a
 * function only ever runs inside a node body (or an LLM tool-call that is
 * itself inside a node), so that frame is already installed. `runNode`
 * installs it for nodes; this is the equivalent entry point for a bare
 * function call. Without it the first line of every generated function
 * throws "getRuntimeContext() called outside an Agency execution frame".
 *
 * Mirrors `runNode`'s bootstrap (cross-module init, this module's globals
 * init, top-level callback registration) against a fresh execution
 * context so the function sees fully-initialized statics/globals and any
 * module-level `callback(...)` blocks, then runs the call inside a
 * node-grade ALS frame with a real `ThreadStore` (so functions that use
 * `llm()` / message threads work), and tears it down like `runNode` does
 * (persist memory, flush statelog).
 *
 * Two deliberate divergences from `runNode`, both consequences of the
 * stateless-RPC model:
 *   - No `agentStart`/`agentEnd` span and no run-level token roll-up. The
 *     generated function body still reports its own failures to statelog
 *     and converts exceptions to a `Failure` result, so per-call errors
 *     are traced and surface to the caller; what is absent is only the
 *     run-level envelope. A practical consequence: `llm()` spend inside a
 *     served function is not attributed to `getCost` / cost dashboards.
 *   - No checkpoint/restore loop — a function call is one shot, so there
 *     is no `RestoreSignal` handling here (a `catch` would risk swallowing
 *     that and other control-flow signals).
 */
export async function runExportedFunction({
  ctx,
  fn,
  namedArgs,
  initializeGlobals,
  registerTopLevelCallbacks,
  moduleDir,
}: {
  ctx: RuntimeContext<GraphState>;
  fn: AgencyFunction;
  namedArgs: Record<string, unknown>;
  initializeGlobals?: (ctx: RuntimeContext<GraphState>) => void | Promise<void>;
  registerTopLevelCallbacks?: (ctx: RuntimeContext<GraphState>) => void | Promise<void>;
  moduleDir?: string;
}): Promise<unknown> {
  const execCtx = await ctx.createExecutionContext(nanoid());
  await initFreshExecCtx(execCtx, { initializeGlobals, registerTopLevelCallbacks, moduleDir });

  const threadStore = ThreadStore.withDefaultActive(execCtx.statelogClient);
  try {
    return await agencyStore.run(
      {
        ctx: execCtx,
        stack: execCtx.stateStack,
        threads: threadStore,
        globals: execCtx.globals,
        moduleDir,
      },
      async () => {
        const result = await fn.invoke({
          type: "named",
          positionalArgs: [],
          namedArgs,
        });
        // Drain any async work the function spawned (async calls, pending
        // promises) before returning, mirroring runNode's awaitAll.
        await execCtx.pendingPromises.awaitAll();
        return result;
      },
    );
  } finally {
    await finalizeExecCtx(execCtx);
  }
}

// eslint-disable-next-line max-lines-per-function -- core node-execution loop; refactor tracked separately
export async function runNode({
  ctx,
  nodeName,
  data,
  messages,
  callbacks,
  initializeGlobals,
  registerTopLevelCallbacks,
  abortSignal,
  moduleDir,
}: {
  // global execution context
  ctx: RuntimeContext<GraphState>;

  // name of node to run
  nodeName: string;

  // arbitrary data to pass to the node
  data: Record<string, any>;

  // any message history to pass to the node
  // tbd how this gets used. Which message thread does it get added to?
  messages?: MessageJSON[];

  callbacks?: AgencyCallbacks;

  // Absolute path of the directory of the compiled JS module that is
  // initiating this run. Seeded by generated code from `imports.mustache`
  // (passing `__dirname`). Stashed in the ALS frame as `moduleDir` so
  // stdlib helpers (e.g. `resolvePath`, `_dirname`) can resolve paths
  // relative to the module instead of `process.cwd()`.
  moduleDir?: string;

  // initializes global variables on the execution context
  initializeGlobals?: (ctx: RuntimeContext<GraphState>) => void | Promise<void>;

  // Re-registers any module top-level `callback(name, fn) { ... }` blocks
  // on the live execCtx. Module top-level callbacks are stored on
  // `ctx.topLevelCallbacks`, which is reset on every new execCtx and is
  // NOT serialized into checkpoints — so a separate, rerunnable
  // registration phase is required (instead of folding it into
  // `initializeGlobals`, which only runs once per module). The same
  // helper is also re-invoked on resume from `respondToInterrupts` so
  // top-level callbacks survive interrupt round-trips.
  registerTopLevelCallbacks?: (
    ctx: RuntimeContext<GraphState>,
  ) => void | Promise<void>;

  // An AbortSignal for cancelling the agent mid-execution.
  // When aborted, in-flight LLM requests are torn down and a AgencyCancelledError is thrown.
  abortSignal?: AbortSignal;
}): Promise<RunNodeResult<any>> {
  // Subprocesses INHERIT the parent's runId (seeded by the bootstrap from
  // the run instruction) so child statelog events land in the same trace —
  // runIds persist across pause/resume cycles, in-process and out.
  const runId = getSubprocessRunInfo().runId ?? nanoid();

  // runNode is the entry point for a fresh agent run (resumes go through
  // respondToInterrupts instead). If trace output is enabled, truncate the
  // target file so this run starts with a clean slate. FileSink opens in
  // append mode, so subsequent per-execCtx writers within this same run
  // accumulate into the same file naturally.
  const tracePath = resolveTraceFilePath(ctx.traceConfig, runId);
  if (tracePath) {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.writeFileSync(tracePath, "");
  }

  const execCtx = await ctx.createExecutionContext(runId);
  // Cross-module init, this module's globals, then top-level callbacks —
  // see `initFreshExecCtx` for the full ordering rationale (and the
  // `node main() { route({ systemPrompt: foreignStatic }) }` case where a
  // foreign static is read only from a function body).
  await initFreshExecCtx(execCtx, { initializeGlobals, registerTopLevelCallbacks, moduleDir });
  // Install the CLI-driven root policy handler (agency run --policy). No-op
  // unless AGENCY_RUN_POLICY is set and this is the root process (not an IPC
  // subprocess). Installed here — after the exec context exists, before the
  // node body runs — so it is the outermost handler and cannot be bypassed.
  installRunPolicyHandler(execCtx);
  // Install a root cost/time budget from --max-cost / --max-time (via env).
  // Same root-only gate as the policy handler (isIpcMode, inside the
  // installer): no-op in IPC subprocesses, whose budgets are owned by the
  // parent's guard. Outermost, before the node body runs, so it cannot be
  // bypassed.
  installRootBudget(execCtx.stateStack);
  // Externally-passed callbacks are stored on ctx; hook execution merges them
  // with scoped/top-level callbacks at call time.
  if (callbacks) {
    Object.assign(execCtx.callbacks, callbacks);
  }

  // Wire external abort signal to the execution context
  const cancel = (reason?: string) => execCtx.cancel(reason);
  if (abortSignal) {
    if (abortSignal.aborted) {
      throw new AgencyCancelledError();
    }
    abortSignal.addEventListener("abort", () => execCtx.cancel(), {
      once: true,
    });
  }

  // onAgentStart fires BEFORE any agent node has executed, so there is
  // no real per-run ThreadStore yet — use a bootstrap frame so user
  // callbacks that reach for thread/message builtins get a clear error
  // instead of writing into a placeholder. `messages` is still
  // available to the callback via `data.messages`.
  await runInBootstrapFrame(
    execCtx,
    () =>
      callHook({
        ctx: execCtx,
        name: "onAgentStart",
        data: { nodeName, args: data, messages: messages || [], cancel },
      }),
    { moduleDir },
  );

  const agentRunSpanId = execCtx.statelogClient.startSpan("agentRun");
  execCtx.statelogClient.agentStart({ entryNode: nodeName, args: data });
  const agentStartTime = performance.now();

  let isResume = false;
  let threadStore = ThreadStore.withDefaultActive(execCtx.statelogClient);
  try {
    while (true) {
      try {
        // Install an initial AsyncLocalStorage frame so stdlib helpers
        // that read `getRuntimeContext()` (the post-migration replacement
        // for the `__ctx, __stateStack, __threads` codegen-injected
        // args) see a sensible context even on code paths that run
        // outside a Runner-managed step. Generated function and node
        // bodies re-enter `agencyStore.run` inside each Runner step with
        // the scope-local stack/threads, so this top-level frame is just
        // the fallback for early code (callHook, validation, etc.).
        const result = await agencyStore.run(
          {
            ctx: execCtx,
            stack: execCtx.stateStack,
            threads: threadStore,
            globals: execCtx.globals,
            moduleDir,
          },
          () =>
            execCtx.graph.run(
              nodeName,
              {
                messages: threadStore,
                data,
                ctx: execCtx,
                isResume,
              },
              { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id), statelogClient: execCtx.statelogClient },
            ),
        );
        await execCtx.pendingPromises.awaitAll();
        const returnObject = createReturnObject({
          result,
          globals: execCtx.globals,
        });

        if (hasInterrupts(returnObject.data)) {
          // Interrupt(s): attach runId and pause (no footer)
          if (execCtx.runId) {
            // eslint-disable-next-line max-depth -- attaching runId to each interrupt
            for (const intr of returnObject.data) {
              intr.runId = execCtx.runId;
            }
          }
          await execCtx.pauseTraceWriter();
        } else {
          // Final result: emit footer and close
          execCtx.statelogClient.agentEnd({
            entryNode: nodeName,
            result: returnObject.data,
            timeTaken: performance.now() - agentStartTime,
            tokenStats: returnObject.tokens,
          });
          // onAgentEnd fires AFTER the run finished, so seed ALS with
          // the real per-run ThreadStore: user callbacks that inspect
          // the final conversation through stdlib helpers see the
          // actual messages, not a sentinel.
          await agencyStore.run(
            {
              ctx: execCtx,
              stack: execCtx.stateStack,
              threads: threadStore,
              globals: execCtx.globals,
              moduleDir,
            },
            () =>
              callHook({
                ctx: execCtx,
                name: "onAgentEnd",
                data: { nodeName, result: returnObject },
              }),
          );
          await execCtx.closeTraceWriter();
        }
        return returnObject;
      } catch (e) {
        if (e instanceof RestoreSignal) {
          execCtx._restoreCount++;
          if (execCtx._restoreCount > execCtx.maxRestores) {
            throw new CheckpointError(
              `Exceeded maximum number of restores (${execCtx.maxRestores}). Possible infinite loop.`,
            );
          }
          const cp = e.checkpoint;
          execCtx.statelogClient.checkpointRestored({
            checkpointId: cp.id,
            restoreCount: execCtx._restoreCount,
            maxRestores: execCtx.maxRestores,
            overrides: {
              args: !!e.options?.args,
              globals: !!e.options?.globals,
            },
          });
          execCtx.restoreState(cp);
          if (e.options?.args) {
            execCtx._pendingArgOverrides = e.options.args;
          }
          if (e.options?.globals) {
            // eslint-disable-next-line max-depth -- applying restored globals overrides
            for (const [varName, value] of Object.entries(e.options.globals)) {
              execCtx.globals.set(cp.moduleId, varName, value);
            }
          }
          nodeName = cp.nodeId;
          data = {};
          isResume = true;
          execCtx.stateStack.nodesTraversed = [cp.nodeId];
          // Reset ThreadStore for the restored execution
          threadStore = ThreadStore.withDefaultActive(execCtx.statelogClient);
          continue;
        }
        throw e;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    execCtx.statelogClient.error({
      errorType: "runtimeError",
      message: errorMessage,
    });
    // Pull whatever token usage accumulated before the crash so cost
    // dashboards still attribute partial spend to failed runs.
    const partialReturn = createReturnObject({
      result: { data: undefined as any },
      globals: execCtx.globals,
    });
    execCtx.statelogClient.agentEnd({
      entryNode: nodeName,
      timeTaken: performance.now() - agentStartTime,
      tokenStats: partialReturn.tokens,
    });
    throw error;
  } finally {
    execCtx.statelogClient.endSpan(agentRunSpanId); // end agentRun span
    await finalizeExecCtx(execCtx);
  }
}
