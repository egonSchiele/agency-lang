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

export async function openai(msg, __state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    
    // put all args on the state stack
    __stack.args["msg"] = msg;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        let __defaultTimeblockName_startTime = performance.now();

async function _response(msg, __metadata) {
  return runPrompt({
    ctx: __ctx,
    prompt: `Respond to this user message: ${msg}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
    interruptData: __state?.interruptData
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

export async function google(msg, __state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    
    // put all args on the state stack
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
    prompt: `Respond to this user message: ${msg}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {"model": `gemini-2.5-flash-lite`},
    stream: false,
    maxToolCallRounds: 10,
    interruptData: __state?.interruptData
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

export async function fibs(__state=undefined) {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupFunction({ state: __state });

    // __state will be undefined if this function is
    // being called as a tool by an llm
    const __ctx = __state?.ctx || __globalCtx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    
    // put all args on the state stack
    

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      

      if (__step <= 1) {
        
async function ___promptVar(__metadata) {
  return runPrompt({
    ctx: __ctx,
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
    interruptData: __state?.interruptData
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
        __stack.args.msg = await _builtinInput(`> `);


if (isInterrupt(__stack.args.msg)) {
  
  return { ...__state, data: __stack.args.msg };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 2) {
        __stack.locals.res2 = google(__stack.args.msg, {
    ctx: __ctx,
    threads: __threads,
    interruptData: __state?.interruptData
});


if (isInterrupt(__stack.locals.res2)) {
  
  return { ...__state, data: __stack.locals.res2 };
  
   
}
        __stack.step++;
      }
      

      if (__step <= 3) {
        __stack.locals.res1 = openai(__stack.args.msg, {
    ctx: __ctx,
    threads: __threads,
    interruptData: __state?.interruptData
});


if (isInterrupt(__stack.locals.res1)) {
  
  return { ...__state, data: __stack.locals.res1 };
  
   
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
        await _printJSON(__stack.locals.results);
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