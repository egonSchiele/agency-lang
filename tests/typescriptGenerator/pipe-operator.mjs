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
  Schema, __validateType,
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
  __ctx.globals.markInitialized("pipe-operator.agency")
}
export const __doubleTool = {
  name: "double",
  description: `No description provided.`,
  schema: z.object({"x": z.number(), })
};
export const __doubleToolParams = ["x"];
export const __multiplyTool = {
  name: "multiply",
  description: `No description provided.`,
  schema: z.object({"a": z.number(), "b": z.number(), })
};
export const __multiplyToolParams = ["a", "b"];
export const __safeDivideTool = {
  name: "safeDivide",
  description: `No description provided.`,
  schema: z.object({"a": z.number(), "b": z.number(), })
};
export const __safeDivideToolParams = ["a", "b"];
const __toolRegistry = {
  double: {
    definition: __doubleTool,
    handler: {
      name: "double",
      params: __doubleToolParams,
      execute: double,
      isBuiltin: false
    }
  },
  multiply: {
    definition: __multiplyTool,
    handler: {
      name: "multiply",
      params: __multiplyToolParams,
      execute: multiply,
      isBuiltin: false
    }
  },
  safeDivide: {
    definition: __safeDivideTool,
    handler: {
      name: "safeDivide",
      params: __safeDivideToolParams,
      execute: safeDivide,
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
async function double(x: number, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("pipe-operator.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "double",
      args: {
        x: x
      },
      isBuiltin: false,
      moduleId: "pipe-operator.agency"
    }
  })
  __stack.args["x"] = x;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "pipe-operator.agency", scopeName: "double" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "pipe-operator.agency", scopeName: "double", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("x" in __overrides) {
    x = __overrides["x"];
    __stack.args["x"] = x;
  }

}

  try {
    await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.args.x * 2)
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
    functionName: "double",
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
          functionName: "double",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
async function multiply(a: number, b: number, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("pipe-operator.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "multiply",
      args: {
        a: a,
        b: b
      },
      isBuiltin: false,
      moduleId: "pipe-operator.agency"
    }
  })
  __stack.args["a"] = a;
  __stack.args["b"] = b;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "pipe-operator.agency", scopeName: "multiply" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "pipe-operator.agency", scopeName: "multiply", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("a" in __overrides) {
    a = __overrides["a"];
    __stack.args["a"] = a;
  }
  if ("b" in __overrides) {
    b = __overrides["b"];
    __stack.args["b"] = b;
  }

}

  try {
    await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.args.a * __stack.args.b)
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
    functionName: "multiply",
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
          functionName: "multiply",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
async function safeDivide(a: number, b: number, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("pipe-operator.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "safeDivide",
      args: {
        a: a,
        b: b
      },
      isBuiltin: false,
      moduleId: "pipe-operator.agency"
    }
  })
  __stack.args["a"] = a;
  __stack.args["b"] = b;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "pipe-operator.agency", scopeName: "safeDivide" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "pipe-operator.agency", scopeName: "safeDivide", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("a" in __overrides) {
    a = __overrides["a"];
    __stack.args["a"] = a;
  }
  if ("b" in __overrides) {
    b = __overrides["b"];
    __stack.args["b"] = b;
  }

}

  try {
    await runner.step(0, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => __stack.args.b === 0,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(failure(`division by zero`, { checkpoint: __ctx.getResultCheckpoint(), functionName: "safeDivide", args: __stack.args }))
return;
            });
    },
  },

]);
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(await success(__stack.args.a / __stack.args.b))
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
    functionName: "safeDivide",
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
          functionName: "safeDivide",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "pipe-operator.agency", scopeName: "main" });
  try {
    await runner.step(0, async (runner) => {
__stack.locals.__pipe_0 = await success(5);
    });
    __stack.locals.r1 = await runner.pipe(1, __stack.locals.__pipe_0, async (__pipeArg) => double(__pipeArg, {
      ctx: __ctx,
      threads: __threads,
      interruptData: __state?.interruptData
    }));
    await runner.step(2, async (runner) => {
__stack.locals.__pipe_1 = await success(5);
    });
    __stack.locals.r2 = await runner.pipe(3, __stack.locals.__pipe_1, async (__pipeArg) => multiply(10, __pipeArg, {
      ctx: __ctx,
      threads: __threads,
      interruptData: __state?.interruptData
    }));
    await runner.step(4, async (runner) => {
__stack.locals.__pipe_2 = await success(10);
    });
    __stack.locals.__pipe_2 = await runner.pipe(5, __stack.locals.__pipe_2, async (__pipeArg) => double(__pipeArg, {
      ctx: __ctx,
      threads: __threads,
      interruptData: __state?.interruptData
    }));
    __stack.locals.r3 = await runner.pipe(6, __stack.locals.__pipe_2, async (__pipeArg) => multiply(3, __pipeArg, {
      ctx: __ctx,
      threads: __threads,
      interruptData: __state?.interruptData
    }));
    await runner.step(7, async (runner) => {
__stack.locals.__pipe_3 = await failure(`nope`);
    });
    __stack.locals.r4 = await runner.pipe(8, __stack.locals.__pipe_3, async (__pipeArg) => double(__pipeArg, {
      ctx: __ctx,
      threads: __threads,
      interruptData: __state?.interruptData
    }));
    await runner.step(9, async (runner) => {
__stack.locals.__pipe_4 = await success(10);
    });
    __stack.locals.r5 = await runner.pipe(10, __stack.locals.__pipe_4, async (__pipeArg) => safeDivide(__pipeArg, 2, {
      ctx: __ctx,
      threads: __threads,
      interruptData: __state?.interruptData
    }));
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
    return {
      messages: __threads,
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "main" })
    };
  }
})
export async function main({ messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
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
export const __sourceMap = {"pipe-operator.agency:double":{"0":{"line":-2,"col":2}},"pipe-operator.agency:multiply":{"0":{"line":2,"col":2}},"pipe-operator.agency:safeDivide":{"0":{"line":6,"col":2},"1":{"line":9,"col":2},"0.0":{"line":7,"col":4}},"pipe-operator.agency:main":{"0":{"line":13,"col":2},"1":{"line":13,"col":2},"2":{"line":14,"col":2},"3":{"line":14,"col":2},"4":{"line":15,"col":2},"5":{"line":15,"col":2},"6":{"line":15,"col":2},"7":{"line":16,"col":2},"8":{"line":16,"col":2},"9":{"line":17,"col":2},"10":{"line":17,"col":2}}};