import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid, registerProvider, registerTextModel } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse, Checkpoint } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint, getCheckpoint, restore,
  interrupt, isInterrupt,
  respondToInterrupts as _respondToInterrupts,
  isInterruptBatch,
  resumeFromState as _resumeFromState,
  ToolCallError,
  RestoreSignal,
  deepClone as __deepClone,
  not, eq, neq, lt, lte, gt, gte, and, or,
  head, tail, empty,
  builtinFetch as _builtinFetch,
  builtinFetchJSON as _builtinFetchJSON,
  builtinInput as input,
  builtinRead as _builtinReadRaw,
  builtinWrite as _builtinWriteRaw,
  builtinReadImage as _builtinReadImageRaw,
  builtinSleep as sleep,
  builtinRound as round,
  printJSON,
  print,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  printTool as __printTool,
  printToolParams as __printToolParams,
  printJSONTool as __printJSONTool,
  printJSONToolParams as __printJSONToolParams,
  inputTool as __inputTool,
  inputToolParams as __inputToolParams,
  readTool as __readTool,
  readToolParams as __readToolParams,
  readImageTool as __readImageTool,
  readImageToolParams as __readImageToolParams,
  writeTool as __writeTool,
  writeToolParams as __writeToolParams,
  fetchTool as __fetchTool,
  fetchToolParams as __fetchToolParams,
  fetchJSONTool as __fetchJSONTool,
  fetchJSONToolParams as __fetchJSONToolParams,
  fetchJsonTool as __fetchJsonTool,
  fetchJsonToolParams as __fetchJsonToolParams,
  sleepTool as __sleepTool,
  sleepToolParams as __sleepToolParams,
  roundTool as __roundTool,
  roundToolParams as __roundToolParams,
  _builtinTool as __builtinTool,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = process.cwd();

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
function read(filename: string): string {
  return _builtinReadRaw({ filename, dirname: __dirname });
}
function write(filename: string, content: string): void {
  _builtinWriteRaw({ filename, content, dirname: __dirname });
}
function readImage(filename: string): string {
  return _builtinReadImageRaw({ filename, dirname: __dirname });
}
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// tool() function — looks up a tool by name from the module's __toolRegistry
function tool(__name: string) {
  return __builtinTool(__name, __toolRegistry);
}

