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
export const __addTool = {
  name: "add",
  description: `Adds two numbers together`,
  schema: z.object({"x": z.number(), "y": z.number(), })
};

export const __addToolParams = ["x","y"];
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

export const __mixedToolParams = ["count","label"];
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

export async function add(x, y, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["x"] = x;
    __stack.args["y"] = y;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _result(x, y, __metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `add ${x} and ${y}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}


__self.result = _result(__stack.args.x, __stack.args.y, {
      messages: new MessageThread()
    });
        __stack.step++;
      }
      

      if (__step <= 2) {
        [__self.result] = await Promise.all([__self.result]);
        __stack.step++;
      }
      

      if (__step <= 3) {
        __ctx.stateStack.pop();
return __stack.locals.result
        __stack.step++;
      }
      
}

export async function greet(name, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["name"] = name;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _message(name, __metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `Hello ${name}!`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}


__self.message = _message(__stack.args.name, {
      messages: new MessageThread()
    });
        __stack.step++;
      }
      

      if (__step <= 2) {
        [__self.message] = await Promise.all([__self.message]);
        __stack.step++;
      }
      

      if (__step <= 3) {
        __ctx.stateStack.pop();
return __stack.locals.message
        __stack.step++;
      }
      
}

export async function mixed(count, label, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["count"] = count;
    __stack.args["label"] = label;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _output(label, count, __metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `${label}: ${count}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}


__self.output = _output(__stack.args.label, __stack.args.count, {
      messages: new MessageThread()
    });
        __stack.step++;
      }
      

      if (__step <= 2) {
        [__self.output] = await Promise.all([__self.output]);
        __stack.step++;
      }
      

      if (__step <= 3) {
        __ctx.stateStack.pop();
return __stack.locals.output
        __stack.step++;
      }
      
}

export async function processArray(items, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["items"] = items;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _result(items, __metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `Processing array with ${items} items`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}


__self.result = _result(__stack.args.items, {
      messages: new MessageThread()
    });
        __stack.step++;
      }
      

      if (__step <= 2) {
        [__self.result] = await Promise.all([__self.result]);
        __stack.step++;
      }
      

      if (__step <= 3) {
        __ctx.stateStack.pop();
return __stack.locals.result
        __stack.step++;
      }
      
}

export async function flexible(value, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["value"] = value;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _result(value, __metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `Received value: ${value}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}


__self.result = _result(__stack.args.value, {
      messages: new MessageThread()
    });
        __stack.step++;
      }
      

      if (__step <= 2) {
        [__self.result] = await Promise.all([__self.result]);
        __stack.step++;
      }
      

      if (__step <= 3) {
        __ctx.stateStack.pop();
return __stack.locals.result
        __stack.step++;
      }
      
}

graph.node("foo", async (state) => {
    const { graph: __graph, statelogClient, stack: __stack, step: __step, self: __self, threads: __threads, globalState: __globalState } =
      setupNode({ ctx: __ctx, state, nodeName: "foo" });
    if (__globalState) __global = __globalState;

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "foo" } });

    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        await _print(`This is a node with a return type`)
        __stack.step++;
      }
      

      if (__step <= 2) {
        return { messages: __threads, data: `Node completed`}
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "foo", data: undefined } });
    return { messages: __threads, data: undefined };
});

graph.node("main", async (state) => {
    const { graph: __graph, statelogClient, stack: __stack, step: __step, self: __self, threads: __threads, globalState: __globalState } =
      setupNode({ ctx: __ctx, state, nodeName: "main" });
    if (__globalState) __global = __globalState;

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "main" } });

    
    
      if (__step <= 0) {
        //  Call the functions
        __stack.step++;
      }
      

      if (__step <= 1) {
        __stack.locals.sum = add(5, 10, {
    statelogClient: statelogClient,
    graph: __graph,
    threads: __threads
});


if (isInterrupt(__stack.locals.sum)) {
  
  return { ...state, data: __stack.locals.sum };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stack.locals.greeting = greet(`Alice`, {
    statelogClient: statelogClient,
    graph: __graph,
    threads: __threads
});


if (isInterrupt(__stack.locals.greeting)) {
  
  return { ...state, data: __stack.locals.greeting };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 3) {
        __stack.locals.labeled = mixed(42, `Answer`, {
    statelogClient: statelogClient,
    graph: __graph,
    threads: __threads
});


if (isInterrupt(__stack.locals.labeled)) {
  
  return { ...state, data: __stack.locals.labeled };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 4) {
        __stack.locals.processed = processArray([1, 2, 3, 4, 5], {
    statelogClient: statelogClient,
    graph: __graph,
    threads: __threads
});


if (isInterrupt(__stack.locals.processed)) {
  
  return { ...state, data: __stack.locals.processed };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 5) {
        __stack.locals.flexResult = flexible(`test`, {
    statelogClient: statelogClient,
    graph: __graph,
    threads: __threads
});


if (isInterrupt(__stack.locals.flexResult)) {
  
  return { ...state, data: __stack.locals.flexResult };
  
   
}
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "main", data: undefined } });
    return { messages: __threads, data: undefined };
});



export async function foo({ messages, callbacks } = {}) {

  return runNode({ ctx: __ctx, nodeName: "foo", data: {  }, messages, callbacks });
}

export const __fooNodeParams = [];


export async function main({ messages, callbacks } = {}) {

  return runNode({ ctx: __ctx, nodeName: "main", data: {  }, messages, callbacks });
}

export const __mainNodeParams = [];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const initialState = { messages: [], data: {} };
    await main(initialState);
}
export default graph;