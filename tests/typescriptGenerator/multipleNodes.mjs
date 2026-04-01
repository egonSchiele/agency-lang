import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify } from "/Users/adit/agency-lang/stdlib/index.js";
import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid, registerProvider, registerTextModel } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse, RewindCheckpoint } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore,
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

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, isDebugger };
export const respondToInterrupt = (interrupt: Interrupt, response: InterruptResponse, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupt({ ctx: __globalCtx, interrupt, interruptResponse: response, overrides: opts?.overrides, metadata: opts?.metadata });
export const approveInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _approveInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const rejectInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _rejectInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const modifyInterrupt = (interrupt: Interrupt, newArguments: Record<string, any>, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _modifyInterrupt({ ctx: __globalCtx, interrupt, newArguments, overrides: opts?.overrides, metadata: opts?.metadata });
export const resolveInterrupt = (interrupt: Interrupt, value: any, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _resolveInterrupt({ ctx: __globalCtx, interrupt, value, overrides: opts?.overrides, metadata: opts?.metadata });
export const rewindFrom = (checkpoint: RewindCheckpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });

export const __setDebugger = (dbg: any) => { __globalCtx.debugger = dbg; };
export const __getCheckpoints = () => __globalCtx.checkpoints;
function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("multipleNodes.agency")
}
const __toolRegistry = {
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

graph.node("greet", async (__state: GraphState) => {
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
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeStart",
    data: {
      nodeName: "greet"
    }
  })
  if (__step <= 0) {
          
    
          __stack.step++;
  }
  if (__step <= 1) {
          __self.__removedTools = __self.__removedTools || [];
__stack.locals.greeting = await runPrompt({
      ctx: __ctx,
      prompt: `say hello`,
      messages: __threads.createAndReturnThread(),
      clientConfig: {},
      maxToolCallRounds: 10,
      interruptData: __state?.interruptData,
      removedTools: __self.__removedTools
    });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.greeting)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        messages: __threads,
        data: __stack.locals.greeting
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__self.__removedTools",
      value: __self.__removedTools
    })
          __stack.step++;
  }
  if (__step <= 2) {
          if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "multipleNodes.agency", scopeName: "greet", stepPath: "2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "greeting",
          prompt: `say hello`,
          response: __stack.locals.greeting,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

          __stack.step++;
  }
  if (__step <= 3) {
          const __auditReturnValue = goToNode("processGreeting", {
      messages: __stack.messages,
      ctx: __ctx,
      data: {
        msg: __stack.locals.greeting
      }
    });
await __ctx.audit({
      type: "return",
      value: __auditReturnValue
    })
return __auditReturnValue
          __stack.step++;
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeEnd",
    data: {
      nodeName: "greet",
      data: undefined
    }
  })
  return {
    messages: __threads,
    data: undefined
  };
})
graph.node("processGreeting", async (__state: GraphState) => {
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
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeStart",
    data: {
      nodeName: "processGreeting"
    }
  })
  if (!__state.isResume) {
    __stack.args["msg"] = __state.data.msg;
  }
  if (__step <= 0) {
          
    
          __stack.step++;
  }
  if (__step <= 1) {
          __self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
      ctx: __ctx,
      prompt: `format this greeting: ${__stack.args.msg}`,
      messages: __threads.createAndReturnThread(),
      clientConfig: {},
      maxToolCallRounds: 10,
      interruptData: __state?.interruptData,
      removedTools: __self.__removedTools
    });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.result)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        messages: __threads,
        data: __stack.locals.result
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__self.__removedTools",
      value: __self.__removedTools
    })
          __stack.step++;
  }
  if (__step <= 2) {
          if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "multipleNodes.agency", scopeName: "processGreeting", stepPath: "2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "result",
          prompt: `format this greeting: ${__stack.args.msg}`,
          response: __stack.locals.result,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

          __stack.step++;
  }
  if (__step <= 3) {
          __self.__retryable = false;
    await print(__stack.locals.result)
          __stack.step++;
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeEnd",
    data: {
      nodeName: "processGreeting",
      data: undefined
    }
  })
  return {
    messages: __threads,
    data: undefined
  };
})
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
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeStart",
    data: {
      nodeName: "main"
    }
  })
  if (__step <= 0) {
      
          __stack.step++;
  }
  if (__step <= 1) {
          const __auditReturnValue = goToNode("greet", {
      messages: __stack.messages,
      ctx: __ctx,
      data: {}
    });
await __ctx.audit({
      type: "return",
      value: __auditReturnValue
    })
return __auditReturnValue
          __stack.step++;
  }
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
graph.conditionalEdge("greet", ["processGreeting"])
graph.conditionalEdge("main", ["greet"])
export async function greet({ messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "greet",
    data: {},
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals
  });
}
export const __greetNodeParams = [];
export async function processGreeting(msg: any, { messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "processGreeting",
    data: {
      msg: msg
    },
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals
  });
}
export const __processGreetingNodeParams = ["msg"];
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
export const __sourceMap = {"multipleNodes.agency:greet":{"1":{"line":2,"col":0},"3":{"line":3,"col":2}},"multipleNodes.agency:processGreeting":{"1":{"line":8,"col":0},"3":{"line":9,"col":2}},"multipleNodes.agency:main":{"1":{"line":13,"col":2}}};