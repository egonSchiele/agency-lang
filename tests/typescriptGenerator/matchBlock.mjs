import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid, registerProvider, registerTextModel } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse } from "agency-lang/runtime";
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
  builtinInput as input,
  builtinRead as _builtinReadRaw,
  builtinWrite as _builtinWriteRaw,
  builtinReadImage as _builtinReadImageRaw,
  builtinSleep as sleep,
  builtinRound as round,
  printJSON,
  print,
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
  _builtinTool as __builtinTool,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = process.cwd();

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://agency-lang.com",
    apiKey: process.env["STATELOG_API_KEY"] || "",
    projectId: "",
    debugMode: false
  },
  smoltalkDefaults: {
    openAiApiKey: process.env["OPENAI_API_KEY"] || "",
    googleApiKey: process.env["GEMINI_API_KEY"] || "",
    model: "gpt-4o-mini",
    logLevel: "warn",
    statelog: {
      host: "https://agency-lang.com",
      projectId: "smoltalk",
      apiKey: process.env["STATELOG_SMOLTALK_API_KEY"] || "",
      traceId: nanoid()
    }
  },
  dirname: __dirname
});
const graph = __globalCtx.graph;

// Path-dependent builtin wrappers
function read(filename: string): string {
  return _builtinReadRaw({ filename, dirname: __dirname });
}
function write(filename: string, content: string): void {
  _builtinWriteRaw({ filename, content, dirname: __dirname });
}
function readImage(filename: string): string {
  return _builtinReadImageRaw({ filename, dirname: __dirname });
}
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// tool() function — looks up a tool by name from the module's __toolRegistry
function tool(__name: string) {
  return __builtinTool(__name, __toolRegistry);
}

