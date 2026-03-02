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

export async function add(x, y, __state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    const __funcStartTime = performance.now();
    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionStart", data: { functionName: "add", args: { x, y }, isBuiltin: false } });

    // put all args on the state stack
    __stack.args["x"] = x;
    __stack.args["y"] = y;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _result(x, y, __metadata) {
  return runPrompt({
    ctx: __ctx,
    prompt: `add ${x} and ${y}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
    interruptData: __state?.interruptData
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
      

    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionEnd", data: { functionName: "add", timeTaken: performance.now() - __funcStartTime } });
}

export async function greet(name, __state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    const __funcStartTime = performance.now();
    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionStart", data: { functionName: "greet", args: { name }, isBuiltin: false } });

    // put all args on the state stack
    __stack.args["name"] = name;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _message(name, __metadata) {
  return runPrompt({
    ctx: __ctx,
    prompt: `Hello ${name}!`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
    interruptData: __state?.interruptData
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
      

    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionEnd", data: { functionName: "greet", timeTaken: performance.now() - __funcStartTime } });
}

export async function mixed(count, label, __state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    const __funcStartTime = performance.now();
    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionStart", data: { functionName: "mixed", args: { count, label }, isBuiltin: false } });

    // put all args on the state stack
    __stack.args["count"] = count;
    __stack.args["label"] = label;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _output(label, count, __metadata) {
  return runPrompt({
    ctx: __ctx,
    prompt: `${label}: ${count}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
    interruptData: __state?.interruptData
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
      

    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionEnd", data: { functionName: "mixed", timeTaken: performance.now() - __funcStartTime } });
}

export async function processArray(items, __state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    const __funcStartTime = performance.now();
    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionStart", data: { functionName: "processArray", args: { items }, isBuiltin: false } });

    // put all args on the state stack
    __stack.args["items"] = items;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _result(items, __metadata) {
  return runPrompt({
    ctx: __ctx,
    prompt: `Processing array with ${items} items`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
    interruptData: __state?.interruptData
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
      

    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionEnd", data: { functionName: "processArray", timeTaken: performance.now() - __funcStartTime } });
}

export async function flexible(value, __state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    const __funcStartTime = performance.now();
    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionStart", data: { functionName: "flexible", args: { value }, isBuiltin: false } });

    // put all args on the state stack
    __stack.args["value"] = value;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function _result(value, __metadata) {
  return runPrompt({
    ctx: __ctx,
    prompt: `Received value: ${value}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
    interruptData: __state?.interruptData
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
      

    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionEnd", data: { functionName: "flexible", timeTaken: performance.now() - __funcStartTime } });
}

graph.node("foo", async (__state) => {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupNode({ state: __state });
    const __ctx = __state.ctx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "foo" } });

    if (__state.isResume) {
      __globalCtx.stateStack.globals = __state.ctx.stateStack.globals;
    }

    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        await _print(`This is a node with a return type`);
        __stack.step++;
      }
      

      if (__step <= 2) {
        return { messages: __threads, data: `Node completed`}
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "foo", data: undefined } });
    return { messages: __threads, data: undefined };
});

graph.node("main", async (__state) => {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupNode({ state: __state });
    const __ctx = __state.ctx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "main" } });

    if (__state.isResume) {
      __globalCtx.stateStack.globals = __state.ctx.stateStack.globals;
    }

    
    
      if (__step <= 0) {
        //  Call the functions
        __stack.step++;
      }
      

      if (__step <= 1) {
        __stack.locals.sum = add(5, 10, {
    ctx: __ctx,
    threads: __threads,
    interruptData: __state?.interruptData
});


if (isInterrupt(__stack.locals.sum)) {
  
  return { ...__state, data: __stack.locals.sum };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stack.locals.greeting = greet(`Alice`, {
    ctx: __ctx,
    threads: __threads,
    interruptData: __state?.interruptData
});


if (isInterrupt(__stack.locals.greeting)) {
  
  return { ...__state, data: __stack.locals.greeting };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 3) {
        __stack.locals.labeled = mixed(42, `Answer`, {
    ctx: __ctx,
    threads: __threads,
    interruptData: __state?.interruptData
});


if (isInterrupt(__stack.locals.labeled)) {
  
  return { ...__state, data: __stack.locals.labeled };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 4) {
        __stack.locals.processed = processArray([1, 2, 3, 4, 5], {
    ctx: __ctx,
    threads: __threads,
    interruptData: __state?.interruptData
});


if (isInterrupt(__stack.locals.processed)) {
  
  return { ...__state, data: __stack.locals.processed };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 5) {
        __stack.locals.flexResult = flexible(`test`, {
    ctx: __ctx,
    threads: __threads,
    interruptData: __state?.interruptData
});


if (isInterrupt(__stack.locals.flexResult)) {
  
  return { ...__state, data: __stack.locals.flexResult };
  
   
}
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "main", data: undefined } });
    return { messages: __threads, data: undefined };
});



export async function foo({ messages, callbacks } = {}) {

  return runNode({
    ctx: __globalCtx,
    nodeName: "foo",
    data: {  },
    messages,
    callbacks,
  });
}

export const __fooNodeParams = [];


export async function main({ messages, callbacks } = {}) {

  return runNode({
    ctx: __globalCtx,
    nodeName: "main",
    data: {  },
    messages,
    callbacks,
  });
}

export const __mainNodeParams = [];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const __resumeFile = process.env.AGENCY_RESUME_FILE;

  // todo rethink
  if (__resumeFile) {
    const __stateJSON = JSON.parse(readFileSync(__resumeFile, 'utf-8'));
    let result = await _resumeFromState({ ctx: __ctx, stateJSON: __stateJSON });
    while (isInterrupt(result.data)) {
      const interruptData = result.data;
      const userResponse = await _builtinInput(`(builtin handler) Agent interrupted: "${interruptData.data}". Approve? (yes/no) `);
      if (userResponse.toLowerCase() === 'yes') {
        result = await _approveInterrupt({ ctx: __ctx, interruptObj: interruptData });
      } else {
        result = await _rejectInterrupt({ ctx: __ctx, interruptObj: interruptData });
      }
    }
  } else {
    try {
      const initialState = { messages: new ThreadStore(), data: {} };
      await main(initialState);
    } catch (__error) {
      __ctx.stateStack.nodesTraversed = __ctx.graph.getNodesTraversed();
      const __stateFile = __filename.replace(/.js$/, '.state.json');
      writeFileSync(__stateFile, JSON.stringify({ __state: __ctx.stateStack.toJSON(), errorMessage: __error.message }, null, 2));
      console.error(`
Agent crashed: ${__error.message}`);
      console.error(`State saved to: ${__stateFile}`);
      console.error(`Resume with: agency run <file>.agency --resume ${__stateFile}`);
      throw __error;
    }
  }
}

export default graph;