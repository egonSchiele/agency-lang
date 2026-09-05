import { print, printJSON, input, sleep, saveDraft, _guard, _pairsOf, read, write, writeBinary, readBinary, range, callback, map, mapWithIndex, filter, exclude, find, findIndex, reduce, flatMap, every, some, count, sortBy, unique, groupBy, flatten, setAgentCwd, getAgentCwd, applyAgentCwd } from "agency-lang/stdlib/index.js";
import { mcp as mcpImpl } from "./dist/src/mcp.js";
import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync } from "fs";
import { z } from "agency-lang/zod";
import { nanoid } from "agency-lang";
import path from "path";
import {
  RuntimeContext,
  Runner,
  setupFunction,
  claimFrameForScope,
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
  respondToInterruptsForServe as _respondToInterruptsForServe,
  rewindFrom as _rewindFrom,
  runExportedFunction as _runExportedFunction,
  runExportedFunctionForServe as _runExportedFunctionForServe,
  runNodeForServe as _runNodeForServe,
  RestoreSignal,
  AgencyAbort,
  AbortedResult,
  __registerGlobalsInit,
  __registerCallbacksInit,
  registerModuleFingerprint as __registerModuleFingerprint,
  failure,
  isFailure,
  stampFailureBoundary,
  AgencyFunction as __AgencyFunction,
  UNSET as __UNSET,
  __call,
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
    model: "gpt-5-mini",
    logLevel: "warn",
    statelog: {
      host: "https://statelog.adit.io",
      projectId: "smoltalk",
      apiKey: __process.env["STATELOG_SMOLTALK_API_KEY"] || "",
      traceId: nanoid()
    },
    provider: "openai-responses"
  },
  dirname: __dirname,
  logLevel: "info",
  traceConfig: {
    program: "index.agency"
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
  if (__ctx.globals.isInitialized("index.agency")) {
    return;
  }
  __ctx.globals.markInitialized("index.agency");
}
__registerGlobalsInit("index.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {
}
__registerCallbacksInit("index.agency", __registerTopLevelCallbacks);
__functionRefReviver.registry = __toolRegistry;
async function __mcp_impl(serverName, onOAuthRequired = __UNSET) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  claimFrameForScope(__stack, "mcp", "index.agency");
  if (!__globals().isInitialized("index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  __stack.args["serverName"] = serverName;
  __stack.args["onOAuthRequired"] = onOAuthRequired === __UNSET ? null : onOAuthRequired;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "index.agency", scopeName: "mcp", threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("serverName" in __overrides) {
      serverName = __overrides["serverName"];
      __stack.args["serverName"] = serverName;
    }
    if ("onOAuthRequired" in __overrides) {
      onOAuthRequired = __overrides["onOAuthRequired"];
      __stack.args["onOAuthRequired"] = onOAuthRequired;
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
            functionName: "mcp",
            args: {
              serverName,
              onOAuthRequired
            },
            moduleId: "index.agency"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        __functionCompleted = true;
        runner2.halt(await __call(mcpImpl, {
          type: "positional",
          args: [__stack.args.serverName, __stack.args.onOAuthRequired]
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
      return AbortedResult.fromError(__error, __stack, "mcp");
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function mcp threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "mcp"
      });
    }
    return failure(
      __error instanceof Error ? __error.message : String(__error),
      {
        checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
        destructiveRan: __self.__destructiveRan,
        functionName: "mcp",
        args: __stack.args
      }
    );
  } finally {
    __stateStack()?.pop();
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "mcp",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const mcp = __AgencyFunction.create({
  name: "mcp",
  module: "index.agency",
  fn: __mcp_impl,
  params: [{
    name: "serverName",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "onOAuthRequired",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "mcp",
    description: "No description provided.",
    schema: z.object({ "serverName": z.string(), "onOAuthRequired": z.string().nullable().describe("Default: null") })
  },
  exported: true
}, __toolRegistry);
var stdin_default = graph;
const __sourceMap = { "index.agency:mcp": { "1": { "line": 41, "col": 2 } } };
__registerModuleFingerprint("index.agency", "88aa10cf49ffe15275ad810b34030a3b5edbe96142467819f310bb4ef151d16b", import.meta.url);
export {
  __getCheckpoints,
  __invokeFunction,
  __invokeFunctionForServe,
  __invokeNodeForServe,
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
  mcp,
  reject,
  respondToInterrupts,
  rewindFrom
};
