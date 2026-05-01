import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify, range, mostCommon, keys, values, entries, emit } from "agency-lang/stdlib/index.js";
import { fileURLToPath } from "url";
import __process from "process";
import { nanoid } from "agency-lang";
import path from "path";
import {
  RuntimeContext,
  ThreadStore,
  Runner,
  setupNode,
  runNode,
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
  deepFreeze as __deepFreeze,
  failure,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  AgencyFunction as __AgencyFunction,
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
    program: "tests/typescriptGenerator/static.agency",
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
const foo = __deepFreeze(1);
async function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("tests/typescriptGenerator/static.agency");
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "tests/typescriptGenerator/static.agency",
  fn: readSkill,
  params: __readSkillToolParams.map((p) => ({ name: p, hasDefault: false, defaultValue: void 0, variadic: false })),
  toolDefinition: __readSkillTool
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
graph.node("main", async (__state) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stateStack = __state.ctx.stateStack;
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __threads = __setupData.threads;
  const __ctx = __state.ctx;
  const statelogClient = __ctx.statelogClient;
  const __graph = __ctx.graph;
  let __forked;
  let __functionCompleted = false;
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeStart",
    data: {
      nodeName: "main"
    }
  });
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "tests/typescriptGenerator/static.agency", scopeName: "main" });
  try {
    await runner.step(0, async (runner2) => {
      runner2.halt({
        messages: __threads,
        data: foo
      });
      return;
    });
    if (runner.halted) return runner.haltResult;
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onNodeEnd",
      data: {
        nodeName: "main",
        data: void 0
      }
    });
    return {
      messages: __threads,
      data: void 0
    };
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error;
    }
    console.error(`
Agent crashed: ${__error.message}`);
    console.error(__error.stack);
    return {
      messages: __threads,
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "main" })
    };
  }
});
async function main({ messages, callbacks } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "main",
    data: {},
    messages,
    callbacks,
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
    await main(initialState);
  } catch (__error) {
    console.error(`
Agent crashed: ${__error.message}`);
    throw __error;
  }
}
var stdin_default = graph;
const __sourceMap = { "tests/typescriptGenerator/static.agency:main": { "0": { "line": 2, "col": 2 } } };
export {
  __getCheckpoints,
  __mainNodeParams,
  __setDebugger,
  __setTraceWriter,
  __sourceMap,
  approve,
  stdin_default as default,
  hasInterrupts,
  interrupt,
  isDebugger,
  isInterrupt,
  main,
  readSkill,
  reject,
  respondToInterrupts,
  rewindFrom
};
