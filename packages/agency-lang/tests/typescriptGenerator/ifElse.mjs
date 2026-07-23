import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "agency-lang/zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import os from "os";
import type { GraphState, Interrupt, InterruptResponse, Checkpoint, LLMClient } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore, Runner, McpManager,
  setupNode, setupFunction, claimFrameForScope, runNode, runPrompt, callHook,
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl, _run as __runtime_run_impl,
  interrupt, isInterrupt, hasInterrupts, reportUnhandledInterrupts, resolveCliInterrupts, reportBudgetExceededAndExit, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  runExportedFunction as _runExportedFunction,
  RestoreSignal,
  AgencyAbort,
  AbortedResult,
  isAborted,
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  __UNINIT_STATIC, __readStatic,
  __registerStaticInit, __registerGlobalsInit, __registerCallbacksInit, __awaitStaticInit, __awaitGlobalsInit,
  head, tail, empty,
  success, failure, isSuccess, isFailure, stampFailureBoundary, markDestructiveWork, __pipeBind, __tryCall, __catchResult, __eq, __nn,
  Schema, __validateType, __validateChain, __validateChainRecursive, __coarseTypeTest,
  AgencyFunction as __AgencyFunction, UNSET as __UNSET,
  __call, __callMethod, __threads, __stateStack, __globals, getRuntimeContext, agencyStore,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient,
  installFetchMock as __installFetchMock,
  createLogger as __createLogger,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = __process.cwd();

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://statelog.adit.io",
    apiKey: __process.env["STATELOG_API_KEY"] || "",
    projectId: "",
    debugMode: false,
    observability: false
  },
  smoltalkDefaults: {
    apiKey: {
      openAi: __process.env["OPENAI_API_KEY"] || "",
      google: __process.env["GEMINI_API_KEY"] || "",
      anthropic: __process.env["ANTHROPIC_API_KEY"] || "",
      openRouter: __process.env["OPENROUTER_API_KEY"] || "",
      deepInfra: __process.env["DEEPINFRA_API_KEY"] || "",
      liteLlm: __process.env["LITELLM_API_KEY"] || "",
      openAiCompat: __process.env["OPENAI_COMPAT_API_KEY"] || ""
    },
    baseUrl: {
      liteLlm: __process.env["LITELLM_BASE_URL"] || "",
      openAiCompat: __process.env["OPENAI_COMPAT_BASE_URL"] || ""
    },
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
    program: "ifElse.agency"
  }
});
const graph = __globalCtx.graph;

// Handler result builtins and interrupt response constructors (unified types)
export function approve(value?: any) { return { type: "approve" as const, value }; }
export function reject(value?: any) { return { type: "reject" as const, value }; }
function propagate() { return { type: "propagate" as const }; }
function pass() { return { type: "pass" as const }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, hasInterrupts, isDebugger };
export const respondToInterrupts = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata });
export const rewindFrom = (checkpoint: Checkpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });

// Invoke an exported function in a node-grade execution frame. Used by
// `agency serve` to call a function from an HTTP/MCP request — outside any
// Agency execution frame, which generated function bodies otherwise require.
export const __invokeFunction = (fn: any, namedArgs: Record<string, unknown>) => _runExportedFunction({ ctx: __globalCtx, fn, namedArgs, initializeGlobals: __initializeGlobals });

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

// Auto-activate fetch mocking when AGENCY_FETCH_MOCKS_FILE points at a mocks
// file. The runner writes resolved mocks (returnFile bodies already inlined) to
// a temp file and passes its path — a file, not an inline env value, so a large
// response body can't blow the exec arg/env size limit (ARG_MAX). Independent of
// AGENCY_LLM_MOCKS — a test may mock the network while using a real LLM, or vice
// versa. Installed before any node runs, ahead of any http.ts / stdlib / interop
// fetch.
if (__process.env.AGENCY_FETCH_MOCKS_FILE) {
  __installFetchMock(JSON.parse(readFileSync(__process.env.AGENCY_FETCH_MOCKS_FILE, "utf-8")));
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
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __runtime_run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "node", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "args", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "wallClock", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "memory", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "ipcPayload", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "stdout", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "configOverrides", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "cwd", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "maxDepth", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);

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
  if (__ctx.globals.isInitialized("ifElse.agency")) {
    return;
  }
  __ctx.globals.markInitialized("ifElse.agency")
}
__registerGlobalsInit("ifElse.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {

}
__registerCallbacksInit("ifElse.agency", __registerTopLevelCallbacks);
__functionRefReviver.registry = __toolRegistry;
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
  claimFrameForScope(__stack, "main");
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "ifElse.agency", scopeName: "main", threads: __setupData.threads });
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
//  Basic if statement with boolean variable
      });
      await runner.step(2, async (runner) => {
__stack.locals.flag = true;
      });
      await runner.ifElse(3, [

  {
    condition: async () => __stack.locals.flag,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result = `condition was true`;
            });
    },
  },

]);
      await runner.step(4, async (runner) => {
__stack.locals.__hoist_0 = await __call(isReady, {
          type: "positional",
          args: []
        });
if (hasInterrupts(__stack.locals.__hoist_0)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __stack.locals.__hoist_0
          })
          return;
        }
