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
  interrupt, isInterrupt, hasInterrupts, reportUnhandledInterrupts, resolveCliInterrupts, reportBudgetExceededAndExit, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  runExportedFunction as _runExportedFunction,
  RestoreSignal,
  AgencyAbort,
  AbortedResult,
  isAborted,
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  __UNINIT_STATIC, __readStatic,
  __registerStaticInit, __registerGlobalsInit, __awaitStaticInit, __awaitGlobalsInit,
  head, tail, empty,
  success, failure, isSuccess, isFailure, stampFailureBoundary, markDestructiveWork, __pipeBind, __tryCall, __catchResult, __eq, __nn,
  Schema, __validateType, __validateChain, __validateChainRecursive,
  AgencyFunction as __AgencyFunction, UNSET as __UNSET,
  __call, __callMethod, __threads, __stateStack, __globals, getRuntimeContext, agencyStore,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient,
  installFetchMock as __installFetchMock,
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
    program: "docstrings.agency"
  }
});
const graph = __globalCtx.graph;
__initializeGlobals(__globalCtx);

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

// Auto-activate fetch mocking when AGENCY_FETCH_MOCKS_FILE points at a mocks
// file. The runner writes resolved mocks (returnFile bodies already inlined) to
// a temp file and passes its path — a file, not an inline env value, so a large
// response body can't blow the exec arg/env size limit (ARG_MAX). Independent of
// AGENCY_LLM_MOCKS — a test may mock the network while using a real LLM, or vice
// versa. Installed before any node runs, ahead of any http.ts / stdlib / interop
// fetch.
if (__process.env.AGENCY_FETCH_MOCKS_FILE) {
  __installFetchMock(JSON.parse(readFileSync(__process.env.AGENCY_FETCH_MOCKS_FILE, "utf-8")));
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
  if (__ctx.globals.isInitialized("docstrings.agency")) {
    return;
  }
  __ctx.globals.markInitialized("docstrings.agency")
  __ctx.globals.set("docstrings.agency", "toolVersion", `2.0`)
}
__registerGlobalsInit("docstrings.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {
  __ctx.topLevelCallbacks = [];
}
__functionRefReviver.registry = __toolRegistry;
//  Test docstrings in functions
async function __add_impl(a: any, b: any) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("docstrings.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["a"] = a;
  __stack.args["b"] = b;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "docstrings.agency", scopeName: "add", threads: __setupData.threads });
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
  if ("a" in __overrides) {
    a = __overrides["a"];
    __stack.args["a"] = a;
  }
  if ("b" in __overrides) {
    b = __overrides["b"];
    __stack.args["b"] = b;
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
              a: a,
              b: b
            },
            moduleId: "docstrings.agency"
          }
        })
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __self.__destructiveRan)
      }
      return runner.haltResult;
    }
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
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__error, __stack, "add");
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
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    destructiveRan: __self.__destructiveRan,
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
export const add = __AgencyFunction.create({
  name: "add",
  module: "docstrings.agency",
  fn: __add_impl,
  params: [{
    name: "a",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "b",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "add",
    description: `Add two numbers together.
  This is a simple addition function.`,
    schema: z.object({"a": z.string(), "b": z.string(), })
  },
  exported: false
}, __toolRegistry);
async function __greet_impl(name: any) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("docstrings.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["name"] = name;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "docstrings.agency", scopeName: "greet", threads: __setupData.threads });
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
            moduleId: "docstrings.agency"
          }
        })
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __self.__destructiveRan)
      }
      return runner.haltResult;
    }
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
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__error, __stack, "greet");
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
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    destructiveRan: __self.__destructiveRan,
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
export const greet = __AgencyFunction.create({
  name: "greet",
  module: "docstrings.agency",
  fn: __greet_impl,
  params: [{
    name: "name",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "greet",
    description: `Generate a greeting message for the given name.`,
    schema: z.object({"name": z.string(), })
  },
  exported: false
}, __toolRegistry);
async function __calculateArea_impl(width: any, height: any) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("docstrings.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["width"] = width;
  __stack.args["height"] = height;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "docstrings.agency", scopeName: "calculateArea", threads: __setupData.threads });
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
  if ("width" in __overrides) {
    width = __overrides["width"];
    __stack.args["width"] = width;
  }
  if ("height" in __overrides) {
    height = __overrides["height"];
    __stack.args["height"] = height;
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
            functionName: "calculateArea",
            args: {
              width: width,
              height: height
            },
            moduleId: "docstrings.agency"
          }
        })
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __self.__destructiveRan)
      }
      return runner.haltResult;
    }
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
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__error, __stack, "calculateArea");
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
  __log.error("Function " + "calculateArea" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "calculateArea",
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    destructiveRan: __self.__destructiveRan,
    functionName: "calculateArea",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "calculateArea",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export const calculateArea = __AgencyFunction.create({
  name: "calculateArea",
  module: "docstrings.agency",
  fn: __calculateArea_impl,
  params: [{
    name: "width",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "height",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "calculateArea",
    description: `Calculate the area of a rectangle.

  Parameters:
  - width: the width of the rectangle
  - height: the height of the rectangle

  Returns: the area as a number`,
    schema: z.object({"width": z.string(), "height": z.string(), })
  },
  exported: false
}, __toolRegistry);
async function __processData_impl() {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("docstrings.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "docstrings.agency", scopeName: "processData", threads: __setupData.threads });
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
            functionName: "processData",
            args: {},
            moduleId: "docstrings.agency"
          }
        })
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __self.__destructiveRan)
      }
      return runner.haltResult;
    }
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
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__error, __stack, "processData");
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
  __log.error("Function " + "processData" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "processData",
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    destructiveRan: __self.__destructiveRan,
    functionName: "processData",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "processData",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export const processData = __AgencyFunction.create({
  name: "processData",
  module: "docstrings.agency",
  fn: __processData_impl,
  params: [],
  toolDefinition: {
    name: "processData",
    description: `Single line docstring`,
    schema: z.object({})
  },
  exported: false
}, __toolRegistry);
async function __versionedTool_impl() {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("docstrings.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "docstrings.agency", scopeName: "versionedTool", threads: __setupData.threads });
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
            functionName: "versionedTool",
            args: {},
            moduleId: "docstrings.agency"
          }
        })
      });
    })
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __self.__destructiveRan)
      }
      return runner.haltResult;
    }
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
  // An abort stopped this function. It does not throw past its own frame:
  // it RETURNS an AbortedResult — a marker plus this frame's saved draft,
  // if it saved one. The caller's post-call check spots the marker and
  // stops too, so the abort travels up the stack as a plain value, the
  // same way interrupts do. See lib/runtime/abortedResult.ts.
  return AbortedResult.fromError(__error, __stack, "versionedTool");
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
  __log.error("Function " + "versionedTool" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "versionedTool",
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    destructiveRan: __self.__destructiveRan,
    functionName: "versionedTool",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "versionedTool",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export const versionedTool = __AgencyFunction.create({
  name: "versionedTool",
  module: "docstrings.agency",
  fn: __versionedTool_impl,
  params: [],
  toolDefinition: {
    name: "versionedTool",
    description: `This tool is version ${__globalCtx.globals.get("docstrings.agency", "toolVersion")}.`,
    schema: z.object({})
  },
  exported: false
}, __toolRegistry);
export default graph
export const __sourceMap = {"docstrings.agency:add":{},"docstrings.agency:greet":{},"docstrings.agency:calculateArea":{},"docstrings.agency:processData":{},"docstrings.agency:versionedTool":{}};