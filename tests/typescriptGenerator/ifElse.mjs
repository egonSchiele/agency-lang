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
  interrupt, isInterrupt, isDebugger, isRejected, isApproved, interruptWithHandlers,
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
function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("ifElse.agency")
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
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeStart",
    data: {
      nodeName: "main"
    }
  })
  if (__step <= 0) {
          //  Basic if statement with boolean variable
          __stack.step++;
  }
  if (__step <= 1) {
          __stack.locals.flag = true;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.flag",
      value: __stack.locals.flag
    })
          __stack.step++;
  }
  if (__step <= 2) {
          if (__stack.locals.__condbranch_2 === undefined) {

  if (__stack.locals.flag) {
    __stack.locals.__condbranch_2 = 0;



  } else {
    __stack.locals.__condbranch_2 = -1;
  }

}
const __condbranch_2 = __stack.locals.__condbranch_2;
const __sub_2 = __stack.locals.__substep_2 ?? 0;

if (__condbranch_2 === 0) {

  if (__sub_2 <= 0) {
    __stack.locals.result = `condition was true`;
    __stack.locals.__substep_2 = 1;
  }


}
          __stack.step++;
  }
  if (__step <= 3) {
          if (__stack.locals.__condbranch_3 === undefined) {

  if (await isReady()) {
    __stack.locals.__condbranch_3 = 0;



  } else {
    __stack.locals.__condbranch_3 = -1;
  }

}
const __condbranch_3 = __stack.locals.__condbranch_3;
const __sub_3 = __stack.locals.__substep_3 ?? 0;

if (__condbranch_3 === 0) {

  if (__sub_3 <= 0) {
    __stack.locals.status = `ready`;
    __stack.locals.__substep_3 = 1;
  }


}
    //  If statement with property access
          __stack.step++;
  }
  if (__step <= 4) {
          __stack.locals.obj = {
      "active": true
    };
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.obj",
      value: __stack.locals.obj
    })
          __stack.step++;
  }
  if (__step <= 5) {
          if (__stack.locals.__condbranch_5 === undefined) {

  if (__stack.locals.obj.active) {
    __stack.locals.__condbranch_5 = 0;



  } else {
    __stack.locals.__condbranch_5 = -1;
  }

}
const __condbranch_5 = __stack.locals.__condbranch_5;
const __sub_5 = __stack.locals.__substep_5 ?? 0;

if (__condbranch_5 === 0) {

  if (__sub_5 <= 0) {
    __stack.locals.message = `object is active`;
    __stack.locals.__substep_5 = 1;
  }


}
    //  Nested if statements
          __stack.step++;
  }
  if (__step <= 6) {
          __stack.locals.outer = true;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.outer",
      value: __stack.locals.outer
    })
          __stack.step++;
  }
  if (__step <= 7) {
          if (__stack.locals.__condbranch_7 === undefined) {

  if (__stack.locals.outer) {
    __stack.locals.__condbranch_7 = 0;



  } else {
    __stack.locals.__condbranch_7 = -1;
  }

}
const __condbranch_7 = __stack.locals.__condbranch_7;
const __sub_7 = __stack.locals.__substep_7 ?? 0;

if (__condbranch_7 === 0) {

  if (__sub_7 <= 0) {
    __stack.locals.inner = false;
    __stack.locals.__substep_7 = 1;
  }

  if (__sub_7 <= 1) {
    if (__stack.locals.__condbranch_7_1 === undefined) {

  if (__stack.locals.inner) {
    __stack.locals.__condbranch_7_1 = 0;



  } else {
    __stack.locals.__condbranch_7_1 = -1;
  }

}
const __condbranch_7_1 = __stack.locals.__condbranch_7_1;
const __sub_7_1 = __stack.locals.__substep_7_1 ?? 0;

if (__condbranch_7_1 === 0) {

  if (__sub_7_1 <= 0) {
    __stack.locals.nested = `both true`;
    __stack.locals.__substep_7_1 = 1;
  }


}
    __stack.locals.__substep_7 = 2;
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
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.condition",
      value: __stack.locals.condition
    })
          __stack.step++;
  }
  if (__step <= 9) {
          if (__stack.locals.__condbranch_9 === undefined) {

  if (__stack.locals.condition) {
    __stack.locals.__condbranch_9 = 0;



  } else {
    __stack.locals.__condbranch_9 = -1;
  }

}
const __condbranch_9 = __stack.locals.__condbranch_9;
const __sub_9 = __stack.locals.__substep_9 ?? 0;

if (__condbranch_9 === 0) {

  if (__sub_9 <= 0) {
    __stack.locals.a = 1;
    __stack.locals.__substep_9 = 1;
  }

  if (__sub_9 <= 1) {
    __stack.locals.b = 2;
    __stack.locals.__substep_9 = 2;
  }

  if (__sub_9 <= 2) {
    __stack.locals.c = 3;
    __stack.locals.__substep_9 = 3;
  }


}
    //  Multiple statements in both then and else bodies
          __stack.step++;
  }
  if (__step <= 10) {
          __stack.locals.value = false;
    await __ctx.audit({
      type: "assignment",
      variable: "__stack.locals.value",
      value: __stack.locals.value
    })
          __stack.step++;
  }
  if (__step <= 11) {
          if (__stack.locals.__condbranch_11 === undefined) {

  if (__stack.locals.value) {
    __stack.locals.__condbranch_11 = 0;



  } else {
    __stack.locals.__condbranch_11 = -1;
  }

}
const __condbranch_11 = __stack.locals.__condbranch_11;
const __sub_11 = __stack.locals.__substep_11 ?? 0;

if (__condbranch_11 === 0) {

  if (__sub_11 <= 0) {
    __stack.locals.x = 10;
    __stack.locals.__substep_11 = 1;
  }

  if (__sub_11 <= 1) {
    __stack.locals.y = 20;
    __stack.locals.__substep_11 = 2;
  }


}
    //  Basic else
          __stack.step++;
  }
  if (__step <= 12) {
          if (__stack.locals.__condbranch_12 === undefined) {

  if (__stack.locals.flag) {
    __stack.locals.__condbranch_12 = 0;


  } else {
    __stack.locals.__condbranch_12 = 1;
  }


}
const __condbranch_12 = __stack.locals.__condbranch_12;
const __sub_12 = __stack.locals.__substep_12 ?? 0;

if (__condbranch_12 === 0) {

  if (__sub_12 <= 0) {
    __stack.locals.result = `yes`;
    __stack.locals.__substep_12 = 1;
  }


} else if (__condbranch_12 === 1) {

  if (__sub_12 <= 0) {
    __stack.locals.result = `no`;
    __stack.locals.__substep_12 = 1;
  }


}
    //  else if chain
          __stack.step++;
  }
  if (__step <= 13) {
          if (__stack.locals.__condbranch_13 === undefined) {

  if (__stack.locals.a == 1) {
    __stack.locals.__condbranch_13 = 0;

  } else if (__stack.locals.a == 2) {
    __stack.locals.__condbranch_13 = 1;


  } else {
    __stack.locals.__condbranch_13 = 2;
  }


}
const __condbranch_13 = __stack.locals.__condbranch_13;
const __sub_13 = __stack.locals.__substep_13 ?? 0;

if (__condbranch_13 === 0) {

  if (__sub_13 <= 0) {
    __stack.locals.result = `one`;
    __stack.locals.__substep_13 = 1;
  }


} else if (__condbranch_13 === 1) {

  if (__sub_13 <= 0) {
    __stack.locals.result = `two`;
    __stack.locals.__substep_13 = 1;
  }


} else if (__condbranch_13 === 2) {

  if (__sub_13 <= 0) {
    __stack.locals.result = `other`;
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
export const __sourceMap = {"ifElse.agency:main":{"1":{"line":4,"col":2},"2":{"line":5,"col":2},"3":{"line":9,"col":2},"4":{"line":14,"col":2},"5":{"line":17,"col":2},"6":{"line":22,"col":2},"7":{"line":23,"col":2},"8":{"line":37,"col":2},"9":{"line":38,"col":2},"10":{"line":45,"col":2},"11":{"line":46,"col":2},"12":{"line":52,"col":2},"13":{"line":59,"col":2},"2.0":{"line":6,"col":4},"3.0":{"line":10,"col":4},"5.0":{"line":18,"col":4},"7.0":{"line":24,"col":4},"7.1":{"line":25,"col":4},"7.1.0":{"line":26,"col":6},"9.0":{"line":39,"col":4},"9.1":{"line":40,"col":4},"9.2":{"line":41,"col":4},"11.0":{"line":47,"col":4},"11.1":{"line":48,"col":4},"12.0":{"line":55,"col":4},"13.0":{"line":64,"col":4}}};