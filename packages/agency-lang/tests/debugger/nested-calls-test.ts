// @ts-nocheck
import { print, printJSON, parseJSON, input, sleep, round, read, write, readImage, notify, range, mostCommon, keys, values, entries, emit, callback } from "agency-lang/stdlib/index.js";
import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "agency-lang/zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import type { GraphState, Interrupt, InterruptResponse, Checkpoint, LLMClient } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore, Runner, McpManager,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl, _run as __runtime_run_impl,
  interrupt, isInterrupt, hasInterrupts, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  RestoreSignal,
  GuardExceededError,
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  __UNINIT_STATIC, __readStatic,
  __registerStaticInit, __registerGlobalsInit, __awaitStaticInit, __awaitGlobalsInit,
  head, tail, empty,
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult,
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
    openAiApiKey: __process.env["OPENAI_API_KEY"] || "",
    googleApiKey: __process.env["GEMINI_API_KEY"] || "",
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
    program: "tests/debugger/nested-calls-test.agency"
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
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __runtime_run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "node", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "args", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "wallClock", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "memory", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "ipcPayload", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "stdout", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
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

__registerTool(print);
__registerTool(printJSON);
__registerTool(parseJSON);
__registerTool(input);
__registerTool(sleep);
__registerTool(round);
__registerTool(read);
__registerTool(write);
__registerTool(readImage);
__registerTool(notify);
__registerTool(range);
__registerTool(mostCommon);
__registerTool(keys);
__registerTool(values);
__registerTool(entries);
__registerTool(emit);
__registerTool(callback);
async function __initializeGlobals(__ctx) {
  if (__ctx.globals.isInitialized("tests/debugger/nested-calls-test.agency")) {
    return;
  }
  __ctx.globals.markInitialized("tests/debugger/nested-calls-test.agency")
}
__registerGlobalsInit("tests/debugger/nested-calls-test.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {
  __ctx.topLevelCallbacks = [];
}
__functionRefReviver.registry = __toolRegistry;

async function __double_impl(n: number) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("tests/debugger/nested-calls-test.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["n"] = n;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "tests/debugger/nested-calls-test.agency", scopeName: "double", threads: __setupData.threads });
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
  if ("n" in __overrides) {
    n = __overrides["n"];
    __stack.args["n"] = n;
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
            functionName: "double",
            args: {
              n: n
            },
            isBuiltin: false,
            moduleId: "tests/debugger/nested-calls-test.agency"
          }
        })
      });
      await runner.step(1, async (runner) => {
__stack.locals.result = __stack.args.n * 2;
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
// GuardExceededError must propagate up to the stdlib `guard`
// function's try/catch (in lib/runtime/result.ts via `try block()`).
// If we converted it to a Failure here, the guard would never see
// the trip and every guarded block would appear to succeed even
// over budget. See lib/runtime/guard.ts.
if (__error instanceof GuardExceededError) {
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
  __log.error("Function " + "double" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "double",
    retryable: __self.__retryable,
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "double",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "double",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const double = __AgencyFunction.create({
  name: "double",
  module: "tests/debugger/nested-calls-test.agency",
  fn: __double_impl,
  params: [{
    name: "n",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }],
  toolDefinition: {
    name: "double",
    description: "No description provided.",
    schema: z.object({"n": z.number(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __addAndDouble_impl(a: any, b: number) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("tests/debugger/nested-calls-test.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["a"] = a;
  __stack.args["b"] = b;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "tests/debugger/nested-calls-test.agency", scopeName: "addAndDouble", threads: __setupData.threads });
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
            functionName: "addAndDouble",
            args: {
              a: a,
              b: b
            },
            isBuiltin: false,
            moduleId: "tests/debugger/nested-calls-test.agency"
          }
        })
      });
      await runner.step(1, async (runner) => {
__stack.locals.sum = __stack.args.a + __stack.args.b;
      });
      await runner.step(2, async (runner) => {
__stack.locals.result = await __call(double, {
          type: "positional",
          args: [__stack.locals.sum]
        });
if (hasInterrupts(__stack.locals.result)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt(__stack.locals.result)
          return;
        }
      });
      await runner.step(3, async (runner) => {
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
// GuardExceededError must propagate up to the stdlib `guard`
// function's try/catch (in lib/runtime/result.ts via `try block()`).
// If we converted it to a Failure here, the guard would never see
// the trip and every guarded block would appear to succeed even
// over budget. See lib/runtime/guard.ts.
if (__error instanceof GuardExceededError) {
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
  __log.error("Function " + "addAndDouble" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "addAndDouble",
    retryable: __self.__retryable,
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "addAndDouble",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "addAndDouble",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const addAndDouble = __AgencyFunction.create({
  name: "addAndDouble",
  module: "tests/debugger/nested-calls-test.agency",
  fn: __addAndDouble_impl,
  params: [{
    name: "a",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }, {
    name: "b",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false
  }],
  toolDefinition: {
    name: "addAndDouble",
    description: "No description provided.",
    schema: z.object({"a": z.string(), "b": z.number(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "tests/debugger/nested-calls-test.agency", scopeName: "main", threads: __setupData.threads });
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
__stack.locals.x = await __call(addAndDouble, {
          type: "positional",
          args: [1, 2]
        });
if (hasInterrupts(__stack.locals.x)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __stack.locals.x
          })
          return;
        }
      });
      await runner.step(2, async (runner) => {
runner.halt({
          messages: __threads(),
          data: __stack.locals.x
        })
return;
      });
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(3, async () => {
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
    if (__error instanceof GuardExceededError) {
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
    await main(initialState)
  } catch (__error: any) {
    console.error(`\nAgent crashed: ${__error.message}`)
    throw __error
  }
}
export default graph
export const __sourceMap = {"tests/debugger/nested-calls-test.agency:double":{"1":{"line":1,"col":2},"2":{"line":2,"col":2}},"tests/debugger/nested-calls-test.agency:addAndDouble":{"1":{"line":6,"col":2},"2":{"line":7,"col":2},"3":{"line":8,"col":2}},"tests/debugger/nested-calls-test.agency:main":{"1":{"line":12,"col":2},"2":{"line":13,"col":2}}};