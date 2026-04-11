import { fileURLToPath } from "url";
import process from "process";
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
  ToolCallError,
  RestoreSignal,
  deepClone as __deepClone,
  not, eq, neq, lt, lte, gt, gte, and, or,
  head, tail, empty,
  success, failure, isSuccess, isFailure,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  _builtinTool as __builtinTool,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = process.cwd();

const getDirname = () => __dirname;

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://agency-lang.com",
    apiKey: process.env["STATELOG_API_KEY"] || "",
    projectId: "",
    debugMode: false
  },
  smoltalkDefaults: {
    openAiApiKey: process.env["OPENAI_API_KEY"] || "",
    googleApiKey: process.env["GEMINI_API_KEY"] || "",
    model: "gpt-4o-mini",
    logLevel: "warn",
    statelog: {
      host: "https://agency-lang.com",
      projectId: "smoltalk",
      apiKey: process.env["STATELOG_SMOLTALK_API_KEY"] || "",
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
function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("docstrings.agency")
}
export const __addTool = {
  name: "add",
  description: `Add two numbers together.
  This is a simple addition function.`,
  schema: z.object({"a": z.string(), "b": z.string(), })
};
export const __addToolParams = ["a", "b"];
export const __greetTool = {
  name: "greet",
  description: `Generate a greeting message for the given name.`,
  schema: z.object({"name": z.string(), })
};
export const __greetToolParams = ["name"];
export const __calculateAreaTool = {
  name: "calculateArea",
  description: `Calculate the area of a rectangle.

  Parameters:
  - width: the width of the rectangle
  - height: the height of the rectangle

  Returns: the area as a number`,
  schema: z.object({"width": z.string(), "height": z.string(), })
};
export const __calculateAreaToolParams = ["width", "height"];
export const __processDataTool = {
  name: "processData",
  description: `Single line docstring`,
  schema: z.object({})
};
export const __processDataToolParams = [];
const __toolRegistry = {
  add: {
    definition: __addTool,
    handler: {
      name: "add",
      params: __addToolParams,
      execute: add,
      isBuiltin: false
    }
  },
  greet: {
    definition: __greetTool,
    handler: {
      name: "greet",
      params: __greetToolParams,
      execute: greet,
      isBuiltin: false
    }
  },
  calculateArea: {
    definition: __calculateAreaTool,
    handler: {
      name: "calculateArea",
      params: __calculateAreaToolParams,
      execute: calculateArea,
      isBuiltin: false
    }
  },
  processData: {
    definition: __processDataTool,
    handler: {
      name: "processData",
      params: __processDataToolParams,
      execute: processData,
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
//  Test docstrings in functions
async function add(a: any, b: any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("docstrings.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "add",
      args: {
        a: a,
        b: b
      },
      isBuiltin: false
    }
  })
  __stack.args["a"] = a;
  __stack.args["b"] = b;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "docstrings.agency", scopeName: "add" });
  try {
    if (runner.halted) return runner.haltResult;
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    if (__error instanceof ToolCallError) {
      __error.retryable = __error.retryable && __self.__retryable
      throw __error
    }
    throw new ToolCallError(__error, { retryable: __self.__retryable })
  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
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
async function greet(name: any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("docstrings.agency")) {
    __initializeGlobals(__ctx)
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
      isBuiltin: false
    }
  })
  __stack.args["name"] = name;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "docstrings.agency", scopeName: "greet" });
  try {
    if (runner.halted) return runner.haltResult;
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    if (__error instanceof ToolCallError) {
      __error.retryable = __error.retryable && __self.__retryable
      throw __error
    }
    throw new ToolCallError(__error, { retryable: __self.__retryable })
  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
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
async function calculateArea(width: any, height: any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("docstrings.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "calculateArea",
      args: {
        width: width,
        height: height
      },
      isBuiltin: false
    }
  })
  __stack.args["width"] = width;
  __stack.args["height"] = height;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "docstrings.agency", scopeName: "calculateArea" });
  try {
    if (runner.halted) return runner.haltResult;
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    if (__error instanceof ToolCallError) {
      __error.retryable = __error.retryable && __self.__retryable
      throw __error
    }
    throw new ToolCallError(__error, { retryable: __self.__retryable })
  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "calculateArea",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
async function processData(__state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("docstrings.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "processData",
      args: {},
      isBuiltin: false
    }
  })
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "docstrings.agency", scopeName: "processData" });
  try {
    if (runner.halted) return runner.haltResult;
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    if (__error instanceof ToolCallError) {
      __error.retryable = __error.retryable && __self.__retryable
      throw __error
    }
    throw new ToolCallError(__error, { retryable: __self.__retryable })
  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "processData",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export default graph
export const __sourceMap = {"docstrings.agency:add":{},"docstrings.agency:greet":{},"docstrings.agency:calculateArea":{},"docstrings.agency:processData":{}};