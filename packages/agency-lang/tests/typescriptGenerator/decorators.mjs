import { z } from "agency-lang/zod";
import type { Run as __Run, GraphState, Interrupt, InterruptResponse, Checkpoint, PausedCheckpoint, LLMClient, InvocationOptions, ResumeOverrides, CheckpointEdit, StopAt } from "agency-lang/runtime";
import {
  goToNode, color, nanoid, smoltalk,
  RuntimeContext, MessageThread, ThreadStore, Runner,
  setupNode, setupFunction, claimFrameForScope, runNode, runPrompt, callHook,
  checkpointFor as __checkpoint_impl, getCheckpointFor as __getCheckpoint_impl, restoreFor as __restore_impl, _runFor as __runtime_run_impl,
  __codeLiteral,
  interrupt, isInterrupt, hasInterrupts, reportUnhandledInterrupts, resolveCliInterrupts, reportBudgetExceededAndExit, flushPendingStatelogPosts, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  isPaused,
  respondToInterrupts as _respondToInterrupts,
  respondToInterruptsForServe as _respondToInterruptsForServe,
  resumeFromCheckpoint as _resumeFromCheckpoint,
  resumeCliFromCheckpoint as _resumeCliFromCheckpoint,
  rewindFrom as _rewindFrom,
  patchCheckpoint as _patchCheckpoint,
  runExportedFunction as _runExportedFunction,
  runExportedFunctionForServe as _runExportedFunctionForServe,
  runNodeForServe as _runNodeForServe,
  RestoreSignal,
  RunControlSignal,
  AgencyAbort,
  AbortedResult,
  isAborted,
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  __UNINIT_STATIC, __readStatic,
  __registerStaticInit, __registerGlobalsInit, __registerCallbacksInit, __awaitStaticInit, __awaitGlobalsInit, __registerAlwaysScope, __enterCallable,
  registerModuleFingerprint as __registerModuleFingerprint,
  head, tail, empty,
  success, failure, runtimeFailure, isSuccess, isFailure, stampFailureBoundary, markDestructiveWork, __pipeBind, __tryCall, __catchResult, __eq, __nn, __requireLength,
  Schema, __validateType, __invalidArgument, __validateChain, __validateChainRecursive, __withUseSiteValidators, __coarseTypeTest, __checkParams, __schemaCheck, __descriptorCheck, __takeArgOverrides, __rebindParameters, __releaseRebind,
  AgencyFunction as __AgencyFunction, UNSET as __UNSET,
  __call, __callMethod, withRun as __withRun, withChildRun as __withChildRun, detachedRun as __detachedRun, runInBootstrapFrame as __runInBootstrapFrame,
  functionRefReviver as __functionRefReviver,
  createLogger as __createLogger,
  defaultHost as __defaultHost,
  path, os,
  runCliEntry,
} from "agency-lang/runtime";

// The host is the platform: a Node process here, a browser elsewhere. The
// default host of the platform this module was bundled for; a run can carry
// its own through InvocationOptions.
const __host = __defaultHost();
const __dirname = __host.system.moduleDir(import.meta.url);

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "",
    apiKey: __host.settings.read("STATELOG_API_KEY") || "",
    projectId: "",
    debugMode: false,
    observability: false
  },
  smoltalkDefaults: {
    apiKey: {
      openAi: __host.settings.read("OPENAI_API_KEY") || "",
      google: __host.settings.read("GEMINI_API_KEY") || "",
      anthropic: __host.settings.read("ANTHROPIC_API_KEY") || "",
      openRouter: __host.settings.read("OPENROUTER_API_KEY") || "",
      deepInfra: __host.settings.read("DEEPINFRA_API_KEY") || "",
      liteLlm: __host.settings.read("LITELLM_API_KEY") || "",
      openAiCompat: __host.settings.read("OPENAI_COMPAT_API_KEY") || "",
      groq: __host.settings.read("GROQ_API_KEY") || "",
      typesafe: __host.settings.read("TYPESAFE_API_KEY") || ""
    },
    baseUrl: {
      liteLlm: __host.settings.read("LITELLM_BASE_URL") || "",
      openAiCompat: __host.settings.read("OPENAI_COMPAT_BASE_URL") || ""
    },
    model: "gpt-5-mini",
    logLevel: "warn",
    provider: "openai-responses"
  },
  dirname: __dirname,
  host: __host,
  logLevel: "info",
  traceConfig: {
    program: "decorators.agency"
  }
});
const graph = __globalCtx.graph;

// Handler result builtins and interrupt response constructors (unified types)
export function approve(value?: any) { return { type: "approve" as const, value }; }
export function reject(reason?: string) { return { type: "reject" as const, value: reason }; }
function propagate() { return { type: "propagate" as const }; }
function pass() { return { type: "pass" as const }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, hasInterrupts, isPaused, isDebugger };
type __ResumeOptions = { overrides?: Record<string, unknown>; edits?: CheckpointEdit[]; at?: StopAt; metadata?: Record<string, any>; abortSignal?: AbortSignal; pauseSignal?: AbortSignal; invocation?: InvocationOptions };
export const respondToInterrupts = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: __ResumeOptions) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, edits: opts?.edits, at: opts?.at, metadata: opts?.metadata, abortSignal: opts?.abortSignal, pauseSignal: opts?.pauseSignal, invocation: opts?.invocation });
type __ResumeFromCheckpointOptions = { edits?: CheckpointEdit[]; metadata?: Record<string, any>; abortSignal?: AbortSignal; pauseSignal?: AbortSignal; invocation?: InvocationOptions };
export const resumeFromCheckpoint = (paused: PausedCheckpoint, opts?: __ResumeFromCheckpointOptions) => _resumeFromCheckpoint({ ctx: __globalCtx, paused, edits: opts?.edits, metadata: opts?.metadata, abortSignal: opts?.abortSignal, pauseSignal: opts?.pauseSignal, invocation: opts?.invocation });
type __RewindOptions = { edits?: CheckpointEdit[]; at?: StopAt; metadata?: Record<string, any>; invocation?: InvocationOptions; abortSignal?: AbortSignal; pauseSignal?: AbortSignal };
export const rewindFrom = (checkpoint: Checkpoint, overrides: Record<string, unknown>, opts?: __RewindOptions) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, edits: opts?.edits, at: opts?.at, metadata: opts?.metadata, invocation: opts?.invocation, abortSignal: opts?.abortSignal, pauseSignal: opts?.pauseSignal });
const __resumeFromCheckpoint = (checkpoint: Checkpoint, overrides?: ResumeOverrides, edits?: CheckpointEdit[]) => _resumeCliFromCheckpoint({ ctx: __globalCtx, checkpoint, overrides, edits });
/** A copy of `checkpoint` with `edits` applied, validated, and re-signed, or every reason one was refused. */
export const patchCheckpoint = (checkpoint: Checkpoint, edits: CheckpointEdit[]) => _patchCheckpoint(checkpoint, edits, __globalCtx.host.settings);

