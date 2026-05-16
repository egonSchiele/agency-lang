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
    program: "euler-0007.agency"
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
// Reconfigure the trace file path at runtime. Mutates the module-level
// traceConfig; the next call to runNode (mod.main / mod.someNode) will
// truncate the file and per-execCtx writers will append to it for the
// duration of that run. NOTE: traceFile is process-wide and cannot be
// used safely with concurrent runs of the same agent — for production
// concurrency, use traceDir instead (each run gets its own
// {traceDir}/{runId}.agencytrace).
export const __setTraceFile = (filePath: string) => {
  __globalCtx.traceConfig.traceFile = filePath;
};
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
  __ctx.globals.markInitialized("euler-0007.agency")
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "euler-0007.agency",
  fn: readSkill,
  params: __readSkillToolParams.map(p => ({ name: p, hasDefault: false, defaultValue: undefined, variadic: false })),
  toolDefinition: __readSkillTool,
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
//  Project Euler Problem 7: 10001st Prime
//  Find the 10001st prime number.
async function __isPrime_impl(n: number, __state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
  const __stateStack = __setupData.stateStack;
const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __threads = __setupData.threads;
const __ctx = __state?.ctx || __globalCtx;
const statelogClient = __ctx.statelogClient;
const __graph = __ctx.graph;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("euler-0007.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "isPrime",
      args: {
        n: n
      },
      isBuiltin: false,
      moduleId: "euler-0007.agency"
    }
  })
  __stack.args["n"] = n;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "euler-0007.agency", scopeName: "isPrime" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "euler-0007.agency", scopeName: "isPrime", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("n" in __overrides) {
    n = __overrides["n"];
    __stack.args["n"] = n;
  }

}

  try {
    await runner.ifElse(0, [

  {
    condition: async () => __stack.args.n < 2,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(false)
return;
          });
    },
  },

]);
    await runner.ifElse(1, [

  {
    condition: async () => __stack.args.n < 4,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(true)
return;
          });
    },
  },

]);
    await runner.ifElse(2, [

  {
    condition: async () => __stack.args.n % 2 === 0 || __stack.args.n % 3 === 0,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(false)
return;
          });
    },
  },

]);
    await runner.step(3, async (runner) => {
__stack.locals.i = 5;
    });
    await runner.whileLoop(4, () => __stack.locals.i * __stack.locals.i <= __stack.args.n, async (runner) => {
await runner.ifElse(0, [

  {
    condition: async () => __stack.args.n % __stack.locals.i === 0 || __stack.args.n % (__stack.locals.i + 2) === 0,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(false)
return;
            });
    },
  },

]);
await runner.step(1, async (runner) => {
__stack.locals.i = __stack.locals.i + 6;
      });
    });
    await runner.step(5, async (runner) => {
__functionCompleted = true;
runner.halt(true)
return;
    });
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
  throw __error;
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: __ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "isPrime",
    args: __stack.args,
  }
);

  } finally {
    __stateStack.pop()
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
        name: "onFunctionEnd",
        data: {
          functionName: "isPrime",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const isPrime = __AgencyFunction.create({
  name: "isPrime",
  module: "euler-0007.agency",
  fn: __isPrime_impl,
  params: [{
    name: "n",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }],
  toolDefinition: {
    name: "isPrime",
    description: `No description provided.`,
    schema: z.object({"n": z.number(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "euler-0007.agency", scopeName: "main" });
  try {
    await runner.step(0, async (runner) => {
__stack.locals.count = 0;
    });
    await runner.step(1, async (runner) => {
__stack.locals.num = 1;
    });
    await runner.whileLoop(2, () => __stack.locals.count < 10001, async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.num = __stack.locals.num + 1;
      });
await runner.ifElse(1, [

  {
    condition: async () => await __call(isPrime, {
            type: "positional",
            args: [__stack.locals.num]
          }, {
            ctx: __ctx,
            threads: __threads,
            stateStack: __stateStack
          }),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.count = __stack.locals.count + 1;
            });
    },
  },

]);
    });
    await runner.step(3, async (runner) => {
runner.halt({
        messages: __threads,
        data: __stack.locals.num
      })
return;
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
export const __sourceMap = {"euler-0007.agency:isPrime":{"0":{"line":4,"col":2},"1":{"line":5,"col":2},"2":{"line":6,"col":2},"3":{"line":7,"col":2},"4":{"line":8,"col":2},"5":{"line":12,"col":2},"0.0":{"line":4,"col":15},"1.0":{"line":5,"col":15},"2.0":{"line":6,"col":34},"4.0.0":{"line":9,"col":42},"4.0":{"line":9,"col":4},"4.1":{"line":10,"col":4}},"euler-0007.agency:main":{"0":{"line":16,"col":2},"1":{"line":17,"col":2},"2":{"line":18,"col":2},"3":{"line":24,"col":2},"2.0":{"line":19,"col":4},"2.1.0":{"line":21,"col":6},"2.1":{"line":20,"col":4}}};