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
export const __fooTool = {
  name: "foo",
  description: `No description provided.`,
  schema: z.object({})
};

export const __fooToolParams = [];

export async function foo(__metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
{


const __tid = __threads.create();

__threads.pushActive(__tid);


async function _res1(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `What are the first 5 prime numbers?`,
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




__self.res1 = await _res1({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res1)) {
  
   
   return  __self.res1;
   
}



{

const __tid = __threads.createSubthread();


__threads.pushActive(__tid);


async function _res2(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `What are the next 2 prime numbers after those?`,
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




__self.res2 = await _res2({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res2)) {
  
   
   return  __self.res2;
   
}



{

const __tid = __threads.createSubthread();


__threads.pushActive(__tid);


async function _res3(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `And what is the sum of all those numbers combined?`,
    messages: __metadata?.messages || new MessageThread(),
    
    responseFormat: z.object({
      response: z.number()
    }),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}




__self.res3 = await _res3({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res3)) {
  
   
   return  __self.res3;
   
}




__threads.popActive();
}



{


const __tid = __threads.create();

__threads.pushActive(__tid);


async function _res5(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `And what is the sum of all those numbers combined?`,
    messages: __metadata?.messages || new MessageThread(),
    
    responseFormat: z.object({
      response: z.number()
    }),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}




__self.res5 = await _res5({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res5)) {
  
   
   return  __self.res5;
   
}




__threads.popActive();
}




__threads.popActive();
}



{

const __tid = __threads.createSubthread();


__threads.pushActive(__tid);


async function _res4(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `And what is the sum of all those numbers combined?`,
    messages: __metadata?.messages || new MessageThread(),
    
    responseFormat: z.object({
      response: z.number()
    }),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}




__self.res4 = await _res4({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res4)) {
  
   
   return  __self.res4;
   
}




__threads.popActive();
}




__threads.popActive();
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        await _print(`res1`, __stack.locals.res1)
        __stack.step++;
      }
      

      if (__step <= 3) {
        await _print(`res2`, __stack.locals.res2)
        __stack.step++;
      }
      

      if (__step <= 4) {
        await _print(`res3`, __stack.locals.res3)
        __stack.step++;
      }
      

      if (__step <= 5) {
        await _print(`res4`, __stack.locals.res4)
        __stack.step++;
      }
      

      if (__step <= 6) {
        await _print(`res5`, __stack.locals.res5)
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
        
{


const __tid = __threads.create();

__threads.pushActive(__tid);


async function _res1(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `What are the first 5 prime numbers?`,
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




__self.res1 = await _res1({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res1)) {
  
  return { messages: __threads, data: __self.res1 };
  
   
}



{

const __tid = __threads.createSubthread();


__threads.pushActive(__tid);


async function _res2(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `What are the next 2 prime numbers after those?`,
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




__self.res2 = await _res2({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res2)) {
  
  return { messages: __threads, data: __self.res2 };
  
   
}



{

const __tid = __threads.createSubthread();


__threads.pushActive(__tid);


async function _res3(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `And what is the sum of all those numbers combined?`,
    messages: __metadata?.messages || new MessageThread(),
    
    responseFormat: z.object({
      response: z.number()
    }),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}




__self.res3 = await _res3({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res3)) {
  
  return { messages: __threads, data: __self.res3 };
  
   
}




__threads.popActive();
}



{


const __tid = __threads.create();

__threads.pushActive(__tid);


async function _res5(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `And what is the sum of all those numbers combined?`,
    messages: __metadata?.messages || new MessageThread(),
    
    responseFormat: z.object({
      response: z.number()
    }),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}




__self.res5 = await _res5({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res5)) {
  
  return { messages: __threads, data: __self.res5 };
  
   
}




__threads.popActive();
}




__threads.popActive();
}



{

const __tid = __threads.createSubthread();


__threads.pushActive(__tid);


async function _res4(__metadata) {
  return runPrompt({
    ctx: __ctx,
    statelogClient: statelogClient,
    graph: __graph,
    prompt: `And what is the sum of all those numbers combined?`,
    messages: __metadata?.messages || new MessageThread(),
    
    responseFormat: z.object({
      response: z.number()
    }),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
  });
}




__self.res4 = await _res4({
      messages: __threads.getOrCreateActive()
    });

// return early from node if this is an interrupt
if (isInterrupt(__self.res4)) {
  
  return { messages: __threads, data: __self.res4 };
  
   
}




__threads.popActive();
}




__threads.popActive();
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        await _print(`res1`, __stack.locals.res1)
        __stack.step++;
      }
      

      if (__step <= 3) {
        await _print(`res2`, __stack.locals.res2)
        __stack.step++;
      }
      

      if (__step <= 4) {
        await _print(`res3`, __stack.locals.res3)
        __stack.step++;
      }
      

      if (__step <= 5) {
        await _print(`res4`, __stack.locals.res4)
        __stack.step++;
      }
      

      if (__step <= 6) {
        await _print(`res5`, __stack.locals.res5)
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