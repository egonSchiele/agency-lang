import { fileURLToPath } from "url";
import process from "process";
import { z } from "zod";
import { goToNode } from "agency-lang";
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

const __ctx = new RuntimeContext({
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
const graph = __ctx.graph;

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
export const respondToInterrupt = (i, r, m) => _respondToInterrupt({ ctx: __ctx, interruptObj: i, interruptResponse: r, metadata: m });
export const approveInterrupt = (i, m) => _approveInterrupt({ ctx: __ctx, interruptObj: i, metadata: m });
export const rejectInterrupt = (i, m) => _rejectInterrupt({ ctx: __ctx, interruptObj: i, metadata: m });
export const modifyInterrupt = (i, a, m) => _modifyInterrupt({ ctx: __ctx, interruptObj: i, newArguments: a, metadata: m });
export const resolveInterrupt = (i, v, m) => _resolveInterrupt({ ctx: __ctx, interruptObj: i, value: v, metadata: m });

// Re-export builtin tools
export { __readSkillTool, __readSkillToolParams };
export { __printTool, __printToolParams };
export { __printJSONTool, __printJSONToolParams };
export { __inputTool, __inputToolParams };
export { __readTool, __readToolParams };
export { __readImageTool, __readImageToolParams };
export { __writeTool, __writeToolParams };
export { __fetchTool, __fetchToolParams };
export { __fetchJSONTool, __fetchJSONToolParams };
export { __fetchJsonTool, __fetchJsonToolParams };
export { __sleepTool, __sleepToolParams };
export { __roundTool, __roundToolParams };
export { __deepClone };
export const __greetTool = {
  name: "greet",
  description: `No description provided.`,
  schema: z.object({"name": z.string(), "age": z.number(), })
};

export const __greetToolParams = ["name","age"];

export async function greet(name, age, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["name"] = name;
    __stack.args["age"] = age;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        if (__ctx.stateStack.interruptData?.interruptResponse?.type === "approve") {
  __ctx.stateStack.interruptData.interruptResponse = null;
} else if (__ctx.stateStack.interruptData?.interruptResponse?.type === "resolve") {
  const __resolvedValue = __ctx.stateStack.interruptData.interruptResponse.value;
  __ctx.stateStack.interruptData.interruptResponse = null;
  
  
  __ctx.stateStack.pop();
  return __resolvedValue;
  
} else {
  const __interruptResult = interrupt(`Agent wants to call the greet function with name: ${__stack.args.name} and age: ${__stack.args.age}`);
  __ctx.stateStack.interruptData = {
    nodesTraversed: __graph.getNodesTraversed(),
  };
  __interruptResult.__state = __ctx.stateStack.toJSON();
  
  
  return __interruptResult;
  
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __ctx.stateStack.pop();
return `Kya chal raha jai, ${__stack.args.name}! You are ${__stack.args.age} years old.`
        __stack.step++;
      }
      
}

graph.node("foo2", async (state) => {
    const { graph: __graph, statelogClient, stack: __stack, step: __step, self: __self, threads: __threads, globalState: __globalState } =
      setupNode({ ctx: __ctx, state, nodeName: "foo2" });
    if (__globalState) __global = __globalState;

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "foo2" } });

    
    if (state.data !== "<from-stack>") {
      __stack.args["name"] = state.data.name;
      __stack.args["age"] = state.data.age;
    }
    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        await _print(`In foo2, name is ${__stack.args.name} and age is ${__stack.args.age}, this message should only print once...`)
        __stack.step++;
      }
      

      if (__step <= 2) {
        
async function _response(name, age, __metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `Greet the user with their name: ${name} and age ${age} using the greet function.`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: [__greetTool],
    toolHandlers: [{ name: "greet", params: __greetToolParams, execute: greet, isBuiltin: false }],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}




__self.response = await _response(__stack.args.name, __stack.args.age, {
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.response)) {
  
  return { messages: __threads, data: __self.response };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 3) {
        await _print(`Greeted, age is still ${__stack.args.age}...`)
        __stack.step++;
      }
      

      if (__step <= 4) {
        return { messages: __threads, data: __stack.locals.response}
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "foo2", data: undefined } });
    return { messages: __threads, data: undefined };
});

graph.node("sayHi", async (state) => {
    const { graph: __graph, statelogClient, stack: __stack, step: __step, self: __self, threads: __threads, globalState: __globalState } =
      setupNode({ ctx: __ctx, state, nodeName: "sayHi" });
    if (__globalState) __global = __globalState;

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "sayHi" } });

    
    if (state.data !== "<from-stack>") {
      __stack.args["name"] = state.data.name;
    }
    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        await _print(`Saying hi to ${__stack.args.name}...`)
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stack.args.age = 30;
        __stack.step++;
      }
      

      if (__step <= 3) {
        return goToNode("foo2",
  {
    messages: __stack.messages,
    __metadata: {
      graph: __graph,
      statelogClient,
      callbacks: __ctx.callbacks,
    },
    
    data: { name: __stack.args.name, age: __stack.args.age }
    
    
  });
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "sayHi", data: undefined } });
    return { messages: __threads, data: undefined };
});

graph.conditionalEdge("sayHi", ["foo2"]);


export async function foo2(name, age, { messages, callbacks } = {}) {


  return runNode({ ctx: __ctx, nodeName: "foo2", data: { name, age }, messages, callbacks });
}

export const __foo2NodeParams = ["name", "age"];

export async function sayHi(name, { messages, callbacks } = {}) {


  return runNode({ ctx: __ctx, nodeName: "sayHi", data: { name }, messages, callbacks });
}

export const __sayHiNodeParams = ["name"];
export default graph;