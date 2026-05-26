// @ts-nocheck
import { print, printJSON, parseJSON, input, sleep, round, read, write, readImage, notify, range, mostCommon, keys, values, entries, emit, callback } from "agency-lang/stdlib/index.js";
import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "agency-lang/zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse, Checkpoint, LLMClient } from "agency-lang/runtime";
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
  head, tail, empty,
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult,
  Schema, __validateType, __validateChain, __validateChainRecursive,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  AgencyFunction as __AgencyFunction, UNSET as __UNSET,
  __call, __callMethod, __threads, __stateStack, __ctx, getRuntimeContext, agencyStore,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = __process.cwd();

const getDirname = () => __dirname;

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://statelog.adit.io",
    apiKey: __process.env["STATELOG_API_KEY"] || "",
    projectId: "agency-lang",
    debugMode: false,
    observability: true,
    logFile: "statelog.log"
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
    program: "tests/agency/fork/fork-deep-call-interrupt.agency",
    traceDir: "traces"
  }
});
const graph = __globalCtx.graph;

// Path-dependent builtin wrappers
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// Handler result builtins and interrupt response constructors (unified types)
export function approve(value?: any) { return { type: "approve" as const, value }; }
export function reject(value?: any) { return { type: "reject" as const, value }; }
function propagate() { return { type: "propagate" as const }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, hasInterrupts, isDebugger };
export const respondToInterrupts = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, registerTopLevelCallbacks: __registerTopLevelCallbacks });
export const rewindFrom = (checkpoint: Checkpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata, registerTopLevelCallbacks: __registerTopLevelCallbacks });

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

export const __toolRegistry: Record<string, any> = {};

