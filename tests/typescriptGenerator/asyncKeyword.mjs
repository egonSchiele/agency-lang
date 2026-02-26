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

export async function openai(msg, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["msg"] = msg;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        let __defaultTimeblockName_startTime = performance.now();

async function _response(msg, __metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `Respond to this user message: ${msg}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}


__self.response = _response(__stack.args.msg, {
      messages: new MessageThread()
    });




let __defaultTimeblockName_endTime = performance.now();
let __defaultTimeblockName = __defaultTimeblockName_endTime - __defaultTimeblockName_startTime;


console.log("Time taken:", __defaultTimeblockName, "ms");
        __stack.step++;
      }
      

      if (__step <= 2) {
        [__self.response] = await Promise.all([__self.response]);
        __stack.step++;
      }
      

      if (__step <= 3) {
        __ctx.stateStack.pop();
return `OpenAI response: ${__stack.locals.response}`
        __stack.step++;
      }
      
}

export async function google(msg, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["msg"] = msg;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        __threads.active().setMessages([]);
        __stack.step++;
      }
      

      if (__step <= 2) {
        let __defaultTimeblockName_startTime = performance.now();

async function _response(msg, __metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `Respond to this user message: ${msg}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {"model": `gemini-2.5-flash-lite`},
    stream: false,
    maxToolCallRounds: 10,
  });
}


__self.response = _response(__stack.args.msg, {
      messages: new MessageThread()
    });




let __defaultTimeblockName_endTime = performance.now();
let __defaultTimeblockName = __defaultTimeblockName_endTime - __defaultTimeblockName_startTime;


console.log("Time taken:", __defaultTimeblockName, "ms");
        __stack.step++;
      }
      

      if (__step <= 3) {
        [__self.response] = await Promise.all([__self.response]);
        __stack.step++;
      }
      

      if (__step <= 4) {
        __ctx.stateStack.pop();
return `Google response: ${__stack.locals.response}`
        __stack.step++;
      }
      
}

export async function fibs(__metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function ___promptVar(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `Generate the first 10 Fibonacci numbers`,
    messages: __metadata?.messages || new MessageThread(),
    
    responseFormat: z.object({
      response: z.array(z.number())
    }),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}




__self.__promptVar = await ___promptVar({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.__promptVar)) {
  
   
   return  __self.__promptVar;
   
}

__ctx.stateStack.pop();
return __self.__promptVar;
        __stack.step++;
      }
      
}

graph.node("main", async (state) => {
    const { graph: __graph, statelogClient, stack: __stack, step: __step, self: __self, threads: __threads, globalState: __globalState } =
      setupNode({ ctx: __ctx, state, nodeName: "main" });
    if (__globalState) __global = __globalState;

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "main" } });

    
    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        __stack.args.msg = await _builtinInput(`> `);


if (isInterrupt(__stack.args.msg)) {
  
  return { ...state, data: __stack.args.msg };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stack.locals.res2 = google(__stack.args.msg, {
    statelogClient: statelogClient,
    graph: __graph,
    threads: __threads
});


if (isInterrupt(__stack.locals.res2)) {
  
  return { ...state, data: __stack.locals.res2 };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 3) {
        __stack.locals.res1 = openai(__stack.args.msg, {
    statelogClient: statelogClient,
    graph: __graph,
    threads: __threads
});


if (isInterrupt(__stack.locals.res1)) {
  
  return { ...state, data: __stack.locals.res1 };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 4) {
        [__self.res2, __self.res1] = await Promise.all([__self.res2, __self.res1]);
        __stack.step++;
      }
      

      if (__step <= 5) {
        __stack.locals.results = __stack.locals.Promise.race([__stack.locals.res1, __stack.locals.res2]);
        __stack.step++;
      }
      

      if (__step <= 6) {
        await _printJSON(__stack.locals.results)
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "main", data: undefined } });
    return { messages: __threads, data: undefined };
});



export async function main({ messages, callbacks } = {}) {

  return runNode({ ctx: __ctx, nodeName: "main", data: {  }, messages, callbacks });
}

export const __mainNodeParams = [];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const initialState = { messages: [], data: {} };
    await main(initialState);
}
export default graph;