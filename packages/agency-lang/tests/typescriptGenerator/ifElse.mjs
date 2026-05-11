import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
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
    program: "ifElse.agency"
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
  __ctx.globals.markInitialized("ifElse.agency")
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "ifElse.agency",
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
    condition: async () => await __call(isReady, {
          type: "positional",
          args: []
        }, {
          ctx: __ctx,
          threads: __threads,
          stateStack: __stateStack
        }),
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
export const __sourceMap = {"ifElse.agency:main":{"1":{"line":2,"col":2},"2":{"line":3,"col":2},"3":{"line":7,"col":2},"5":{"line":12,"col":2},"6":{"line":15,"col":2},"8":{"line":20,"col":2},"9":{"line":21,"col":2},"11":{"line":35,"col":2},"12":{"line":36,"col":2},"14":{"line":43,"col":2},"15":{"line":44,"col":2},"17":{"line":50,"col":2},"19":{"line":57,"col":2},"2.0":{"line":4,"col":4},"3.0":{"line":8,"col":4},"6.0":{"line":16,"col":4},"9.0":{"line":22,"col":4},"9.1.0":{"line":24,"col":6},"9.1":{"line":23,"col":4},"12.0":{"line":37,"col":4},"12.1":{"line":38,"col":4},"12.2":{"line":39,"col":4},"15.0":{"line":45,"col":4},"15.1":{"line":46,"col":4},"17.0":{"line":51,"col":4},"17.1":{"line":53,"col":4},"19.0":{"line":58,"col":4},"19.1":{"line":60,"col":4},"19.2":{"line":62,"col":4}}};