function __registerTool(value: unknown, name?: string) {
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[name ?? value.name] = value;
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
      __toolRegistry[tool.name] = tool;
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
  __ctx.globals.markInitialized("tests/agency/fork/fork-deep-call-interrupt.agency")
}
async function __registerTopLevelCallbacks(__ctx) {
  __ctx.topLevelCallbacks = [];
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "tests/agency/fork/fork-deep-call-interrupt.agency",
  fn: readSkill,
  params: __readSkillToolParams.map(p => ({ name: p, hasDefault: false, defaultValue: undefined, variadic: false })),
  toolDefinition: __readSkillTool,
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;

async function __inner_impl(item: string, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = __state?.ctx || __globalCtx;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("tests/agency/fork/fork-deep-call-interrupt.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["item"] = item;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "tests/agency/fork/fork-deep-call-interrupt.agency", scopeName: "inner", threads: __setupData.threads });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack(), __ctx, { moduleId: "tests/agency/fork/fork-deep-call-interrupt.agency", scopeName: "inner", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("item" in __overrides) {
    item = __overrides["item"];
    __stack.args["item"] = item;
  }

}

  try {
    await agencyStore.run({
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onFunctionStart",
          data: {
            functionName: "inner",
            args: {
              item: item
            },
            isBuiltin: false,
            moduleId: "tests/agency/fork/fork-deep-call-interrupt.agency"
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
    
    
    runner.halt(failure("interrupt rejected", { retryable: false, checkpoint: getRuntimeContext().ctx.getResultCheckpoint() }));
    
    return;
  }
} else {
  // First run: call handlers, then propagate if unhandled
  const __handlerResult = await interruptWithHandlers("unknown", `approve ${__stack.args.item}?`, {}, "./tests/agency/fork/fork-deep-call-interrupt.agency", __ctx, __stateStack());
  if (isRejected(__handlerResult)) {
    
    
    runner.halt(failure(__handlerResult.value ?? "interrupt rejected", { retryable: false, checkpoint: getRuntimeContext().ctx.checkpoints.get(__resultCheckpointId) }));
    
    return;
  }
  if (!isApproved(__handlerResult)) {
    // No handler — propagate interrupt array to TypeScript caller
    // Store interruptId on frame BEFORE checkpoint so it's captured in the snapshot
    __self.__interruptId_1 = __handlerResult[0].interruptId;
    const __checkpointId = getRuntimeContext().ctx.checkpoints.create(__stateStack(), __ctx, { moduleId: "tests/agency/fork/fork-deep-call-interrupt.agency", scopeName: "inner", stepPath: "1" });
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
runner.halt(`inner: ${__stack.args.item}`)
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
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "inner",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "inner",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const inner = __AgencyFunction.create({
  name: "inner",
  module: "tests/agency/fork/fork-deep-call-interrupt.agency",
  fn: __inner_impl,
  params: [{
    name: "item",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }],
  toolDefinition: {
    name: "inner",
    description: "No description provided.",
    schema: z.object({"item": z.string(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __outer_impl(item: string, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = __state?.ctx || __globalCtx;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("tests/agency/fork/fork-deep-call-interrupt.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["item"] = item;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "tests/agency/fork/fork-deep-call-interrupt.agency", scopeName: "outer", threads: __setupData.threads });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack(), __ctx, { moduleId: "tests/agency/fork/fork-deep-call-interrupt.agency", scopeName: "outer", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("item" in __overrides) {
    item = __overrides["item"];
    __stack.args["item"] = item;
  }

}

  try {
    await agencyStore.run({
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onFunctionStart",
          data: {
            functionName: "outer",
            args: {
              item: item
            },
            isBuiltin: false,
            moduleId: "tests/agency/fork/fork-deep-call-interrupt.agency"
          }
        })
      });
      await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(await __call(inner, {
          type: "positional",
          args: [__stack.args.item]
        }))
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
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "outer",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "outer",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const outer = __AgencyFunction.create({
  name: "outer",
  module: "tests/agency/fork/fork-deep-call-interrupt.agency",
  fn: __outer_impl,
  params: [{
    name: "item",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }],
  toolDefinition: {
    name: "outer",
    description: "No description provided.",
    schema: z.object({"item": z.string(), })
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
const __ctx = __state.ctx;
let __forked;
let __functionCompleted = false;
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "tests/agency/fork/fork-deep-call-interrupt.agency", scopeName: "main", threads: __setupData.threads });
  try {
    await agencyStore.run({
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
__stack.locals.results = await runner.fork(1, [`a`, `b`], async (__forkItem, __forkIndex, __forkBranchStack) => {
          
const __bstack = __forkBranchStack.getNewState();
const __self = __bstack.locals;
// `__stateStack` is read from ALS via the `__stateStack()` accessor.
// The branch ALS frame seeded by `runBatch.runInBranchAlsFrame`
// (lib/runtime/runBatch.ts) already carries `stack: __forkBranchStack`,
// so accessor calls inside the branch body resolve to the branch
// stack automatically — no local rebind needed. The earlier
// `const __stateStack = __forkBranchStack` line was removed because
// it shadowed the runtime import and made `__stateStack()` calls
// (emitted by interrupt/checkpoint templates) crash with
// "__stateStack2 is not a function".
const item = __forkItem;

__bstack.args["item"] = __forkItem;
const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: "tests/agency/fork/fork-deep-call-interrupt.agency", scopeName: "__block_0" });
try {
await runner.step(0, async (runner) => {
runner.halt(await __call(outer, {
      type: "positional",
      args: [__bstack.args.item]
    }))
return;
  });
return runner.halted ? runner.haltResult : undefined;
} finally {
__forkBranchStack.pop();
}


        }, "all", getRuntimeContext().stack);
if (hasInterrupts(__stack.locals.results)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __stack.locals.results
          })
          return;
        }
      });
      await runner.step(2, async (runner) => {
runner.halt({
          messages: __threads(),
          data: __stack.locals.results
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
    console.error(`\nAgent crashed: ${__error.message}`)
    console.error(__error.stack)
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
    registerTopLevelCallbacks: __registerTopLevelCallbacks
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
export const __sourceMap = {"tests/agency/fork/fork-deep-call-interrupt.agency:inner":{"1":{"line":1,"col":2},"2":{"line":2,"col":2}},"tests/agency/fork/fork-deep-call-interrupt.agency:outer":{"1":{"line":6,"col":2}},"tests/agency/fork/fork-deep-call-interrupt.agency:main":{"1":{"line":10,"col":2},"2":{"line":13,"col":2}},"tests/agency/fork/fork-deep-call-interrupt.agency:__block_0":{"1.0":{"line":11,"col":4}}};