// Interrupt re-exports bound to this module's context
export { interrupt, isInterrupt };
export const respondToInterrupt = (interrupt: Interrupt, response: InterruptResponse, metadata?: Record<string, any>) => _respondToInterrupt({ ctx: __globalCtx, interrupt, interruptResponse: response, metadata });
export const approveInterrupt = (interrupt: Interrupt, metadata?: Record<string, any>) => _approveInterrupt({ ctx: __globalCtx, interrupt, metadata });
export const rejectInterrupt = (interrupt: Interrupt, metadata?: Record<string, any>) => _rejectInterrupt({ ctx: __globalCtx, interrupt, metadata });
export const modifyInterrupt = (interrupt: Interrupt, newArguments: Record<string, any>, metadata?: Record<string, any>) => _modifyInterrupt({ ctx: __globalCtx, interrupt, newArguments, metadata });
export const resolveInterrupt = (interrupt: Interrupt, value: any, metadata?: Record<string, any>) => _resolveInterrupt({ ctx: __globalCtx, interrupt, value, metadata });
function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("matchBlock.agency")
}
const __toolRegistry = {
  readSkill: {
    definition: __readSkillTool,
    handler: {
      name: "readSkill",
      params: __readSkillToolParams,
      execute: readSkill,
      isBuiltin: true
    }
  },
  print: {
    definition: __printTool,
    handler: {
      name: "print",
      params: __printToolParams,
      execute: print,
      isBuiltin: true
    }
  },
  printJSON: {
    definition: __printJSONTool,
    handler: {
      name: "printJSON",
      params: __printJSONToolParams,
      execute: printJSON,
      isBuiltin: true
    }
  },
  input: {
    definition: __inputTool,
    handler: {
      name: "input",
      params: __inputToolParams,
      execute: input,
      isBuiltin: true
    }
  },
  read: {
    definition: __readTool,
    handler: {
      name: "read",
      params: __readToolParams,
      execute: read,
      isBuiltin: true
    }
  },
  readImage: {
    definition: __readImageTool,
    handler: {
      name: "readImage",
      params: __readImageToolParams,
      execute: readImage,
      isBuiltin: true
    }
  },
  write: {
    definition: __writeTool,
    handler: {
      name: "write",
      params: __writeToolParams,
      execute: write,
      isBuiltin: true
    }
  },
  fetch: {
    definition: __fetchTool,
    handler: {
      name: "fetch",
      params: __fetchToolParams,
      execute: _builtinFetch,
      isBuiltin: true
    }
  },
  fetchJSON: {
    definition: __fetchJSONTool,
    handler: {
      name: "fetchJSON",
      params: __fetchJSONToolParams,
      execute: _builtinFetchJSON,
      isBuiltin: true
    }
  },
  fetchJson: {
    definition: __fetchJsonTool,
    handler: {
      name: "fetchJson",
      params: __fetchJsonToolParams,
      execute: _builtinFetchJSON,
      isBuiltin: true
    }
  },
  sleep: {
    definition: __sleepTool,
    handler: {
      name: "sleep",
      params: __sleepToolParams,
      execute: sleep,
      isBuiltin: true
    }
  },
  round: {
    definition: __roundTool,
    handler: {
      name: "round",
      params: __roundToolParams,
      execute: round,
      isBuiltin: true
    }
  }
};
graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state.ctx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeStart",
    data: {
      nodeName: "main"
    }
  })
  if (__step <= 0) {
    //  Test match blocks (pattern matching)
    
    
    //  Simple match with string literals
    
    __stack.step++;
  }
  if (__step <= 1) {
    __stack.locals.action = `start`;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.action",
      value: __stack.locals.action
    })
    
    __stack.step++;
  }
  if (__step <= 2) {
    __self.__retryable = false;
    switch (__stack.locals.action) {
      case `start`:
        await print(`Starting...`)
        break;
      case `stop`:
        await print(`Stopping...`)
        break;
      case `restart`:
        await print(`Restarting...`)
        break;
      default:
        await print(`Unknown action`)
        break;
    }
    
    
    //  Match with number literals
    
    __stack.step++;
  }
  if (__step <= 3) {
    __stack.locals.statusCode = 200;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.statusCode",
      value: __stack.locals.statusCode
    })
    
    __stack.step++;
  }
  if (__step <= 4) {
    __self.__retryable = false;
    switch (__stack.locals.statusCode) {
      case 200:
        await print(`OK`)
        break;
      case 404:
        await print(`Not Found`)
        break;
      case 500:
        await print(`Internal Server Error`)
        break;
      default:
        await print(`Unknown status`)
        break;
    }
    
    
    //  Match with variable assignment in body
    
    __stack.step++;
  }
  if (__step <= 5) {
    __stack.locals.grade = `A`;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.grade",
      value: __stack.locals.grade
    })
    
    __stack.step++;
  }
  if (__step <= 6) {
    __stack.locals.points = 0;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.points",
      value: __stack.locals.points
    })
    
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
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.level",
      value: __stack.locals.level
    })
    
    __stack.step++;
  }
  if (__step <= 9) {
    __self.__retryable = false;
    switch (__stack.locals.level) {
      case `debug`:
        await print(`Debug mode enabled`)
        break;
      case `info`:
        await print(`Info level logging`)
        break;
      case `warn`:
        await print(`Warning level`)
        break;
      case `error`:
        await print(`Error level`)
        break;
    }
    
    
    //  Match with array results
    
    __stack.step++;
  }
  if (__step <= 10) {
    __stack.locals.resultType = `array`;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.resultType",
      value: __stack.locals.resultType
    })
    
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
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.format",
      value: __stack.locals.format
    })
    
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
  await __ctx.pendingPromises.awaitAll()
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeEnd",
    data: {
      nodeName: "main",
      data: undefined
    }
  })
  return {
    messages: __threads,
    data: undefined
  };
})
export async function main({ messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
  return runNode({
    ctx: __globalCtx,
    nodeName: "main",
    data: {},
    messages: messages,
    callbacks: callbacks,
    initializeGlobals: __initializeGlobals
  });
}
export const __mainNodeParams = [];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const initialState = {
      messages: new ThreadStore(),
      data: {}
    };
    await main(initialState)
  } catch (__error: any) {
    console.error(`\nAgent crashed: ${__error.message}`)
    throw __error
  }
}
export default graph