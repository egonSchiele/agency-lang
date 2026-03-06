import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";
import {
  RuntimeContext, MessageThread, ThreadStore,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  interrupt, isInterrupt,
  respondToInterrupt as _respondToInterrupt,
  approveInterrupt as _approveInterrupt,
  rejectInterrupt as _rejectInterrupt,
  resolveInterrupt as _resolveInterrupt,
  modifyInterrupt as _modifyInterrupt,
  resumeFromState as _resumeFromState,
  deepClone as __deepClone,
  not, eq, neq, lt, lte, gt, gte, and, or,
  head, tail, empty,
  builtinFetch as _builtinFetch,
  builtinFetchJSON as _builtinFetchJSON,
  builtinInput as _builtinInput,
  builtinRead as _builtinReadRaw,
  builtinWrite as _builtinWriteRaw,
  builtinReadImage as _builtinReadImageRaw,
  builtinSleep as _builtinSleep,
  builtinRound as _builtinRound,
  printJSON as _printJSON,
  print as _print,
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
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://agency-lang.com",
    
    
    apiKey: process.env.STATELOG_API_KEY || "",
    
    projectId: "",
    debugMode: false,
  },
  smoltalkDefaults: {
    
    
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    
    
    
    googleApiKey: process.env.GEMINI_API_KEY || "",
    
    model: "gpt-4o-mini",
    logLevel: "warn",
  },
  dirname: __dirname,
});
const graph = __globalCtx.graph;

// Path-dependent builtin wrappers
function _builtinRead(filename) {
  return _builtinReadRaw({ filename, dirname: __dirname });
}
function _builtinWrite(filename, content) {
  return _builtinWriteRaw({ filename, content, dirname: __dirname });
}
function _builtinReadImage(filename) {
  return _builtinReadImageRaw({ filename, dirname: __dirname });
}
export function readSkill({filepath}) {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// Interrupt re-exports bound to this module's context
export { interrupt, isInterrupt };
export const respondToInterrupt = (i, r, m) => _respondToInterrupt({ ctx: __globalCtx, interrupt: i, interruptResponse: r, metadata: m });
export const approveInterrupt = (i, m) => _approveInterrupt({ ctx: __globalCtx, interrupt: i, metadata: m });
export const rejectInterrupt = (i, m) => _rejectInterrupt({ ctx: __globalCtx, interrupt: i, metadata: m });
export const modifyInterrupt = (i, a, m) => _modifyInterrupt({ ctx: __globalCtx, interrupt: i, newArguments: a, metadata: m });
export const resolveInterrupt = (i, v, m) => _resolveInterrupt({ ctx: __globalCtx, interrupt: i, value: v, metadata: m });
export const __greetTool = {
  name: "greet",
  description: `No description provided.`,
  schema: z.object({"name": z.string(), "age": z.number(), })
};

export const __greetToolParams = ["name","age"];
export const __foo2Tool = {
  name: "foo2",
  description: `No description provided.`,
  schema: z.object({"name": z.string(), "age": z.number(), })
};

export const __foo2ToolParams = ["name","age"];

export async function greet(name, age, __state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    const __funcStartTime = performance.now();
    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionStart", data: { functionName: "greet", args: { name, age }, isBuiltin: false } });

    // put all args on the state stack
    __stack.args["name"] = name;
    __stack.args["age"] = age;

    
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
  
  
  __ctx.stateStack.pop();
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
  
  
  __ctx.stateStack.pop();
  return __resolvedValue;
  
} else {
  const __interruptResult = interrupt(`Agent wants to call the greet function with name: ${__stack.args.name} and age: ${__stack.args.age}`);
  __ctx.stateStack.nodesTraversed = __graph.getNodesTraversed();
  __interruptResult.state = __ctx.stateStack.toJSON();
  
  
  return __interruptResult;
  
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __ctx.stateStack.pop();
return `Kya chal raha jai, ${__stack.args.name}! You are ${__stack.args.age} years old.`
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionEnd", data: { functionName: "greet", timeTaken: performance.now() - __funcStartTime } });
}

export async function foo2(name, age, __state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    const __funcStartTime = performance.now();
    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionStart", data: { functionName: "foo2", args: { name, age }, isBuiltin: false } });

    // put all args on the state stack
    __stack.args["name"] = name;
    __stack.args["age"] = age;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        await _print(`In foo2, name is ${__stack.args.name} and age is ${__stack.args.age}, this message should only print once...`);
        __stack.step++;
      }
      

      if (__step <= 2) {
        
async function _response(name, age, __metadata) {
  return runPrompt({
    ctx: __ctx,
    prompt: `Greet the user with their name: ${name} and age ${age} using the greet function.`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: [__greetTool],
    toolHandlers: [{ name: "greet", params: __greetToolParams, execute: greet, isBuiltin: false }],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
    interruptData: __state?.interruptData
  });
}




__self.response = await _response(__stack.args.name, __stack.args.age, {
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.response)) {
  
   
   return  __self.response;
   
}
        __stack.step++;
      }
      

      if (__step <= 3) {
        await _print(`Greeted, age is still ${__stack.args.age}...`);
        __stack.step++;
      }
      

      if (__step <= 4) {
        __ctx.stateStack.pop();
return __stack.locals.response
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionEnd", data: { functionName: "foo2", timeTaken: performance.now() - __funcStartTime } });
}

graph.node("sayHi", async (__state) => {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupNode({ state: __state });
    const __ctx = __state.ctx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "sayHi" } });

    if (__state.isResume) {
      __globalCtx.stateStack.globals = __state.ctx.stateStack.globals;
    }

    
    if (!__state.isResume) {
      __stack.args["name"] = __state.data.name;
    }
    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        await _print(`Saying hi to ${__stack.args.name}...`);
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stack.locals.age = 30;
        __stack.step++;
      }
      

      if (__step <= 3) {
        __stack.locals.response = foo2(__stack.args.name, __stack.locals.age, {
    ctx: __ctx,
    threads: __threads,
    interruptData: __state?.interruptData
});


if (isInterrupt(__stack.locals.response)) {
  
  return { ...__state, data: __stack.locals.response };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 4) {
        [__self.response] = await Promise.all([__self.response]);
        __stack.step++;
      }
      

      if (__step <= 5) {
        await _print(__stack.locals.response);
        __stack.step++;
      }
      

      if (__step <= 6) {
        await _print(`Greeting sent.`);
        __stack.step++;
      }
      

      if (__step <= 7) {
        return { messages: __threads, data: __stack.locals.response}
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "sayHi", data: undefined } });
    return { messages: __threads, data: undefined };
});


export async function sayHi(name, { messages, callbacks } = {}) {


  return runNode({
    ctx: __globalCtx,
    nodeName: "sayHi",
    data: { name },
    messages,
    callbacks,
  });
}

export const __sayHiNodeParams = ["name"];
export default graph;