// Invoke an exported function in a node-grade execution frame. Used by
// `agency serve` to call a function from an HTTP/MCP request — outside any
// Agency execution frame, which generated function bodies otherwise require.
export const __invokeFunction = (fn: any, namedArgs: Record<string, unknown>) => _runExportedFunction({ ctx: __globalCtx, fn, namedArgs, initializeGlobals: __initializeGlobals });

// Serve-only invokers: identical execution to the entries above, but they hand
// back a ServedInvocationOutcome (value/error + per-invocation usage snapshot)
// so the serve adapters can report authoritative cost. `discoverExports`
// requires all three; a bundle without them must be recompiled.
export const __invokeFunctionForServe = (fn: any, namedArgs: Record<string, unknown>, invocation?: InvocationOptions) => _runExportedFunctionForServe({ ctx: __globalCtx, fn, namedArgs, invocation, initializeGlobals: __initializeGlobals });
export const __invokeNodeForServe = (nodeName: string, data: Record<string, any>, invocation?: InvocationOptions) => _runNodeForServe({ ctx: __globalCtx, nodeName, data, invocation, initializeGlobals: __initializeGlobals });
type ServeResumeOptions = { overrides?: Record<string, unknown>; edits?: CheckpointEdit[]; at?: StopAt; metadata?: Record<string, any>; invocation?: InvocationOptions; abortSignal?: AbortSignal; pauseSignal?: AbortSignal };
export const __respondToInterruptsForServe = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: ServeResumeOptions) => _respondToInterruptsForServe({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, edits: opts?.edits, at: opts?.at, metadata: opts?.metadata, invocation: opts?.invocation, abortSignal: opts?.abortSignal, pauseSignal: opts?.pauseSignal });

export const __setDebugger = (dbg: any) => { __globalCtx.debuggerState = dbg; };
export const __getDebugger = () => __globalCtx.debuggerState;
// Reconfigure the trace file path at runtime. Mutates the module-level
// traceConfig; the next call to runNode (mod.main / mod.someNode) will
// truncate the file and per-execCtx writers will append to it for the
// duration of that run. NOTE: traceFile is process-wide and cannot be
// used safely with concurrent runs of the same agent — for production
// concurrency, use traceDir instead (each run gets its own
// {traceDir}/{runId}.agencytrace).
export const __setTraceFile = (filePath: string) => {
  __globalCtx.traceConfig.traceFile = filePath;
};
export const __setLLMClient = (client: LLMClient) => { __globalCtx.setLLMClient(client); };
export const __getCheckpoints = () => __globalCtx.checkpoints;

// Share a single registry object across every compiled module. With
// composite "module:name" keys, all modules' helpers — plus
// runtime-created blocks registered by `AgencyFunction.create` while
// a function is executing — stay reachable from `FunctionRefReviver`
// no matter which module touched the registry last.
export const __toolRegistry: Record<string, any> = (__functionRefReviver.registry ??= {} as any);

function __registerTool(value: unknown, _aliasName?: string) {
  // Composite "module:name" key keyed off the function's *own*
  // identity, not the importing module's local alias — so different
  // modules that import the same function don't shadow each other in
  // the shared global registry that `FunctionRefReviver` reads from.
  // `_aliasName` is kept in the signature for backwards compatibility
  // with already-compiled callers that pass it.
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[`${value.module}:${value.name}`] = value;
  }
}

