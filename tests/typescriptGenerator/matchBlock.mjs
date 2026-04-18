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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "matchBlock.agency", scopeName: "main" });
  try {
    await runner.step(0, async (runner) => {
//  Test match blocks (pattern matching)
//  Simple match with string literals
    });
    await runner.step(1, async (runner) => {
__stack.locals.action = `start`;
    });
    await runner.ifElse(2, [

  {
    condition: async () => __stack.locals.action === `start`,
    body: async (runner) => {
await print(`Starting...`)
    },
  },

  {
    condition: async () => __stack.locals.action === `stop`,
    body: async (runner) => {
await print(`Stopping...`)
    },
  },

  {
    condition: async () => __stack.locals.action === `restart`,
    body: async (runner) => {
await print(`Restarting...`)
    },
  },

], async (runner) => {
await print(`Unknown action`)
});
    await runner.step(3, async (runner) => {
//  Match with number literals
    });
    await runner.step(4, async (runner) => {
__stack.locals.statusCode = 200;
    });
    await runner.ifElse(5, [

  {
    condition: async () => __stack.locals.statusCode === 200,
    body: async (runner) => {
await print(`OK`)
    },
  },

  {
    condition: async () => __stack.locals.statusCode === 404,
    body: async (runner) => {
await print(`Not Found`)
    },
  },

  {
    condition: async () => __stack.locals.statusCode === 500,
    body: async (runner) => {
await print(`Internal Server Error`)
    },
  },

], async (runner) => {
await print(`Unknown status`)
});
    await runner.step(6, async (runner) => {
//  Match with variable assignment in body
    });
    await runner.step(7, async (runner) => {
__stack.locals.grade = `A`;
    });
    await runner.step(8, async (runner) => {
__stack.locals.points = 0;
    });
    await runner.ifElse(9, [

  {
    condition: async () => __stack.locals.grade === `A`,
    body: async (runner) => {
__stack.locals.a = 100;
    },
  },

  {
    condition: async () => __stack.locals.grade === `B`,
    body: async (runner) => {
__stack.locals.b = 85;
    },
  },

  {
    condition: async () => __stack.locals.grade === `C`,
    body: async (runner) => {
__stack.locals.c = 70;
    },
  },

  {
    condition: async () => __stack.locals.grade === `D`,
    body: async (runner) => {
__stack.locals.d = 55;
    },
  },

], async (runner) => {
__stack.locals.e = 0;
});
    await runner.step(10, async (runner) => {
//  Match with function calls in body
    });
    await runner.step(11, async (runner) => {
__stack.locals.level = `debug`;
    });
    await runner.ifElse(12, [

  {
    condition: async () => __stack.locals.level === `debug`,
    body: async (runner) => {
await print(`Debug mode enabled`)
    },
  },

  {
    condition: async () => __stack.locals.level === `info`,
    body: async (runner) => {
await print(`Info level logging`)
    },
  },

  {
    condition: async () => __stack.locals.level === `warn`,
    body: async (runner) => {
await print(`Warning level`)
    },
  },

  {
    condition: async () => __stack.locals.level === `error`,
    body: async (runner) => {
await print(`Error level`)
    },
  },

]);
    await runner.step(13, async (runner) => {
//  Match with array results
    });
    await runner.step(14, async (runner) => {
__stack.locals.resultType = `array`;
    });
    await runner.ifElse(15, [

  {
    condition: async () => __stack.locals.resultType === `array`,
    body: async (runner) => {
__stack.locals.data1 = [1, 2, 3];
    },
  },

  {
    condition: async () => __stack.locals.resultType === `object`,
    body: async (runner) => {
__stack.locals.data2 = {
            "x": 1,
            "y": 2
          };
    },
  },

], async (runner) => {
__stack.locals.data3 = [];
});
    await runner.step(16, async (runner) => {
//  Match with object results
    });
    await runner.step(17, async (runner) => {
__stack.locals.format = `json`;
    });
    await runner.ifElse(18, [

  {
    condition: async () => __stack.locals.format === `xml`,
    body: async (runner) => {
__stack.locals.output1 = {
            "type": `xml`,
            "ext": `.xml`
          };
    },
  },

  {
    condition: async () => __stack.locals.format === `json`,
    body: async (runner) => {
__stack.locals.output2 = {
            "type": `json`,
            "ext": `.json`
          };
    },
  },

  {
    condition: async () => __stack.locals.format === `csv`,
    body: async (runner) => {
__stack.locals.output3 = {
            "type": `csv`,
            "ext": `.csv`
          };
    },
  },

], async (runner) => {
__stack.locals.output4 = {
          "type": `unknown`,
          "ext": ``
        };
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
export const __sourceMap = {"matchBlock.agency:main":{"1":{"line":1,"col":2},"4":{"line":10,"col":2},"7":{"line":19,"col":2},"8":{"line":20,"col":2},"11":{"line":30,"col":2},"14":{"line":39,"col":2},"17":{"line":50,"col":2}}};