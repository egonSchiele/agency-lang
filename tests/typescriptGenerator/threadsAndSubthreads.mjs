import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid } from "agency-lang";
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
const __cwd = process.cwd();

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
    statelog: { 
      host: "https://agency-lang.com",
      projectId: "smoltalk",
      apiKey: process.env.STATELOG_SMOLTALK_API_KEY || "",
      traceId: nanoid()
    }
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
export const __fooTool = {
  name: "foo",
  description: `No description provided.`,
  schema: z.object({})
};

export const __fooToolParams = [];

export async function foo(__state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    const __funcStartTime = performance.now();
    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionStart", data: { functionName: "foo", args: {}, isBuiltin: false } });

    // put all args on the state stack
    

    
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
    interruptData: __state?.interruptData
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
    interruptData: __state?.interruptData
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
    interruptData: __state?.interruptData
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
    interruptData: __state?.interruptData
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
    interruptData: __state?.interruptData
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
        await _print(`res1`, __stack.locals.res1);
        __stack.step++;
      }
      

      if (__step <= 3) {
        await _print(`res2`, __stack.locals.res2);
        __stack.step++;
      }
      

      if (__step <= 4) {
        await _print(`res3`, __stack.locals.res3);
        __stack.step++;
      }
      

      if (__step <= 5) {
        await _print(`res4`, __stack.locals.res4);
        __stack.step++;
      }
      

      if (__step <= 6) {
        await _print(`res5`, __stack.locals.res5);
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onFunctionEnd", data: { functionName: "foo", timeTaken: performance.now() - __funcStartTime } });
}

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
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
{


const __tid = __threads.create();

__threads.pushActive(__tid);


async function _res1(__metadata) {
  return runPrompt({
    ctx: __ctx,
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
    interruptData: __state?.interruptData
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
    interruptData: __state?.interruptData
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
    interruptData: __state?.interruptData
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
    interruptData: __state?.interruptData
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
    interruptData: __state?.interruptData
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
        await _print(`res1`, __stack.locals.res1);
        __stack.step++;
      }
      

      if (__step <= 3) {
        await _print(`res2`, __stack.locals.res2);
        __stack.step++;
      }
      

      if (__step <= 4) {
        await _print(`res3`, __stack.locals.res3);
        __stack.step++;
      }
      

      if (__step <= 5) {
        await _print(`res4`, __stack.locals.res4);
        __stack.step++;
      }
      

      if (__step <= 6) {
        await _print(`res5`, __stack.locals.res5);
        __stack.step++;
      }
      

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "main", data: undefined } });
    return { messages: __threads, data: undefined };
});



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
    try {
      const initialState = { messages: new ThreadStore(), data: {} };
      await main(initialState);
    } catch (__error) {
      console.error(`
Agent crashed: ${__error.message}`);
      throw __error;
    }
}

export default graph;