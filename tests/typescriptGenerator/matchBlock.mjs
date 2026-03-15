import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid, registerProvider, registerTextModel } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt } from "agency-lang/runtime";
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
  ToolCallError,
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
function _builtinRead(filename: string): string {
  return _builtinReadRaw({ filename, dirname: __dirname });
}
function _builtinWrite(filename: string, content: string): void {
  _builtinWriteRaw({ filename, content, dirname: __dirname });
}
function _builtinReadImage(filename: string): string {
  return _builtinReadImageRaw({ filename, dirname: __dirname });
}
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// Interrupt re-exports bound to this module's context
export { interrupt, isInterrupt };
export const respondToInterrupt = (i: Interrupt, r: any, m?: any) => _respondToInterrupt({ ctx: __globalCtx, interrupt: i, interruptResponse: r, metadata: m });
export const approveInterrupt = (i: Interrupt, m?: any) => _approveInterrupt({ ctx: __globalCtx, interrupt: i, metadata: m });
export const rejectInterrupt = (i: Interrupt, m?: any) => _rejectInterrupt({ ctx: __globalCtx, interrupt: i, metadata: m });
export const modifyInterrupt = (i: Interrupt, a: any, m?: any) => _modifyInterrupt({ ctx: __globalCtx, interrupt: i, newArguments: a, metadata: m });
export const resolveInterrupt = (i: Interrupt, v: any, m?: any) => _resolveInterrupt({ ctx: __globalCtx, interrupt: i, value: v, metadata: m });

graph.node("main", async (__state: GraphState) => {
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
  //  Test match blocks (pattern matching)
  
  
  //  Simple match with string literals
  
  __stack.step++;
}
if (__step <= 1) {
  __stack.locals.action = `start`;
  
  __stack.step++;
}
if (__step <= 2) {
  switch (__stack.locals.action) {
    case `start`:
      await await _print(`Starting...`)

      break;
    case `stop`:
      await await _print(`Stopping...`)

      break;
    case `restart`:
      await await _print(`Restarting...`)

      break;
    default:
      await await _print(`Unknown action`)

      break;
  }
  
  
  //  Match with number literals
  
  __stack.step++;
}
if (__step <= 3) {
  __stack.locals.statusCode = 200;
  
  __stack.step++;
}
if (__step <= 4) {
  switch (__stack.locals.statusCode) {
    case 200:
      await await _print(`OK`)

      break;
    case 404:
      await await _print(`Not Found`)

      break;
    case 500:
      await await _print(`Internal Server Error`)

      break;
    default:
      await await _print(`Unknown status`)

      break;
  }
  
  
  //  Match with variable assignment in body
  
  __stack.step++;
}
if (__step <= 5) {
  __stack.locals.grade = `A`;
  
  __stack.step++;
}
if (__step <= 6) {
  __stack.locals.points = 0;
  
  __stack.step++;
}
if (__step <= 7) {
  switch (__stack.locals.grade) {
    case `A`:
      __stack.locals.a = 100;
      break;
    case `B`:
      __stack.locals.b = 85;
      break;
    case `C`:
      __stack.locals.c = 70;
      break;
    case `D`:
      __stack.locals.d = 55;
      break;
    default:
      __stack.locals.e = 0;
      break;
  }
  
  
  //  Match with function calls in body
  
  __stack.step++;
}
if (__step <= 8) {
  __stack.locals.level = `debug`;
  
  __stack.step++;
}
if (__step <= 9) {
  switch (__stack.locals.level) {
    case `debug`:
      await await _print(`Debug mode enabled`)

      break;
    case `info`:
      await await _print(`Info level logging`)

      break;
    case `warn`:
      await await _print(`Warning level`)

      break;
    case `error`:
      await await _print(`Error level`)

      break;
  }
  
  
  //  Match with array results
  
  __stack.step++;
}
if (__step <= 10) {
  __stack.locals.resultType = `array`;
  
  __stack.step++;
}
if (__step <= 11) {
  switch (__stack.locals.resultType) {
    case `array`:
      __stack.locals.data1 = [1, 2, 3];
      break;
    case `object`:
      __stack.locals.data2 = {
        "x": 1,
        "y": 2
      };
      break;
    default:
      __stack.locals.data3 = [];
      break;
  }
  
  
  //  Match with object results
  
  __stack.step++;
}
if (__step <= 12) {
  __stack.locals.format = `json`;
  
  __stack.step++;
}
if (__step <= 13) {
  switch (__stack.locals.format) {
    case `xml`:
      __stack.locals.output1 = {
        "type": `xml`,
        "ext": `.xml`
      };
      break;
    case `json`:
      __stack.locals.output2 = {
        "type": `json`,
        "ext": `.json`
      };
      break;
    case `csv`:
      __stack.locals.output3 = {
        "type": `csv`,
        "ext": `.csv`
      };
      break;
    default:
      __stack.locals.output4 = {
        "type": `unknown`,
        "ext": ``
      };
      break;
  }
  
  __stack.step++;
}

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "main", data: undefined } });
    return { messages: __threads, data: undefined };
});



export async function main({ messages, callbacks }: { messages?: any; callbacks?: any } = {}) {

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
    } catch (__error: any) {
      console.error(`
Agent crashed: ${__error.message}`);
      throw __error;
    }
}

export default graph;