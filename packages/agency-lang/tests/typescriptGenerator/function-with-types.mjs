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
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  head, tail, empty,
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult,
  Schema, __validateType,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  AgencyFunction as __AgencyFunction, UNSET as __UNSET,
  __call, __callMethod,
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
    projectId: "",
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
    program: "function-with-types.agency"
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
export const respondToInterrupts = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata });
export const rewindFrom = (checkpoint: Checkpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });

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

async function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("function-with-types.agency")
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "function-with-types.agency",
  fn: readSkill,
  params: __readSkillToolParams.map(p => ({ name: p, hasDefault: false, defaultValue: undefined, variadic: false })),
  toolDefinition: __readSkillTool,
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
async function __add_impl(x: number, y: number, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "add",
      args: {
        x: x,
        y: y
      },
      isBuiltin: false,
      moduleId: "function-with-types.agency"
    }
  })
  __stack.args["x"] = x;
  __stack.args["y"] = y;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "add" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "function-with-types.agency", scopeName: "add", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("x" in __overrides) {
    x = __overrides["x"];
    __stack.args["x"] = x;
  }
  if ("y" in __overrides) {
    y = __overrides["y"];
    __stack.args["y"] = y;
  }

}

  try {
    await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
        ctx: __ctx,
        prompt: `add ${__stack.args.x} and ${__stack.args.y}`,
        messages: __threads.getOrCreateActive(),
        responseFormat: z.object({
          response: z.number()
        }),
        clientConfig: {},
        maxToolCallRounds: 10,
        stateStack: __stateStack,
        removedTools: __self.__removedTools,
        checkpointInfo: runner.getCheckpointInfo()
      });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.result)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__stack.locals.result)
        return;
      }
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.result)
return;
    });
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
  throw __error;
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: __ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "add",
    args: __stack.args,
  }
);

  } finally {
    __stateStack.pop()
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "add",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const add = __AgencyFunction.create({
  name: "add",
  module: "function-with-types.agency",
  fn: __add_impl,
  params: [{
    name: "x",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }, {
    name: "y",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }],
  toolDefinition: {
    name: "add",
    description: `Adds two numbers together`,
    schema: z.object({"x": z.number(), "y": z.number(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __greet_impl(name: string, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "greet",
      args: {
        name: name
      },
      isBuiltin: false,
      moduleId: "function-with-types.agency"
    }
  })
  __stack.args["name"] = name;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "greet" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "function-with-types.agency", scopeName: "greet", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("name" in __overrides) {
    name = __overrides["name"];
    __stack.args["name"] = name;
  }

}

  try {
    await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.message = await runPrompt({
        ctx: __ctx,
        prompt: `Hello ${__stack.args.name}!`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        stateStack: __stateStack,
        removedTools: __self.__removedTools,
        checkpointInfo: runner.getCheckpointInfo()
      });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.message)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__stack.locals.message)
        return;
      }
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.message)
return;
    });
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
  throw __error;
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: __ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "greet",
    args: __stack.args,
  }
);

  } finally {
    __stateStack.pop()
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "greet",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const greet = __AgencyFunction.create({
  name: "greet",
  module: "function-with-types.agency",
  fn: __greet_impl,
  params: [{
    name: "name",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }],
  toolDefinition: {
    name: "greet",
    description: `Greets a person by name`,
    schema: z.object({"name": z.string(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __mixed_impl(count: number, label: any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "mixed",
      args: {
        count: count,
        label: label
      },
      isBuiltin: false,
      moduleId: "function-with-types.agency"
    }
  })
  __stack.args["count"] = count;
  __stack.args["label"] = label;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "mixed" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "function-with-types.agency", scopeName: "mixed", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("count" in __overrides) {
    count = __overrides["count"];
    __stack.args["count"] = count;
  }
  if ("label" in __overrides) {
    label = __overrides["label"];
    __stack.args["label"] = label;
  }

}

  try {
    await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.output = await runPrompt({
        ctx: __ctx,
        prompt: `${__stack.args.label}: ${__stack.args.count}`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        stateStack: __stateStack,
        removedTools: __self.__removedTools,
        checkpointInfo: runner.getCheckpointInfo()
      });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.output)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__stack.locals.output)
        return;
      }
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.output)
return;
    });
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
  throw __error;
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: __ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "mixed",
    args: __stack.args,
  }
);

  } finally {
    __stateStack.pop()
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "mixed",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const mixed = __AgencyFunction.create({
  name: "mixed",
  module: "function-with-types.agency",
  fn: __mixed_impl,
  params: [{
    name: "count",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }, {
    name: "label",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }],
  toolDefinition: {
    name: "mixed",
    description: `Mixed typed and untyped parameters`,
    schema: z.object({"count": z.number(), "label": z.string(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __processArray_impl(items: number[], __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "processArray",
      args: {
        items: items
      },
      isBuiltin: false,
      moduleId: "function-with-types.agency"
    }
  })
  __stack.args["items"] = items;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "processArray" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "function-with-types.agency", scopeName: "processArray", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("items" in __overrides) {
    items = __overrides["items"];
    __stack.args["items"] = items;
  }

}

  try {
    await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
        ctx: __ctx,
        prompt: `Processing array with ${__stack.args.items} items`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        stateStack: __stateStack,
        removedTools: __self.__removedTools,
        checkpointInfo: runner.getCheckpointInfo()
      });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.result)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__stack.locals.result)
        return;
      }
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.result)
return;
    });
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
  throw __error;
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: __ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "processArray",
    args: __stack.args,
  }
);

  } finally {
    __stateStack.pop()
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "processArray",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const processArray = __AgencyFunction.create({
  name: "processArray",
  module: "function-with-types.agency",
  fn: __processArray_impl,
  params: [{
    name: "items",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }],
  toolDefinition: {
    name: "processArray",
    description: `Processes an array of numbers`,
    schema: z.object({"items": z.array(z.number()), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
async function __flexible_impl(value: string | number, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "flexible",
      args: {
        value: value
      },
      isBuiltin: false,
      moduleId: "function-with-types.agency"
    }
  })
  __stack.args["value"] = value;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "function-with-types.agency", scopeName: "flexible" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "function-with-types.agency", scopeName: "flexible", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("value" in __overrides) {
    value = __overrides["value"];
    __stack.args["value"] = value;
  }

}

  try {
    await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
        ctx: __ctx,
        prompt: `Received value: ${__stack.args.value}`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        stateStack: __stateStack,
        removedTools: __self.__removedTools,
        checkpointInfo: runner.getCheckpointInfo()
      });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.result)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__stack.locals.result)
        return;
      }
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.result)
return;
    });
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
  throw __error;
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: __ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "flexible",
    args: __stack.args,
  }
);

  } finally {
    __stateStack.pop()
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "flexible",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const flexible = __AgencyFunction.create({
  name: "flexible",
  module: "function-with-types.agency",
  fn: __flexible_impl,
  params: [{
    name: "value",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }],
  toolDefinition: {
    name: "flexible",
    description: `Handles either a string or number`,
    schema: z.object({"value": z.union([z.string(), z.number()]), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
graph.node("foo", async (__state: GraphState) => {
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
      nodeName: "foo"
    }
  })
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "function-with-types.agency", scopeName: "foo" });
  try {
    await runner.step(0, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`This is a node with a return type`]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __funcResult
        })
        return;
      }
    });
    await runner.step(1, async (runner) => {
runner.halt({
        messages: __threads,
        data: `Node completed`
      })
return;
    });
    if (runner.halted) return runner.haltResult;
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onNodeEnd",
      data: {
        nodeName: "foo",
        data: undefined
      }
    })
    return {
      messages: __threads,
      data: undefined
    };
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    console.error(`\nAgent crashed: ${__error.message}`)
    console.error(__error.stack)
    return {
      messages: __threads,
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "foo" })
    };
  }
})
graph.node("main", async (__state: GraphState) => {
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
  })
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "function-with-types.agency", scopeName: "main" });
  try {
    await runner.step(0, async (runner) => {
//  Call the functions
    });
    await runner.step(1, async (runner) => {
__stack.locals.sum = await __call(add, {
        type: "positional",
        args: [5, 10]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__stack.locals.sum)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __stack.locals.sum
        })
        return;
      }
    });
    await runner.step(2, async (runner) => {
__stack.locals.greeting = await __call(greet, {
        type: "positional",
        args: [`Alice`]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__stack.locals.greeting)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __stack.locals.greeting
        })
        return;
      }
    });
    await runner.step(3, async (runner) => {
__stack.locals.labeled = await __call(mixed, {
        type: "positional",
        args: [42, `Answer`]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__stack.locals.labeled)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __stack.locals.labeled
        })
        return;
      }
    });
    await runner.step(4, async (runner) => {
__stack.locals.processed = await __call(processArray, {
        type: "positional",
        args: [[1, 2, 3, 4, 5]]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__stack.locals.processed)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __stack.locals.processed
        })
        return;
      }
    });
    await runner.step(5, async (runner) => {
__stack.locals.flexResult = await __call(flexible, {
        type: "positional",
        args: [`test`]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__stack.locals.flexResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __stack.locals.flexResult
        })
        return;
      }
    });
    if (runner.halted) return runner.haltResult;
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onNodeEnd",
      data: {
        nodeName: "main",
        data: undefined
      }
    })
    return {
      messages: __threads,
      data: undefined
    };
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    console.error(`\nAgent crashed: ${__error.message}`)
    console.error(__error.stack)
    return {
      messages: __threads,
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "main" })
    };
  }
})
export async function foo({ messages, callbacks }: { messages?: any; callbacks?: any } = {}): Promise<RunNodeResult<any>> {
  return runNode({
    ctx: __globalCtx,
    nodeName: "foo",
    data: {},
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals
  });
}
export const __fooNodeParams = [];
export async function main({ messages, callbacks }: { messages?: any; callbacks?: any } = {}): Promise<RunNodeResult<any>> {
  return runNode({
    ctx: __globalCtx,
    nodeName: "main",
    data: {},
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals
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
export const __sourceMap = {"function-with-types.agency:add":{"0":{"line":4,"col":2},"1":{"line":5,"col":2}},"function-with-types.agency:greet":{"0":{"line":12,"col":2},"1":{"line":13,"col":2}},"function-with-types.agency:mixed":{"0":{"line":20,"col":2},"1":{"line":21,"col":2}},"function-with-types.agency:processArray":{"0":{"line":28,"col":2},"1":{"line":29,"col":2}},"function-with-types.agency:flexible":{"0":{"line":36,"col":2},"1":{"line":37,"col":2}},"function-with-types.agency:foo":{"0":{"line":41,"col":2},"1":{"line":42,"col":2}},"function-with-types.agency:main":{"1":{"line":47,"col":2},"2":{"line":48,"col":2},"3":{"line":49,"col":2},"4":{"line":50,"col":2},"5":{"line":51,"col":2}}};