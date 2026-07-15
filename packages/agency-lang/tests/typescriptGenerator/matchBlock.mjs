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
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl, _run as __runtime_run_impl,
  interrupt, isInterrupt, hasInterrupts, reportUnhandledInterrupts, resolveCliInterrupts, reportBudgetExceededAndExit, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  runExportedFunction as _runExportedFunction,
  RestoreSignal,
  AgencyAbort,
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  __UNINIT_STATIC, __readStatic,
  __registerStaticInit, __registerGlobalsInit, __awaitStaticInit, __awaitGlobalsInit,
  head, tail, empty,
  success, failure, isSuccess, isFailure, stampFailureBoundary, markDestructiveWork, __pipeBind, __tryCall, __catchResult, __eq, __nn,
  Schema, __validateType, __validateChain, __validateChainRecursive,
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
    program: "matchBlock.agency"
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

// Invoke an exported function in a node-grade execution frame. Used by
// `agency serve` to call a function from an HTTP/MCP request — outside any
// Agency execution frame, which generated function bodies otherwise require.
export const __invokeFunction = (fn: any, namedArgs: Record<string, unknown>) => _runExportedFunction({ ctx: __globalCtx, fn, namedArgs, initializeGlobals: __initializeGlobals, registerTopLevelCallbacks: __registerTopLevelCallbacks, moduleDir: __dirname });

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
  if (__ctx.globals.isInitialized("matchBlock.agency")) {
    return;
  }
  __ctx.globals.markInitialized("matchBlock.agency")
}
__registerGlobalsInit("matchBlock.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {
  __ctx.topLevelCallbacks = [];
}
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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "matchBlock.agency", scopeName: "main", threads: __setupData.threads });
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
//  Test match blocks (pattern matching)
//  Simple match with string literals
      });
      await runner.step(2, async (runner) => {
__stack.locals.action = `start`;
      });
      await runner.ifElse(3, [

  {
    condition: async () => __stack.locals.action === `start`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`Starting...`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

  {
    condition: async () => __stack.locals.action === `stop`,
    body: async (runner) => {
await runner.step(1, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`Stopping...`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

  {
    condition: async () => __stack.locals.action === `restart`,
    body: async (runner) => {
await runner.step(2, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`Restarting...`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

], async (runner) => {
await runner.step(3, async (runner) => {
const __funcResult = await __call(print, {
              type: "positional",
              args: [`Unknown action`]
            });
if (hasInterrupts(__funcResult)) {
              await getRuntimeContext().ctx.pendingPromises.awaitAll()
              runner.halt({
                ...__state,
                data: __funcResult
              })
              return;
            }
          });
});
      await runner.step(4, async (runner) => {
//  Match with number literals
      });
      await runner.step(5, async (runner) => {
__stack.locals.statusCode = 200;
      });
      await runner.ifElse(6, [

  {
    condition: async () => __stack.locals.statusCode === 200,
    body: async (runner) => {
await runner.step(0, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`OK`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

  {
    condition: async () => __stack.locals.statusCode === 404,
    body: async (runner) => {
await runner.step(1, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`Not Found`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

  {
    condition: async () => __stack.locals.statusCode === 500,
    body: async (runner) => {
await runner.step(2, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`Internal Server Error`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

], async (runner) => {
await runner.step(3, async (runner) => {
const __funcResult = await __call(print, {
              type: "positional",
              args: [`Unknown status`]
            });
if (hasInterrupts(__funcResult)) {
              await getRuntimeContext().ctx.pendingPromises.awaitAll()
              runner.halt({
                ...__state,
                data: __funcResult
              })
              return;
            }
          });
});
      await runner.step(7, async (runner) => {
//  Match with variable assignment in body
      });
      await runner.step(8, async (runner) => {
__stack.locals.grade = `A`;
      });
      await runner.step(9, async (runner) => {
__stack.locals.points = 0;
      });
      await runner.ifElse(10, [

  {
    condition: async () => __stack.locals.grade === `A`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.a = 100;
            });
    },
  },

  {
    condition: async () => __stack.locals.grade === `B`,
    body: async (runner) => {
await runner.step(1, async (runner) => {
__stack.locals.b = 85;
            });
    },
  },

  {
    condition: async () => __stack.locals.grade === `C`,
    body: async (runner) => {
await runner.step(2, async (runner) => {
__stack.locals.c = 70;
            });
    },
  },

  {
    condition: async () => __stack.locals.grade === `D`,
    body: async (runner) => {
await runner.step(3, async (runner) => {
__stack.locals.d = 55;
            });
    },
  },

], async (runner) => {
await runner.step(4, async (runner) => {
__stack.locals.e = 0;
          });
});
      await runner.step(11, async (runner) => {
//  Match with function calls in body
      });
      await runner.step(12, async (runner) => {
__stack.locals.level = `debug`;
      });
      await runner.ifElse(13, [

  {
    condition: async () => __stack.locals.level === `debug`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`Debug mode enabled`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

  {
    condition: async () => __stack.locals.level === `info`,
    body: async (runner) => {
await runner.step(1, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`Info level logging`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

  {
    condition: async () => __stack.locals.level === `warn`,
    body: async (runner) => {
await runner.step(2, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`Warning level`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

  {
    condition: async () => __stack.locals.level === `error`,
    body: async (runner) => {
await runner.step(3, async (runner) => {
const __funcResult = await __call(print, {
                type: "positional",
                args: [`Error level`]
              });
if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
            });
    },
  },

]);
      await runner.step(14, async (runner) => {
//  Match with array results
      });
      await runner.step(15, async (runner) => {
__stack.locals.resultType = `array`;
      });
      await runner.ifElse(16, [

  {
    condition: async () => __stack.locals.resultType === `array`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.data1 = [1, 2, 3];
            });
    },
  },

  {
    condition: async () => __stack.locals.resultType === `object`,
    body: async (runner) => {
await runner.step(1, async (runner) => {
__stack.locals.data2 = {
                "x": 1,
                "y": 2
              };
            });
    },
  },

], async (runner) => {
await runner.step(2, async (runner) => {
__stack.locals.data3 = [];
          });
});
      await runner.step(17, async (runner) => {
//  Match with object results
      });
      await runner.step(18, async (runner) => {
__stack.locals.format = `json`;
      });
      await runner.ifElse(19, [

  {
    condition: async () => __stack.locals.format === `xml`,
    body: async (runner) => {
await runner.step(0, async (runner) => {
__stack.locals.output1 = {
                "type": `xml`,
                "ext": `.xml`
              };
            });
    },
  },

  {
    condition: async () => __stack.locals.format === `json`,
    body: async (runner) => {
await runner.step(1, async (runner) => {
__stack.locals.output2 = {
                "type": `json`,
                "ext": `.json`
              };
            });
    },
  },

  {
    condition: async () => __stack.locals.format === `csv`,
    body: async (runner) => {
await runner.step(2, async (runner) => {
__stack.locals.output3 = {
                "type": `csv`,
                "ext": `.csv`
              };
            });
    },
  },

], async (runner) => {
await runner.step(3, async (runner) => {
__stack.locals.output4 = {
              "type": `unknown`,
              "ext": ``
            };
          });
});
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(20, async () => {
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
export const __sourceMap = {"matchBlock.agency:main":{"2":{"line":4,"col":2},"3":{"line":5,"col":2},"5":{"line":13,"col":2},"6":{"line":14,"col":2},"8":{"line":22,"col":2},"9":{"line":23,"col":2},"10":{"line":24,"col":2},"12":{"line":33,"col":2},"13":{"line":34,"col":2},"15":{"line":42,"col":2},"16":{"line":43,"col":2},"18":{"line":53,"col":2},"19":{"line":54,"col":2},"3.0":{"line":6,"col":15},"3.1":{"line":7,"col":14},"3.2":{"line":8,"col":17},"3.3":{"line":9,"col":9},"6.0":{"line":15,"col":11},"6.1":{"line":16,"col":11},"6.2":{"line":17,"col":11},"6.3":{"line":18,"col":9},"10.0":{"line":25,"col":11},"10.1":{"line":26,"col":11},"10.2":{"line":27,"col":11},"10.3":{"line":28,"col":11},"10.4":{"line":29,"col":9},"13.0":{"line":35,"col":15},"13.1":{"line":36,"col":14},"13.2":{"line":37,"col":14},"13.3":{"line":38,"col":15},"16.0":{"line":44,"col":15},"16.1":{"line":45,"col":16},"16.2":{"line":49,"col":9},"19.0":{"line":55,"col":13},"19.1":{"line":59,"col":14},"19.2":{"line":63,"col":13},"19.3":{"line":67,"col":9}}};