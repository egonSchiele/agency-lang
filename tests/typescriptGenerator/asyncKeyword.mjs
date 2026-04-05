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
  __ctx.globals.markInitialized("asyncKeyword.agency")
}
export const __openaiTool = {
  name: "openai",
  description: `No description provided.`,
  schema: z.object({"msg": z.string(), })
};
export const __openaiToolParams = ["msg"];
export const __googleTool = {
  name: "google",
  description: `No description provided.`,
  schema: z.object({"msg": z.string(), })
};
export const __googleToolParams = ["msg"];
export const __fibsTool = {
  name: "fibs",
  description: `No description provided.`,
  schema: z.object({})
};
export const __fibsToolParams = [];
const __toolRegistry = {
  openai: {
    definition: __openaiTool,
    handler: {
      name: "openai",
      params: __openaiToolParams,
      execute: openai,
      isBuiltin: false
    }
  },
  google: {
    definition: __googleTool,
    handler: {
      name: "google",
      params: __googleToolParams,
      execute: google,
      isBuiltin: false
    }
  },
  fibs: {
    definition: __fibsTool,
    handler: {
      name: "fibs",
      params: __fibsToolParams,
      execute: fibs,
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
export async function openai(msg: string, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("asyncKeyword.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "openai",
      args: {
        msg: msg
      },
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "openai",
    args: {
      msg: msg
    },
    result: undefined
  })
  __stack.args["msg"] = msg;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {
      
            __stack.step++;
    }
    if (__step <= 1) {
            __self.__removedTools = __self.__removedTools || [];
__stack.locals.response = await runPrompt({
        ctx: __ctx,
        prompt: `Respond to this user message: ${__stack.args.msg}`,
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
    if (__step <= 2) {
            if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "asyncKeyword.agency", scopeName: "openai", stepPath: "2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "response",
          prompt: `Respond to this user message: ${__stack.args.msg}`,
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
    if (__step <= 3) {
            const __auditReturnValue = `OpenAI response: ${__stack.locals.response}`;
await __ctx.audit({
        type: "return",
        value: __auditReturnValue
      })
__functionCompleted = true;
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
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "openai",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function google(msg: string, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("asyncKeyword.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "google",
      args: {
        msg: msg
      },
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "google",
    args: {
      msg: msg
    },
    result: undefined
  })
  __stack.args["msg"] = msg;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {
      
            __stack.step++;
    }
    if (__step <= 1) {
            __threads.active().setMessages([])
            __stack.step++;
    }
    if (__step <= 2) {
            __self.__removedTools = __self.__removedTools || [];
__stack.locals.response = await runPrompt({
        ctx: __ctx,
        prompt: `Respond to this user message: ${__stack.args.msg}`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {
          "model": `gemini-2.5-flash-lite`
        },
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
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "asyncKeyword.agency", scopeName: "google", stepPath: "3" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "response",
          prompt: `Respond to this user message: ${__stack.args.msg}`,
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
            const __auditReturnValue = `Google response: ${__stack.locals.response}`;
await __ctx.audit({
        type: "return",
        value: __auditReturnValue
      })
__functionCompleted = true;
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
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "google",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
export async function fibs(__state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("asyncKeyword.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "fibs",
      args: {},
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "fibs",
    args: {},
    result: undefined
  })
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {
      
            __stack.step++;
    }
    if (__step <= 1) {
            __self.__removedTools = __self.__removedTools || [];
__stack.locals.__promptVar = await runPrompt({
        ctx: __ctx,
        prompt: `Generate the first 10 Fibonacci numbers`,
        messages: __threads.getOrCreateActive(),
        responseFormat: z.object({
          response: z.array(z.number())
        }),
        clientConfig: {},
        maxToolCallRounds: 10,
        interruptData: __state?.interruptData,
        removedTools: __self.__removedTools
      });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.__promptVar)) {
        await __ctx.pendingPromises.awaitAll()
        return __stack.locals.__promptVar;
      }
__functionCompleted = true;
return __self.__promptVar
      await __ctx.audit({
        type: "assignment",
        variable: "__self.__removedTools",
        value: __self.__removedTools
      })
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
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "fibs",
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
  if (__step <= 0) {
      
          __stack.step++;
  }
  if (__step <= 1) {
          __stack.locals.msg = await input(`> `);
if (isInterrupt(__stack.locals.msg)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        ...__state,
        data: __stack.locals.msg
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.msg",
      value: __stack.locals.msg
    })
          __stack.step++;
  }
  if (__step <= 2 || (__stack.branches && __stack.branches["2"])) {
          if ((__stack.branches && __stack.branches["2"])) {
      __forked = __stack.branches["2"].stack;
      __forked.deserializeMode()
    } else {
      __forked = __ctx.forkStack();
    }
__stack.branches = (__stack.branches || {});
__stack.branches["2"] = {
      stack: __forked
    };
__stack.locals.res2 = google(__stack.locals.msg, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData,
      stateStack: __forked,
      isForked: true
    });
__self.__pendingKey_res2 = __ctx.pendingPromises.add(__stack.locals.res2, (val) => { __stack.locals.res2 = val; });
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.branches",
      value: __stack.branches
    })
          __stack.step++;
  }
  if (__step <= 3 || (__stack.branches && __stack.branches["3"])) {
          if ((__stack.branches && __stack.branches["3"])) {
      __forked = __stack.branches["3"].stack;
      __forked.deserializeMode()
    } else {
      __forked = __ctx.forkStack();
    }
__stack.branches = (__stack.branches || {});
__stack.branches["3"] = {
      stack: __forked
    };
__stack.locals.res1 = openai(__stack.locals.msg, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData,
      stateStack: __forked,
      isForked: true
    });
__self.__pendingKey_res1 = __ctx.pendingPromises.add(__stack.locals.res1, (val) => { __stack.locals.res1 = val; });
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.branches",
      value: __stack.branches
    })
          __stack.step++;
  }
  if (__step <= 4) {
          await __ctx.pendingPromises.awaitPending([__self.__pendingKey_res2, __self.__pendingKey_res1]);
          __stack.step++;
  }
  if (__step <= 5) {
          __stack.locals.results = Promise.race([__stack.locals.res1, __stack.locals.res2]);
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.results",
      value: __stack.locals.results
    })
          __stack.step++;
  }
  if (__step <= 6) {
          await printJSON(__stack.locals.results)
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
export const __sourceMap = {"asyncKeyword.agency:openai":{"1":{"line":-1,"col":2},"3":{"line":0,"col":2}},"asyncKeyword.agency:google":{"2":{"line":5,"col":2},"4":{"line":8,"col":2}},"asyncKeyword.agency:fibs":{"1":{"line":12,"col":2}},"asyncKeyword.agency:main":{"1":{"line":16,"col":2},"2":{"line":17,"col":2},"3":{"line":18,"col":2},"5":{"line":19,"col":2},"6":{"line":20,"col":2}}};