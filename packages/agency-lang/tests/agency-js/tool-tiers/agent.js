import { print, printJSON, input, sleep, read, write, writeBinary, readBinary, range, callback, map, filter, exclude, find, findIndex, reduce, flatMap, every, some, count, sortBy, unique, groupBy } from "agency-lang/stdlib/index.js";
import { flaky, boom, resetCounters } from "./tools.js";
import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync } from "fs";
import { z } from "agency-lang/zod";
import { nanoid } from "agency-lang";
import path from "path";
import {
  RuntimeContext,
  Runner,
  setupNode,
  setupFunction,
  runNode,
  runPrompt,
  callHook,
  checkpoint as __checkpoint_impl,
  getCheckpoint as __getCheckpoint_impl,
  restore as __restore_impl,
  _run as __runtime_run_impl,
  interrupt,
  isInterrupt,
  hasInterrupts,
  isDebugger,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  runExportedFunction as _runExportedFunction,
  RestoreSignal,
  AgencyAbort,
  __registerGlobalsInit,
  failure,
  isFailure,
  stampFailureBoundary,
  AgencyFunction as __AgencyFunction,
  __call,
  __threads,
  __stateStack,
  __globals,
  getRuntimeContext,
  agencyStore,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient,
  installFetchMock as __installFetchMock,
  createLogger as __createLogger
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
    logFile: "log.jsonl"
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
    program: "tests/agency-js/tool-tiers/agent.agency"
  }
});
const graph = __globalCtx.graph;
function approve(value) {
  return { type: "approve", value };
}
function reject(value) {
  return { type: "reject", value };
}
function propagate() {
  return { type: "propagate" };
}
const respondToInterrupts = (interrupts, responses, opts) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, registerTopLevelCallbacks: __registerTopLevelCallbacks, moduleDir: __dirname });
const rewindFrom = (checkpoint2, overrides, opts) => _rewindFrom({ ctx: __globalCtx, checkpoint: checkpoint2, overrides, metadata: opts?.metadata, registerTopLevelCallbacks: __registerTopLevelCallbacks, moduleDir: __dirname });
const __invokeFunction = (fn, namedArgs) => _runExportedFunction({ ctx: __globalCtx, fn, namedArgs, initializeGlobals: __initializeGlobals, registerTopLevelCallbacks: __registerTopLevelCallbacks, moduleDir: __dirname });
const __setDebugger = (dbg) => {
  __globalCtx.debuggerState = dbg;
};
const __setTraceFile = (filePath) => {
  __globalCtx.traceConfig.traceFile = filePath;
};
const __setLLMClient = (client) => {
  __globalCtx.setLLMClient(client);
};
const __getCheckpoints = () => __globalCtx.checkpoints;
if (__process.env.AGENCY_LLM_MOCKS) {
  __globalCtx.setLLMClient(
    new __DeterministicClient(JSON.parse(__process.env.AGENCY_LLM_MOCKS))
  );
}
if (__process.env.AGENCY_FETCH_MOCKS_FILE) {
  __installFetchMock(JSON.parse(readFileSync(__process.env.AGENCY_FETCH_MOCKS_FILE, "utf-8")));
}
const __toolRegistry = __functionRefReviver.registry ??= {};
function __registerTool(value, _aliasName) {
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[`${value.module}:${value.name}`] = value;
  }
}
const checkpoint = __AgencyFunction.create({ name: "checkpoint", module: "__runtime", fn: __checkpoint_impl, params: [], toolDefinition: null }, __toolRegistry);
const getCheckpoint = __AgencyFunction.create({ name: "getCheckpoint", module: "__runtime", fn: __getCheckpoint_impl, params: [{ name: "checkpointId", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const restore = __AgencyFunction.create({ name: "restore", module: "__runtime", fn: __restore_impl, params: [{ name: "checkpointIdOrCheckpoint", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "options", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __runtime_run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "node", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "args", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "wallClock", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "memory", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "ipcPayload", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "stdout", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "configOverrides", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "cwd", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "maxDepth", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
function setLLMClient(client) {
  __globalCtx.setLLMClient(client);
}
function registerTools(tools) {
  for (const tool of tools) {
    if (__AgencyFunction.isAgencyFunction(tool)) {
      __toolRegistry[`${tool.module}:${tool.name}`] = tool;
    }
  }
}
__registerTool(print);
__registerTool(printJSON);
__registerTool(input);
__registerTool(sleep);
__registerTool(read);
__registerTool(write);
__registerTool(writeBinary);
__registerTool(readBinary);
__registerTool(range);
__registerTool(callback);
__registerTool(map);
__registerTool(filter);
__registerTool(exclude);
__registerTool(find);
__registerTool(findIndex);
__registerTool(reduce);
__registerTool(flatMap);
__registerTool(every);
__registerTool(some);
__registerTool(count);
__registerTool(sortBy);
__registerTool(unique);
__registerTool(groupBy);
async function __initializeGlobals(__ctx) {
  if (__ctx.globals.isInitialized("tests/agency-js/tool-tiers/agent.agency")) {
    return;
  }
  __ctx.globals.markInitialized("tests/agency-js/tool-tiers/agent.agency");
}
__registerGlobalsInit("tests/agency-js/tool-tiers/agent.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {
  __ctx.topLevelCallbacks = [];
}
__functionRefReviver.registry = __toolRegistry;
async function __flakyTool_impl(id) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  if (!__globals().isInitialized("tests/agency-js/tool-tiers/agent.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  __stack.args["id"] = id;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "tests/agency-js/tool-tiers/agent.agency", scopeName: "flakyTool", threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("id" in __overrides) {
      id = __overrides["id"];
      __stack.args["id"] = id;
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
            functionName: "flakyTool",
            args: {
              id
            },
            moduleId: "tests/agency-js/tool-tiers/agent.agency"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        __functionCompleted = true;
        runner2.halt(await __call(flaky, {
          type: "positional",
          args: [__stack.args.id]
        }));
        return;
      });
    });
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __self.__destructiveRan);
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error;
    }
    if (__error instanceof AgencyAbort) {
      throw __error;
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function flakyTool threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "flakyTool",
        retryable: false
      });
    }
    return failure(
      __error instanceof Error ? __error.message : String(__error),
      {
        checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
        retryable: false,
        destructiveRan: __self.__destructiveRan,
        functionName: "flakyTool",
        args: __stack.args
      }
    );
  } finally {
    __stateStack()?.pop();
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "flakyTool",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const flakyTool = __AgencyFunction.create({
  name: "flakyTool",
  module: "tests/agency-js/tool-tiers/agent.agency",
  fn: __flakyTool_impl,
  params: [{
    name: "id",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "flakyTool",
    description: "No description provided.",
    schema: z.object({ "id": z.string() })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __destructiveTool_impl(id) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  if (!__globals().isInitialized("tests/agency-js/tool-tiers/agent.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  __stack.args["id"] = id;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "tests/agency-js/tool-tiers/agent.agency", scopeName: "destructiveTool", threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("id" in __overrides) {
      id = __overrides["id"];
      __stack.args["id"] = id;
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
            functionName: "destructiveTool",
            args: {
              id
            },
            moduleId: "tests/agency-js/tool-tiers/agent.agency"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        __self.__destructiveRan = true;
        __functionCompleted = true;
        runner2.halt(await __call(boom, {
          type: "positional",
          args: [__stack.args.id]
        }));
        return;
      });
    });
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __self.__destructiveRan);
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error;
    }
    if (__error instanceof AgencyAbort) {
      throw __error;
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function destructiveTool threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "destructiveTool",
        retryable: false
      });
    }
    return failure(
      __error instanceof Error ? __error.message : String(__error),
      {
        checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
        retryable: false,
        destructiveRan: __self.__destructiveRan,
        functionName: "destructiveTool",
        args: __stack.args
      }
    );
  } finally {
    __stateStack()?.pop();
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "destructiveTool",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const destructiveTool = __AgencyFunction.create({
  name: "destructiveTool",
  module: "tests/agency-js/tool-tiers/agent.agency",
  fn: __destructiveTool_impl,
  params: [{
    name: "id",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "destructiveTool",
    description: "No description provided.",
    schema: z.object({ "id": z.string() })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __resetTool_impl() {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  if (!__globals().isInitialized("tests/agency-js/tool-tiers/agent.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "tests/agency-js/tool-tiers/agent.agency", scopeName: "resetTool", threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
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
            functionName: "resetTool",
            args: {},
            moduleId: "tests/agency-js/tool-tiers/agent.agency"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        __functionCompleted = true;
        runner2.halt(await __call(resetCounters, {
          type: "positional",
          args: []
        }));
        return;
      });
    });
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __self.__destructiveRan);
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error;
    }
    if (__error instanceof AgencyAbort) {
      throw __error;
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function resetTool threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "resetTool",
        retryable: false
      });
    }
    return failure(
      __error instanceof Error ? __error.message : String(__error),
      {
        checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
        retryable: false,
        destructiveRan: __self.__destructiveRan,
        functionName: "resetTool",
        args: __stack.args
      }
    );
  } finally {
    __stateStack()?.pop();
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "resetTool",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const resetTool = __AgencyFunction.create({
  name: "resetTool",
  module: "tests/agency-js/tool-tiers/agent.agency",
  fn: __resetTool_impl,
  params: [],
  toolDefinition: {
    name: "resetTool",
    description: "No description provided.",
    schema: z.object({})
  },
  safe: false,
  exported: false
}, __toolRegistry);
graph.node("neutralStaysCallable", async (__state) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "tests/agency-js/tool-tiers/agent.agency", scopeName: "neutralStaysCallable", threads: __setupData.threads });
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
            nodeName: "neutralStaysCallable"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        const __funcResult = await __call(resetTool, {
          type: "positional",
          args: []
        });
        if (hasInterrupts(__funcResult)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt({
            ...__state,
            data: __funcResult
          });
          return;
        }
      });
      await runner.step(2, async (runner2) => {
        __self.__removedTools = __self.__removedTools || [];
        __stack.locals.result = await runPrompt({
          prompt: `Use flakyTool on 'a'; if it errors, call it again.`,
          messages: __threads().getOrCreateActive(),
          clientConfig: {
            "tools": [flakyTool]
          },
          maxToolCallRounds: 10,
          removedTools: __self.__removedTools,
          checkpointInfo: runner2.getCheckpointInfo()
        });
        if (hasInterrupts(__stack.locals.result)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt({
            messages: __threads(),
            data: __stack.locals.result
          });
          return;
        }
      });
      await runner.step(3, async (runner2) => {
        runner2.halt({
          messages: __threads(),
          data: __stack.locals.result
        });
        return;
      });
    });
    if (runner.halted) return runner.haltResult;
    await runner.hook(4, async () => {
      await callHook({
        name: "onNodeEnd",
        data: {
          nodeName: "neutralStaysCallable",
          data: void 0
        }
      });
    });
    return {
      messages: __threads(),
      data: void 0
    };
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error;
    }
    if (__error instanceof AgencyAbort) {
      throw __error;
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error(`Node neutralStaysCallable crashed: ${__errMsg}`);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "neutralStaysCallable"
      });
    }
    return {
      messages: __threads(),
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "neutralStaysCallable" })
    };
  }
});
graph.node("destructiveRemoved", async (__state) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "tests/agency-js/tool-tiers/agent.agency", scopeName: "destructiveRemoved", threads: __setupData.threads });
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
            nodeName: "destructiveRemoved"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        __self.__removedTools = __self.__removedTools || [];
        __stack.locals.result = await runPrompt({
          prompt: `Use destructiveTool on 'b'.`,
          messages: __threads().getOrCreateActive(),
          clientConfig: {
            "tools": [destructiveTool]
          },
          maxToolCallRounds: 10,
          removedTools: __self.__removedTools,
          checkpointInfo: runner2.getCheckpointInfo()
        });
        if (hasInterrupts(__stack.locals.result)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt({
            messages: __threads(),
            data: __stack.locals.result
          });
          return;
        }
      });
      await runner.step(2, async (runner2) => {
        runner2.halt({
          messages: __threads(),
          data: __stack.locals.result
        });
        return;
      });
    });
    if (runner.halted) return runner.haltResult;
    await runner.hook(3, async () => {
      await callHook({
        name: "onNodeEnd",
        data: {
          nodeName: "destructiveRemoved",
          data: void 0
        }
      });
    });
    return {
      messages: __threads(),
      data: void 0
    };
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error;
    }
    if (__error instanceof AgencyAbort) {
      throw __error;
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error(`Node destructiveRemoved crashed: ${__errMsg}`);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "destructiveRemoved"
      });
    }
    return {
      messages: __threads(),
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "destructiveRemoved" })
    };
  }
});
async function neutralStaysCallable({ messages, callbacks } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "neutralStaysCallable",
    data: {},
    messages,
    callbacks,
    initializeGlobals: __initializeGlobals,
    registerTopLevelCallbacks: __registerTopLevelCallbacks,
    moduleDir: __dirname
  });
}
const __neutralStaysCallableNodeParams = [];
async function destructiveRemoved({ messages, callbacks } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "destructiveRemoved",
    data: {},
    messages,
    callbacks,
    initializeGlobals: __initializeGlobals,
    registerTopLevelCallbacks: __registerTopLevelCallbacks,
    moduleDir: __dirname
  });
}
const __destructiveRemovedNodeParams = [];
var stdin_default = graph;
const __sourceMap = { "tests/agency-js/tool-tiers/agent.agency:flakyTool": { "1": { "line": 5, "col": 2 } }, "tests/agency-js/tool-tiers/agent.agency:destructiveTool": { "1": { "line": 11, "col": 2 } }, "tests/agency-js/tool-tiers/agent.agency:resetTool": { "1": { "line": 15, "col": 2 } }, "tests/agency-js/tool-tiers/agent.agency:neutralStaysCallable": { "1": { "line": 21, "col": 2 }, "2": { "line": 22, "col": 2 }, "3": { "line": 23, "col": 2 } }, "tests/agency-js/tool-tiers/agent.agency:destructiveRemoved": { "1": { "line": 28, "col": 2 }, "2": { "line": 29, "col": 2 } } };
export {
  __destructiveRemovedNodeParams,
  __getCheckpoints,
  __invokeFunction,
  __neutralStaysCallableNodeParams,
  __setDebugger,
  __setLLMClient,
  __setTraceFile,
  __sourceMap,
  __toolRegistry,
  approve,
  stdin_default as default,
  destructiveRemoved,
  destructiveTool,
  flakyTool,
  hasInterrupts,
  interrupt,
  isDebugger,
  isInterrupt,
  neutralStaysCallable,
  reject,
  resetTool,
  respondToInterrupts,
  rewindFrom
};
