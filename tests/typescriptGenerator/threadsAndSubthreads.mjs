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
export const respondToInterrupts = (checkpoint: Checkpoint, responses: Record<string, InterruptResponse>, metadata?: Record<string, any>) => _respondToInterrupts({ ctx: __globalCtx, checkpoint, responses, metadata });
function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("threadsAndSubthreads.agency")
}
export const __fooTool = {
  name: "foo",
  description: `No description provided.`,
  schema: z.object({})
};
export const __fooToolParams = [];
const __toolRegistry = {
  foo: {
    definition: __fooTool,
    handler: {
      name: "foo",
      params: __fooToolParams,
      execute: foo,
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
export async function foo(__state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("threadsAndSubthreads.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "foo",
      args: {},
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "foo",
    args: {},
    result: undefined
  })
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
    if (__step <= 1) {
      {
const __tid = __threads.create();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res1 = await runPrompt({
  ctx: __ctx,
  prompt: `What are the first 5 prime numbers?`,
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
if (isInterrupt(__stack.locals.res1)) {
  await __ctx.pendingPromises.awaitAll()
  return __stack.locals.res1;
}

{
const __tid = __threads.createSubthread();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res2 = await runPrompt({
  ctx: __ctx,
  prompt: `What are the next 2 prime numbers after those?`,
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
if (isInterrupt(__stack.locals.res2)) {
  await __ctx.pendingPromises.awaitAll()
  return __stack.locals.res2;
}

{
const __tid = __threads.createSubthread();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res3 = await runPrompt({
  ctx: __ctx,
  prompt: `And what is the sum of all those numbers combined?`,
  messages: __threads.getOrCreateActive(),
  responseFormat: z.object({
    response: z.number()
  }),
  clientConfig: {},
  maxToolCallRounds: 10,
  interruptData: __state?.interruptData,
  removedTools: __self.__removedTools
});
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res3)) {
  await __ctx.pendingPromises.awaitAll()
  return __stack.locals.res3;
}

__threads.popActive()
}

{
const __tid = __threads.create();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res5 = await runPrompt({
  ctx: __ctx,
  prompt: `And what is the sum of all those numbers combined?`,
  messages: __threads.getOrCreateActive(),
  responseFormat: z.object({
    response: z.number()
  }),
  clientConfig: {},
  maxToolCallRounds: 10,
  interruptData: __state?.interruptData,
  removedTools: __self.__removedTools
});
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res5)) {
  await __ctx.pendingPromises.awaitAll()
  return __stack.locals.res5;
}

__threads.popActive()
}

__threads.popActive()
}

{
const __tid = __threads.createSubthread();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res4 = await runPrompt({
  ctx: __ctx,
  prompt: `And what is the sum of all those numbers combined?`,
  messages: __threads.getOrCreateActive(),
  responseFormat: z.object({
    response: z.number()
  }),
  clientConfig: {},
  maxToolCallRounds: 10,
  interruptData: __state?.interruptData,
  removedTools: __self.__removedTools
});
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res4)) {
  await __ctx.pendingPromises.awaitAll()
  return __stack.locals.res4;
}

__threads.popActive()
}

__threads.popActive()
}
      
      __stack.step++;
    }
    if (__step <= 2) {
      __self.__retryable = false;
      await print(`res1`, __stack.locals.res1)
      
      __stack.step++;
    }
    if (__step <= 3) {
      __self.__retryable = false;
      await print(`res2`, __stack.locals.res2)
      
      __stack.step++;
    }
    if (__step <= 4) {
      __self.__retryable = false;
      await print(`res3`, __stack.locals.res3)
      
      __stack.step++;
    }
    if (__step <= 5) {
      __self.__retryable = false;
      await print(`res4`, __stack.locals.res4)
      
      __stack.step++;
    }
    if (__step <= 6) {
      __self.__retryable = false;
      await print(`res5`, __stack.locals.res5)
      
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
    __ctx.stateStack.pop()
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "foo",
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
    {
const __tid = __threads.create();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res1 = await runPrompt({
  ctx: __ctx,
  prompt: `What are the first 5 prime numbers?`,
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
if (isInterrupt(__stack.locals.res1)) {
  await __ctx.pendingPromises.awaitAll()
  return {
    messages: __threads,
    data: __stack.locals.res1
  };
}

{
const __tid = __threads.createSubthread();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res2 = await runPrompt({
  ctx: __ctx,
  prompt: `What are the next 2 prime numbers after those?`,
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
if (isInterrupt(__stack.locals.res2)) {
  await __ctx.pendingPromises.awaitAll()
  return {
    messages: __threads,
    data: __stack.locals.res2
  };
}

{
const __tid = __threads.createSubthread();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res3 = await runPrompt({
  ctx: __ctx,
  prompt: `And what is the sum of all those numbers combined?`,
  messages: __threads.getOrCreateActive(),
  responseFormat: z.object({
    response: z.number()
  }),
  clientConfig: {},
  maxToolCallRounds: 10,
  interruptData: __state?.interruptData,
  removedTools: __self.__removedTools
});
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res3)) {
  await __ctx.pendingPromises.awaitAll()
  return {
    messages: __threads,
    data: __stack.locals.res3
  };
}

__threads.popActive()
}

{
const __tid = __threads.create();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res5 = await runPrompt({
  ctx: __ctx,
  prompt: `And what is the sum of all those numbers combined?`,
  messages: __threads.getOrCreateActive(),
  responseFormat: z.object({
    response: z.number()
  }),
  clientConfig: {},
  maxToolCallRounds: 10,
  interruptData: __state?.interruptData,
  removedTools: __self.__removedTools
});
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res5)) {
  await __ctx.pendingPromises.awaitAll()
  return {
    messages: __threads,
    data: __stack.locals.res5
  };
}

__threads.popActive()
}

__threads.popActive()
}

{
const __tid = __threads.createSubthread();
__threads.pushActive(__tid)
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res4 = await runPrompt({
  ctx: __ctx,
  prompt: `And what is the sum of all those numbers combined?`,
  messages: __threads.getOrCreateActive(),
  responseFormat: z.object({
    response: z.number()
  }),
  clientConfig: {},
  maxToolCallRounds: 10,
  interruptData: __state?.interruptData,
  removedTools: __self.__removedTools
});
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res4)) {
  await __ctx.pendingPromises.awaitAll()
  return {
    messages: __threads,
    data: __stack.locals.res4
  };
}

__threads.popActive()
}

__threads.popActive()
}
    
    __stack.step++;
  }
  if (__step <= 2) {
    __self.__retryable = false;
    await print(`res1`, __stack.locals.res1)
    
    __stack.step++;
  }
  if (__step <= 3) {
    __self.__retryable = false;
    await print(`res2`, __stack.locals.res2)
    
    __stack.step++;
  }
  if (__step <= 4) {
    __self.__retryable = false;
    await print(`res3`, __stack.locals.res3)
    
    __stack.step++;
  }
  if (__step <= 5) {
    __self.__retryable = false;
    await print(`res4`, __stack.locals.res4)
    
    __stack.step++;
  }
  if (__step <= 6) {
    __self.__retryable = false;
    await print(`res5`, __stack.locals.res5)
    
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