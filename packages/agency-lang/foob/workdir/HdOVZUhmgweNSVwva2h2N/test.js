import { print, printJSON, input, sleep, saveDraft, _guard, _pairsOf, read, write, writeBinary, readBinary, range, callback, map, mapWithIndex, filter, exclude, find, findIndex, reduce, flatMap, every, some, count, sortBy, unique, groupBy, flatten, setAgentCwd, getAgentCwd, applyAgentCwd } from "agency-lang/stdlib/index.js";
import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync } from "fs";
import { nanoid } from "agency-lang";
import path from "path";
import {
  RuntimeContext,
  ThreadStore,
  Runner,
  setupNode,
  claimFrameForScope,
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
  resolveCliInterrupts,
  reportBudgetExceededAndExit,
  isDebugger,
  respondToInterrupts as _respondToInterrupts,
  respondToInterruptsForServe as _respondToInterruptsForServe,
  rewindFrom as _rewindFrom,
  runExportedFunction as _runExportedFunction,
  runExportedFunctionForServe as _runExportedFunctionForServe,
  runNodeForServe as _runNodeForServe,
  RestoreSignal,
  AgencyAbort,
  isAborted,
  __registerGlobalsInit,
  __registerCallbacksInit,
  failure,
  AgencyFunction as __AgencyFunction,
  __call,
  __threads,
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
    program: ".staging/foob/input-1/workdir/test.agency"
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
function pass() {
  return { type: "pass" };
}
const respondToInterrupts = (interrupts, responses, opts) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata });
const rewindFrom = (checkpoint2, overrides, opts) => _rewindFrom({ ctx: __globalCtx, checkpoint: checkpoint2, overrides, metadata: opts?.metadata });
const __invokeFunction = (fn, namedArgs) => _runExportedFunction({ ctx: __globalCtx, fn, namedArgs, initializeGlobals: __initializeGlobals });
const __invokeFunctionForServe = (fn, namedArgs, invocation) => _runExportedFunctionForServe({ ctx: __globalCtx, fn, namedArgs, invocation, initializeGlobals: __initializeGlobals });
const __invokeNodeForServe = (nodeName, data, invocation) => _runNodeForServe({ ctx: __globalCtx, nodeName, data, invocation, initializeGlobals: __initializeGlobals });
const __respondToInterruptsForServe = (interrupts, responses, opts) => _respondToInterruptsForServe({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, invocation: opts?.invocation });
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
__registerTool(saveDraft);
__registerTool(_guard);
__registerTool(_pairsOf);
__registerTool(read);
__registerTool(write);
__registerTool(writeBinary);
__registerTool(readBinary);
__registerTool(range);
__registerTool(callback);
__registerTool(map);
__registerTool(mapWithIndex);
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
__registerTool(flatten);
__registerTool(setAgentCwd);
__registerTool(getAgentCwd);
__registerTool(applyAgentCwd);
async function __initializeGlobals(__ctx) {
  if (__ctx.globals.isInitialized(".staging/foob/input-1/workdir/test.agency")) {
    return;
  }
  __ctx.globals.markInitialized(".staging/foob/input-1/workdir/test.agency");
}
__registerGlobalsInit(".staging/foob/input-1/workdir/test.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {
}
__registerCallbacksInit(".staging/foob/input-1/workdir/test.agency", __registerTopLevelCallbacks);
__functionRefReviver.registry = __toolRegistry;
graph.node("main", async (__state) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  claimFrameForScope(__stack, "main");
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: ".staging/foob/input-1/workdir/test.agency", scopeName: "main", threads: __setupData.threads });
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
        });
      });
      await runner.step(1, async (runner2) => {
        __self.__removedTools = __self.__removedTools || [];
        __stack.locals.response = await runPrompt({
          prompt: `What is Einstein's birthday?`,
          messages: __threads().getOrCreateActive(),
          clientConfig: {},
          maxToolCallRounds: 10,
          removedTools: __self.__removedTools,
          destructiveSink: __self,
          checkpointInfo: runner2.getCheckpointInfo()
        });
        if (hasInterrupts(__stack.locals.response)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt({
            messages: __threads(),
            data: __stack.locals.response
          });
          return;
        }
      });
      await runner.step(2, async (runner2) => {
        const __funcResult = await __call(print, {
          type: "positional",
          args: [__stack.locals.response]
        });
        if (hasInterrupts(__funcResult)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt({
            ...__state,
            data: __funcResult
          });
          return;
        }
        if (isAborted(__funcResult)) {
          throw __funcResult.toError();
        }
      });
      await runner.step(3, async (runner2) => {
        runner2.halt({
          messages: __threads(),
          data: __stack.locals.response
        });
        return;
      });
    });
    if (runner.halted) return runner.haltResult;
    await runner.hook(4, async () => {
      await callHook({
        name: "onNodeEnd",
        data: {
          nodeName: "main",
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
      __log.error(`Node main crashed: ${__errMsg}`);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "main"
      });
    }
    return {
      messages: __threads(),
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "main" })
    };
  }
});
async function main({ messages: __invocationMessages, callbacks: __invocationCallbacks, config: __invocationConfig, traceId: __invocationTraceId, invocationInput: __invocationInput } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "main",
    data: {},
    messages: __invocationMessages,
    callbacks: __invocationCallbacks,
    invocation: {
      config: __invocationConfig,
      traceId: __invocationTraceId
    },
    input: __invocationInput,
    initializeGlobals: __initializeGlobals
  });
}
const __mainNodeParams = [];
if (__process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const initialState = {
      messages: new ThreadStore(),
      data: {}
    };
    const __result = await main(initialState);
    await resolveCliInterrupts(__result, respondToInterrupts);
  } catch (__error) {
    reportBudgetExceededAndExit(__error);
    console.error(`
Agent crashed: ${__error.message}`);
    throw __error;
  }
}
var stdin_default = graph;
const __sourceMap = { ".staging/foob/input-1/workdir/test.agency:main": { "1": { "line": 1, "col": 2 }, "2": { "line": 2, "col": 2 }, "3": { "line": 3, "col": 2 } } };
export {
  __getCheckpoints,
  __invokeFunction,
  __invokeFunctionForServe,
  __invokeNodeForServe,
  __mainNodeParams,
  __respondToInterruptsForServe,
  __setDebugger,
  __setLLMClient,
  __setTraceFile,
  __sourceMap,
  __toolRegistry,
  approve,
  stdin_default as default,
  hasInterrupts,
  interrupt,
  isDebugger,
  isInterrupt,
  main,
  reject,
  respondToInterrupts,
  rewindFrom
};
