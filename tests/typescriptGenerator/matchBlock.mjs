import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify } from "/Users/adityabhargava/agency-lang/stdlib/index.js";
import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid, registerProvider, registerTextModel } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse, RewindCheckpoint } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint, getCheckpoint, restore,
  interrupt, isInterrupt, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupt as _respondToInterrupt,
  approveInterrupt as _approveInterrupt,
  rejectInterrupt as _rejectInterrupt,
  resolveInterrupt as _resolveInterrupt,
  modifyInterrupt as _modifyInterrupt,
  resumeFromState as _resumeFromState,
  rewindFrom as _rewindFrom,
  ToolCallError,
  RestoreSignal,
  deepClone as __deepClone,
  not, eq, neq, lt, lte, gt, gte, and, or,
  head, tail, empty,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  _builtinTool as __builtinTool,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = process.cwd();

const getDirname = () => __dirname;

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

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, isDebugger };
export const respondToInterrupt = (interrupt: Interrupt, response: InterruptResponse, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupt({ ctx: __globalCtx, interrupt, interruptResponse: response, overrides: opts?.overrides, metadata: opts?.metadata });
export const approveInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _approveInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const rejectInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _rejectInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const modifyInterrupt = (interrupt: Interrupt, newArguments: Record<string, any>, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _modifyInterrupt({ ctx: __globalCtx, interrupt, newArguments, overrides: opts?.overrides, metadata: opts?.metadata });
export const resolveInterrupt = (interrupt: Interrupt, value: any, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _resolveInterrupt({ ctx: __globalCtx, interrupt, value, overrides: opts?.overrides, metadata: opts?.metadata });
export const rewindFrom = (checkpoint: RewindCheckpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });

export const __setDebugger = (dbg: any) => { __globalCtx.debuggerState = dbg; };
export const __getCheckpoints = () => __globalCtx.checkpoints;
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
let __functionCompleted = false;
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
    if (__stack.locals.__condbranch_2 === undefined) {

  if (__stack.locals.action === `start`) {
    __stack.locals.__condbranch_2 = 0;

  } else if (__stack.locals.action === `stop`) {
    __stack.locals.__condbranch_2 = 1;

  } else if (__stack.locals.action === `restart`) {
    __stack.locals.__condbranch_2 = 2;


  } else {
    __stack.locals.__condbranch_2 = 3;
  }


}
const __condbranch_2 = __stack.locals.__condbranch_2;
const __sub_2 = __stack.locals.__substep_2 ?? 0;

if (__condbranch_2 === 0) {

  if (__sub_2 <= 0) {
    await print(`Starting...`)
    __stack.locals.__substep_2 = 1;
  }


} else if (__condbranch_2 === 1) {

  if (__sub_2 <= 0) {
    await print(`Stopping...`)
    __stack.locals.__substep_2 = 1;
  }


} else if (__condbranch_2 === 2) {

  if (__sub_2 <= 0) {
    await print(`Restarting...`)
    __stack.locals.__substep_2 = 1;
  }


} else if (__condbranch_2 === 3) {

  if (__sub_2 <= 0) {
    await print(`Unknown action`)
    __stack.locals.__substep_2 = 1;
  }


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
    if (__stack.locals.__condbranch_4 === undefined) {

  if (__stack.locals.statusCode === 200) {
    __stack.locals.__condbranch_4 = 0;

  } else if (__stack.locals.statusCode === 404) {
    __stack.locals.__condbranch_4 = 1;

  } else if (__stack.locals.statusCode === 500) {
    __stack.locals.__condbranch_4 = 2;


  } else {
    __stack.locals.__condbranch_4 = 3;
  }


}
const __condbranch_4 = __stack.locals.__condbranch_4;
const __sub_4 = __stack.locals.__substep_4 ?? 0;

if (__condbranch_4 === 0) {

  if (__sub_4 <= 0) {
    await print(`OK`)
    __stack.locals.__substep_4 = 1;
  }


} else if (__condbranch_4 === 1) {

  if (__sub_4 <= 0) {
    await print(`Not Found`)
    __stack.locals.__substep_4 = 1;
  }


} else if (__condbranch_4 === 2) {

  if (__sub_4 <= 0) {
    await print(`Internal Server Error`)
    __stack.locals.__substep_4 = 1;
  }


} else if (__condbranch_4 === 3) {

  if (__sub_4 <= 0) {
    await print(`Unknown status`)
    __stack.locals.__substep_4 = 1;
  }


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
          if (__stack.locals.__condbranch_7 === undefined) {

  if (__stack.locals.grade === `A`) {
    __stack.locals.__condbranch_7 = 0;

  } else if (__stack.locals.grade === `B`) {
    __stack.locals.__condbranch_7 = 1;

  } else if (__stack.locals.grade === `C`) {
    __stack.locals.__condbranch_7 = 2;

  } else if (__stack.locals.grade === `D`) {
    __stack.locals.__condbranch_7 = 3;


  } else {
    __stack.locals.__condbranch_7 = 4;
  }


}
const __condbranch_7 = __stack.locals.__condbranch_7;
const __sub_7 = __stack.locals.__substep_7 ?? 0;

if (__condbranch_7 === 0) {

  if (__sub_7 <= 0) {
    __stack.locals.a = 100;
    __stack.locals.__substep_7 = 1;
  }


} else if (__condbranch_7 === 1) {

  if (__sub_7 <= 0) {
    __stack.locals.b = 85;
    __stack.locals.__substep_7 = 1;
  }


} else if (__condbranch_7 === 2) {

  if (__sub_7 <= 0) {
    __stack.locals.c = 70;
    __stack.locals.__substep_7 = 1;
  }


} else if (__condbranch_7 === 3) {

  if (__sub_7 <= 0) {
    __stack.locals.d = 55;
    __stack.locals.__substep_7 = 1;
  }


} else if (__condbranch_7 === 4) {

  if (__sub_7 <= 0) {
    __stack.locals.e = 0;
    __stack.locals.__substep_7 = 1;
  }


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
    if (__stack.locals.__condbranch_9 === undefined) {

  if (__stack.locals.level === `debug`) {
    __stack.locals.__condbranch_9 = 0;

  } else if (__stack.locals.level === `info`) {
    __stack.locals.__condbranch_9 = 1;

  } else if (__stack.locals.level === `warn`) {
    __stack.locals.__condbranch_9 = 2;

  } else if (__stack.locals.level === `error`) {
    __stack.locals.__condbranch_9 = 3;



  } else {
    __stack.locals.__condbranch_9 = -1;
  }

}
const __condbranch_9 = __stack.locals.__condbranch_9;
const __sub_9 = __stack.locals.__substep_9 ?? 0;

if (__condbranch_9 === 0) {

  if (__sub_9 <= 0) {
    await print(`Debug mode enabled`)
    __stack.locals.__substep_9 = 1;
  }


} else if (__condbranch_9 === 1) {

  if (__sub_9 <= 0) {
    await print(`Info level logging`)
    __stack.locals.__substep_9 = 1;
  }


} else if (__condbranch_9 === 2) {

  if (__sub_9 <= 0) {
    await print(`Warning level`)
    __stack.locals.__substep_9 = 1;
  }


} else if (__condbranch_9 === 3) {

  if (__sub_9 <= 0) {
    await print(`Error level`)
    __stack.locals.__substep_9 = 1;
  }


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
          if (__stack.locals.__condbranch_11 === undefined) {

  if (__stack.locals.resultType === `array`) {
    __stack.locals.__condbranch_11 = 0;

  } else if (__stack.locals.resultType === `object`) {
    __stack.locals.__condbranch_11 = 1;


  } else {
    __stack.locals.__condbranch_11 = 2;
  }


}
const __condbranch_11 = __stack.locals.__condbranch_11;
const __sub_11 = __stack.locals.__substep_11 ?? 0;

if (__condbranch_11 === 0) {

  if (__sub_11 <= 0) {
    __stack.locals.data1 = [1, 2, 3];
    __stack.locals.__substep_11 = 1;
  }


} else if (__condbranch_11 === 1) {

  if (__sub_11 <= 0) {
    __stack.locals.data2 = {
          "x": 1,
          "y": 2
        };
    __stack.locals.__substep_11 = 1;
  }


} else if (__condbranch_11 === 2) {

  if (__sub_11 <= 0) {
    __stack.locals.data3 = [];
    __stack.locals.__substep_11 = 1;
  }


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
          if (__stack.locals.__condbranch_13 === undefined) {

  if (__stack.locals.format === `xml`) {
    __stack.locals.__condbranch_13 = 0;

  } else if (__stack.locals.format === `json`) {
    __stack.locals.__condbranch_13 = 1;

  } else if (__stack.locals.format === `csv`) {
    __stack.locals.__condbranch_13 = 2;


  } else {
    __stack.locals.__condbranch_13 = 3;
  }


}
const __condbranch_13 = __stack.locals.__condbranch_13;
const __sub_13 = __stack.locals.__substep_13 ?? 0;

if (__condbranch_13 === 0) {

  if (__sub_13 <= 0) {
    __stack.locals.output1 = {
          "type": `xml`,
          "ext": `.xml`
        };
    __stack.locals.__substep_13 = 1;
  }


} else if (__condbranch_13 === 1) {

  if (__sub_13 <= 0) {
    __stack.locals.output2 = {
          "type": `json`,
          "ext": `.json`
        };
    __stack.locals.__substep_13 = 1;
  }


} else if (__condbranch_13 === 2) {

  if (__sub_13 <= 0) {
    __stack.locals.output3 = {
          "type": `csv`,
          "ext": `.csv`
        };
    __stack.locals.__substep_13 = 1;
  }


} else if (__condbranch_13 === 3) {

  if (__sub_13 <= 0) {
    __stack.locals.output4 = {
          "type": `unknown`,
          "ext": ``
        };
    __stack.locals.__substep_13 = 1;
  }


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
export const __sourceMap = {"matchBlock.agency:main":{"1":{"line":4,"col":2},"3":{"line":13,"col":2},"5":{"line":22,"col":2},"6":{"line":23,"col":2},"8":{"line":33,"col":2},"10":{"line":42,"col":2},"12":{"line":53,"col":2}}};