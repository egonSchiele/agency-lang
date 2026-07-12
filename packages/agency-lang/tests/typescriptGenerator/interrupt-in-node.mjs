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
  interrupt, isInterrupt, hasInterrupts, reportUnhandledInterrupts, resolveCliInterrupts, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
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
  success, failure, isSuccess, isFailure, stampFailureBoundary, markDestructiveWork, __pipeBind, __tryCall, __catchResult, __eq,
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
    program: "interrupt-in-node.agency"
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
  if (__ctx.globals.isInitialized("interrupt-in-node.agency")) {
    return;
  }
  __ctx.globals.markInitialized("interrupt-in-node.agency")
}
__registerGlobalsInit("interrupt-in-node.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {
  __ctx.topLevelCallbacks = [];
}
__functionRefReviver.registry = __toolRegistry;
async function __greet_impl(name: string, age: number) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__globals()!.isInitialized("interrupt-in-node.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["name"] = name;
  __stack.args["age"] = age;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "interrupt-in-node.agency", scopeName: "greet", threads: __setupData.threads });
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
  if ("age" in __overrides) {
    age = __overrides["age"];
    __stack.args["age"] = age;
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
              name: name,
              age: age
            },
            moduleId: "interrupt-in-node.agency"
          }
        })
      });
      await runner.step(1, async (runner) => {
// Resume path: check for a response by interruptId
const __response = getRuntimeContext().ctx.getInterruptResponse(__self.__interruptId_1);
if (__response) {
  if (__response.type === "approve") {
    // approved, continue execution
  } else if (__response.type === "reject") {
    // rejected, halt
    
    
    runner.halt(failure("interrupt rejected", { checkpoint: getRuntimeContext().ctx.getResultCheckpoint() }));
    
    return;
  }
} else {
  // First run: call handlers, then propagate if unhandled
  const __handlerResult = await interruptWithHandlers("unknown", `Agent wants to call the greet function with name: ${__stack.args.name} and age: ${__stack.args.age}`, {}, "./interrupt-in-node.agency", __ctx, __stateStack());
  if (isRejected(__handlerResult)) {
    
    
    runner.halt(failure(__handlerResult.value ?? "interrupt rejected", { checkpoint: getRuntimeContext().ctx.checkpoints.get(__resultCheckpointId) }));
    
    return;
  }
  if (!isApproved(__handlerResult)) {
    // No handler — propagate interrupt array to TypeScript caller
    // Store interruptId on frame BEFORE checkpoint so it's captured in the snapshot
    __self.__interruptId_1 = __handlerResult[0].interruptId;
    const __checkpointId = getRuntimeContext().ctx.checkpoints.create(__stateStack(), __ctx, { moduleId: "interrupt-in-node.agency", scopeName: "greet", stepPath: "1" });
    __handlerResult[0].checkpointId = __checkpointId;
    __handlerResult[0].checkpoint = getRuntimeContext().ctx.checkpoints.get(__checkpointId);
    
    
    runner.halt(__handlerResult);
    
    return;
  }
  // Approved — continue execution past interrupt
}

      });
      await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(`Kya chal raha jai, ${__stack.args.name}! You are ${__stack.args.age} years old.`)
