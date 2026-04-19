import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse, RewindCheckpoint } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore, Runner,
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
  RestoreSignal,
  deepClone as __deepClone,
  not, eq, neq, lt, lte, gt, gte, and, or,
  head, tail, empty,
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult,
  Schema, __validateType,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  _builtinTool as __builtinTool,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = __process.cwd();

const getDirname = () => __dirname;

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://statelog.adit.io",
    apiKey: __process.env["STATELOG_API_KEY"] || "",
    projectId: "",
    debugMode: false
  },
  smoltalkDefaults: {
    openAiApiKey: __process.env["OPENAI_API_KEY"] || "",
    googleApiKey: __process.env["GEMINI_API_KEY"] || "",
    model: "gpt-4o-mini",
    logLevel: "warn",
    statelog: {
      host: "https://statelog.adit.io",
      projectId: "smoltalk",
      apiKey: __process.env["STATELOG_SMOLTALK_API_KEY"] || "",
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
function propagate() { return { type: "propagated" as const }; }

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
async function __initializeGlobals(__ctx) {
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
let __functionCompleted = false;
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onNodeStart",
    data: {
      nodeName: "main"
    }
  })
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "ifElse.agency", scopeName: "main" });
  try {
    await runner.step(0, async (runner) => {
//  Basic if statement with boolean variable
    });
    await runner.step(1, async (runner) => {
__stack.locals.flag = true;
    });
    await runner.ifElse(2, [

  {
    condition: async () => __stack.locals.flag,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result = `condition was true`;
          });
    },
  },

]);
    await runner.ifElse(3, [

  {
    condition: async () => await isReady(),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.status = `ready`;
          });
    },
  },

]);
    await runner.step(4, async (runner) => {
//  If statement with property access
    });
    await runner.step(5, async (runner) => {
__stack.locals.obj = {
        "active": true
      };
    });
    await runner.ifElse(6, [

  {
    condition: async () => __stack.locals.obj.active,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.message = `object is active`;
          });
    },
  },

]);
    await runner.step(7, async (runner) => {
//  Nested if statements
    });
    await runner.step(8, async (runner) => {
__stack.locals.outer = true;
    });
    await runner.ifElse(9, [

  {
    condition: async () => __stack.locals.outer,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.inner = false;
          });
await runner.ifElse(1, [

  {
    condition: async () => __stack.locals.inner,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.nested = `both true`;
                });
    },
  },

]);
    },
  },

]);
    await runner.step(10, async (runner) => {
//  TODO fix
//  If with index access
//  arr = [1, 2, 3]
//  if (arr[0]) {
//    firstElement = "exists"
//  }
//  Multiple statements in then body
    });
    await runner.step(11, async (runner) => {
__stack.locals.condition = true;
    });
    await runner.ifElse(12, [

  {
    condition: async () => __stack.locals.condition,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.a = 1;
          });
await runner.step(1, async (runner) => {
__stack.locals.b = 2;
          });
await runner.step(2, async (runner) => {
__stack.locals.c = 3;
          });
    },
  },

]);
    await runner.step(13, async (runner) => {
//  Multiple statements in both then and else bodies
    });
    await runner.step(14, async (runner) => {
__stack.locals.value = false;
    });
    await runner.ifElse(15, [

  {
    condition: async () => __stack.locals.value,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.x = 10;
          });
await runner.step(1, async (runner) => {
__stack.locals.y = 20;
          });
    },
  },

]);
    await runner.step(16, async (runner) => {
//  Basic else
    });
    await runner.ifElse(17, [

  {
    condition: async () => __stack.locals.flag,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result = `yes`;
          });
    },
  },

], async (runner) => {
await runner.step(1, async (runner) => {
__stack.locals.result = `no`;
        });
});
    await runner.step(18, async (runner) => {
//  else if chain
    });
    await runner.ifElse(19, [

  {
    condition: async () => __stack.locals.a === 1,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result = `one`;
          });
    },
  },

  {
    condition: async () => __stack.locals.a === 2,
    body: async (runner) => {
await runner.step(1, async (runner) => {
__stack.locals.result = `two`;
          });
    },
  },

], async (runner) => {
await runner.step(2, async (runner) => {
__stack.locals.result = `other`;
        });
});
    if (runner.halted) return runner.haltResult;
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
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    return {
      messages: __threads,
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "main" })
    };
  }
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
if (__process.argv[1] === fileURLToPath(import.meta.url)) {
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
export const __sourceMap = {"ifElse.agency:main":{"1":{"line":-1,"col":2},"2":{"line":0,"col":2},"3":{"line":4,"col":2},"5":{"line":9,"col":2},"6":{"line":12,"col":2},"8":{"line":17,"col":2},"9":{"line":18,"col":2},"11":{"line":32,"col":2},"12":{"line":33,"col":2},"14":{"line":40,"col":2},"15":{"line":41,"col":2},"17":{"line":47,"col":2},"19":{"line":54,"col":2},"2.0":{"line":1,"col":4},"3.0":{"line":5,"col":4},"6.0":{"line":13,"col":4},"9.0":{"line":19,"col":4},"9.1.0":{"line":21,"col":6},"9.1":{"line":20,"col":4},"12.0":{"line":34,"col":4},"12.1":{"line":35,"col":4},"12.2":{"line":36,"col":4},"15.0":{"line":42,"col":4},"15.1":{"line":43,"col":4},"17.0":{"line":48,"col":4},"17.1":{"line":50,"col":4},"19.0":{"line":55,"col":4},"19.1":{"line":57,"col":4},"19.2":{"line":59,"col":4}}};