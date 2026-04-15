// @ts-nocheck
import { print, __printTool, __printToolParams, printJSON, __printJSONTool, __printJSONToolParams, input, __inputTool, __inputToolParams, sleep, __sleepTool, __sleepToolParams, round, __roundTool, __roundToolParams, fetch, __fetchTool, __fetchToolParams, fetchJSON, __fetchJSONTool, __fetchJSONToolParams, read, __readTool, __readToolParams, write, __writeTool, __writeToolParams, readImage, __readImageTool, __readImageToolParams, notify, __notifyTool, __notifyToolParams, range, __rangeTool, __rangeToolParams, mostCommon, __mostCommonTool, __mostCommonToolParams } from "/Users/adityabhargava/worktrees/agency-lang/stdlib/index.js";
import { map, __mapTool, __mapToolParams, filter, __filterTool, __filterToolParams, exclude, __excludeTool, __excludeToolParams, find, __findTool, __findToolParams, findIndex, __findIndexTool, __findIndexToolParams, reduce, __reduceTool, __reduceToolParams, flatMap, __flatMapTool, __flatMapToolParams, every, __everyTool, __everyToolParams, some, __someTool, __someToolParams, count, __countTool, __countToolParams, sortBy, __sortByTool, __sortByToolParams, unique, __uniqueTool, __uniqueToolParams, groupBy, __groupByTool, __groupByToolParams } from "/Users/adityabhargava/worktrees/agency-lang/stdlib/array.js";
import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse, RewindCheckpoint } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore, Runner,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint, getCheckpoint, restore,
  interrupt, isInterrupt, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupt as _respondToInterrupt,
  approveInterrupt as _approveInterrupt,
  rejectInterrupt as _rejectInterrupt,
  resolveInterrupt as _resolveInterrupt,
  modifyInterrupt as _modifyInterrupt,
  resumeFromState as _resumeFromState,
  rewindFrom as _rewindFrom,
  RestoreSignal,
  deepClone as __deepClone,
  not, eq, neq, lt, lte, gt, gte, and, or,
  head, tail, empty,
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  _builtinTool as __builtinTool,
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
  dirname: __dirname
});
const graph = __globalCtx.graph;

// Path-dependent builtin wrappers
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// tool() function — looks up a tool by name from the module's __toolRegistry
function tool(__name: string) {
  return __builtinTool(__name, __toolRegistry);
}

