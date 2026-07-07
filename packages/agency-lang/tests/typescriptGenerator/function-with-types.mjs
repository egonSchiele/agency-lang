import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "agency-lang/zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import os from "os";
import type { GraphState, Interrupt, InterruptResponse, Checkpoint, LLMClient } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore, Runner, McpManager,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl, _run as __runtime_run_impl,
  interrupt, isInterrupt, hasInterrupts, reportUnhandledInterrupts, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  runExportedFunction as _runExportedFunction,
  RestoreSignal,
  AgencyAbort,
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  __UNINIT_STATIC, __readStatic,
  __registerStaticInit, __registerGlobalsInit, __awaitStaticInit, __awaitGlobalsInit,
  head, tail, empty,
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult, __eq,
  Schema, __validateType, __validateChain, __validateChainRecursive,
  AgencyFunction as __AgencyFunction, UNSET as __UNSET,
  __call, __callMethod, __threads, __stateStack, __globals, getRuntimeContext, agencyStore,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient,
  createLogger as __createLogger,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = __process.cwd();

const getDirname = () => __dirname;

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://statelog.adit.io",
    apiKey: __process.env["STATELOG_API_KEY"] || "",
    projectId: "",
    debugMode: false,
    observability: false
  },
  smoltalkDefaults: {
    apiKey: {
      openAi: __process.env["OPENAI_API_KEY"] || "",
      google: __process.env["GEMINI_API_KEY"] || "",
      anthropic: __process.env["ANTHROPIC_API_KEY"] || "",
      openRouter: __process.env["OPENROUTER_API_KEY"] || "",
      deepInfra: __process.env["DEEPINFRA_API_KEY"] || "",
      liteLlm: __process.env["LITELLM_API_KEY"] || "",
      openAiCompat: __process.env["OPENAI_COMPAT_API_KEY"] || ""
    },
    baseUrl: {
      liteLlm: __process.env["LITELLM_BASE_URL"] || "",
      openAiCompat: __process.env["OPENAI_COMPAT_BASE_URL"] || ""
    },
    model: "gpt-4o-mini",
    logLevel: "warn",
    statelog: {
      host: "https://statelog.adit.io",
      projectId: "smoltalk",
      apiKey: __process.env["STATELOG_SMOLTALK_API_KEY"] || "",
      traceId: nanoid()
    }
  },
  dirname: __dirname,
  logLevel: "info",
  traceConfig: {
    program: "function-with-types.agency"
  }
});
const graph = __globalCtx.graph;

// Handler result builtins and interrupt response constructors (unified types)
export function approve(value?: any) { return { type: "approve" as const, value }; }
export function reject(value?: any) { return { type: "reject" as const, value }; }
function propagate() { return { type: "propagate" as const }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, hasInterrupts, isDebugger };
export const respondToInterrupts = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, registerTopLevelCallbacks: __registerTopLevelCallbacks, moduleDir: __dirname });
export const rewindFrom = (checkpoint: Checkpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata, registerTopLevelCallbacks: __registerTopLevelCallbacks, moduleDir: __dirname });

// Invoke an exported function in a node-grade execution frame. Used by
// `agency serve` to call a function from an HTTP/MCP request — outside any
// Agency execution frame, which generated function bodies otherwise require.
export const __invokeFunction = (fn: any, namedArgs: Record<string, unknown>) => _runExportedFunction({ ctx: __globalCtx, fn, namedArgs, initializeGlobals: __initializeGlobals, registerTopLevelCallbacks: __registerTopLevelCallbacks, moduleDir: __dirname });

export const __setDebugger = (dbg: any) => { __globalCtx.debuggerState = dbg; };
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

// Auto-activate the deterministic LLM client when AGENCY_LLM_MOCKS is set.
// The test runner (lib/cli/util.ts) populates this env var as a JSON string
// when AGENCY_USE_TEST_LLM_PROVIDER=1. Both the agency evaluate template
// and the agency-js test.js paths import this module, so this single block
// covers both code paths.
if (__process.env.AGENCY_LLM_MOCKS) {
  __globalCtx.setLLMClient(
    new __DeterministicClient(JSON.parse(__process.env.AGENCY_LLM_MOCKS))
  );
}

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

// Wrap stateful runtime functions as AgencyFunction instances
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

async function __initializeGlobals(__ctx) {
  if (__ctx.globals.isInitialized("function-with-types.agency")) {
    return;
  }
  __ctx.globals.markInitialized("function-with-types.agency")
}
__registerGlobalsInit("function-with-types.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {
  __ctx.topLevelCallbacks = [];
}
__functionRefReviver.registry = __toolRegistry;
async function __add_impl(x: number, y: number) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["x"] = x;
  __stack.args["y"] = y;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "add", threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// per-keystroke cost inside std::ui's repl loop. The cost of always
