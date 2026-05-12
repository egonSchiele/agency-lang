import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify, range, mostCommon, keys, values, entries, emit } from "agency-lang/stdlib/index.js";
import { mcp as mcpImpl } from "./dist/src/mcp.js";
import { fileURLToPath } from "url";
import __process from "process";
import { z } from "agency-lang/zod";
import { nanoid } from "agency-lang";
import path from "path";
import {
  RuntimeContext,
  Runner,
  setupFunction,
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
  RestoreSignal,
  failure,
  isFailure,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  AgencyFunction as __AgencyFunction,
  UNSET as __UNSET,
  __call,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient
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
    debugMode: false
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
  traceConfig: {
    program: "../mcp/index.agency",
    traceDir: "traces"
  }
});
const graph = __globalCtx.graph;
function readSkill({ filepath }) {
  return _readSkillRaw({ filepath, dirname: __dirname });
}
function approve(value) {
  return { type: "approve", value };
}
function reject(value) {
  return { type: "reject", value };
}
function propagate() {
  return { type: "propagate" };
}
const respondToInterrupts = (interrupts, responses, opts) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata });
const rewindFrom = (checkpoint2, overrides, opts) => _rewindFrom({ ctx: __globalCtx, checkpoint: checkpoint2, overrides, metadata: opts?.metadata });
const __setDebugger = (dbg) => {
  __globalCtx.debuggerState = dbg;
};
const __setTraceWriter = (tw) => {
  __globalCtx.traceWriter = tw;
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
const __toolRegistry = {};
function __registerTool(value, name) {
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[name ?? value.name] = value;
  }
}
const checkpoint = __AgencyFunction.create({ name: "checkpoint", module: "__runtime", fn: __checkpoint_impl, params: [], toolDefinition: null }, __toolRegistry);
const getCheckpoint = __AgencyFunction.create({ name: "getCheckpoint", module: "__runtime", fn: __getCheckpoint_impl, params: [{ name: "checkpointId", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const restore = __AgencyFunction.create({ name: "restore", module: "__runtime", fn: __restore_impl, params: [{ name: "checkpointIdOrCheckpoint", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "options", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __runtime_run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "node", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "args", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "wallClock", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "memory", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "ipcPayload", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "stdout", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
function setLLMClient(client) {
  __globalCtx.setLLMClient(client);
}
function registerTools(tools) {
  for (const tool of tools) {
    if (__AgencyFunction.isAgencyFunction(tool)) {
      __toolRegistry[tool.name] = tool;
    }
  }
}
__registerTool(print);
__registerTool(printJSON);
__registerTool(input);
__registerTool(sleep);
__registerTool(round);
__registerTool(fetch);
__registerTool(fetchJSON);
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
async function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("../mcp/index.agency");
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "../mcp/index.agency",
  fn: readSkill,
  params: __readSkillToolParams.map((p) => ({ name: p, hasDefault: false, defaultValue: void 0, variadic: false })),
  toolDefinition: __readSkillTool
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
async function __mcp_impl(serverName, onOAuthRequired = __UNSET, __state = void 0) {
  const __setupData = setupFunction({
    state: __state
  });
  const __stateStack = __setupData.stateStack;
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __threads = __setupData.threads;
  const __ctx = __state?.ctx || __globalCtx;
  const statelogClient = __ctx.statelogClient;
  const __graph = __ctx.graph;
  let __forked;
  let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("../mcp/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "mcp",
      args: {
        serverName,
        onOAuthRequired
      },
      isBuiltin: false,
      moduleId: "../mcp/index.agency"
    }
  });
  __stack.args["serverName"] = serverName;
  __stack.args["onOAuthRequired"] = onOAuthRequired === __UNSET ? null : onOAuthRequired;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../mcp/index.agency", scopeName: "mcp" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../mcp/index.agency", scopeName: "mcp", stepPath: "", label: "result-entry" });
  }
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
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(mcpImpl, {
        type: "positional",
        args: [__stack.args.serverName, __stack.args.onOAuthRequired]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      }));
      return;
    });
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable;
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error;
    }
    return failure(
      __error instanceof Error ? __error.message : String(__error),
      {
        checkpoint: __ctx.getResultCheckpoint(),
        retryable: __self.__retryable,
        functionName: "mcp",
        args: __stack.args
      }
    );
  } finally {
    __stateStack.pop();
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
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
  module: "../mcp/index.agency",
  fn: __mcp_impl,
  params: [{
    name: "serverName",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "onOAuthRequired",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "mcp",
    description: `No description provided.`,
    schema: z.object({ "serverName": z.string(), "onOAuthRequired": z.string().nullable().describe("Default: null") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
var stdin_default = graph;
const __sourceMap = { "../mcp/index.agency:mcp": { "0": { "line": 41, "col": 2 } } };
export {
  __getCheckpoints,
  __setDebugger,
  __setLLMClient,
  __setTraceWriter,
  __sourceMap,
  __toolRegistry,
  approve,
  stdin_default as default,
  hasInterrupts,
  interrupt,
  isDebugger,
  isInterrupt,
  mcp,
  readSkill,
  reject,
  respondToInterrupts,
  rewindFrom
};