// Handler result builtins
function approve(value?: any) { return { type: "approved" as const, value }; }
function reject(value?: any) { return { type: "rejected" as const, value }; }
function propagate() { return { type: "propagated" as const }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, isDebugger };
export const respondToInterrupt = (interrupt: Interrupt, response: InterruptResponse, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupt({ ctx: __globalCtx, interrupt, interruptResponse: response, overrides: opts?.overrides, metadata: opts?.metadata });
export const approveInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _approveInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const rejectInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _rejectInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const modifyInterrupt = (interrupt: Interrupt, newArguments: Record<string, any>, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _modifyInterrupt({ ctx: __globalCtx, interrupt, newArguments, overrides: opts?.overrides, metadata: opts?.metadata });
export const resolveInterrupt = (interrupt: Interrupt, value: any, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _resolveInterrupt({ ctx: __globalCtx, interrupt, value, overrides: opts?.overrides, metadata: opts?.metadata });
export const rewindFrom = (checkpoint: RewindCheckpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });

export const __setDebugger = (dbg: any) => { __globalCtx.debuggerState = dbg; };
export const __getCheckpoints = () => __globalCtx.checkpoints;
async function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("stdlib/array.agency")
}
export const __mapTool = {
  name: "map",
  description: `Map a function over an array, returning a new array of results.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __mapToolParams = ["arr", "func"];
export const __filterTool = {
  name: "filter",
  description: `Return a new array containing only the elements for which the function returns true.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __filterToolParams = ["arr", "func"];
export const __excludeTool = {
  name: "exclude",
  description: `Return a new array excluding elements for which the function returns true. Inverse of filter.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __excludeToolParams = ["arr", "func"];
export const __findTool = {
  name: "find",
  description: `Return the first element for which the function returns true, or null if none match.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __findToolParams = ["arr", "func"];
export const __findIndexTool = {
  name: "findIndex",
  description: `Return the index of the first element for which the function returns true, or -1 if none match.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __findIndexToolParams = ["arr", "func"];
export const __reduceTool = {
  name: "reduce",
  description: `Reduce an array to a single value by applying a function to an accumulator and each element.`,
  schema: z.object({"arr": z.array(z.any()), "initial": z.any(), "func": z.string(), })
};
export const __reduceToolParams = ["arr", "initial", "func"];
export const __flatMapTool = {
  name: "flatMap",
  description: `Map a function over an array and flatten the results by one level.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __flatMapToolParams = ["arr", "func"];
export const __everyTool = {
  name: "every",
  description: `Return true if the function returns true for every element in the array.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __everyToolParams = ["arr", "func"];
export const __someTool = {
  name: "some",
  description: `Return true if the function returns true for at least one element in the array.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __someToolParams = ["arr", "func"];
export const __countTool = {
  name: "count",
  description: `Count the number of elements in the array for which the function returns true.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __countToolParams = ["arr", "func"];
export const __sortByTool = {
  name: "sortBy",
  description: `Return a new array sorted by the values returned by the function, in ascending order.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __sortByToolParams = ["arr", "func"];
export const __uniqueTool = {
  name: "unique",
  description: `Return a new array with duplicate elements removed, using the function to determine the identity of each element.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __uniqueToolParams = ["arr", "func"];
export const __groupByTool = {
  name: "groupBy",
  description: `Group elements of an array by the value returned by the function. Returns an object where keys are group names and values are arrays of elements.`,
  schema: z.object({"arr": z.array(z.any()), "func": z.string(), })
};
export const __groupByToolParams = ["arr", "func"];
const __toolRegistry = {
  map: {
    definition: __mapTool,
    handler: {
      name: "map",
      params: __mapToolParams,
      execute: map,
      isBuiltin: false
    }
  },
  filter: {
    definition: __filterTool,
    handler: {
      name: "filter",
      params: __filterToolParams,
      execute: filter,
      isBuiltin: false
    }
  },
  exclude: {
    definition: __excludeTool,
    handler: {
      name: "exclude",
      params: __excludeToolParams,
      execute: exclude,
      isBuiltin: false
    }
  },
  find: {
    definition: __findTool,
    handler: {
      name: "find",
      params: __findToolParams,
      execute: find,
      isBuiltin: false
    }
  },
  findIndex: {
    definition: __findIndexTool,
    handler: {
      name: "findIndex",
      params: __findIndexToolParams,
      execute: findIndex,
      isBuiltin: false
    }
  },
  reduce: {
    definition: __reduceTool,
    handler: {
      name: "reduce",
      params: __reduceToolParams,
      execute: reduce,
      isBuiltin: false
    }
  },
  flatMap: {
    definition: __flatMapTool,
    handler: {
      name: "flatMap",
      params: __flatMapToolParams,
      execute: flatMap,
      isBuiltin: false
    }
  },
  every: {
    definition: __everyTool,
    handler: {
      name: "every",
      params: __everyToolParams,
      execute: every,
      isBuiltin: false
    }
  },
  some: {
    definition: __someTool,
    handler: {
      name: "some",
      params: __someToolParams,
      execute: some,
      isBuiltin: false
    }
  },
  count: {
    definition: __countTool,
    handler: {
      name: "count",
      params: __countToolParams,
      execute: count,
      isBuiltin: false
    }
  },
  sortBy: {
    definition: __sortByTool,
    handler: {
      name: "sortBy",
      params: __sortByToolParams,
      execute: sortBy,
      isBuiltin: false
    }
  },
  unique: {
    definition: __uniqueTool,
    handler: {
      name: "unique",
      params: __uniqueToolParams,
      execute: unique,
      isBuiltin: false
    }
  },
  groupBy: {
    definition: __groupByTool,
    handler: {
      name: "groupBy",
      params: __groupByToolParams,
      execute: groupBy,
      isBuiltin: false
    }
  },
  print: {
    definition: __printTool,
    handler: {
      name: "print",
      params: __printToolParams,
      execute: print,
      isBuiltin: false
    }
  },
  printJSON: {
    definition: __printJSONTool,
    handler: {
      name: "printJSON",
      params: __printJSONToolParams,
      execute: printJSON,
      isBuiltin: false
    }
  },
  input: {
    definition: __inputTool,
    handler: {
      name: "input",
      params: __inputToolParams,
      execute: input,
      isBuiltin: false
    }
  },
  sleep: {
    definition: __sleepTool,
    handler: {
      name: "sleep",
      params: __sleepToolParams,
      execute: sleep,
      isBuiltin: false
    }
  },
  round: {
    definition: __roundTool,
    handler: {
      name: "round",
      params: __roundToolParams,
      execute: round,
      isBuiltin: false
    }
  },
  fetch: {
    definition: __fetchTool,
    handler: {
      name: "fetch",
      params: __fetchToolParams,
      execute: fetch,
      isBuiltin: false
    }
  },
  fetchJSON: {
    definition: __fetchJSONTool,
    handler: {
      name: "fetchJSON",
      params: __fetchJSONToolParams,
      execute: fetchJSON,
      isBuiltin: false
    }
  },
  read: {
    definition: __readTool,
    handler: {
      name: "read",
      params: __readToolParams,
      execute: read,
      isBuiltin: false
    }
  },
  write: {
    definition: __writeTool,
    handler: {
      name: "write",
      params: __writeToolParams,
      execute: write,
      isBuiltin: false
    }
  },
  readImage: {
    definition: __readImageTool,
    handler: {
      name: "readImage",
      params: __readImageToolParams,
      execute: readImage,
      isBuiltin: false
    }
  },
  notify: {
    definition: __notifyTool,
    handler: {
      name: "notify",
      params: __notifyToolParams,
      execute: notify,
      isBuiltin: false
    }
  },
  range: {
    definition: __rangeTool,
    handler: {
      name: "range",
      params: __rangeToolParams,
      execute: range,
      isBuiltin: false
    }
  },
  mostCommon: {
    definition: __mostCommonTool,
    handler: {
      name: "mostCommon",
      params: __mostCommonToolParams,
      execute: mostCommon,
      isBuiltin: false
    }
  },
  readSkill: {
    definition: __readSkillTool,
    handler: {
      name: "readSkill",
      params: __readSkillToolParams,
      execute: readSkill,
      isBuiltin: true
    }
  }
};


export async function map(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "map",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "map" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "map", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.newArr = [];
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.newArr.push(await func(item))
        });
      });
    });
    await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.newArr)
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
    functionName: "map",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "map",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function filter(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "filter",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "filter" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "filter", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.result = [];
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(item),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result.push(item)
                });
    },
  },

]);
        });
      });
    });
    await runner.step(2, async (runner) => {
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
    functionName: "filter",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "filter",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function exclude(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "exclude",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "exclude" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "exclude", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.result = [];
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(item) == false,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result.push(item)
                });
    },
  },

]);
        });
      });
    });
    await runner.step(2, async (runner) => {
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
    functionName: "exclude",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "exclude",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function find(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "find",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "find" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "find", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
await runner.loop(0, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(item),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(item)
return;
                });
    },
  },

]);
        });
      });
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(null)
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
    functionName: "find",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "find",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function findIndex(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "findIndex",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "findIndex" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "findIndex", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
await runner.loop(0, __stack.args.arr, async (item, index, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(item),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(index)
return;
                });
    },
  },

]);
        });
      });
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(-1)
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
    functionName: "findIndex",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "findIndex",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function reduce(arr: any[], initial: any, func: (any, any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "reduce",
      args: {
        arr: arr,
        initial: initial,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["initial"] = initial;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "reduce" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "reduce", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("initial" in __overrides) {
    initial = __overrides["initial"];
    __stack.args["initial"] = initial;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.acc = __stack.args.initial;
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.acc = await func(__stack.locals.acc, item);
if (isInterrupt(__stack.locals.acc)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.acc)
            return;
          }
        });
      });
    });
    await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.acc)
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
    functionName: "reduce",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "reduce",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function flatMap(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "flatMap",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "flatMap" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "flatMap", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.result = [];
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.mapped = await func(item);
if (isInterrupt(__stack.locals.mapped)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.mapped)
            return;
          }
        });
await runner.step(1, async (runner) => {
await runner.loop(1, __stack.locals.mapped, async (sub, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result.push(sub)
            });
          });
        });
      });
    });
    await runner.step(2, async (runner) => {
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
    functionName: "flatMap",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "flatMap",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function every(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "every",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "every" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "every", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
await runner.loop(0, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(item) == false,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(false)
return;
                });
    },
  },

]);
        });
      });
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(true)
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
    functionName: "every",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "every",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function some(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "some",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "some" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "some", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
await runner.loop(0, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(item),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(true)
return;
                });
    },
  },

]);
        });
      });
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(false)
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
    functionName: "some",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "some",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function count(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "count",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "count" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "count", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.n = 0;
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(item),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.n = __stack.locals.n + 1;
                });
    },
  },

]);
        });
      });
    });
    await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.n)
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
    functionName: "count",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "count",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function sortBy(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "sortBy",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "sortBy" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "sortBy", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.result = [];
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result.push(item)
        });
      });
    });
    await runner.step(2, async (runner) => {
__stack.locals.i = 0;
    });
    await runner.step(3, async (runner) => {
await runner.whileLoop(3, () => __stack.locals.i < __stack.locals.result.length, async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.j = __stack.locals.i + 1;
        });
await runner.step(1, async (runner) => {
await runner.whileLoop(1, () => __stack.locals.j < __stack.locals.result.length, async (runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(__stack.locals.result[__stack.locals.j]) < await func(__stack.locals.result[__stack.locals.i]),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.temp = __stack.locals.result[__stack.locals.i];
                    });
await runner.step(1, async (runner) => {
__stack.locals.result[__stack.locals.i] = __stack.locals.result[__stack.locals.j];
                    });
await runner.step(2, async (runner) => {
__stack.locals.result[__stack.locals.j] = __stack.locals.temp;
                    });
    },
  },

]);
            });
await runner.step(1, async (runner) => {
__stack.locals.j = __stack.locals.j + 1;
            });
          });
        });
await runner.step(2, async (runner) => {
__stack.locals.i = __stack.locals.i + 1;
        });
      });
    });
    await runner.step(4, async (runner) => {
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
    functionName: "sortBy",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "sortBy",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function unique(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "unique",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "unique" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "unique", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.result = [];
    });
    await runner.step(1, async (runner) => {
__stack.locals.seen = [];
    });
    await runner.step(2, async (runner) => {
await runner.loop(2, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.key = await func(item);
if (isInterrupt(__stack.locals.key)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.key)
            return;
          }
        });
await runner.step(1, async (runner) => {
__stack.locals.found = false;
        });
await runner.step(2, async (runner) => {
await runner.loop(2, __stack.locals.seen, async (s, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => s == __stack.locals.key,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.found = true;
                    });
    },
  },

]);
            });
          });
        });
await runner.step(3, async (runner) => {
await runner.ifElse(3, [

  {
    condition: async () => __stack.locals.found == false,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result.push(item)
                });
await runner.step(1, async (runner) => {
__stack.locals.seen.push(__stack.locals.key)
                });
    },
  },

]);
        });
      });
    });
    await runner.step(3, async (runner) => {
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
    functionName: "unique",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "unique",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function groupBy(arr: any[], func: (any) => any, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("stdlib/array.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "groupBy",
      args: {
        arr: arr,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["arr"] = arr;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/array.agency", scopeName: "groupBy" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/array.agency", scopeName: "groupBy", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("arr" in __overrides) {
    arr = __overrides["arr"];
    __stack.args["arr"] = arr;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.groups = {};
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, __stack.args.arr, async (item, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.key = await func(item);
if (isInterrupt(__stack.locals.key)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.key)
            return;
          }
        });
await runner.step(1, async (runner) => {
await runner.ifElse(1, [

  {
    condition: async () => __stack.locals.groups[__stack.locals.key] == null,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.groups[__stack.locals.key] = [];
                });
    },
  },

]);
        });
await runner.step(2, async (runner) => {
__stack.locals.groups[__stack.locals.key].push(item)
        });
      });
    });
    await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.groups)
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
    functionName: "groupBy",
    args: __stack.args,
  }
);

  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "groupBy",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export default graph
export const __sourceMap = {"stdlib/array.agency:map":{"0":{"line":5,"col":2},"1":{"line":6,"col":2},"2":{"line":9,"col":2},"1.0":{"line":7,"col":4}},"stdlib/array.agency:filter":{"0":{"line":16,"col":2},"1":{"line":17,"col":2},"2":{"line":22,"col":2},"1.0.0":{"line":19,"col":6},"1.0":{"line":18,"col":4}},"stdlib/array.agency:exclude":{"0":{"line":29,"col":2},"1":{"line":30,"col":2},"2":{"line":35,"col":2},"1.0.0":{"line":32,"col":6},"1.0":{"line":31,"col":4}},"stdlib/array.agency:find":{"0":{"line":42,"col":2},"1":{"line":47,"col":2},"0.0.0":{"line":44,"col":6},"0.0":{"line":43,"col":4}},"stdlib/array.agency:findIndex":{"0":{"line":54,"col":2},"1":{"line":59,"col":2},"0.0.0":{"line":56,"col":6},"0.0":{"line":55,"col":4}},"stdlib/array.agency:reduce":{"0":{"line":66,"col":2},"1":{"line":67,"col":2},"2":{"line":70,"col":2},"1.0":{"line":68,"col":4}},"stdlib/array.agency:flatMap":{"0":{"line":77,"col":2},"1":{"line":78,"col":2},"2":{"line":84,"col":2},"1.0":{"line":79,"col":4},"1.1.0":{"line":81,"col":6},"1.1":{"line":80,"col":4}},"stdlib/array.agency:every":{"0":{"line":91,"col":2},"1":{"line":96,"col":2},"0.0.0":{"line":93,"col":6},"0.0":{"line":92,"col":4}},"stdlib/array.agency:some":{"0":{"line":103,"col":2},"1":{"line":108,"col":2},"0.0.0":{"line":105,"col":6},"0.0":{"line":104,"col":4}},"stdlib/array.agency:count":{"0":{"line":115,"col":2},"1":{"line":116,"col":2},"2":{"line":121,"col":2},"1.0.0":{"line":118,"col":6},"1.0":{"line":117,"col":4}},"stdlib/array.agency:sortBy":{"0":{"line":128,"col":2},"1":{"line":129,"col":2},"2":{"line":132,"col":2},"3":{"line":133,"col":2},"4":{"line":145,"col":2},"1.0":{"line":130,"col":4},"3.0":{"line":134,"col":4},"3.1.0.0":{"line":137,"col":8},"3.1.0.1":{"line":138,"col":8},"3.1.0.2":{"line":139,"col":8},"3.1.0":{"line":136,"col":6},"3.1.1":{"line":141,"col":6},"3.1":{"line":135,"col":4},"3.2":{"line":143,"col":4}},"stdlib/array.agency:unique":{"0":{"line":152,"col":2},"1":{"line":153,"col":2},"2":{"line":154,"col":2},"3":{"line":167,"col":2},"2.0":{"line":155,"col":4},"2.1":{"line":156,"col":4},"2.2.0.0":{"line":159,"col":8},"2.2.0":{"line":158,"col":6},"2.2":{"line":157,"col":4},"2.3.0":{"line":163,"col":6},"2.3.1":{"line":164,"col":6},"2.3":{"line":162,"col":4}},"stdlib/array.agency:groupBy":{"0":{"line":174,"col":2},"1":{"line":175,"col":2},"2":{"line":182,"col":2},"1.0":{"line":176,"col":4},"1.1.0":{"line":178,"col":6},"1.1":{"line":177,"col":4},"1.2":{"line":180,"col":4}}};