// pinning outweighs the retry-on-failure feature, so it is disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("x" in __overrides) {
    x = __overrides["x"];
    __stack.args["x"] = x;
  }
  if ("y" in __overrides) {
    y = __overrides["y"];
    __stack.args["y"] = y;
  }

}

  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onFunctionStart",
          data: {
            functionName: "add",
            args: {
              x: x,
              y: y
            },
            moduleId: "function-with-types.agency"
          }
        })
      });
      await runner.step(1, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
          prompt: `add ${__stack.args.x} and ${__stack.args.y}`,
          messages: __threads().getOrCreateActive(),
          responseFormat: z.object({
            response: z.number()
          }),
          clientConfig: {},
          maxToolCallRounds: 10,
          removedTools: __self.__removedTools,
          checkpointInfo: runner.getCheckpointInfo()
        });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.result)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt(__stack.locals.result)
          return;
        }
      });
      await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.result)
return;
      });
    })
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
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
  throw __error;
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
  __log.error("Function " + "add" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "add",
    retryable: __self.__retryable,
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "add",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "add",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const add = __AgencyFunction.create({
  name: "add",
  module: "function-with-types.agency",
  fn: __add_impl,
  params: [{
    name: "x",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }, {
    name: "y",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }],
  toolDefinition: {
    name: "add",
    description: `Adds two numbers together`,
    schema: z.object({"x": z.number(), "y": z.number(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __greet_impl(name: string) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["name"] = name;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "greet", threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// per-keystroke cost inside std::ui's repl loop. The cost of always
// pinning outweighs the retry-on-failure feature, so it is disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("name" in __overrides) {
    name = __overrides["name"];
    __stack.args["name"] = name;
  }

}

  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onFunctionStart",
          data: {
            functionName: "greet",
            args: {
              name: name
            },
            moduleId: "function-with-types.agency"
          }
        })
      });
      await runner.step(1, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.message = await runPrompt({
          prompt: `Hello ${__stack.args.name}!`,
          messages: __threads().getOrCreateActive(),
          clientConfig: {},
          maxToolCallRounds: 10,
          removedTools: __self.__removedTools,
          checkpointInfo: runner.getCheckpointInfo()
        });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.message)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt(__stack.locals.message)
          return;
        }
      });
      await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.message)
return;
      });
    })
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
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
  throw __error;
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
  __log.error("Function " + "greet" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "greet",
    retryable: __self.__retryable,
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "greet",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "greet",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const greet = __AgencyFunction.create({
  name: "greet",
  module: "function-with-types.agency",
  fn: __greet_impl,
  params: [{
    name: "name",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }],
  toolDefinition: {
    name: "greet",
    description: `Greets a person by name`,
    schema: z.object({"name": z.string(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __mixed_impl(count: number, label: any) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["count"] = count;
  __stack.args["label"] = label;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "mixed", threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// per-keystroke cost inside std::ui's repl loop. The cost of always
// pinning outweighs the retry-on-failure feature, so it is disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("count" in __overrides) {
    count = __overrides["count"];
    __stack.args["count"] = count;
  }
  if ("label" in __overrides) {
    label = __overrides["label"];
    __stack.args["label"] = label;
  }

}

  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onFunctionStart",
          data: {
            functionName: "mixed",
            args: {
              count: count,
              label: label
            },
            moduleId: "function-with-types.agency"
          }
        })
      });
      await runner.step(1, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.output = await runPrompt({
          prompt: `${__stack.args.label}: ${__stack.args.count}`,
          messages: __threads().getOrCreateActive(),
          clientConfig: {},
          maxToolCallRounds: 10,
          removedTools: __self.__removedTools,
          checkpointInfo: runner.getCheckpointInfo()
        });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.output)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt(__stack.locals.output)
          return;
        }
      });
      await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.output)
