import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "agency-lang/zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import type { GraphState, Interrupt, InterruptResponse, Checkpoint, LLMClient } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore, Runner, McpManager,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl, _run as __runtime_run_impl,
  interrupt, isInterrupt, hasInterrupts, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  RestoreSignal,
  GuardExceededError,
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  head, tail, empty,
  success, failure, isSuccess, isFailure, __pipeBind, __tryCall, __catchResult,
  Schema, __validateType, __validateChain, __validateChainRecursive,
  AgencyFunction as __AgencyFunction, UNSET as __UNSET,
  __call, __callMethod, __threads, __stateStack, getRuntimeContext, agencyStore,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient,
  createLogger as __createLogger,
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
    debugMode: false,
    observability: false
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
  logLevel: "info",
  traceConfig: {
    program: "euler-0008.agency"
  }
});
const graph = __globalCtx.graph;

// Handler result builtins and interrupt response constructors (unified types)
export function approve(value?: any) { return { type: "approve" as const, value }; }
export function reject(value?: any) { return { type: "reject" as const, value }; }
function propagate() { return { type: "propagate" as const }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, hasInterrupts, isDebugger };
export const respondToInterrupts = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, registerTopLevelCallbacks: __registerTopLevelCallbacks, moduleDir: __dirname });
export const rewindFrom = (checkpoint: Checkpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata, registerTopLevelCallbacks: __registerTopLevelCallbacks, moduleDir: __dirname });

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

// Share a single registry object across every compiled module. With
// composite "module:name" keys, all modules' helpers — plus
// runtime-created blocks registered by `AgencyFunction.create` while
// a function is executing — stay reachable from `FunctionRefReviver`
// no matter which module touched the registry last.
export const __toolRegistry: Record<string, any> = (__functionRefReviver.registry ??= {} as any);

function __registerTool(value: unknown, _aliasName?: string) {
  // Composite "module:name" key keyed off the function's *own*
  // identity, not the importing module's local alias — so different
  // modules that import the same function don't shadow each other in
  // the shared global registry that `FunctionRefReviver` reads from.
  // `_aliasName` is kept in the signature for backwards compatibility
  // with already-compiled callers that pass it.
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[`${value.module}:${value.name}`] = value;
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
      __toolRegistry[`${tool.module}:${tool.name}`] = tool;
    }
  }
}

async function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("euler-0008.agency")
}
async function __registerTopLevelCallbacks(__ctx) {
  __ctx.topLevelCallbacks = [];
}
__functionRefReviver.registry = __toolRegistry;
//  Project Euler Problem 8: Largest Product in a Series
//  Find the thirteen adjacent digits in the 1000-digit number that have
//  the greatest product.
async function __toDigit_impl(c: string) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  if (!__ctx.globals.isInitialized("euler-0008.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  __stack.args["c"] = c;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "euler-0008.agency", scopeName: "toDigit", threads: __setupData.threads });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack(), __ctx, { moduleId: "euler-0008.agency", scopeName: "toDigit", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;
  if ("c" in __overrides) {
    c = __overrides["c"];
    __stack.args["c"] = c;
  }

}

  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onFunctionStart",
          data: {
            functionName: "toDigit",
            args: {
              c: c
            },
            isBuiltin: false,
            moduleId: "euler-0008.agency"
          }
        })
      });
      await runner.ifElse(1, [

  {
    condition: async () => __stack.args.c === `1`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(1)
return;
            });
    },
  },

]);
      await runner.ifElse(2, [

  {
    condition: async () => __stack.args.c === `2`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(2)
return;
            });
    },
  },

]);
      await runner.ifElse(3, [

  {
    condition: async () => __stack.args.c === `3`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(3)
return;
            });
    },
  },

]);
      await runner.ifElse(4, [

  {
    condition: async () => __stack.args.c === `4`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(4)
return;
            });
    },
  },

]);
      await runner.ifElse(5, [

  {
    condition: async () => __stack.args.c === `5`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(5)
return;
            });
    },
  },

]);
      await runner.ifElse(6, [

  {
    condition: async () => __stack.args.c === `6`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(6)
return;
            });
    },
  },

]);
      await runner.ifElse(7, [

  {
    condition: async () => __stack.args.c === `7`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(7)
return;
            });
    },
  },

]);
      await runner.ifElse(8, [

  {
    condition: async () => __stack.args.c === `8`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(8)
return;
            });
    },
  },

]);
      await runner.ifElse(9, [

  {
    condition: async () => __stack.args.c === `9`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__functionCompleted = true;
runner.halt(9)
return;
            });
    },
  },

]);
      await runner.step(10, async (runner) => {
__functionCompleted = true;
runner.halt(0)
return;
      });
    })
    if (runner.halted) { if (isFailure(runner.haltResult)) { runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable; } return runner.haltResult; }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
  throw __error;
}
// GuardExceededError must propagate up to the stdlib `guard`
// function's try/catch (in lib/runtime/result.ts via `try block()`).
// If we converted it to a Failure here, the guard would never see
// the trip and every guarded block would appear to succeed even
// over budget. See lib/runtime/guard.ts.
if (__error instanceof GuardExceededError) {
  throw __error;
}
// Surface the underlying exception via logger + statelog before
// converting to a Failure. Without this, a caller that doesn't
// inspect the result (the common case for void side-effect calls)
// silently loses the error — a debugging nightmare. See the
// recordAlwaysScoped bug debugged in
// https://ampcode.com/threads/T-019e7a3a-edfa-74d6-917a-255c31bf8491.
{
  const __errMsg = __error instanceof Error ? __error.message : String(__error);
  const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
  const __log = __createLogger(__ctx.logLevel);
  __log.error("Function " + "toDigit" + " threw an exception (converted to Failure): " + __errMsg);
  if (__errStack) __log.error(__errStack);
  __ctx.statelogClient?.error?.({
    errorType: "runtimeError",
    message: __errMsg,
    functionName: "toDigit",
    retryable: __self.__retryable,
  });
}
return failure(
  __error instanceof Error ? __error.message : String(__error),
  {
    checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
    retryable: __self.__retryable,
    functionName: "toDigit",
    args: __stack.args,
  }
);

  } finally {
    __stateStack()?.pop()
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "toDigit",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const toDigit = __AgencyFunction.create({
  name: "toDigit",
  module: "euler-0008.agency",
  fn: __toDigit_impl,
  params: [{
    name: "c",
    hasDefault: false,
    defaultValue: undefined,
    variadic: false
  }],
  toolDefinition: {
    name: "toDigit",
    description: "No description provided.",
    schema: z.object({"c": z.string(), })
  },
  safe: false,
  exported: false
}, __toolRegistry);
graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = getRuntimeContext().ctx;
let __forked;
let __functionCompleted = false;
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "euler-0008.agency", scopeName: "main", threads: __setupData.threads });
  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __ctx.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
