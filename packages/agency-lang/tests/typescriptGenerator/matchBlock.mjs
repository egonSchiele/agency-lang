import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "agency-lang/zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse, Checkpoint, LLMClient } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore, Runner, McpManager,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl, _run as __runtime_run_impl,
  interrupt, isInterrupt, hasInterrupts, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  RestoreSignal,
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  head, tail, empty,
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult,
  Schema, __validateType,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  AgencyFunction as __AgencyFunction, UNSET as __UNSET,
  __call, __callMethod,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient,
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
  dirname: __dirname,
  traceConfig: {
    program: "matchBlock.agency"
  }
});
const graph = __globalCtx.graph;

// Path-dependent builtin wrappers
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// Handler result builtins and interrupt response constructors (unified types)
export function approve(value?: any) { return { type: "approve" as const, value }; }
export function reject(value?: any) { return { type: "reject" as const, value }; }
function propagate() { return { type: "propagate" as const }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, hasInterrupts, isDebugger };
export const respondToInterrupts = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata });
export const rewindFrom = (checkpoint: Checkpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });

export const __setDebugger = (dbg: any) => { __globalCtx.debuggerState = dbg; };
export const __setTraceWriter = (tw: any) => { __globalCtx.traceWriter = tw; };
export const __setLLMClient = (client: LLMClient) => { __globalCtx.setLLMClient(client); };
export const __getCheckpoints = () => __globalCtx.checkpoints;

// Auto-activate the deterministic LLM client when AGENCY_LLM_MOCKS is set.
// The test runner (lib/cli/util.ts) populates this env var as a JSON string
// when AGENCY_USE_TEST_LLM_PROVIDER=1. Both the agency evaluate template
// and the agency-js test.js paths import this module, so this single block
// covers both code paths.
if (__process.env.AGENCY_LLM_MOCKS) {
  __globalCtx.setLLMClient(
    new __DeterministicClient(JSON.parse(__process.env.AGENCY_LLM_MOCKS))
  );
}

export const __toolRegistry: Record<string, any> = {};

function __registerTool(value: unknown, name?: string) {
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[name ?? value.name] = value;
  }
}

// Wrap stateful runtime functions as AgencyFunction instances
const checkpoint = __AgencyFunction.create({ name: "checkpoint", module: "__runtime", fn: __checkpoint_impl, params: [], toolDefinition: null }, __toolRegistry);
const getCheckpoint = __AgencyFunction.create({ name: "getCheckpoint", module: "__runtime", fn: __getCheckpoint_impl, params: [{ name: "checkpointId", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
const restore = __AgencyFunction.create({ name: "restore", module: "__runtime", fn: __restore_impl, params: [{ name: "checkpointIdOrCheckpoint", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "options", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __runtime_run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "node", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "args", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "wallClock", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "memory", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "ipcPayload", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "stdout", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
function setLLMClient(client: LLMClient) {
  __globalCtx.setLLMClient(client);
}


function registerTools(tools: any[]) {
  for (const tool of tools) {
    if (__AgencyFunction.isAgencyFunction(tool)) {
      __toolRegistry[tool.name] = tool;
    }
  }
}

async function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("matchBlock.agency")
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "matchBlock.agency",
  fn: readSkill,
  params: __readSkillToolParams.map(p => ({ name: p, hasDefault: false, defaultValue: undefined, variadic: false })),
  toolDefinition: __readSkillTool,
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stateStack = __state.ctx.stateStack;
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
await __call(print, {
            type: "positional",
            args: [`Starting...`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
    },
  },

  {
    condition: async () => __stack.locals.action === `stop`,
    body: async (runner) => {
await __call(print, {
            type: "positional",
            args: [`Stopping...`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
    },
  },

  {
    condition: async () => __stack.locals.action === `restart`,
    body: async (runner) => {
await __call(print, {
            type: "positional",
            args: [`Restarting...`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
    },
  },

], async (runner) => {
await __call(print, {
          type: "positional",
          args: [`Unknown action`]
        }, {
          ctx: __ctx,
          threads: __threads,
          stateStack: __stateStack
        })
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
await __call(print, {
            type: "positional",
            args: [`OK`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
    },
  },

  {
    condition: async () => __stack.locals.statusCode === 404,
    body: async (runner) => {
await __call(print, {
            type: "positional",
            args: [`Not Found`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
    },
  },

  {
    condition: async () => __stack.locals.statusCode === 500,
    body: async (runner) => {
await __call(print, {
            type: "positional",
            args: [`Internal Server Error`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
    },
  },

], async (runner) => {
await __call(print, {
          type: "positional",
          args: [`Unknown status`]
        }, {
          ctx: __ctx,
          threads: __threads,
          stateStack: __stateStack
        })
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
await __call(print, {
            type: "positional",
            args: [`Debug mode enabled`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
    },
  },

  {
    condition: async () => __stack.locals.level === `info`,
    body: async (runner) => {
await __call(print, {
            type: "positional",
            args: [`Info level logging`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
    },
  },

  {
    condition: async () => __stack.locals.level === `warn`,
    body: async (runner) => {
await __call(print, {
            type: "positional",
            args: [`Warning level`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
    },
  },

  {
    condition: async () => __stack.locals.level === `error`,
    body: async (runner) => {
await __call(print, {
            type: "positional",
            args: [`Error level`]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          })
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
    console.error(`\nAgent crashed: ${__error.message}`)
    console.error(__error.stack)
    return {
      messages: __threads,
      data: failure(__error instanceof Error ? __error.message : String(__error), { functionName: "main" })
    };
  }
})
export async function main({ messages, callbacks }: { messages?: any; callbacks?: any } = {}): Promise<RunNodeResult<any>> {
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
export const __sourceMap = {"matchBlock.agency:main":{"1":{"line":4,"col":2},"2":{"line":5,"col":2},"4":{"line":13,"col":2},"5":{"line":14,"col":2},"7":{"line":22,"col":2},"8":{"line":23,"col":2},"9":{"line":24,"col":2},"11":{"line":33,"col":2},"12":{"line":34,"col":2},"14":{"line":42,"col":2},"15":{"line":43,"col":2},"17":{"line":53,"col":2},"18":{"line":54,"col":2}}};