if (isAborted(__stack.locals.__hoist_0)) {
          throw __stack.locals.__hoist_0.toError()
        }
      });
      await runner.ifElse(5, [

  {
    condition: async () => __stack.locals.__hoist_0,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.status = `ready`;
            });
    },
  },

]);
      await runner.step(6, async (runner) => {
//  If statement with property access
      });
      await runner.step(7, async (runner) => {
__stack.locals.obj = {
          "active": true
        };
      });
      await runner.ifElse(8, [

  {
    condition: async () => __stack.locals.obj.active,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.message = `object is active`;
            });
    },
  },

]);
      await runner.step(9, async (runner) => {
//  Nested if statements
      });
      await runner.step(10, async (runner) => {
__stack.locals.outer = true;
      });
      await runner.ifElse(11, [

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
      await runner.step(12, async (runner) => {
//  TODO fix
//  If with index access
//  arr = [1, 2, 3]
//  if (arr[0]) {
//    firstElement = "exists"
//  }
//  Multiple statements in then body
      });
      await runner.step(13, async (runner) => {
__stack.locals.condition = true;
      });
      await runner.ifElse(14, [

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
      await runner.step(15, async (runner) => {
//  Multiple statements in both then and else bodies
      });
      await runner.step(16, async (runner) => {
__stack.locals.value = false;
      });
      await runner.ifElse(17, [

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
      await runner.step(18, async (runner) => {
//  Basic else
      });
      await runner.ifElse(19, [

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
      await runner.step(20, async (runner) => {
//  else if chain
      });
      await runner.ifElse(21, [

  {
    condition: async () => __eq(__stack.locals.a, 1),
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.result = `one`;
            });
    },
  },

  {
    condition: async () => __eq(__stack.locals.a, 2),
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
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(22, async () => {
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
    if (__error instanceof AgencyAbort) {
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
    const __result = await main(initialState);
    await resolveCliInterrupts(__result, respondToInterrupts)
  } catch (__error: any) {
    reportBudgetExceededAndExit(__error)
    console.error(`
Agent crashed: ${__error.message}`)
    throw __error
  }
}
export default graph
export const __sourceMap = {"ifElse.agency:main":{"2":{"line":2,"col":2},"3":{"line":3,"col":2},"4":{"line":7,"col":6},"5":{"line":7,"col":2},"7":{"line":12,"col":2},"8":{"line":15,"col":2},"10":{"line":20,"col":2},"11":{"line":21,"col":2},"13":{"line":35,"col":2},"14":{"line":36,"col":2},"16":{"line":43,"col":2},"17":{"line":44,"col":2},"19":{"line":50,"col":2},"21":{"line":57,"col":2},"3.0":{"line":4,"col":4},"5.0":{"line":8,"col":4},"8.0":{"line":16,"col":4},"11.0":{"line":22,"col":4},"11.1.0":{"line":24,"col":6},"11.1":{"line":23,"col":4},"14.0":{"line":37,"col":4},"14.1":{"line":38,"col":4},"14.2":{"line":39,"col":4},"17.0":{"line":45,"col":4},"17.1":{"line":46,"col":4},"19.0":{"line":51,"col":4},"19.1":{"line":53,"col":4},"21.0":{"line":58,"col":4},"21.1":{"line":60,"col":4},"21.2":{"line":62,"col":4}}};