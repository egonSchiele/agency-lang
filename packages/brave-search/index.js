import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify, range, mostCommon, keys, values, entries, emit } from "agency-lang/stdlib/index.js";
import { braveSearch as braveSearchImpl } from "./dist/src/braveSearch.js";
import { fileURLToPath } from "url";
import __process from "process";
import { z } from "zod";
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
  functionRefReviver as __functionRefReviver
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
    program: "../brave-search/index.agency",
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
const __getCheckpoints = () => __globalCtx.checkpoints;
const __toolRegistry = {};
function __registerTool(value, name) {
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[name ?? value.name] = value;
  }
}
const checkpoint = __AgencyFunction.create({ name: "checkpoint", module: "__runtime", fn: __checkpoint_impl, params: [], toolDefinition: null }, __toolRegistry);
const getCheckpoint = __AgencyFunction.create({ name: "getCheckpoint", module: "__runtime", fn: __getCheckpoint_impl, params: [{ name: "checkpointId", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const restore = __AgencyFunction.create({ name: "restore", module: "__runtime", fn: __restore_impl, params: [{ name: "checkpointIdOrCheckpoint", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "options", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
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
  __ctx.globals.markInitialized("../brave-search/index.agency");
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "../brave-search/index.agency",
  fn: readSkill,
  params: __readSkillToolParams.map((p) => ({ name: p, hasDefault: false, defaultValue: void 0, variadic: false })),
  toolDefinition: __readSkillTool
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
async function __braveSearch_impl(query, count = __UNSET, apiKey = __UNSET, country = __UNSET, searchLang = __UNSET, safesearch = __UNSET, freshness = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../brave-search/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "braveSearch",
      args: {
        query,
        count,
        apiKey,
        country,
        searchLang,
        safesearch,
        freshness
      },
      isBuiltin: false,
      moduleId: "../brave-search/index.agency"
    }
  });
  __stack.args["query"] = query;
  __stack.args["count"] = count === __UNSET ? 5 : count;
  __stack.args["apiKey"] = apiKey === __UNSET ? `` : apiKey;
  __stack.args["country"] = country === __UNSET ? `` : country;
  __stack.args["searchLang"] = searchLang === __UNSET ? `` : searchLang;
  __stack.args["safesearch"] = safesearch === __UNSET ? `` : safesearch;
  __stack.args["freshness"] = freshness === __UNSET ? `` : freshness;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../brave-search/index.agency", scopeName: "braveSearch" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../brave-search/index.agency", scopeName: "braveSearch", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("query" in __overrides) {
      query = __overrides["query"];
      __stack.args["query"] = query;
    }
    if ("count" in __overrides) {
      count = __overrides["count"];
      __stack.args["count"] = count;
    }
    if ("apiKey" in __overrides) {
      apiKey = __overrides["apiKey"];
      __stack.args["apiKey"] = apiKey;
    }
    if ("country" in __overrides) {
      country = __overrides["country"];
      __stack.args["country"] = country;
    }
    if ("searchLang" in __overrides) {
      searchLang = __overrides["searchLang"];
      __stack.args["searchLang"] = searchLang;
    }
    if ("safesearch" in __overrides) {
      safesearch = __overrides["safesearch"];
      __stack.args["safesearch"] = safesearch;
    }
    if ("freshness" in __overrides) {
      freshness = __overrides["freshness"];
      __stack.args["freshness"] = freshness;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(braveSearchImpl, {
        type: "positional",
        args: [__stack.args.query, {
          "count": __stack.args.count,
          "apiKey": __stack.args.apiKey,
          "country": __stack.args.country,
          "searchLang": __stack.args.searchLang,
          "safesearch": __stack.args.safesearch,
          "freshness": __stack.args.freshness
        }]
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
        functionName: "braveSearch",
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
          functionName: "braveSearch",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const braveSearch = __AgencyFunction.create({
  name: "braveSearch",
  module: "../brave-search/index.agency",
  fn: __braveSearch_impl,
  params: [{
    name: "query",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "count",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "apiKey",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "country",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "searchLang",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "safesearch",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "freshness",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "braveSearch",
    description: `No description provided.`,
    schema: z.object({ "query": z.string(), "count": z.number().nullable().describe("Default: 5"), "apiKey": z.string().nullable().describe("Default: "), "country": z.string().nullable().describe("Default: "), "searchLang": z.string().nullable().describe("Default: "), "safesearch": z.string().nullable().describe("Default: "), "freshness": z.string().nullable().describe("Default: ") })
  }
}, __toolRegistry);
var stdin_default = graph;
const __sourceMap = { "../brave-search/index.agency:braveSearch": { "0": { "line": 4, "col": 2 } } };
export {
  __getCheckpoints,
  __setDebugger,
  __setTraceWriter,
  __sourceMap,
  approve,
  braveSearch,
  stdin_default as default,
  hasInterrupts,
  interrupt,
  isDebugger,
  isInterrupt,
  readSkill,
  reject,
  respondToInterrupts,
  rewindFrom
};