// Wrap stateful runtime functions as AgencyFunction instances. Each `_impl`
// takes the run first, as every AgencyFunction body does.
const checkpoint = __AgencyFunction.create({ name: "checkpoint", module: "__runtime", fn: __checkpoint_impl, params: [], toolDefinition: null }, __toolRegistry);
const getCheckpoint = __AgencyFunction.create({ name: "getCheckpoint", module: "__runtime", fn: __getCheckpoint_impl, params: [{ name: "checkpointId", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
const restore = __AgencyFunction.create({ name: "restore", module: "__runtime", fn: __restore_impl, params: [{ name: "checkpointIdOrCheckpoint", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "options", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __runtime_run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "node", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "args", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "wallClock", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "memory", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "ipcPayload", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "stdout", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "configOverrides", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "cwd", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "maxDepth", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);

function setLLMClient(client: LLMClient) {
  __globalCtx.setLLMClient(client);
}


function registerTools(tools: any[]) {
  for (const tool of tools) {
    if (__AgencyFunction.isAgencyFunction(tool)) {
      __toolRegistry[`${tool.module}:${tool.name}`] = tool;
    }
  }
}

async function __initializeGlobals(__run) {
  const __ctx = __run.ctx;
  if (__ctx.globals.isInitialized("decorators.agency")) {
    return;
  }
  __ctx.globals.markInitialized("decorators.agency")
}
__registerGlobalsInit("decorators.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__run) {
  const __ctx = __run.ctx;
}
__registerCallbacksInit("decorators.agency", __registerTopLevelCallbacks);
__functionRefReviver.registry = __toolRegistry;
//  Decorators: a `@name(...)` tag above a def lowers to a call to `name`
//  with the def's body as the block argument. This fixture pins the lowered
//  shape in generated code and the tool metadata of a decorated def, which
//  must match its undecorated twin.
const Call = z.object({ "name": z.string(), "args": z.record(z.string(), z.any()) });
type Call = z.infer<typeof Call>;
async function __logged_impl(__run: __Run, call: Call, block: () => any) {
  const __setupData = setupFunction(__run);
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __activation = __self;
const __ctx = __run.ctx;
let __forked;
let __functionCompleted = false;
  claimFrameForScope(__stack, "logged", "decorators.agency", __run.log);
  if (!__run.globals.isInitialized("decorators.agency")) {
    await __initializeGlobals(__run)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["call"] = call;
  __stack.args["block"] = block;
  const __overridden = __takeArgOverrides(__ctx, __stack, ["call", "block"]);
  if (__overridden !== undefined) {
    call = __stack.args["call"];
    block = __stack.args["block"];
  }
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "decorators.agency", scopeName: "logged", stack: __run.stack, threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// cost in any loop that calls a function per keystroke or per line. The
// cost of always pinning outweighs the retry-on-failure feature, so it is
// disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;

  try {
    await __withChildRun(__run, {
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, "its body", async (__run) => {
      await runner.hook(0, __run, async (__run) => {
__activation.__destructiveRan = __activation.__destructiveRan ?? false;
await callHook(__run, {
          name: "onFunctionStart",
          data: {
            functionName: "logged",
            args: {
              call: call,
              block: block
            },
            moduleId: "decorators.agency"
          }
        })
      });
      await runner.step(1, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
          type: "positional",
          args: [`entering ${__stack.args.call.name}`]
        });
if (hasInterrupts(__funcResult)) {
          await __run.ctx.pendingPromises.awaitAll()
          runner.halt(__funcResult)
          return;
        }
if (isAborted(__funcResult)) {
          runner.halt(__funcResult.carryThrough(__run.log, __stack, "logged"))
          return;
        }
      });
      await runner.step(2, __run, async (runner, __run) => {
__stack.locals.result = await __call(__run, __stack.args.block, {
          type: "positional",
          args: [__stack.args.call.args]
        });
if (hasInterrupts(__stack.locals.result)) {
          await __run.ctx.pendingPromises.awaitAll()
          runner.halt(__stack.locals.result)
          return;
        }
if (isAborted(__stack.locals.result)) {
          runner.halt(__stack.locals.result.carryThrough(__run.log, __stack, "logged"))
          return;
        }
      });
      await runner.step(3, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
          type: "positional",
          args: [`leaving ${__stack.args.call.name}`]
        });
if (hasInterrupts(__funcResult)) {
          await __run.ctx.pendingPromises.awaitAll()
          runner.halt(__funcResult)
          return;
        }
if (isAborted(__funcResult)) {
          runner.halt(__funcResult.carryThrough(__run.log, __stack, "logged"))
          return;
        }
      });
      await runner.step(4, __run, async (runner, __run) => {
__functionCompleted = true;
runner.halt(__stack.locals.result)
return;
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __activation.__destructiveRan ?? false)
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RunControlSignal) {
  throw __error;
}
// All aborts — cancellations (Esc / abort) AND guard trips — are now a single
// AgencyAbort carrying an AbortCause, and must propagate untouched. The owning
// guard's `try` converts its own guardTrip; every other abort unwinds. One
// rung replaces the old GuardExceededError + isAbortError ladder. Converting
// any abort to a Failure here would (a) hide a guard trip so the block appears
// to succeed over budget, and (b) let a cancel limp onward / surface as a
// logged ERROR the REPL can't recognize. See lib/runtime/errors.ts (§5).
if (__error instanceof AgencyAbort) {
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__run.log, __error, __stack, "logged");
}
// Surface the underlying exception via logger + statelog before
// converting to a Failure. Without this, a caller that doesn't
// inspect the result (the common case for void side-effect calls)
// silently loses the error — a debugging nightmare. See the
// recordAlwaysScoped bug debugged in
// https://ampcode.com/threads/T-019e7a3a-edfa-74d6-917a-255c31bf8491.
{
  const __errMsg = __error instanceof Error ? __error.message : String(__error);
  const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
  const __log = __createLogger(__ctx.logLevel);
  __log.error("Function " + "logged" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __run.log?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "logged",
  });
}
return runtimeFailure(__error, {
  checkpoint: __run.ctx.getResultCheckpoint(),
  destructiveRan: __activation.__destructiveRan,
  functionName: "logged",
  args: __stack.args,
});

  } finally {
    __run.stack.pop()
    if (__functionCompleted) {
      await callHook(__run, {
        name: "onFunctionEnd",
        data: {
          functionName: "logged",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export const logged = __AgencyFunction.create({
  name: "logged",
  module: "decorators.agency",
  fn: __logged_impl,
  params: [{
    name: "call",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "block",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: true,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "logged",
    description: "No description provided.",
    schema: z.object({"call": Call, })
  },
  exported: false,
  markers: {
    decorator: true
  }
}, __toolRegistry);
async function __retry_impl(__run: __Run, times: number, call: Call, block: () => any) {
  const __setupData = setupFunction(__run);
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __activation = __self;
const __ctx = __run.ctx;
let __forked;
let __functionCompleted = false;
  claimFrameForScope(__stack, "retry", "decorators.agency", __run.log);
  if (!__run.globals.isInitialized("decorators.agency")) {
    await __initializeGlobals(__run)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["times"] = times;
  __stack.args["call"] = call;
  __stack.args["block"] = block;
  const __overridden = __takeArgOverrides(__ctx, __stack, ["times", "call", "block"]);
  if (__overridden !== undefined) {
    times = __stack.args["times"];
    call = __stack.args["call"];
    block = __stack.args["block"];
  }
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "decorators.agency", scopeName: "retry", stack: __run.stack, threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// cost in any loop that calls a function per keystroke or per line. The
// cost of always pinning outweighs the retry-on-failure feature, so it is
// disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;

  try {
    await __withChildRun(__run, {
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, "its body", async (__run) => {
      await runner.hook(0, __run, async (__run) => {
__activation.__destructiveRan = __activation.__destructiveRan ?? false;
await callHook(__run, {
          name: "onFunctionStart",
          data: {
            functionName: "retry",
            args: {
              times: times,
              call: call,
              block: block
            },
            moduleId: "decorators.agency"
          }
        })
      });
      await runner.step(1, __run, async (runner, __run) => {
__stack.locals.last = null;
      });
      await runner.step(2, __run, async (runner, __run) => {
__stack.locals.__hoist_0 = await __call(__run, range, {
          type: "positional",
          args: [0, __stack.args.times]
        });
if (hasInterrupts(__stack.locals.__hoist_0)) {
          await __run.ctx.pendingPromises.awaitAll()
          runner.halt(__stack.locals.__hoist_0)
          return;
        }
if (isAborted(__stack.locals.__hoist_0)) {
          runner.halt(__stack.locals.__hoist_0.carryThrough(__run.log, __stack, "retry"))
          return;
        }
      });
      await runner.loop(3, __run, async (__run) => (__stack.locals.__hoist_0), async (i, _, runner, __run) => {
await runner.step(0, __run, async (runner, __run) => {
__stack.locals.last = await __call(__run, __stack.args.block, {
            type: "positional",
            args: [__stack.args.call.args]
          });
if (hasInterrupts(__stack.locals.last)) {
            await __run.ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.last)
            return;
          }
if (isAborted(__stack.locals.last)) {
            runner.halt(__stack.locals.last.carryThrough(__run.log, __stack, "retry"))
            return;
          }
        });
      });
      await runner.step(4, __run, async (runner, __run) => {
__functionCompleted = true;
runner.halt(__stack.locals.last)
return;
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __activation.__destructiveRan ?? false)
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RunControlSignal) {
  throw __error;
}
// All aborts — cancellations (Esc / abort) AND guard trips — are now a single
// AgencyAbort carrying an AbortCause, and must propagate untouched. The owning
// guard's `try` converts its own guardTrip; every other abort unwinds. One
// rung replaces the old GuardExceededError + isAbortError ladder. Converting
// any abort to a Failure here would (a) hide a guard trip so the block appears
// to succeed over budget, and (b) let a cancel limp onward / surface as a
// logged ERROR the REPL can't recognize. See lib/runtime/errors.ts (§5).
if (__error instanceof AgencyAbort) {
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__run.log, __error, __stack, "retry");
}
// Surface the underlying exception via logger + statelog before
// converting to a Failure. Without this, a caller that doesn't
// inspect the result (the common case for void side-effect calls)
// silently loses the error — a debugging nightmare. See the
// recordAlwaysScoped bug debugged in
// https://ampcode.com/threads/T-019e7a3a-edfa-74d6-917a-255c31bf8491.
{
  const __errMsg = __error instanceof Error ? __error.message : String(__error);
  const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
  const __log = __createLogger(__ctx.logLevel);
  __log.error("Function " + "retry" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __run.log?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "retry",
  });
}
return runtimeFailure(__error, {
  checkpoint: __run.ctx.getResultCheckpoint(),
  destructiveRan: __activation.__destructiveRan,
  functionName: "retry",
  args: __stack.args,
});

  } finally {
    __run.stack.pop()
    if (__functionCompleted) {
      await callHook(__run, {
        name: "onFunctionEnd",
        data: {
          functionName: "retry",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export const retry = __AgencyFunction.create({
  name: "retry",
  module: "decorators.agency",
  fn: __retry_impl,
  params: [{
    name: "times",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "call",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "block",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: true,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "retry",
    description: "No description provided.",
    schema: z.object({"times": z.number(), "call": Call, })
  },
  exported: false,
  markers: {
    decorator: true
  }
}, __toolRegistry);
async function __plainTwin_impl(__run: __Run, x: number) {
  const __setupData = setupFunction(__run);
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __activation = __self;
const __ctx = __run.ctx;
let __forked;
let __functionCompleted = false;
  claimFrameForScope(__stack, "plainTwin", "decorators.agency", __run.log);
  if (!__run.globals.isInitialized("decorators.agency")) {
    await __initializeGlobals(__run)
  }
  let __funcStartTime: number = performance.now();
  if (!Object.hasOwn(__stack.args, "x")) {
    __stack.args["x"] = x;
  }
  const __overridden = __takeArgOverrides(__ctx, __stack, ["x"]);
  if (__overridden !== undefined) {
    x = __stack.args["x"];
  }
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "decorators.agency", scopeName: "plainTwin", stack: __run.stack, threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// cost in any loop that calls a function per keystroke or per line. The
// cost of always pinning outweighs the retry-on-failure feature, so it is
// disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;

  try {
    await __withChildRun(__run, {
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, "its body", async (__run) => {
      await runner.hook(0, __run, async (__run) => {
__activation.__destructiveRan = __activation.__destructiveRan ?? false;
await callHook(__run, {
          name: "onFunctionStart",
          data: {
            functionName: "plainTwin",
            args: {
              x: x
            },
            moduleId: "decorators.agency"
          }
        })
      });
      await runner.step(1, __run, async (runner, __run) => {
__stack.locals.__call_0 = {
          "name": `plainTwin`,
          "args": {
            "x": __stack.args.x
          }
        };
      });
      await runner.step(2, __run, async (runner, __run) => {
__functionCompleted = true;
runner.halt(await __call(__run, logged, {
          type: "named",
          positionalArgs: [],
          namedArgs: {
            call: __stack.locals.__call_0
          },
          blockArg: __AgencyFunction.create({ name: "__block_0", module: "decorators.agency", fn: async (__run: __Run, __args: any) => {
            const __bsetup = setupFunction(__run);
const __bstack = __bsetup.stack;
const __self = __bstack.locals;
const __bframe___block_0 = __bstack;
// Claim site: this block just pulled its frame via setupFunction. A
// mismatched claim on resume replay is a frame desync and throws.
claimFrameForScope(__bstack, "__block_0", "decorators.agency", __run.log);

__bstack.args["__args"] = __args;

const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: "decorators.agency", scopeName: "__block_0", stack: __run.stack, threads: __run.threads });
try {
await runner.step(0, __run, async (runner, __run) => {
await __rebindParameters(__run, runner, __stack, __toolRegistry["decorators.agency:plainTwin"], __bstack.args["__args"], {}, [{
      name: "x",
      checked: false
    }], null, 0)
if (runner.halted) {
      return;
    }
  });
await runner.step(1, __run, async (runner, __run) => {
runner.halt(__stack.args.x + 1)
return;
  });
return runner.halted ? runner.haltResult : undefined;
} catch (__blockError) {
// An abort stopped this block. Like a function, the block returns an
// AbortedResult instead of throwing on: the marker plus the block's own
// saved draft. This is how a saveDraft placed directly inside a guard
// block reaches the guard. Other errors keep throwing as before.
if (__blockError instanceof AgencyAbort) {
  return AbortedResult.fromError(__run.log, __blockError, __bstack, "__block_0");
}
throw __blockError;
} finally {
__releaseRebind(__stack, 0);
// Pop the SAME stack `setupFunction` pushed onto (the ALS-current
// stack via `__bsetup.stateStack`), NOT `__ctx.stateStack`. When this
// block runs inside a parallel/fork/race branch (e.g. as a callback
// fired from `onToolCallEnd` during runPrompt's tool dispatch), the
// ALS stack is the branch stack — distinct from `__ctx.stateStack`.
// Popping `__ctx.stateStack` would corrupt the parent's frame chain
// (the parent's runPrompt frame disappears, the next iteration's
// `pr.parallel` reads `lastFrame()` as undefined, and crashes with
// "Cannot read properties of undefined (reading 'getOrCreateBranch')").
__bsetup.stateStack.pop();
}
          }, params: [{ name: "__args", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry)
        }))
return;
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __activation.__destructiveRan ?? false)
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RunControlSignal) {
  throw __error;
}
// All aborts — cancellations (Esc / abort) AND guard trips — are now a single
// AgencyAbort carrying an AbortCause, and must propagate untouched. The owning
// guard's `try` converts its own guardTrip; every other abort unwinds. One
// rung replaces the old GuardExceededError + isAbortError ladder. Converting
// any abort to a Failure here would (a) hide a guard trip so the block appears
// to succeed over budget, and (b) let a cancel limp onward / surface as a
// logged ERROR the REPL can't recognize. See lib/runtime/errors.ts (§5).
if (__error instanceof AgencyAbort) {
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__run.log, __error, __stack, "plainTwin");
}
// Surface the underlying exception via logger + statelog before
// converting to a Failure. Without this, a caller that doesn't
// inspect the result (the common case for void side-effect calls)
// silently loses the error — a debugging nightmare. See the
// recordAlwaysScoped bug debugged in
// https://ampcode.com/threads/T-019e7a3a-edfa-74d6-917a-255c31bf8491.
{
  const __errMsg = __error instanceof Error ? __error.message : String(__error);
  const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
  const __log = __createLogger(__ctx.logLevel);
  __log.error("Function " + "plainTwin" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __run.log?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "plainTwin",
  });
}
return runtimeFailure(__error, {
  checkpoint: __run.ctx.getResultCheckpoint(),
  destructiveRan: __activation.__destructiveRan,
  functionName: "plainTwin",
  args: __stack.args,
});

  } finally {
    __run.stack.pop()
    if (__functionCompleted) {
      await callHook(__run, {
        name: "onFunctionEnd",
        data: {
          functionName: "plainTwin",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export const plainTwin = __AgencyFunction.create({
  name: "plainTwin",
  module: "decorators.agency",
  fn: __plainTwin_impl,
  params: [{
    name: "x",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "plainTwin",
    description: "No description provided.",
    schema: z.object({"x": z.number(), })
  },
  exported: false
}, __toolRegistry);
async function __undecoratedTwin_impl(__run: __Run, x: number) {
  const __setupData = setupFunction(__run);
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __activation = __self;
const __ctx = __run.ctx;
let __forked;
let __functionCompleted = false;
  claimFrameForScope(__stack, "undecoratedTwin", "decorators.agency", __run.log);
  if (!__run.globals.isInitialized("decorators.agency")) {
    await __initializeGlobals(__run)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["x"] = x;
  const __overridden = __takeArgOverrides(__ctx, __stack, ["x"]);
  if (__overridden !== undefined) {
    x = __stack.args["x"];
  }
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "decorators.agency", scopeName: "undecoratedTwin", stack: __run.stack, threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// cost in any loop that calls a function per keystroke or per line. The
// cost of always pinning outweighs the retry-on-failure feature, so it is
// disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;

  try {
    await __withChildRun(__run, {
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, "its body", async (__run) => {
      await runner.hook(0, __run, async (__run) => {
__activation.__destructiveRan = __activation.__destructiveRan ?? false;
await callHook(__run, {
          name: "onFunctionStart",
          data: {
            functionName: "undecoratedTwin",
            args: {
              x: x
            },
            moduleId: "decorators.agency"
          }
        })
      });
      await runner.step(1, __run, async (runner, __run) => {
__functionCompleted = true;
runner.halt(__stack.args.x + 1)
return;
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __activation.__destructiveRan ?? false)
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RunControlSignal) {
  throw __error;
}
// All aborts — cancellations (Esc / abort) AND guard trips — are now a single
// AgencyAbort carrying an AbortCause, and must propagate untouched. The owning
// guard's `try` converts its own guardTrip; every other abort unwinds. One
// rung replaces the old GuardExceededError + isAbortError ladder. Converting
// any abort to a Failure here would (a) hide a guard trip so the block appears
// to succeed over budget, and (b) let a cancel limp onward / surface as a
// logged ERROR the REPL can't recognize. See lib/runtime/errors.ts (§5).
if (__error instanceof AgencyAbort) {
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__run.log, __error, __stack, "undecoratedTwin");
}
// Surface the underlying exception via logger + statelog before
// converting to a Failure. Without this, a caller that doesn't
// inspect the result (the common case for void side-effect calls)
// silently loses the error — a debugging nightmare. See the
// recordAlwaysScoped bug debugged in
// https://ampcode.com/threads/T-019e7a3a-edfa-74d6-917a-255c31bf8491.
{
  const __errMsg = __error instanceof Error ? __error.message : String(__error);
  const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
  const __log = __createLogger(__ctx.logLevel);
  __log.error("Function " + "undecoratedTwin" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __run.log?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "undecoratedTwin",
  });
}
return runtimeFailure(__error, {
  checkpoint: __run.ctx.getResultCheckpoint(),
  destructiveRan: __activation.__destructiveRan,
  functionName: "undecoratedTwin",
  args: __stack.args,
});

  } finally {
    __run.stack.pop()
    if (__functionCompleted) {
      await callHook(__run, {
        name: "onFunctionEnd",
        data: {
          functionName: "undecoratedTwin",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export const undecoratedTwin = __AgencyFunction.create({
  name: "undecoratedTwin",
  module: "decorators.agency",
  fn: __undecoratedTwin_impl,
  params: [{
    name: "x",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "undecoratedTwin",
    description: "No description provided.",
    schema: z.object({"x": z.number(), })
  },
  exported: false
}, __toolRegistry);
async function __researcher_impl(__run: __Run, task: string, maxCost: number | typeof __UNSET = __UNSET) {
  const __setupData = setupFunction(__run);
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __activation = __self;
const __ctx = __run.ctx;
let __forked;
let __functionCompleted = false;
  claimFrameForScope(__stack, "researcher", "decorators.agency", __run.log);
  if (!__run.globals.isInitialized("decorators.agency")) {
    await __initializeGlobals(__run)
  }
  let __funcStartTime: number = performance.now();
  if (!Object.hasOwn(__stack.args, "task")) {
    __stack.args["task"] = task;
  }
  if (!Object.hasOwn(__stack.args, "maxCost")) {
    __stack.args["maxCost"] = (maxCost === __UNSET ? (2) : (maxCost));
  }
  const __overridden = __takeArgOverrides(__ctx, __stack, ["task", "maxCost"]);
  if (__overridden !== undefined) {
    task = __stack.args["task"];
    maxCost = __stack.args["maxCost"];
  }
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "decorators.agency", scopeName: "researcher", stack: __run.stack, threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// cost in any loop that calls a function per keystroke or per line. The
// cost of always pinning outweighs the retry-on-failure feature, so it is
// disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;

  try {
    await __withChildRun(__run, {
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, "its body", async (__run) => {
      await runner.hook(0, __run, async (__run) => {
__activation.__destructiveRan = __activation.__destructiveRan ?? false;
await callHook(__run, {
          name: "onFunctionStart",
          data: {
            functionName: "researcher",
            args: {
              task: task,
              maxCost: maxCost
            },
            moduleId: "decorators.agency"
          }
        })
      });
      await runner.step(1, __run, async (runner, __run) => {
__stack.locals.__call_0 = {
          "name": `researcher`,
          "args": {
            "task": __stack.args.task,
            "maxCost": __stack.args.maxCost
          }
        };
      });
      await runner.step(2, __run, async (runner, __run) => {
__functionCompleted = true;
runner.halt(await __call(__run, logged, {
          type: "named",
          positionalArgs: [],
          namedArgs: {
            call: __stack.locals.__call_0
          },
          blockArg: __AgencyFunction.create({ name: "__block_1", module: "decorators.agency", fn: async (__run: __Run, __args: any) => {
            const __bsetup = setupFunction(__run);
const __bstack = __bsetup.stack;
const __self = __bstack.locals;
const __bframe___block_1 = __bstack;
// Claim site: this block just pulled its frame via setupFunction. A
// mismatched claim on resume replay is a frame desync and throws.
claimFrameForScope(__bstack, "__block_1", "decorators.agency", __run.log);

__bstack.args["__args"] = __args;

const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: "decorators.agency", scopeName: "__block_1", stack: __run.stack, threads: __run.threads });
try {
await runner.step(0, __run, async (runner, __run) => {
await __rebindParameters(__run, runner, __stack, __toolRegistry["decorators.agency:researcher"], __bstack.args["__args"], {}, [{
      name: "task",
      checked: false
    }, {
      name: "maxCost",
      checked: false,
      defaultValue: () => 2
    }], null, 0)
if (runner.halted) {
      return;
    }
  });
await runner.step(1, __run, async (runner, __run) => {
__bstack.locals.__call_1 = {
      "name": `researcher`,
      "args": {
        "task": __stack.args.task,
        "maxCost": __stack.args.maxCost
      }
    };
  });
await runner.step(2, __run, async (runner, __run) => {
runner.halt(await __call(__run, retry, {
      type: "named",
      positionalArgs: [3],
      namedArgs: {
        call: __bstack.locals.__call_1
      },
      blockArg: __AgencyFunction.create({ name: "__block_2", module: "decorators.agency", fn: async (__run: __Run, __args: any) => {
        const __bsetup = setupFunction(__run);
const __bstack = __bsetup.stack;
const __self = __bstack.locals;
const __bframe___block_2 = __bstack;
// Claim site: this block just pulled its frame via setupFunction. A
// mismatched claim on resume replay is a frame desync and throws.
claimFrameForScope(__bstack, "__block_2", "decorators.agency", __run.log);

__bstack.args["__args"] = __args;

const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: "decorators.agency", scopeName: "__block_2", stack: __run.stack, threads: __run.threads });
try {
await runner.step(0, __run, async (runner, __run) => {
await __rebindParameters(__run, runner, __stack, __toolRegistry["decorators.agency:researcher"], __bstack.args["__args"], {}, [{
      name: "task",
      checked: false
    }, {
      name: "maxCost",
      checked: false,
      defaultValue: () => 2
    }], null, 1)
if (runner.halted) {
      return;
    }
  });
await runner.step(1, __run, async (runner, __run) => {
__activation.__removedTools = __activation.__removedTools || [];
__bstack.locals.__promptVar = await runPrompt(__run, {
      prompt: `research ${__stack.args.task} within ${__stack.args.maxCost}`,
      messages: __run.threads.getOrCreateActive(),
      clientConfig: {},
      maxToolCallRounds: 10,
      removedTools: __activation.__removedTools,
      destructiveSink: __activation,
      checkpointInfo: runner.getCheckpointInfo()
    });
// halt if this is an interrupt
if (hasInterrupts(__bstack.locals.__promptVar)) {
      await __run.ctx.pendingPromises.awaitAll()
      runner.halt(__bstack.locals.__promptVar)
      return;
    }
runner.halt(__self.__promptVar)
return;
  });
return runner.halted ? runner.haltResult : undefined;
} catch (__blockError) {
// An abort stopped this block. Like a function, the block returns an
// AbortedResult instead of throwing on: the marker plus the block's own
// saved draft. This is how a saveDraft placed directly inside a guard
// block reaches the guard. Other errors keep throwing as before.
if (__blockError instanceof AgencyAbort) {
  return AbortedResult.fromError(__run.log, __blockError, __bstack, "__block_2");
}
throw __blockError;
} finally {
__releaseRebind(__stack, 1);
// Pop the SAME stack `setupFunction` pushed onto (the ALS-current
// stack via `__bsetup.stateStack`), NOT `__ctx.stateStack`. When this
// block runs inside a parallel/fork/race branch (e.g. as a callback
// fired from `onToolCallEnd` during runPrompt's tool dispatch), the
// ALS stack is the branch stack — distinct from `__ctx.stateStack`.
// Popping `__ctx.stateStack` would corrupt the parent's frame chain
// (the parent's runPrompt frame disappears, the next iteration's
// `pr.parallel` reads `lastFrame()` as undefined, and crashes with
// "Cannot read properties of undefined (reading 'getOrCreateBranch')").
__bsetup.stateStack.pop();
}
      }, params: [{ name: "__args", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry)
    }))
return;
  });
return runner.halted ? runner.haltResult : undefined;
} catch (__blockError) {
// An abort stopped this block. Like a function, the block returns an
// AbortedResult instead of throwing on: the marker plus the block's own
// saved draft. This is how a saveDraft placed directly inside a guard
// block reaches the guard. Other errors keep throwing as before.
if (__blockError instanceof AgencyAbort) {
  return AbortedResult.fromError(__run.log, __blockError, __bstack, "__block_1");
}
throw __blockError;
} finally {
__releaseRebind(__stack, 0);
// Pop the SAME stack `setupFunction` pushed onto (the ALS-current
// stack via `__bsetup.stateStack`), NOT `__ctx.stateStack`. When this
// block runs inside a parallel/fork/race branch (e.g. as a callback
// fired from `onToolCallEnd` during runPrompt's tool dispatch), the
// ALS stack is the branch stack — distinct from `__ctx.stateStack`.
// Popping `__ctx.stateStack` would corrupt the parent's frame chain
// (the parent's runPrompt frame disappears, the next iteration's
// `pr.parallel` reads `lastFrame()` as undefined, and crashes with
// "Cannot read properties of undefined (reading 'getOrCreateBranch')").
__bsetup.stateStack.pop();
}
          }, params: [{ name: "__args", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry)
        }))
return;
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __activation.__destructiveRan ?? false)
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RunControlSignal) {
  throw __error;
}
// All aborts — cancellations (Esc / abort) AND guard trips — are now a single
// AgencyAbort carrying an AbortCause, and must propagate untouched. The owning
// guard's `try` converts its own guardTrip; every other abort unwinds. One
// rung replaces the old GuardExceededError + isAbortError ladder. Converting
// any abort to a Failure here would (a) hide a guard trip so the block appears
// to succeed over budget, and (b) let a cancel limp onward / surface as a
// logged ERROR the REPL can't recognize. See lib/runtime/errors.ts (§5).
if (__error instanceof AgencyAbort) {
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__run.log, __error, __stack, "researcher");
}
// Surface the underlying exception via logger + statelog before
// converting to a Failure. Without this, a caller that doesn't
// inspect the result (the common case for void side-effect calls)
// silently loses the error — a debugging nightmare. See the
// recordAlwaysScoped bug debugged in
// https://ampcode.com/threads/T-019e7a3a-edfa-74d6-917a-255c31bf8491.
{
  const __errMsg = __error instanceof Error ? __error.message : String(__error);
  const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
  const __log = __createLogger(__ctx.logLevel);
  __log.error("Function " + "researcher" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __run.log?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "researcher",
  });
}
return runtimeFailure(__error, {
  checkpoint: __run.ctx.getResultCheckpoint(),
  destructiveRan: __activation.__destructiveRan,
  functionName: "researcher",
  args: __stack.args,
});

  } finally {
    __run.stack.pop()
    if (__functionCompleted) {
      await callHook(__run, {
        name: "onFunctionEnd",
        data: {
          functionName: "researcher",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export const researcher = __AgencyFunction.create({
  name: "researcher",
  module: "decorators.agency",
  fn: __researcher_impl,
  params: [{
    name: "task",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "maxCost",
    hasDefault: true,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "researcher",
    description: "No description provided.",
    schema: z.object({"task": z.string(), "maxCost": z.number().nullable().describe("Default: 2.00"), })
  },
  exported: true,
  markers: {
    handoff: true
  }
}, __toolRegistry);
async function __positionalAndNamed_impl(__run: __Run, a: string) {
  const __setupData = setupFunction(__run);
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __activation = __self;
const __ctx = __run.ctx;
let __forked;
let __functionCompleted = false;
  claimFrameForScope(__stack, "positionalAndNamed", "decorators.agency", __run.log);
  if (!__run.globals.isInitialized("decorators.agency")) {
    await __initializeGlobals(__run)
  }
  let __funcStartTime: number = performance.now();
  if (!Object.hasOwn(__stack.args, "a")) {
    __stack.args["a"] = a;
  }
  const __overridden = __takeArgOverrides(__ctx, __stack, ["a"]);
  if (__overridden !== undefined) {
    a = __stack.args["a"];
  }
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "decorators.agency", scopeName: "positionalAndNamed", stack: __run.stack, threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// cost in any loop that calls a function per keystroke or per line. The
// cost of always pinning outweighs the retry-on-failure feature, so it is
// disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;

  try {
    await __withChildRun(__run, {
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, "its body", async (__run) => {
      await runner.hook(0, __run, async (__run) => {
__activation.__destructiveRan = __activation.__destructiveRan ?? false;
await callHook(__run, {
          name: "onFunctionStart",
          data: {
            functionName: "positionalAndNamed",
            args: {
              a: a
            },
            moduleId: "decorators.agency"
          }
        })
      });
      await runner.step(1, __run, async (runner, __run) => {
__stack.locals.__call_0 = {
          "name": `positionalAndNamed`,
          "args": {
            "a": __stack.args.a
          }
        };
      });
      await runner.step(2, __run, async (runner, __run) => {
__functionCompleted = true;
runner.halt(await __call(__run, retry, {
          type: "named",
          positionalArgs: [],
          namedArgs: {
            times: 2,
            call: __stack.locals.__call_0
          },
          blockArg: __AgencyFunction.create({ name: "__block_3", module: "decorators.agency", fn: async (__run: __Run, __args: any) => {
            const __bsetup = setupFunction(__run);
const __bstack = __bsetup.stack;
const __self = __bstack.locals;
const __bframe___block_3 = __bstack;
// Claim site: this block just pulled its frame via setupFunction. A
// mismatched claim on resume replay is a frame desync and throws.
claimFrameForScope(__bstack, "__block_3", "decorators.agency", __run.log);

__bstack.args["__args"] = __args;

const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: "decorators.agency", scopeName: "__block_3", stack: __run.stack, threads: __run.threads });
try {
await runner.step(0, __run, async (runner, __run) => {
await __rebindParameters(__run, runner, __stack, __toolRegistry["decorators.agency:positionalAndNamed"], __bstack.args["__args"], {}, [{
      name: "a",
      checked: false
    }], null, 0)
if (runner.halted) {
      return;
    }
  });
await runner.step(1, __run, async (runner, __run) => {
runner.halt(__stack.args.a)
return;
  });
return runner.halted ? runner.haltResult : undefined;
} catch (__blockError) {
// An abort stopped this block. Like a function, the block returns an
// AbortedResult instead of throwing on: the marker plus the block's own
// saved draft. This is how a saveDraft placed directly inside a guard
// block reaches the guard. Other errors keep throwing as before.
if (__blockError instanceof AgencyAbort) {
  return AbortedResult.fromError(__run.log, __blockError, __bstack, "__block_3");
}
throw __blockError;
} finally {
__releaseRebind(__stack, 0);
// Pop the SAME stack `setupFunction` pushed onto (the ALS-current
// stack via `__bsetup.stateStack`), NOT `__ctx.stateStack`. When this
// block runs inside a parallel/fork/race branch (e.g. as a callback
// fired from `onToolCallEnd` during runPrompt's tool dispatch), the
// ALS stack is the branch stack — distinct from `__ctx.stateStack`.
// Popping `__ctx.stateStack` would corrupt the parent's frame chain
// (the parent's runPrompt frame disappears, the next iteration's
// `pr.parallel` reads `lastFrame()` as undefined, and crashes with
// "Cannot read properties of undefined (reading 'getOrCreateBranch')").
__bsetup.stateStack.pop();
}
          }, params: [{ name: "__args", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry)
        }))
return;
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __activation.__destructiveRan ?? false)
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RunControlSignal) {
  throw __error;
}
// All aborts — cancellations (Esc / abort) AND guard trips — are now a single
// AgencyAbort carrying an AbortCause, and must propagate untouched. The owning
// guard's `try` converts its own guardTrip; every other abort unwinds. One
// rung replaces the old GuardExceededError + isAbortError ladder. Converting
// any abort to a Failure here would (a) hide a guard trip so the block appears
// to succeed over budget, and (b) let a cancel limp onward / surface as a
// logged ERROR the REPL can't recognize. See lib/runtime/errors.ts (§5).
if (__error instanceof AgencyAbort) {
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__run.log, __error, __stack, "positionalAndNamed");
}
// Surface the underlying exception via logger + statelog before
// converting to a Failure. Without this, a caller that doesn't
// inspect the result (the common case for void side-effect calls)
// silently loses the error — a debugging nightmare. See the
// recordAlwaysScoped bug debugged in
// https://ampcode.com/threads/T-019e7a3a-edfa-74d6-917a-255c31bf8491.
{
  const __errMsg = __error instanceof Error ? __error.message : String(__error);
  const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
  const __log = __createLogger(__ctx.logLevel);
  __log.error("Function " + "positionalAndNamed" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __run.log?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "positionalAndNamed",
  });
}
return runtimeFailure(__error, {
  checkpoint: __run.ctx.getResultCheckpoint(),
  destructiveRan: __activation.__destructiveRan,
  functionName: "positionalAndNamed",
  args: __stack.args,
});

  } finally {
    __run.stack.pop()
    if (__functionCompleted) {
      await callHook(__run, {
        name: "onFunctionEnd",
        data: {
          functionName: "positionalAndNamed",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export const positionalAndNamed = __AgencyFunction.create({
  name: "positionalAndNamed",
  module: "decorators.agency",
  fn: __positionalAndNamed_impl,
  params: [{
    name: "a",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "positionalAndNamed",
    description: "No description provided.",
    schema: z.object({"a": z.string(), })
  },
  exported: false
}, __toolRegistry);
graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
  const __run = __setupData.run;
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __activation = __self;
const __ctx = __run.ctx;
let __forked;
let __functionCompleted = false;
  claimFrameForScope(__stack, "main", "decorators.agency", __run.log);
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "decorators.agency", scopeName: "main", stack: __run.stack, threads: __setupData.threads });
  return await __enterCallable(__run, "main", [], async (__run) => {
    try {
      await __withChildRun(__run, {
        ctx: __ctx,
        stack: __ctx.stateStack,
        threads: __setupData.threads
      }, "its body", async (__run) => {
        await runner.hook(0, __run, async (__run) => {
await callHook(__run, {
            name: "onNodeStart",
            data: {
              nodeName: "main"
            }
          })
        });
        await runner.step(1, __run, async (runner, __run) => {
runner.halt({
            messages: __run.threads,
            data: await __call(__run, plainTwin, {
              type: "positional",
              args: [1]
            })
          })
return;
        });
      })
      if (runner.halted) return runner.haltResult;
      await runner.hook(2, __run, async (__run) => {
await callHook(__run, {
          name: "onNodeEnd",
          data: {
            nodeName: "main",
            data: undefined
          }
        })
      });
      return {
        messages: __run.threads,
        data: undefined
      };
    } catch (__error) {
      if (__error instanceof RunControlSignal) {
        throw __error
      }
      if (__error instanceof AgencyAbort) {
        throw __error
      }
      {
              const __errMsg = __error instanceof Error ? __error.message : String(__error);
              const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
              const __log = __createLogger(__ctx.logLevel, __ctx.host.settings);
              __log.error(`Node main crashed: ${__errMsg}`);
              if (__errStack) __log.error(__errStack);
              __run.log?.error?.({
                errorType: "runtimeError",
                message: __errMsg,
                functionName: "main",
              });
            }
      return {
        messages: __run.threads,
        data: runtimeFailure(__error, { functionName: "main" })
      };
    }
  }, (__run, __failure) => {
    return {
      messages: __run.threads,
      data: __failure
    };
  });
})
export async function main({ messages: __invocationMessages, callbacks: __invocationCallbacks, config: __invocationConfig, traceId: __invocationTraceId, policy: __invocationPolicy, host: __invocationHost, invocationInput: __invocationInput, abortSignal: __invocationAbortSignal, pauseSignal: __invocationPauseSignal, inputOverride: __invocationInputOverride }: ({ messages?: any; callbacks?: any; invocationInput?: unknown; abortSignal?: AbortSignal; pauseSignal?: AbortSignal } & InvocationOptions) = {}): Promise<RunNodeResult<any>> {
  return runNode({
    ctx: __globalCtx,
    nodeName: "main",
    data: {},
    messages: __invocationMessages,
    callbacks: __invocationCallbacks,
    invocation: {
      config: __invocationConfig,
      traceId: __invocationTraceId,
      policy: __invocationPolicy,
      host: __invocationHost,
      inputOverride: __invocationInputOverride
    },
    input: __invocationInput,
    abortSignal: __invocationAbortSignal,
    pauseSignal: __invocationPauseSignal,
    initializeGlobals: __initializeGlobals
  });
}
export const __mainNodeParams = [];
if (__host.system.isMainModule(import.meta.url)) {
  try {
    const initialState = {
      messages: new ThreadStore(),
      data: {}
    };
    const __result = await runCliEntry({
      nodeNames: ["main"],
      startNode: (nodeName: string) => runNode({
        ctx: __globalCtx,
        nodeName: nodeName,
        data: initialState.data,
        messages: initialState.messages,
        initializeGlobals: __initializeGlobals
      }),
      resume: __resumeFromCheckpoint
    });
    await resolveCliInterrupts(__result, respondToInterrupts)
  } catch (__error: any) {
    await reportBudgetExceededAndExit(__error)
    console.error(`
Agent crashed: ${__error.message}`)
    await flushPendingStatelogPosts()
    throw __error
  }
}
export default graph
export const __sourceMap = {"decorators.agency:logged":{"1":{"line":10,"col":2},"2":{"line":11,"col":2},"3":{"line":12,"col":2},"4":{"line":13,"col":2}},"decorators.agency:retry":{"1":{"line":17,"col":2},"2":{"line":18,"col":12},"3":{"line":18,"col":2},"4":{"line":21,"col":2},"3.0":{"line":19,"col":4}},"decorators.agency:plainTwin":{"1":{"line":24,"col":0},"2":{"line":24,"col":0}},"decorators.agency:__block_0":{"0":{"line":24,"col":0},"1":{"line":26,"col":2}},"decorators.agency:undecoratedTwin":{"1":{"line":30,"col":2}},"decorators.agency:researcher":{"1":{"line":33,"col":0},"2":{"line":33,"col":0}},"decorators.agency:__block_1":{"0":{"line":33,"col":0},"1":{"line":34,"col":0},"2":{"line":34,"col":0}},"decorators.agency:__block_2":{"0":{"line":34,"col":0},"1":{"line":36,"col":2}},"decorators.agency:positionalAndNamed":{"1":{"line":39,"col":0},"2":{"line":39,"col":0}},"decorators.agency:__block_3":{"0":{"line":39,"col":0},"1":{"line":41,"col":2}},"decorators.agency:main":{"1":{"line":45,"col":2}}};