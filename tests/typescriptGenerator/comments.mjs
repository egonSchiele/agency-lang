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
  __ctx.globals.set("comments.agency", "x", 42)
  __ctx.globals.set("comments.agency", "y", `hello`)
  __ctx.globals.markInitialized("comments.agency")
}
export const __greetTool = {
  name: "greet",
  description: `No description provided.`,
  schema: z.object({})
};
export const __greetToolParams = [];
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

//  This is a single line comment at the top of the file
//  Variable assignment with comment above
//  Multiple comments
//  can be placed
//  on consecutive lines
//  Comment before function definition
export async function greet(__state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("comments.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "greet",
      args: {},
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "greet",
    args: {},
    result: undefined
  })
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {
            //  Comment inside function
            __stack.step++;
    }
    if (__step <= 1) {
            __stack.locals.message = `Hello, World!`;
      await __ctx.audit({
        type: "assignment",
        variable: "__stack.locals.message",
        value: __stack.locals.message
      })
      //  Another comment
            __stack.step++;
    }
    if (__step <= 2) {
            const __auditReturnValue = __stack.locals.message;
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
          //  Comment before function call
          __stack.step++;
  }
  if (__step <= 1) {
          __stack.locals.result = await greet({
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData
    });
if (isInterrupt(__stack.locals.result)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        ...__state,
        data: __stack.locals.result
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.result",
      value: __stack.locals.result
    })
          __stack.step++;
  }
  if (__step <= 2) {
          __self.__retryable = false;
    await print(__stack.locals.result)
    //  Testing comments in different contexts
    //  1. Before type hints
    
    
          __stack.step++;
  }
  if (__step <= 3) {
          __stack.locals.age = 25;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.age",
      value: __stack.locals.age
    })
    //  2. Before conditionals
          __stack.step++;
  }
  if (__step <= 4) {
          __stack.locals.status = `active`;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.status",
      value: __stack.locals.status
    })
          __stack.step++;
  }
  if (__step <= 5) {
          __self.__retryable = false;
    if (__stack.locals.__condbranch_5 === undefined) {

  if (__stack.locals.status === `inactive`) {
    __stack.locals.__condbranch_5 = 0;



  } else {
    __stack.locals.__condbranch_5 = -1;
  }

}
const __condbranch_5 = __stack.locals.__condbranch_5;
const __sub_5 = __stack.locals.__substep_5 ?? 0;

if (__condbranch_5 === 0) {

  if (__sub_5 <= 0) {
    await print(`Stopped`)
    __stack.locals.__substep_5 = 1;
  }


}
    
    
    //  Final comment at end of file
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