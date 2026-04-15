// @ts-nocheck
import { print, __printTool, __printToolParams, printJSON, __printJSONTool, __printJSONToolParams, input, __inputTool, __inputToolParams, sleep, __sleepTool, __sleepToolParams, round, __roundTool, __roundToolParams, fetch, __fetchTool, __fetchToolParams, fetchJSON, __fetchJSONTool, __fetchJSONToolParams, read, __readTool, __readToolParams, write, __writeTool, __writeToolParams, readImage, __readImageTool, __readImageToolParams, notify, __notifyTool, __notifyToolParams, range, __rangeTool, __rangeToolParams, mostCommon, __mostCommonTool, __mostCommonToolParams } from "/Users/adityabhargava/worktrees/agency-lang/stdlib/index.js";
import { map, __mapTool, __mapToolParams, filter, __filterTool, __filterToolParams, exclude, __excludeTool, __excludeToolParams, find, __findTool, __findToolParams, findIndex, __findIndexTool, __findIndexToolParams, reduce, __reduceTool, __reduceToolParams, flatMap, __flatMapTool, __flatMapToolParams, every, __everyTool, __everyToolParams, some, __someTool, __someToolParams, count, __countTool, __countToolParams, sortBy, __sortByTool, __sortByToolParams, unique, __uniqueTool, __uniqueToolParams, groupBy, __groupByTool, __groupByToolParams } from "/Users/adityabhargava/worktrees/agency-lang/stdlib/array.js";
import { keys, __keysTool, __keysToolParams, values, __valuesTool, __valuesToolParams, entries, __entriesTool, __entriesToolParams } from "/Users/adityabhargava/worktrees/agency-lang/stdlib/object.js";
import { _keys, _values, _entries } from "./_builtins.js";
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
import { TraceWriter } from "agency-lang/runtime";
const __traceWriter = new TraceWriter("/Users/adityabhargava/worktrees/agency-lang/tests/debugger/trace-test.agencytrace", "stdlib/object.agency");
__globalCtx.traceWriter = __traceWriter;


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
  __ctx.globals.markInitialized("stdlib/object.agency")
}
export const __keysTool = {
  name: "keys",
  description: `Return an array of an object's own enumerable property names.`,
  schema: z.object({"obj": z.any(), })
};
export const __keysToolParams = ["obj"];
export const __valuesTool = {
  name: "values",
  description: `Return an array of an object's own enumerable property values.`,
  schema: z.object({"obj": z.any(), })
};
export const __valuesToolParams = ["obj"];
export const __entriesTool = {
  name: "entries",
  description: `Return an array of an object's own enumerable entries, each as { key, value }.`,
  schema: z.object({"obj": z.any(), })
};
export const __entriesToolParams = ["obj"];
export const __mapValuesTool = {
  name: "mapValues",
  description: `Return a new object with the same keys, but with each value transformed by the function. The function receives (value, key).`,
  schema: z.object({"obj": z.any(), "func": z.string(), })
};
export const __mapValuesToolParams = ["obj", "func"];
export const __mapEntriesTool = {
  name: "mapEntries",
  description: `Return a new object by applying the function to each entry. The function receives (value, key) and should return { key, value }.`,
  schema: z.object({"obj": z.any(), "func": z.string(), })
};
export const __mapEntriesToolParams = ["obj", "func"];
export const __filterEntriesTool = {
  name: "filterEntries",
  description: `Return a new object containing only the entries for which the function returns true. The function receives (value, key).`,
  schema: z.object({"obj": z.any(), "func": z.string(), })
};
export const __filterEntriesToolParams = ["obj", "func"];
export const __everyTool = {
  name: "every",
  description: `Return true if the function returns true for every entry in the object. The function receives (value, key).`,
  schema: z.object({"obj": z.any(), "func": z.string(), })
};
export const __everyToolParams = ["obj", "func"];
export const __someTool = {
  name: "some",
  description: `Return true if the function returns true for at least one entry in the object. The function receives (value, key).`,
  schema: z.object({"obj": z.any(), "func": z.string(), })
};
export const __someToolParams = ["obj", "func"];
const __toolRegistry = {
  keys: {
    definition: __keysTool,
    handler: {
      name: "keys",
      params: __keysToolParams,
      execute: keys,
      isBuiltin: false
    }
  },
  values: {
    definition: __valuesTool,
    handler: {
      name: "values",
      params: __valuesToolParams,
      execute: values,
      isBuiltin: false
    }
  },
  entries: {
    definition: __entriesTool,
    handler: {
      name: "entries",
      params: __entriesToolParams,
      execute: entries,
      isBuiltin: false
    }
  },
  mapValues: {
    definition: __mapValuesTool,
    handler: {
      name: "mapValues",
      params: __mapValuesToolParams,
      execute: mapValues,
      isBuiltin: false
    }
  },
  mapEntries: {
    definition: __mapEntriesTool,
    handler: {
      name: "mapEntries",
      params: __mapEntriesToolParams,
      execute: mapEntries,
      isBuiltin: false
    }
  },
  filterEntries: {
    definition: __filterEntriesTool,
    handler: {
      name: "filterEntries",
      params: __filterEntriesToolParams,
      execute: filterEntries,
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




export async function keys(obj: any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("stdlib/object.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "keys",
      args: {
        obj: obj
      },
      isBuiltin: false
    }
  })
  __stack.args["obj"] = obj;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/object.agency", scopeName: "keys" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/object.agency", scopeName: "keys", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("obj" in __overrides) {
    obj = __overrides["obj"];
    __stack.args["obj"] = obj;
  }

}

  try {
    await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(await _keys(__stack.args.obj))
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
    functionName: "keys",
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
          functionName: "keys",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function values(obj: any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("stdlib/object.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "values",
      args: {
        obj: obj
      },
      isBuiltin: false
    }
  })
  __stack.args["obj"] = obj;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/object.agency", scopeName: "values" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/object.agency", scopeName: "values", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("obj" in __overrides) {
    obj = __overrides["obj"];
    __stack.args["obj"] = obj;
  }

}

  try {
    await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(await _values(__stack.args.obj))
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
    functionName: "values",
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
          functionName: "values",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function entries(obj: any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("stdlib/object.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "entries",
      args: {
        obj: obj
      },
      isBuiltin: false
    }
  })
  __stack.args["obj"] = obj;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/object.agency", scopeName: "entries" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/object.agency", scopeName: "entries", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("obj" in __overrides) {
    obj = __overrides["obj"];
    __stack.args["obj"] = obj;
  }

}

  try {
    await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(await _entries(__stack.args.obj))
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
    functionName: "entries",
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
          functionName: "entries",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function mapValues(obj: any, func: (any, string) => any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("stdlib/object.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "mapValues",
      args: {
        obj: obj,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["obj"] = obj;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/object.agency", scopeName: "mapValues" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/object.agency", scopeName: "mapValues", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("obj" in __overrides) {
    obj = __overrides["obj"];
    __stack.args["obj"] = obj;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.result = {};
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, await entries(__stack.args.obj, {
        ctx: __ctx,
        threads: __threads,
        interruptData: __state?.interruptData
      }), async (entry, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result[entry.key] = await func(entry.value, entry.key);
if (isInterrupt(__stack.locals.result[entry.key])) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.result[entry.key])
            return;
          }
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
    functionName: "mapValues",
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
          functionName: "mapValues",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function mapEntries(obj: any, func: (any, string) => any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("stdlib/object.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "mapEntries",
      args: {
        obj: obj,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["obj"] = obj;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/object.agency", scopeName: "mapEntries" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/object.agency", scopeName: "mapEntries", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("obj" in __overrides) {
    obj = __overrides["obj"];
    __stack.args["obj"] = obj;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.result = {};
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, await entries(__stack.args.obj, {
        ctx: __ctx,
        threads: __threads,
        interruptData: __state?.interruptData
      }), async (entry, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.mapped = await func(entry.value, entry.key);
if (isInterrupt(__stack.locals.mapped)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.mapped)
            return;
          }
        });
await runner.step(1, async (runner) => {
__stack.locals.result[__stack.locals.mapped.key] = __stack.locals.mapped.value;
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
    functionName: "mapEntries",
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
          functionName: "mapEntries",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function filterEntries(obj: any, func: (any, string) => boolean, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("stdlib/object.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "filterEntries",
      args: {
        obj: obj,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["obj"] = obj;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/object.agency", scopeName: "filterEntries" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/object.agency", scopeName: "filterEntries", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("obj" in __overrides) {
    obj = __overrides["obj"];
    __stack.args["obj"] = obj;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
__stack.locals.result = {};
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, await entries(__stack.args.obj, {
        ctx: __ctx,
        threads: __threads,
        interruptData: __state?.interruptData
      }), async (entry, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(entry.value, entry.key),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result[entry.key] = entry.value;
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
    functionName: "filterEntries",
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
          functionName: "filterEntries",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function every(obj: any, func: (any, string) => boolean, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("stdlib/object.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "every",
      args: {
        obj: obj,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["obj"] = obj;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/object.agency", scopeName: "every" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/object.agency", scopeName: "every", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("obj" in __overrides) {
    obj = __overrides["obj"];
    __stack.args["obj"] = obj;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
await runner.loop(0, await entries(__stack.args.obj, {
        ctx: __ctx,
        threads: __threads,
        interruptData: __state?.interruptData
      }), async (entry, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(entry.value, entry.key) == false,
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
export async function some(obj: any, func: (any, string) => boolean, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("stdlib/object.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "some",
      args: {
        obj: obj,
        func: func
      },
      isBuiltin: false
    }
  })
  __stack.args["obj"] = obj;
  __stack.args["func"] = func;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "stdlib/object.agency", scopeName: "some" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "stdlib/object.agency", scopeName: "some", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("obj" in __overrides) {
    obj = __overrides["obj"];
    __stack.args["obj"] = obj;
  }
  if ("func" in __overrides) {
    func = __overrides["func"];
    __stack.args["func"] = func;
  }

}

  try {
    await runner.step(0, async (runner) => {
await runner.loop(0, await entries(__stack.args.obj, {
        ctx: __ctx,
        threads: __threads,
        interruptData: __state?.interruptData
      }), async (entry, _, runner) => {
await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => await func(entry.value, entry.key),
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
export default graph
export const __sourceMap = {"stdlib/object.agency:keys":{"0":{"line":8,"col":2}},"stdlib/object.agency:values":{"0":{"line":15,"col":2}},"stdlib/object.agency:entries":{"0":{"line":22,"col":2}},"stdlib/object.agency:mapValues":{"0":{"line":29,"col":2},"1":{"line":30,"col":2},"2":{"line":33,"col":2},"1.0":{"line":31,"col":4}},"stdlib/object.agency:mapEntries":{"0":{"line":40,"col":2},"1":{"line":41,"col":2},"2":{"line":45,"col":2},"1.0":{"line":42,"col":4},"1.1":{"line":43,"col":4}},"stdlib/object.agency:filterEntries":{"0":{"line":52,"col":2},"1":{"line":53,"col":2},"2":{"line":58,"col":2},"1.0.0":{"line":55,"col":6},"1.0":{"line":54,"col":4}},"stdlib/object.agency:every":{"0":{"line":65,"col":2},"1":{"line":70,"col":2},"0.0.0":{"line":67,"col":6},"0.0":{"line":66,"col":4}},"stdlib/object.agency:some":{"0":{"line":77,"col":2},"1":{"line":82,"col":2},"0.0.0":{"line":79,"col":6},"0.0":{"line":78,"col":4}}};