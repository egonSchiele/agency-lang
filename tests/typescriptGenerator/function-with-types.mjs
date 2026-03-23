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
  __ctx.globals.markInitialized("function-with-types.agency")
}
export const __addTool = {
  name: "add",
  description: `Adds two numbers together`,
  schema: z.object({"x": z.number(), "y": z.number(), })
};
export const __addToolParams = ["x", "y"];
export const __greetTool = {
  name: "greet",
  description: `Greets a person by name`,
  schema: z.object({"name": z.string(), })
};
export const __greetToolParams = ["name"];
export const __mixedTool = {
  name: "mixed",
  description: `Mixed typed and untyped parameters`,
  schema: z.object({"count": z.number(), "label": z.string(), })
};
export const __mixedToolParams = ["count", "label"];
export const __processArrayTool = {
  name: "processArray",
  description: `Processes an array of numbers`,
  schema: z.object({"items": z.array(z.number()), })
};
export const __processArrayToolParams = ["items"];
export const __flexibleTool = {
  name: "flexible",
  description: `Handles either a string or number`,
  schema: z.object({"value": z.union([z.string(), z.number()]), })
};
export const __flexibleToolParams = ["value"];
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
  mixed: {
    definition: __mixedTool,
    handler: {
      name: "mixed",
      params: __mixedToolParams,
      execute: mixed,
      isBuiltin: false
    }
  },
  processArray: {
    definition: __processArrayTool,
    handler: {
      name: "processArray",
      params: __processArrayToolParams,
      execute: processArray,
      isBuiltin: false
    }
  },
  flexible: {
    definition: __flexibleTool,
    handler: {
      name: "flexible",
      params: __flexibleToolParams,
      execute: flexible,
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
export async function add(x: number, y: number, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "add",
      args: {
        x: x,
        y: y
      },
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "add",
    args: {
      x: x,
      y: y
    },
    result: undefined
  })
  __stack.args["x"] = x;
  __stack.args["y"] = y;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
    if (__step <= 1) {
      __self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
        ctx: __ctx,
        prompt: `add ${__stack.args.x} and ${__stack.args.y}`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        interruptData: __state?.interruptData,
        removedTools: __self.__removedTools
      });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.result)) {
        await __ctx.pendingPromises.awaitAll()
        return __stack.locals.result;
      }
      await __ctx.audit({
        type: "assignment",
        variable: "__self.__removedTools",
        value: __self.__removedTools
      })
      
      __stack.step++;
    }
    if (__step <= 2) {
      const __auditReturnValue = __stack.locals.result;
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
    __setupData.stateStack.pop()
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "add",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


export async function greet(name: string, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
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
  await __ctx.audit({
    type: "functionCall",
    functionName: "greet",
    args: {
      name: name
    },
    result: undefined
  })
  __stack.args["name"] = name;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
    if (__step <= 1) {
      __self.__removedTools = __self.__removedTools || [];
__stack.locals.message = await runPrompt({
        ctx: __ctx,
        prompt: `Hello ${__stack.args.name}!`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        interruptData: __state?.interruptData,
        removedTools: __self.__removedTools
      });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.message)) {
        await __ctx.pendingPromises.awaitAll()
        return __stack.locals.message;
      }
      await __ctx.audit({
        type: "assignment",
        variable: "__self.__removedTools",
        value: __self.__removedTools
      })
      
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
    __setupData.stateStack.pop()
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


export async function mixed(count: number, label: any, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "mixed",
      args: {
        count: count,
        label: label
      },
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "mixed",
    args: {
      count: count,
      label: label
    },
    result: undefined
  })
  __stack.args["count"] = count;
  __stack.args["label"] = label;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
    if (__step <= 1) {
      __self.__removedTools = __self.__removedTools || [];
__stack.locals.output = await runPrompt({
        ctx: __ctx,
        prompt: `${__stack.args.label}: ${__stack.args.count}`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        interruptData: __state?.interruptData,
        removedTools: __self.__removedTools
      });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.output)) {
        await __ctx.pendingPromises.awaitAll()
        return __stack.locals.output;
      }
      await __ctx.audit({
        type: "assignment",
        variable: "__self.__removedTools",
        value: __self.__removedTools
      })
      
      __stack.step++;
    }
    if (__step <= 2) {
      const __auditReturnValue = __stack.locals.output;
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
    __setupData.stateStack.pop()
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "mixed",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


export async function processArray(items: number[], __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "processArray",
      args: {
        items: items
      },
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "processArray",
    args: {
      items: items
    },
    result: undefined
  })
  __stack.args["items"] = items;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
    if (__step <= 1) {
      __self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
        ctx: __ctx,
        prompt: `Processing array with ${__stack.args.items} items`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        interruptData: __state?.interruptData,
        removedTools: __self.__removedTools
      });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.result)) {
        await __ctx.pendingPromises.awaitAll()
        return __stack.locals.result;
      }
      await __ctx.audit({
        type: "assignment",
        variable: "__self.__removedTools",
        value: __self.__removedTools
      })
      
      __stack.step++;
    }
    if (__step <= 2) {
      const __auditReturnValue = __stack.locals.result;
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
    __setupData.stateStack.pop()
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "processArray",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


export async function flexible(value: string | number, __state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("function-with-types.agency")) {
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "flexible",
      args: {
        value: value
      },
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "flexible",
    args: {
      value: value
    },
    result: undefined
  })
  __stack.args["value"] = value;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
    if (__step <= 1) {
      __self.__removedTools = __self.__removedTools || [];
__stack.locals.result = await runPrompt({
        ctx: __ctx,
        prompt: `Received value: ${__stack.args.value}`,
        messages: __threads.getOrCreateActive(),
        clientConfig: {},
        maxToolCallRounds: 10,
        interruptData: __state?.interruptData,
        removedTools: __self.__removedTools
      });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.result)) {
        await __ctx.pendingPromises.awaitAll()
        return __stack.locals.result;
      }
      await __ctx.audit({
        type: "assignment",
        variable: "__self.__removedTools",
        value: __self.__removedTools
      })
      
      __stack.step++;
    }
    if (__step <= 2) {
      const __auditReturnValue = __stack.locals.result;
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
    __setupData.stateStack.pop()
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "flexible",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


graph.node("foo", async (__state: GraphState) => {
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
      nodeName: "foo"
    }
  })
  if (__step <= 0) {

    __stack.step++;
  }
  if (__step <= 1) {
    __self.__retryable = false;
    await print(`This is a node with a return type`)
    
    __stack.step++;
  }
  if (__step <= 2) {
    const __auditReturnValue = {
      messages: __threads,
      data: `Node completed`
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
      nodeName: "foo",
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
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeStart",
    data: {
      nodeName: "main"
    }
  })
  if (__step <= 0) {
    //  Call the functions
    
    __stack.step++;
  }
  if (__step <= 1) {
    __stack.locals.sum = await add(5, 10, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData
    });
