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
  __ctx.globals.markInitialized("blockParams.agency")
}
export const __mapItemsTool = {
  name: "mapItems",
  description: `No description provided.`,
  schema: z.object({"items": z.array(z.any()), "block": z.string(), })
};
export const __mapItemsToolParams = ["items", "block"];
const __toolRegistry = {
  mapItems: {
    definition: __mapItemsTool,
    handler: {
      name: "mapItems",
      params: __mapItemsToolParams,
      execute: mapItems,
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
async function mapItems(items: any[], block: (any) => any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("blockParams.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "mapItems",
      args: {
        items: items,
        block: block
      },
      isBuiltin: false
    }
  })
  __stack.args["items"] = items;
  __stack.args["block"] = block;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "blockParams.agency", scopeName: "mapItems" });
  const __resultCheckpointId = __ctx.checkpoints.createPinned(__ctx, { moduleId: "blockParams.agency", scopeName: "mapItems", stepPath: "", label: "result-entry" });
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = undefined;
    items = __overrides[0];
__stack.args["items"] = items;
    block = __overrides[1];
__stack.args["block"] = block;
  }
  try {
    await runner.step(0, async (runner) => {
__stack.locals.results = [];
    });
    await runner.step(1, async (runner) => {
await runner.loop(1, __stack.args.items, async (item, _, runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result = await block(item);
if (isInterrupt(__stack.locals.result)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.result)
            return;
          }
        });
await runner.step(1, async (runner) => {
__stack.locals.results = await append(__stack.locals.results, __stack.locals.result);
if (isInterrupt(__stack.locals.results)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.results)
            return;
          }
        });
      });
    });
    await runner.step(2, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.results)
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
          functionName: "mapItems",
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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "blockParams.agency", scopeName: "main" });
  await runner.step(0, async (runner) => {
__stack.locals.items = [1, 2, 3];
  });
  await runner.step(1, async (runner) => {
__stack.locals.doubled = await mapItems(__stack.locals.items, async (x: any) => {
      const __bsetup = setupFunction({ state: { ctx: __ctx, threads: __threads } });
const __bstack = __bsetup.stack;
const __self = __bstack.locals;

__bstack.args["x"] = x;

const runner = new Runner(__ctx, __bstack, { state: __bstack, moduleId: "blockParams.agency", scopeName: "__block_0" });
try {
await runner.step(0, async (runner) => {
runner.halt(__bstack.args.x * 2)
return;
  });
return runner.halted ? runner.haltResult : undefined;
} finally {
__ctx.stateStack.pop();
}
    }, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData
    });
if (isInterrupt(__stack.locals.doubled)) {
      await __ctx.pendingPromises.awaitAll()
      runner.halt({
        ...__state,
        data: __stack.locals.doubled
      })
      return;
    }
  });
  await runner.step(2, async (runner) => {
await print(__stack.locals.doubled)
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
export const __sourceMap = {"blockParams.agency:mapItems":{"0":{"line":-1,"col":2},"1":{"line":0,"col":2},"2":{"line":4,"col":2},"1.0":{"line":1,"col":4},"1.1":{"line":2,"col":4}},"blockParams.agency:main":{"0":{"line":8,"col":2},"1":{"line":9,"col":2},"2":{"line":12,"col":2}},"blockParams.agency:__block_0":{"1.0":{"line":10,"col":4}}};