return;
      });
    })
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
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
  throw __error;
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
  __log.error("Function " + "mixed" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "mixed",
    retryable: __self.__retryable,
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "mixed",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "mixed",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const mixed = __AgencyFunction.create({
  name: "mixed",
  module: "function-with-types.agency",
  fn: __mixed_impl,
  params: [{
    name: "count",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }, {
    name: "label",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }],
  toolDefinition: {
    name: "mixed",
    description: `Mixed typed and untyped parameters`,
    schema: z.object({"count": z.number(), "label": z.string(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __processArray_impl(items: number[]) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["items"] = items;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "processArray", threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// per-keystroke cost inside std::ui's repl loop. The cost of always
// pinning outweighs the retry-on-failure feature, so it is disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("items" in __overrides) {
    items = __overrides["items"];
    __stack.args["items"] = items;
  }

}

  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onFunctionStart",
          data: {
            functionName: "processArray",
            args: {
              items: items
            },
            moduleId: "function-with-types.agency"
          }
        })
      });
      await runner.step(1, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
          prompt: `Processing array with ${__stack.args.items} items`,
          messages: __threads().getOrCreateActive(),
          clientConfig: {},
          maxToolCallRounds: 10,
          removedTools: __self.__removedTools,
          checkpointInfo: runner.getCheckpointInfo()
        });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.result)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt(__stack.locals.result)
          return;
        }
      });
      await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.result)
return;
      });
    })
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
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
  throw __error;
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
  __log.error("Function " + "processArray" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "processArray",
    retryable: __self.__retryable,
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "processArray",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "processArray",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const processArray = __AgencyFunction.create({
  name: "processArray",
  module: "function-with-types.agency",
  fn: __processArray_impl,
  params: [{
    name: "items",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }],
  toolDefinition: {
    name: "processArray",
    description: `Processes an array of numbers`,
    schema: z.object({"items": z.array(z.number()), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __flexible_impl(value: string | number) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["value"] = value;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "flexible", threads: __setupData.threads });
  // `__resultCheckpointId` is referenced by interruptAssignment /
// interruptReturn templates when an interrupt rejects and `runner.halt`
// builds a Failure carrying the entry checkpoint for `result.retry(...)`.
// We keep the variable declared (sentinel -1) but skip the createPinned
// call: pinning at every function entry causes pinned checkpoints to
// accumulate without bound (evictIfNeeded only evicts unpinned), and the
// JSON deep-clone of stateStack + globals on each call is a measurable
// per-keystroke cost inside std::ui's repl loop. The cost of always
// pinning outweighs the retry-on-failure feature, so it is disabled.
// `ctx.checkpoints.get(-1)` returns undefined, so the failure path
// gracefully omits the embedded checkpoint and retry simply becomes a
// no-op rather than failing.
let __resultCheckpointId = -1;
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("value" in __overrides) {
    value = __overrides["value"];
    __stack.args["value"] = value;
  }

}

  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onFunctionStart",
          data: {
            functionName: "flexible",
            args: {
              value: value
            },
            moduleId: "function-with-types.agency"
          }
        })
      });
      await runner.step(1, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
          prompt: `Received value: ${__stack.args.value}`,
          messages: __threads().getOrCreateActive(),
          clientConfig: {},
          maxToolCallRounds: 10,
          removedTools: __self.__removedTools,
          checkpointInfo: runner.getCheckpointInfo()
        });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.result)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt(__stack.locals.result)
          return;
        }
      });
      await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.result)
