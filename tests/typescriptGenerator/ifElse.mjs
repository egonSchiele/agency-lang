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
        //  Basic if statement with boolean variable
        __stack.step++;
      }
      

      if (__step <= 1) {
        __stack.locals.flag = true;
        __stack.step++;
      }
      

      if (__step <= 2) {
        if (__stack.locals.flag) {
__stack.locals.result = `condition was true`;


}
        __stack.step++;
      }
      

      if (__step <= 3) {
        if (isReady()) {
__stack.locals.status = `ready`;


}
//  If statement with property access
        __stack.step++;
      }
      

      if (__step <= 4) {
        __stack.locals.obj = {"active": true};
        __stack.step++;
      }
      

      if (__step <= 5) {
        if (__stack.locals.obj.active) {
__stack.locals.message = `object is active`;


}
//  Nested if statements
        __stack.step++;
      }
      

      if (__step <= 6) {
        __stack.locals.outer = true;
        __stack.step++;
      }
      

      if (__step <= 7) {
        if (__stack.locals.outer) {
__stack.locals.inner = false;


if (__stack.locals.inner) {
__stack.locals.nested = `both true`;


}


}
//  TODO fix
//  If with index access
//  arr = [1, 2, 3]
//  if (arr[0]) {
//    firstElement = "exists"
//  }
//  Multiple statements in then body
        __stack.step++;
      }
      

      if (__step <= 8) {
        __stack.locals.condition = true;
        __stack.step++;
      }
      

      if (__step <= 9) {
        if (__stack.locals.condition) {
__stack.locals.a = 1;


__stack.locals.b = 2;


__stack.locals.c = 3;


}
//  Multiple statements in both then and else bodies
        __stack.step++;
      }
      

      if (__step <= 10) {
        __stack.locals.value = false;
        __stack.step++;
      }
      

      if (__step <= 11) {
        if (__stack.locals.value) {
__stack.locals.x = 10;


__stack.locals.y = 20;


}
//  Basic else
        __stack.step++;
      }
      

      if (__step <= 12) {
        if (__stack.locals.flag) {
__stack.locals.result = `yes`;


} else {
__stack.locals.result = `no`;


}
//  else if chain
        __stack.step++;
      }
      

      if (__step <= 13) {
        if (__stack.locals.a == 1) {
__stack.locals.result = `one`;


} else if (__stack.locals.a == 2) {
__stack.locals.result = `two`;


} else {
__stack.locals.result = `other`;


}
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