return;
      });
    })
    if (runner.halted) { if (isFailure(runner.haltResult)) { stampFailureBoundary(runner.haltResult, __self.__destructiveRan); } return runner.haltResult; }
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
  module: "interrupt-in-node.agency",
  fn: __greet_impl,
  params: [{
    name: "name",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "age",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "greet",
    description: "No description provided.",
    schema: z.object({"name": z.string(), "age": z.number(), })
  },
  exported: false
}, __toolRegistry);
graph.node("foo2", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "interrupt-in-node.agency", scopeName: "foo2", threads: __setupData.threads });
  if (!__state.isResume) {
    __stack.args["name"] = __state.data.name;
    __stack.args["age"] = __state.data.age;
  }
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
            nodeName: "foo2"
          }
        })
      });
      await runner.step(1, async (runner) => {
await __call(print, {
          type: "positional",
          args: [`In foo2, name is ${__stack.args.name} and age is ${__stack.args.age}, this message should only print once...`]
        }) + greet
      });
      await runner.step(2, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.response = await runPrompt({
          prompt: `Greet the user with their name: ${__stack.args.name} and age ${__stack.args.age} using the greet function.`,
          messages: __threads().getOrCreateActive(),
          clientConfig: {},
          maxToolCallRounds: 10,
          removedTools: __self.__removedTools,
          destructiveSink: __self,
          checkpointInfo: runner.getCheckpointInfo()
        });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.response)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            messages: __threads(),
            data: __stack.locals.response
          })
          return;
        }
      });
      await runner.step(3, async (runner) => {
const __funcResult = await __call(print, {
          type: "positional",
          args: [`Greeted, age is still ${__stack.args.age}...`]
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
      await runner.step(4, async (runner) => {
runner.halt({
          messages: __threads(),
          data: __stack.locals.response
        })
return;
      });
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(5, async () => {
await callHook({
        name: "onNodeEnd",
        data: {
          nodeName: "foo2",
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
              __log.error(`Node foo2 crashed: ${__errMsg}`);
              if (__errStack) __log.error(__errStack);
              __ctx.statelogClient?.error?.({
                errorType: "runtimeError",
                message: __errMsg,
                functionName: "foo2",
              });
            }
    return {
      messages: __threads(),
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "foo2" })
    };
  }
})
graph.node("sayHi", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "interrupt-in-node.agency", scopeName: "sayHi", threads: __setupData.threads });
  if (!__state.isResume) {
    __stack.args["name"] = __state.data.name;
  }
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
            nodeName: "sayHi"
          }
        })
      });
      await runner.step(1, async (runner) => {
const __funcResult = await __call(print, {
          type: "positional",
          args: [`Saying hi to ${__stack.args.name}...`]
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
__stack.locals.age = 30;
      });
      await runner.step(3, async (runner) => {
__stateStack()?.pop()
__functionCompleted = true;
runner.halt(goToNode("foo2", {
          messages: __threads(),
          ctx: getRuntimeContext().ctx,
          data: {
            name: __stack.args.name,
            age: __stack.locals.age
          }
        }))
return;
      });
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(4, async () => {
await callHook({
        name: "onNodeEnd",
        data: {
          nodeName: "sayHi",
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
              __log.error(`Node sayHi crashed: ${__errMsg}`);
              if (__errStack) __log.error(__errStack);
              __ctx.statelogClient?.error?.({
                errorType: "runtimeError",
                message: __errMsg,
                functionName: "sayHi",
              });
            }
    return {
      messages: __threads(),
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "sayHi" })
    };
  }
})
graph.conditionalEdge("sayHi", ["foo2"])
export async function foo2(name: string, age: number, { messages, callbacks }: { messages?: any; callbacks?: any } = {}): Promise<RunNodeResult<any>> {
  return runNode({
    ctx: __globalCtx,
    nodeName: "foo2",
    data: {
      name: name,
      age: age
    },
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals,
    registerTopLevelCallbacks: __registerTopLevelCallbacks,
    moduleDir: __dirname
  });
}
export const __foo2NodeParams = ["name", "age"];
export async function sayHi(name: any, { messages, callbacks }: { messages?: any; callbacks?: any } = {}): Promise<RunNodeResult<any>> {
  return runNode({
    ctx: __globalCtx,
    nodeName: "sayHi",
    data: {
      name: name
    },
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals,
    registerTopLevelCallbacks: __registerTopLevelCallbacks,
    moduleDir: __dirname
  });
}
export const __sayHiNodeParams = ["name"];
export default graph
export const __sourceMap = {"interrupt-in-node.agency:greet":{"1":{"line":1,"col":2},"2":{"line":2,"col":2}},"interrupt-in-node.agency:foo2":{"2":{"line":8,"col":2},"3":{"line":9,"col":2},"4":{"line":10,"col":2}},"interrupt-in-node.agency:sayHi":{"1":{"line":14,"col":2},"2":{"line":15,"col":2},"3":{"line":16,"col":2}}};