return;
      });
    })
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
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
  throw __error;
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
  __log.error("Function " + "flexible" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "flexible",
    retryable: __self.__retryable,
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "flexible",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "flexible",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const flexible = __AgencyFunction.create({
  name: "flexible",
  module: "function-with-types.agency",
  fn: __flexible_impl,
  params: [{
    name: "value",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }],
  toolDefinition: {
    name: "flexible",
    description: `Handles either a string or number`,
    schema: z.object({"value": z.union([z.string(), z.number()]), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
graph.node("foo", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "function-with-types.agency", scopeName: "foo", threads: __setupData.threads });
  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __ctx.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onNodeStart",
          data: {
            nodeName: "foo"
          }
        })
      });
      await runner.step(1, async (runner) => {
const __funcResult = await __call(print, {
          type: "positional",
          args: [`This is a node with a return type`]
        });
if (hasInterrupts(__funcResult)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __funcResult
          })
          return;
        }
      });
      await runner.step(2, async (runner) => {
runner.halt({
          messages: __threads(),
          data: `Node completed`
        })
return;
      });
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(3, async () => {
await callHook({
        name: "onNodeEnd",
        data: {
          nodeName: "foo",
          data: undefined
        }
      })
    });
    return {
      messages: __threads(),
      data: undefined
    };
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    if (__error instanceof AgencyAbort) {
      throw __error
    }
    {
              const __errMsg = __error instanceof Error ? __error.message : String(__error);
              const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
              const __log = __createLogger(__ctx.logLevel);
              __log.error(`Node foo crashed: ${__errMsg}`);
              if (__errStack) __log.error(__errStack);
              __ctx.statelogClient?.error?.({
                errorType: "runtimeError",
                message: __errMsg,
                functionName: "foo",
              });
            }
    return {
      messages: __threads(),
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "foo" })
    };
  }
})
graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "function-with-types.agency", scopeName: "main", threads: __setupData.threads });
  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __ctx.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onNodeStart",
          data: {
            nodeName: "main"
          }
        })
      });
      await runner.step(1, async (runner) => {
//  Call the functions
      });
      await runner.step(2, async (runner) => {
__stack.locals.sum = await __call(add, {
          type: "positional",
          args: [5, 10]
        });
if (hasInterrupts(__stack.locals.sum)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __stack.locals.sum
          })
          return;
        }
      });
      await runner.step(3, async (runner) => {
__stack.locals.greeting = await __call(greet, {
          type: "positional",
          args: [`Alice`]
        });
if (hasInterrupts(__stack.locals.greeting)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __stack.locals.greeting
          })
          return;
        }
      });
      await runner.step(4, async (runner) => {
__stack.locals.labeled = await __call(mixed, {
          type: "positional",
          args: [42, `Answer`]
        });
if (hasInterrupts(__stack.locals.labeled)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __stack.locals.labeled
          })
          return;
        }
      });
      await runner.step(5, async (runner) => {
__stack.locals.processed = await __call(processArray, {
          type: "positional",
          args: [[1, 2, 3, 4, 5]]
        });
if (hasInterrupts(__stack.locals.processed)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __stack.locals.processed
          })
          return;
        }
      });
      await runner.step(6, async (runner) => {
__stack.locals.flexResult = await __call(flexible, {
          type: "positional",
          args: [`test`]
        });
if (hasInterrupts(__stack.locals.flexResult)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __stack.locals.flexResult
          })
          return;
        }
      });
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(7, async () => {
await callHook({
        name: "onNodeEnd",
        data: {
          nodeName: "main",
          data: undefined
        }
      })
    });
    return {
      messages: __threads(),
      data: undefined
    };
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    if (__error instanceof AgencyAbort) {
      throw __error
    }
    {
              const __errMsg = __error instanceof Error ? __error.message : String(__error);
              const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
              const __log = __createLogger(__ctx.logLevel);
              __log.error(`Node main crashed: ${__errMsg}`);
              if (__errStack) __log.error(__errStack);
              __ctx.statelogClient?.error?.({
                errorType: "runtimeError",
                message: __errMsg,
                functionName: "main",
              });
            }
    return {
      messages: __threads(),
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "main" })
    };
  }
})
export async function foo({ messages, callbacks }: { messages?: any; callbacks?: any } = {}): Promise<RunNodeResult<any>> {
  return runNode({
    ctx: __globalCtx,
    nodeName: "foo",
    data: {},
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals,
    registerTopLevelCallbacks: __registerTopLevelCallbacks,
    moduleDir: __dirname
  });
}
export const __fooNodeParams = [];
export async function main({ messages, callbacks }: { messages?: any; callbacks?: any } = {}): Promise<RunNodeResult<any>> {
  return runNode({
    ctx: __globalCtx,
    nodeName: "main",
    data: {},
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals,
    registerTopLevelCallbacks: __registerTopLevelCallbacks,
    moduleDir: __dirname
  });
}
export const __mainNodeParams = [];
if (__process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const initialState = {
      messages: new ThreadStore(),
      data: {}
    };
    const __result = await main(initialState);
    reportUnhandledInterrupts(__result)
  } catch (__error: any) {
    console.error(`
Agent crashed: ${__error.message}`)
    throw __error
  }
}
export default graph
export const __sourceMap = {"function-with-types.agency:add":{"1":{"line":4,"col":2},"2":{"line":5,"col":2}},"function-with-types.agency:greet":{"1":{"line":12,"col":2},"2":{"line":13,"col":2}},"function-with-types.agency:mixed":{"1":{"line":20,"col":2},"2":{"line":21,"col":2}},"function-with-types.agency:processArray":{"1":{"line":28,"col":2},"2":{"line":29,"col":2}},"function-with-types.agency:flexible":{"1":{"line":36,"col":2},"2":{"line":37,"col":2}},"function-with-types.agency:foo":{"1":{"line":41,"col":2},"2":{"line":42,"col":2}},"function-with-types.agency:main":{"2":{"line":47,"col":2},"3":{"line":48,"col":2},"4":{"line":49,"col":2},"5":{"line":50,"col":2},"6":{"line":51,"col":2}}};