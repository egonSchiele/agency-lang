import { print } from "/Users/adityabhargava/agency-lang/stdlib/index.js";
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
  checkpoint, getCheckpoint, restore,
  interrupt, isInterrupt, isRejected, isApproved, interruptWithHandlers,
  respondToInterrupt as _respondToInterrupt,
  approveInterrupt as _approveInterrupt,
  rejectInterrupt as _rejectInterrupt,
  resolveInterrupt as _resolveInterrupt,
  modifyInterrupt as _modifyInterrupt,
  resumeFromState as _resumeFromState,
  ToolCallError,
  RestoreSignal,
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
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
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

// Handler result builtins
function approve(value?: any) { return { type: "approved" as const, value }; }
function reject(value?: any) { return { type: "rejected" as const, value }; }

// Interrupt re-exports bound to this module's context
export { interrupt, isInterrupt };
export const respondToInterrupt = (interrupt: Interrupt, response: InterruptResponse, metadata?: Record<string, any>) => _respondToInterrupt({ ctx: __globalCtx, interrupt, interruptResponse: response, metadata });
export const approveInterrupt = (interrupt: Interrupt, metadata?: Record<string, any>) => _approveInterrupt({ ctx: __globalCtx, interrupt, metadata });
export const rejectInterrupt = (interrupt: Interrupt, metadata?: Record<string, any>) => _rejectInterrupt({ ctx: __globalCtx, interrupt, metadata });
export const modifyInterrupt = (interrupt: Interrupt, newArguments: Record<string, any>, metadata?: Record<string, any>) => _modifyInterrupt({ ctx: __globalCtx, interrupt, newArguments, metadata });
export const resolveInterrupt = (interrupt: Interrupt, value: any, metadata?: Record<string, any>) => _resolveInterrupt({ ctx: __globalCtx, interrupt, value, metadata });
function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("forLoop.agency")
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
  let __forked;
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeStart",
    data: {
      nodeName: "main"
    }
  })
  if (__step <= 0) {
          //  Basic for-of loop
    
          __stack.step++;
  }
  if (__step <= 1) {
          __stack.locals.items = [`a`, `b`, `c`];
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.items",
      value: __stack.locals.items
    })
    
          __stack.step++;
  }
  if (__step <= 2) {
          __self.__retryable = false;
    __stack.locals.__iteration_2 = __stack.locals.__iteration_2 ?? 0;
let __currentIter_2 = 0;
for (let __i_2 = 0; __i_2 < __stack.locals.items.length; __i_2++) {
  if (__currentIter_2 < __stack.locals.__iteration_2) {
    __currentIter_2++;
    continue;
  }

  const item = __stack.locals.items[__i_2];

  __stack.locals.__substep_2 = __stack.locals.__substep_2 ?? 0;

  if (__stack.locals.__substep_2 <= 0) {
    await print(item)

    __stack.locals.__substep_2 = 1;
  }

  if (__stack.locals.__substep_2 <= 1) {
    

    __stack.locals.__substep_2 = 2;
  }

  __stack.resetLoopIteration("2");
  __stack.locals.__iteration_2++;
  __currentIter_2++;
}
    
    
    //  Range-based for loop
    
          __stack.step++;
  }
  if (__step <= 3) {
          __self.__retryable = false;
    __stack.locals.__iteration_3 = __stack.locals.__iteration_3 ?? 0;
let __currentIter_3 = 0;
for (let i = 0; i < 5; i++) {
  if (__currentIter_3 < __stack.locals.__iteration_3) {
    __currentIter_3++;
    continue;
  }

  __stack.locals.__substep_3 = __stack.locals.__substep_3 ?? 0;

  if (__stack.locals.__substep_3 <= 0) {
    await print(i)

    __stack.locals.__substep_3 = 1;
  }

  if (__stack.locals.__substep_3 <= 1) {
    

    __stack.locals.__substep_3 = 2;
  }

  __stack.resetLoopIteration("3");
  __stack.locals.__iteration_3++;
  __currentIter_3++;
}
    
    
    //  Indexed for loop
    
          __stack.step++;
  }
  if (__step <= 4) {
          __stack.locals.names = [`alice`, `bob`];
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.names",
      value: __stack.locals.names
    })
    
          __stack.step++;
  }
  if (__step <= 5) {
          __self.__retryable = false;
    __stack.locals.__iteration_5 = __stack.locals.__iteration_5 ?? 0;
let __currentIter_5 = 0;
for (let index = 0; index < __stack.locals.names.length; index++) {
  if (__currentIter_5 < __stack.locals.__iteration_5) {
    __currentIter_5++;
    continue;
  }

  const name = __stack.locals.names[index];

  __stack.locals.__substep_5 = __stack.locals.__substep_5 ?? 0;

  if (__stack.locals.__substep_5 <= 0) {
    await print(name)

    __stack.locals.__substep_5 = 1;
  }

  if (__stack.locals.__substep_5 <= 1) {
    

    __stack.locals.__substep_5 = 2;
  }

  if (__stack.locals.__substep_5 <= 2) {
    await print(index)

    __stack.locals.__substep_5 = 3;
  }

  if (__stack.locals.__substep_5 <= 3) {
    

    __stack.locals.__substep_5 = 4;
  }

  __stack.resetLoopIteration("5");
  __stack.locals.__iteration_5++;
  __currentIter_5++;
}
    
          __stack.step++;
  }
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