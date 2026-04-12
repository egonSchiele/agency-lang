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
  success, failure, isSuccess, isFailure, __pipeBind,
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
  __ctx.globals.markInitialized("asyncAssigned.agency")
}
export const __computeTool = {
  name: "compute",
  description: `No description provided.`,
  schema: z.object({"val": z.number(), })
};
export const __computeToolParams = ["val"];
const __toolRegistry = {
  compute: {
    definition: __computeTool,
    handler: {
      name: "compute",
      params: __computeToolParams,
      execute: compute,
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
async function compute(val: number, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("asyncAssigned.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "compute",
      args: {
        val: val
      },
      isBuiltin: false
    }
  })
  __stack.args["val"] = val;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "asyncAssigned.agency", scopeName: "compute" });
  const __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "asyncAssigned.agency", scopeName: "compute", stepPath: "", label: "result-entry" });
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = undefined;
    val = __overrides[0];
__stack.args["val"] = val;
  }
  try {
    await runner.step(0, async (runner) => {
await sleep(0.1)
    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.args.val * 2)
return;
    });
    if (runner.halted) return runner.haltResult;
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    if (__error instanceof ToolCallError) {
      __error.retryable = __error.retryable && __self.__retryable
      throw __error
    }
    return failure(__error instanceof Error ? __error.message : String(__error), __ctx.checkpoints.get(__resultCheckpointId));
  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "compute",
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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "asyncAssigned.agency", scopeName: "main" });
  await runner.branchStep(0, "0", async (runner) => {
if ((__stack.branches && __stack.branches["0"])) {
      __forked = __stack.branches["0"].stack;
      __forked.deserializeMode()
    } else {
      __forked = __ctx.forkStack();
    }
__stack.branches = (__stack.branches || {});
__stack.branches["0"] = {
      stack: __forked
    };
__stack.locals.x = compute(5, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData,
      stateStack: __forked,
      isForked: true
    });
__self.__pendingKey_x = __ctx.pendingPromises.add(__stack.locals.x, (val) => { __stack.locals.x = val; });
  });
  await runner.branchStep(1, "1", async (runner) => {
if ((__stack.branches && __stack.branches["1"])) {
      __forked = __stack.branches["1"].stack;
      __forked.deserializeMode()
    } else {
      __forked = __ctx.forkStack();
    }
__stack.branches = (__stack.branches || {});
__stack.branches["1"] = {
      stack: __forked
    };
__stack.locals.y = compute(10, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData,
      stateStack: __forked,
      isForked: true
    });
__self.__pendingKey_y = __ctx.pendingPromises.add(__stack.locals.y, (val) => { __stack.locals.y = val; });
  });
  await runner.step(2, async (runner) => {
await __ctx.pendingPromises.awaitPending([__self.__pendingKey_x, __self.__pendingKey_y]);
  });
  await runner.step(3, async (runner) => {
runner.halt({
      messages: __threads,
      data: [__stack.locals.x, __stack.locals.y]
    })
return;
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
if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
export const __sourceMap = {"asyncAssigned.agency:compute":{"0":{"line":-1,"col":2},"1":{"line":0,"col":2}},"asyncAssigned.agency:main":{"0":{"line":4,"col":2},"1":{"line":5,"col":2},"3":{"line":6,"col":2}}};