await callHook({
          name: "onNodeStart",
          data: {
            nodeName: "main"
          }
        })
      });
      await runner.step(1, async (runner) => {
__stack.locals.digits = `7316717653133062491922511967442657474235534919493496983520312774506326239578318016984801869478851843858615607891129494954595017379583319528532088055111254069874715852386305071569329096329522744304355766896648950445244523161731856403098711121722383113622298934233803081353362766142828064444866452387493035890729629049156044077239071381051585930796086670172427121883998797908792274921901699720888093776657273330010533678812202354218097512545405947522435258490771167055601360483958644670632441572215539753697817977846174064955149290862569321978468622482839722413756570560574902614079729686524145351004748216637048440319989000889524345065854122758866688116427171479924442928230863465674813919123162824586178664583591245665294765456828489128831426076900422421902267105562632111110937054421750694165896040807198403850962455444362981230987879927244284909188845801561660979191338754992005240636899125607176060588611646710940507754100225698315520005593572972571636269561882670428252483600823257530420752963450`;
      });
      await runner.step(2, async (runner) => {
__stack.locals.maxProduct = 0;
      });
      await runner.step(3, async (runner) => {
__stack.locals.i = 0;
      });
      await runner.whileLoop(4, async () => __stack.locals.i <= __stack.locals.digits.length - 13, async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.product = 1;
        });
await runner.step(1, async (runner) => {
__stack.locals.j = 0;
        });
await runner.whileLoop(2, async () => __stack.locals.j < 13, async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.product = __stack.locals.product * await __call(toDigit, {
              type: "positional",
              args: [__stack.locals.digits[__stack.locals.i + __stack.locals.j]]
            });
          });
await runner.step(1, async (runner) => {
__stack.locals.j = __stack.locals.j + 1;
          });
        });
await runner.ifElse(3, [

  {
    condition: async () => __stack.locals.product > __stack.locals.maxProduct,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.maxProduct = __stack.locals.product;
              });
    },
  },

]);
await runner.step(4, async (runner) => {
__stack.locals.i = __stack.locals.i + 1;
        });
      });
      await runner.step(5, async (runner) => {
runner.halt({
          messages: __threads(),
          data: __stack.locals.maxProduct
        })
return;
      });
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(6, async () => {
await callHook({
        name: "onNodeEnd",
        data: {
          nodeName: "main",
          data: undefined
        }
      })
    });
    return {
      messages: __threads(),
      data: undefined
    };
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    if (__error instanceof GuardExceededError) {
      throw __error
    }
    {
              const __errMsg = __error instanceof Error ? __error.message : String(__error);
              const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
              const __log = __createLogger(__ctx.logLevel);
              __log.error(`Node main crashed: ${__errMsg}`);
              if (__errStack) __log.error(__errStack);
              __ctx.statelogClient?.error?.({
                errorType: "runtimeError",
                message: __errMsg,
                functionName: "main",
              });
            }
    return {
      messages: __threads(),
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
    initializeGlobals: __initializeGlobals,
    registerTopLevelCallbacks: __registerTopLevelCallbacks,
    moduleDir: __dirname
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
export const __sourceMap = {"euler-0008.agency:toDigit":{"1":{"line":5,"col":2},"2":{"line":6,"col":2},"3":{"line":7,"col":2},"4":{"line":8,"col":2},"5":{"line":9,"col":2},"6":{"line":10,"col":2},"7":{"line":11,"col":2},"8":{"line":12,"col":2},"9":{"line":13,"col":2},"10":{"line":14,"col":2},"1.0":{"line":5,"col":18},"2.0":{"line":6,"col":18},"3.0":{"line":7,"col":18},"4.0":{"line":8,"col":18},"5.0":{"line":9,"col":18},"6.0":{"line":10,"col":18},"7.0":{"line":11,"col":18},"8.0":{"line":12,"col":18},"9.0":{"line":13,"col":18}},"euler-0008.agency:main":{"1":{"line":18,"col":2},"2":{"line":19,"col":2},"3":{"line":20,"col":2},"4":{"line":21,"col":2},"5":{"line":33,"col":2},"4.0":{"line":22,"col":4},"4.1":{"line":23,"col":4},"4.2.0":{"line":25,"col":6},"4.2.1":{"line":26,"col":6},"4.2":{"line":24,"col":4},"4.3.0":{"line":29,"col":6},"4.3":{"line":28,"col":4},"4.4":{"line":31,"col":4}}};