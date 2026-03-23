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
  __ctx.globals.markInitialized("interrupt-in-node.agency")
}
export const __greetTool = {
  name: "greet",
  description: `No description provided.`,
  schema: z.object({"name": z.string(), "age": z.number(), })
};
export const __greetToolParams = ["name", "age"];
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
  if (!__ctx.globals.isInitialized("interrupt-in-node.agency")) {
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

// Check for a direct interruptResponse (single interrupt) or a batch response keyed by interrupt_id
const __ir = __state.interruptData?.interruptResponse || (__ctx.__interruptResponses && __stack.locals.__interruptId ? __ctx.__interruptResponses[__stack.locals.__interruptId] : undefined);
if (__ir?.type === "approve") {
  // approved, clear interrupt response and continue execution
  if (__state.interruptData) __state.interruptData.interruptResponse = null;
  delete __ctx.__interruptResponses?.[__stack.locals.__interruptId];
} else if (__ir?.type === "reject" && !__state.isToolCall) {
  // rejected, clear interrupt response and return early
  // tool calls will instead tell the llm that the call was rejected
  if (__state.interruptData) __state.interruptData.interruptResponse = null;
  delete __ctx.__interruptResponses?.[__stack.locals.__interruptId];
  
  
  return null;
  
} else if (__ir?.type === "modify") {
  if (__state.isToolCall) {
    // continue, args will get modified in the tool call handler
  } else {
    throw new Error("Interrupt response of type 'modify' is not supported outside of tool calls yet.");
  }
} else if (__ir?.type === "resolve") {
  console.log(JSON.stringify(__state.interruptData, null, 2));
  throw new Error("Interrupt response of type 'resolve' cannot be returned from an interrupt call. It can only be assigned to a variable.");
  const __resolvedValue = __ir.value;
  
  
  return __resolvedValue;
  
} else {
  const __interruptResult = interrupt(`Agent wants to call the greet function with name: ${__stack.args.name} and age: ${__stack.args.age}`);
  __stack.locals.__interruptId = __interruptResult.interrupt_id;
  const __checkpointId = __ctx.checkpoints.create(__ctx);
  __interruptResult.checkpointId = __checkpointId;
  __interruptResult.checkpoint = __ctx.checkpoints.get(__checkpointId);
  
  
  return __interruptResult;
  
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


graph.node("foo2", async (__state: GraphState) => {
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
      nodeName: "foo2"
    }
  })
  if (!__state.isResume) {
    __stack.args["name"] = __state.data.name;
    __stack.args["age"] = __state.data.age;
  }
  if (__step <= 0) {

    __stack.step++;
  }
  if (__step <= 1) {
    __self.__retryable = false;
    await print(`In foo2, name is ${__stack.args.name} and age is ${__stack.args.age}, this message should only print once...`)
    
    
    __stack.step++;
  }
  if (__step <= 2) {
    __self.__removedTools = __self.__removedTools || [];
__stack.locals.response = await runPrompt({
      ctx: __ctx,
      prompt: `Greet the user with their name: ${__stack.args.name} and age ${__stack.args.age} using the greet function.`,
      messages: __threads.createAndReturnThread(),
      clientConfig: {
        tools: [tool("greet")],
        ...{}
      },
      maxToolCallRounds: 10,
      interruptData: __state?.interruptData,
      removedTools: __self.__removedTools
    });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.response)) {
      await __ctx.pendingPromises.awaitAll()
      return {
        messages: __threads,
        data: __stack.locals.response
      };
    }
    await __ctx.audit({
      type: "assignment",
      variable: "__self.__removedTools",
      value: __self.__removedTools
    })
    
    __stack.step++;
  }
  if (__step <= 3) {
    __self.__retryable = false;
    await print(`Greeted, age is still ${__stack.args.age}...`)
    
    __stack.step++;
  }
  if (__step <= 4) {
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
      nodeName: "foo2",
      data: undefined
    }
  })
  return {
    messages: __threads,
    data: undefined
  };
})


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
    const __auditReturnValue = goToNode("foo2", {
      messages: __stack.messages,
      ctx: __ctx,
      data: {
        name: __stack.args.name,
        age: __stack.locals.age
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
      nodeName: "sayHi",
      data: undefined
    }
  })
  return {
    messages: __threads,
    data: undefined
  };
})
graph.conditionalEdge("sayHi", ["foo2"])
export async function foo2(name: string, age: number, { messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "foo2",
    data: {
      name: name,
      age: age
    },
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals
  });
}
export const __foo2NodeParams = ["name", "age"];
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