if (isInterrupt(__stack.locals.sum)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        ...__state,
        data: __stack.locals.sum
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.sum",
      value: __stack.locals.sum
    })
    
    __stack.step++;
  }
  if (__step <= 2) {
    __stack.locals.greeting = await greet(`Alice`, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData
    });
if (isInterrupt(__stack.locals.greeting)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        ...__state,
        data: __stack.locals.greeting
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.greeting",
      value: __stack.locals.greeting
    })
    
    __stack.step++;
  }
  if (__step <= 3) {
    __stack.locals.labeled = await mixed(42, `Answer`, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData
    });
if (isInterrupt(__stack.locals.labeled)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        ...__state,
        data: __stack.locals.labeled
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.labeled",
      value: __stack.locals.labeled
    })
    
    __stack.step++;
  }
  if (__step <= 4) {
    __stack.locals.processed = await processArray([1, 2, 3, 4, 5], {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData
    });
if (isInterrupt(__stack.locals.processed)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        ...__state,
        data: __stack.locals.processed
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.processed",
      value: __stack.locals.processed
    })
    
    __stack.step++;
  }
  if (__step <= 5) {
    __stack.locals.flexResult = await flexible(`test`, {
      ctx: __ctx,
      threads: new ThreadStore(),
      interruptData: __state?.interruptData
    });
if (isInterrupt(__stack.locals.flexResult)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        ...__state,
        data: __stack.locals.flexResult
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.flexResult",
      value: __stack.locals.flexResult
    })
    
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
export async function foo({ messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "foo",
    data: {},
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals
  });
}
export const __fooNodeParams = [];
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