// Interrupt re-exports bound to this module's context
export { interrupt, isInterrupt, isInterruptBatch };
export const respondToInterrupts = (batch: any, responses: Record<string, InterruptResponse>, metadata?: Record<string, any>) => _respondToInterrupts({ ctx: __globalCtx, batch, responses, metadata });
function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("multi-thread-interrupt.agency")
}
export const __aTool = {
  name: "a",
  description: `No description provided.`,
  schema: z.object({})
};
export const __aToolParams = [];
export const __bTool = {
  name: "b",
  description: `No description provided.`,
  schema: z.object({})
};
export const __bToolParams = [];
const __toolRegistry = {
  a: {
    definition: __aTool,
    handler: {
      name: "a",
      params: __aToolParams,
      execute: a,
      isBuiltin: false
    }
  },
  b: {
    definition: __bTool,
    handler: {
      name: "b",
      params: __bToolParams,
      execute: b,
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
  },
  print: {
    definition: __printTool,
    handler: {
      name: "print",
      params: __printToolParams,
      execute: print,
      isBuiltin: true
    }
  },
  printJSON: {
    definition: __printJSONTool,
    handler: {
      name: "printJSON",
      params: __printJSONToolParams,
      execute: printJSON,
      isBuiltin: true
    }
  },
  input: {
    definition: __inputTool,
    handler: {
      name: "input",
      params: __inputToolParams,
      execute: input,
      isBuiltin: true
    }
  },
  read: {
    definition: __readTool,
    handler: {
      name: "read",
      params: __readToolParams,
      execute: read,
      isBuiltin: true
    }
  },
  readImage: {
    definition: __readImageTool,
    handler: {
      name: "readImage",
      params: __readImageToolParams,
      execute: readImage,
      isBuiltin: true
    }
  },
  write: {
    definition: __writeTool,
    handler: {
      name: "write",
      params: __writeToolParams,
      execute: write,
      isBuiltin: true
    }
  },
  fetch: {
    definition: __fetchTool,
    handler: {
      name: "fetch",
      params: __fetchToolParams,
      execute: _builtinFetch,
      isBuiltin: true
    }
  },
  fetchJSON: {
    definition: __fetchJSONTool,
    handler: {
      name: "fetchJSON",
      params: __fetchJSONToolParams,
      execute: _builtinFetchJSON,
      isBuiltin: true
    }
  },
  fetchJson: {
    definition: __fetchJsonTool,
    handler: {
      name: "fetchJson",
      params: __fetchJsonToolParams,
      execute: _builtinFetchJSON,
      isBuiltin: true
    }
  },
  sleep: {
    definition: __sleepTool,
    handler: {
      name: "sleep",
      params: __sleepToolParams,
      execute: sleep,
      isBuiltin: true
    }
  },
  round: {
    definition: __roundTool,
    handler: {
      name: "round",
      params: __roundToolParams,
      execute: round,
      isBuiltin: true
    }
  }
};
export async function a(__state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("multi-thread-interrupt.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "a",
      args: {},
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "a",
    args: {},
    result: undefined
  })
  __self.__retryable = __self.__retryable ?? true;
  const __scopeMarker = __ctx.pendingPromises.scopeMarker();
  try {
    if (__step <= 0) {
      
            __stack.step++;
    }
    if (__step <= 1) {
            // Check for a batch response keyed by interrupt_id
const __interruptData = __stack.locals.__interruptId ? __ctx.getInterruptData(__stack.locals.__interruptId) : undefined;
const __ir = __interruptData?.interruptResponse;
if (__interruptData) {
  __state.interruptData = __interruptData;
}
if (__ir?.type === "resolve") {
  __stack.locals.response = __ir.value;;
} else if (__ir?.type === "approve") {
  __stack.locals.response = true;;
} else if (__ir?.type === "reject") {
  __stack.locals.response = false;;
} else if (__ir?.type === "modify") {
  throw new Error("Interrupt response of type 'modify' is used for modifying tool call args. Use resolve instead.");
} else if (!__ir) {
  const __interruptResult = interrupt(`approve a?`);
  __stack.locals.__interruptId = __interruptResult.interrupt_id;
  __stack.interrupted = true;
  
  
  return __interruptResult;
  
}

      
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
    if (!__state?.isForked && !__stack.hasChildInterrupts && !__stack.interrupted) { __setupData.stateStack.pop() }
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "a",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


export async function b(__state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("multi-thread-interrupt.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "b",
      args: {},
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "b",
    args: {},
    result: undefined
  })
  __self.__retryable = __self.__retryable ?? true;
  const __scopeMarker = __ctx.pendingPromises.scopeMarker();
  try {
    if (__step <= 0) {
      
            __stack.step++;
    }
    if (__step <= 1) {
            // Check for a batch response keyed by interrupt_id
const __interruptData = __stack.locals.__interruptId ? __ctx.getInterruptData(__stack.locals.__interruptId) : undefined;
const __ir = __interruptData?.interruptResponse;
if (__interruptData) {
  __state.interruptData = __interruptData;
}
if (__ir?.type === "resolve") {
  __stack.locals.response = __ir.value;;
} else if (__ir?.type === "approve") {
  __stack.locals.response = true;;
} else if (__ir?.type === "reject") {
  __stack.locals.response = false;;
} else if (__ir?.type === "modify") {
  throw new Error("Interrupt response of type 'modify' is used for modifying tool call args. Use resolve instead.");
} else if (!__ir) {
  const __interruptResult = interrupt(`approve b?`);
  __stack.locals.__interruptId = __interruptResult.interrupt_id;
  __stack.interrupted = true;
  
  
  return __interruptResult;
  
}

      
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
    if (!__state?.isForked && !__stack.hasChildInterrupts && !__stack.interrupted) { __setupData.stateStack.pop() }
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "b",
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
  const __scopeMarker = __ctx.pendingPromises.scopeMarker();
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
  if (__step <= 1 || (__stack.branches && __stack.branches[1])) {
          let __forked
if (__stack.branches && __stack.branches[1]) {
  __forked = __stack.branches[1].stack;
  __forked.deserializeMode();
} else {
  __forked = __ctx.forkStack();
}
__stack.branches = __stack.branches || {}
__stack.branches[1] = { stack: __forked }
__ctx.pendingPromises.add(a({
  ctx: __ctx,
  threads: new ThreadStore(),
  interruptData: __state?.interruptData,
  stateStack: __forked,
  isForked: true
}))
    
          __stack.step++;
  }
  if (__step <= 2 || (__stack.branches && __stack.branches[2])) {
          let __forked
if (__stack.branches && __stack.branches[2]) {
  __forked = __stack.branches[2].stack;
  __forked.deserializeMode();
} else {
  __forked = __ctx.forkStack();
}
__stack.branches = __stack.branches || {}
__stack.branches[2] = { stack: __forked }
__ctx.pendingPromises.add(b({
  ctx: __ctx,
  threads: new ThreadStore(),
  interruptData: __state?.interruptData,
  stateStack: __forked,
  isForked: true
}))
    
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