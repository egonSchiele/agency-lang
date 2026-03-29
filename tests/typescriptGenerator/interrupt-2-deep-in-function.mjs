import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify } from "/Users/adityabhargava/agency-lang/stdlib/index.js";
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
  interrupt, isInterrupt, isDebugger, isRejected, isApproved, interruptWithHandlers,
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
function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("interrupt-2-deep-in-function.agency")
}
export const __greetTool = {
  name: "greet",
  description: `No description provided.`,
  schema: z.object({"name": z.string(), "age": z.number(), })
};
export const __greetToolParams = ["name", "age"];
export const __foo2Tool = {
  name: "foo2",
  description: `No description provided.`,
  schema: z.object({"name": z.string(), "age": z.number(), })
};
export const __foo2ToolParams = ["name", "age"];
const __toolRegistry = {
  greet: {
    definition: __greetTool,
    handler: {
      name: "greet",
      params: __greetToolParams,
      execute: greet,
      isBuiltin: false
    }
  },
  foo2: {
    definition: __foo2Tool,
    handler: {
      name: "foo2",
      params: __foo2ToolParams,
      execute: foo2,
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


export async function greet(name: string, age: number, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("interrupt-2-deep-in-function.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "greet",
      args: {
        name: name,
        age: age
      },
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "greet",
    args: {
      name: name,
      age: age
    },
    result: undefined
  })
  __stack.args["name"] = name;
  __stack.args["age"] = age;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {
      
            __stack.step++;
    }
    if (__step <= 1) {
            // Remember this will be called both in a tool call context
// and when the user is simply calling a function.

if (__state.interruptData?.interruptResponse?.type === "approve") {
  // approved, clear interrupt response and continue execution
  __state.interruptData.interruptResponse = null;
} else if (__state.interruptData?.interruptResponse?.type === "reject" && !__state.isToolCall) {
  // rejected, clear interrupt response and return early
  // tool calls will instead tell the llm that the call was rejected
  __state.interruptData.interruptResponse = null;
  
  
  return null;
  
} else if (__state.interruptData?.interruptResponse?.type === "modify") {
  if (__state.isToolCall) {
    // continue, args will get modified in the tool call handler
  } else {
    throw new Error("Interrupt response of type 'modify' is not supported outside of tool calls yet.");
  }
} else if (__state.interruptData?.interruptResponse?.type === "resolve") {
  console.log(JSON.stringify(__state.interruptData, null, 2));
  throw new Error("Interrupt response of type 'resolve' cannot be returned from an interrupt call. It can only be assigned to a variable.");
  const __resolvedValue = __state.interruptData.interruptResponse.value;
  
  
  return __resolvedValue;
  
} else {
  const __handlerResult = await interruptWithHandlers(`Agent wants to call the greet function with name: ${__stack.args.name} and age: ${__stack.args.age}`, __ctx);
  if (isRejected(__handlerResult)) {
    
    
    return __handlerResult.value;
    
  }
  if (!isApproved(__handlerResult)) {
    // No handler — propagate interrupt to TypeScript caller
    const __checkpointId = __ctx.checkpoints.create(__ctx);
    __handlerResult.checkpointId = __checkpointId;
    __handlerResult.checkpoint = __ctx.checkpoints.get(__checkpointId);
    
    
    return __handlerResult;
    
  }
  // Approved — continue execution past interrupt
}

            __stack.step++;
    }
    if (__step <= 2) {
            const __auditReturnValue = `Kya chal raha jai, ${__stack.args.name}! You are ${__stack.args.age} years old.`;
await __ctx.audit({
        type: "return",
        value: __auditReturnValue
      })
return __auditReturnValue
      
            __stack.step++;
    }
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
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "greet",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


export async function foo2(name: string, age: number, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("interrupt-2-deep-in-function.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "foo2",
      args: {
        name: name,
        age: age
      },
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "foo2",
    args: {
      name: name,
      age: age
    },
    result: undefined
  })
  __stack.args["name"] = name;
  __stack.args["age"] = age;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {
      
            __stack.step++;
    }
    if (__step <= 1) {
            __self.__retryable = false;
      await print(`In foo2, name is ${__stack.args.name} and age is ${__stack.args.age}, this message should only print once...`) + greet
      
            __stack.step++;
    }
    if (__step <= 2) {
            __self.__removedTools = __self.__removedTools || [];
__stack.locals.response = await runPrompt({
        ctx: __ctx,
        prompt: `Greet the user with their name: ${__stack.args.name} and age ${__stack.args.age} using the greet function.`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        interruptData: __state?.interruptData,
        removedTools: __self.__removedTools
      });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.response)) {
        await __ctx.pendingPromises.awaitAll()
        return __stack.locals.response;
      }
      await __ctx.audit({
        type: "assignment",
        variable: "__self.__removedTools",
        value: __self.__removedTools
      })
            __stack.step++;
    }
    if (__step <= 3) {
            if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx);
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "response",
          prompt: `Greet the user with their name: ${__stack.args.name} and age ${__stack.args.age} using the greet function.`,
          response: __stack.locals.response,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

            __stack.step++;
    }
    if (__step <= 4) {
            __self.__retryable = false;
      await print(`Greeted, age is still ${__stack.args.age}...`)
            __stack.step++;
    }
    if (__step <= 5) {
            const __auditReturnValue = __stack.locals.response;
await __ctx.audit({
        type: "return",
        value: __auditReturnValue
      })
return __auditReturnValue
      
            __stack.step++;
    }
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
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "foo2",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


graph.node("sayHi", async (__state: GraphState) => {
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
      nodeName: "sayHi"
    }
  })
  if (!__state.isResume) {
    __stack.args["name"] = __state.data.name;
  }
  if (__step <= 0) {
      
          __stack.step++;
  }
  if (__step <= 1) {
          __self.__retryable = false;
    await print(`Saying hi to ${__stack.args.name}...`)
          __stack.step++;
  }
  if (__step <= 2) {
          __stack.locals.age = 30;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.age",
      value: __stack.locals.age
    })
          __stack.step++;
  }
  if (__step <= 3) {
          __stack.locals.response = await foo2(__stack.args.name, __stack.locals.age, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData
    });
if (isInterrupt(__stack.locals.response)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        ...__state,
        data: __stack.locals.response
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.response",
      value: __stack.locals.response
    })
          __stack.step++;
  }
  if (__step <= 4) {
          __self.__retryable = false;
    await print(__stack.locals.response)
          __stack.step++;
  }
  if (__step <= 5) {
          __self.__retryable = false;
    await print(`Greeting sent.`)
          __stack.step++;
  }
  if (__step <= 6) {
          const __auditReturnValue = {
      messages: __threads,
      data: __stack.locals.response
    };
await __ctx.audit({
      type: "return",
      value: __auditReturnValue
    })
return __auditReturnValue;
    
          __stack.step++;
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeEnd",
    data: {
      nodeName: "sayHi",
      data: undefined
    }
  })
  return {
    messages: __threads,
    data: undefined
  };
})
export async function sayHi(name: any, { messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "sayHi",
    data: {
      name: name
    },
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals
  });
}
export const __sayHiNodeParams = ["name"];
export default graph