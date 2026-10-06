import { z } from "agency-lang/zod";
import type { Run as __Run, GraphState, Interrupt, InterruptResponse, Checkpoint, PausedCheckpoint, LLMClient, InvocationOptions, ResumeOverrides } from "agency-lang/runtime";
import {
  goToNode, color, nanoid, smoltalk,
  RuntimeContext, MessageThread, ThreadStore, Runner, McpManager,
  setupNode, setupFunction, claimFrameForScope, runNode, runPrompt, callHook,
  checkpointFor as __checkpoint_impl, getCheckpointFor as __getCheckpoint_impl, restoreFor as __restore_impl, _runFor as __runtime_run_impl,
  __codeLiteral,
  interrupt, isInterrupt, hasInterrupts, reportUnhandledInterrupts, resolveCliInterrupts, reportBudgetExceededAndExit, flushPendingStatelogPosts, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  isPaused,
  respondToInterrupts as _respondToInterrupts,
  respondToInterruptsForServe as _respondToInterruptsForServe,
  resumeFromCheckpoint as _resumeFromCheckpoint,
  resumeCliFromCheckpoint as _resumeCliFromCheckpoint,
  rewindFrom as _rewindFrom,
  runExportedFunction as _runExportedFunction,
  runExportedFunctionForServe as _runExportedFunctionForServe,
  runNodeForServe as _runNodeForServe,
  RestoreSignal,
  RunControlSignal,
  AgencyAbort,
  AbortedResult,
  isAborted,
  deepClone as __deepClone,
  deepFreeze as __deepFreeze,
  __UNINIT_STATIC, __readStatic,
  __registerStaticInit, __registerGlobalsInit, __registerCallbacksInit, __awaitStaticInit, __awaitGlobalsInit, __registerAlwaysScope,
  registerModuleFingerprint as __registerModuleFingerprint,
  head, tail, empty,
  success, failure, runtimeFailure, isSuccess, isFailure, stampFailureBoundary, markDestructiveWork, __pipeBind, __tryCall, __catchResult, __eq, __nn, __requireLength,
  Schema, __validateType, __invalidArgument, __validateChain, __validateChainRecursive, __withUseSiteValidators, __coarseTypeTest,
  AgencyFunction as __AgencyFunction, UNSET as __UNSET,
  __call, __callMethod, withRun as __withRun, withChildRun as __withChildRun, detachedRun as __detachedRun, runInBootstrapFrame as __runInBootstrapFrame,
  functionRefReviver as __functionRefReviver,
  createLogger as __createLogger,
  defaultHost as __defaultHost,
  path, os,
  runCliEntry,
} from "agency-lang/runtime";

// The host is the platform: a Node process here, a browser elsewhere. The
// default host of the platform this module was bundled for; a run can carry
// its own through InvocationOptions.
const __host = __defaultHost();
const __dirname = __host.system.moduleDir(import.meta.url);

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "",
    apiKey: __host.settings.read("STATELOG_API_KEY") || "",
    projectId: "",
    debugMode: false,
    observability: false
  },
  smoltalkDefaults: {
    apiKey: {
      openAi: __host.settings.read("OPENAI_API_KEY") || "",
      google: __host.settings.read("GEMINI_API_KEY") || "",
      anthropic: __host.settings.read("ANTHROPIC_API_KEY") || "",
      openRouter: __host.settings.read("OPENROUTER_API_KEY") || "",
      deepInfra: __host.settings.read("DEEPINFRA_API_KEY") || "",
      liteLlm: __host.settings.read("LITELLM_API_KEY") || "",
      openAiCompat: __host.settings.read("OPENAI_COMPAT_API_KEY") || ""
    },
    baseUrl: {
      liteLlm: __host.settings.read("LITELLM_BASE_URL") || "",
      openAiCompat: __host.settings.read("OPENAI_COMPAT_BASE_URL") || ""
    },
    model: "gpt-5-mini",
    logLevel: "warn",
    provider: "openai-responses"
  },
  dirname: __dirname,
  host: __host,
  logLevel: "info",
  traceConfig: {
    program: "matchBlock.agency"
  }
});
const graph = __globalCtx.graph;

// Handler result builtins and interrupt response constructors (unified types)
export function approve(value?: any) { return { type: "approve" as const, value }; }
export function reject(reason?: string) { return { type: "reject" as const, value: reason }; }
function propagate() { return { type: "propagate" as const }; }
function pass() { return { type: "pass" as const }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, hasInterrupts, isPaused, isDebugger };
type __ResumeOptions = { overrides?: Record<string, unknown>; metadata?: Record<string, any>; abortSignal?: AbortSignal; pauseSignal?: AbortSignal; invocation?: InvocationOptions };
export const respondToInterrupts = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: __ResumeOptions) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, abortSignal: opts?.abortSignal, pauseSignal: opts?.pauseSignal, invocation: opts?.invocation });
type __ResumeFromCheckpointOptions = { metadata?: Record<string, any>; abortSignal?: AbortSignal; pauseSignal?: AbortSignal; invocation?: InvocationOptions };
export const resumeFromCheckpoint = (paused: PausedCheckpoint, opts?: __ResumeFromCheckpointOptions) => _resumeFromCheckpoint({ ctx: __globalCtx, paused, metadata: opts?.metadata, abortSignal: opts?.abortSignal, pauseSignal: opts?.pauseSignal, invocation: opts?.invocation });
export const rewindFrom = (checkpoint: Checkpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });
const __resumeFromCheckpoint = (checkpoint: Checkpoint, overrides?: ResumeOverrides) => _resumeCliFromCheckpoint({ ctx: __globalCtx, checkpoint, overrides });

// Invoke an exported function in a node-grade execution frame. Used by
// `agency serve` to call a function from an HTTP/MCP request — outside any
// Agency execution frame, which generated function bodies otherwise require.
export const __invokeFunction = (fn: any, namedArgs: Record<string, unknown>) => _runExportedFunction({ ctx: __globalCtx, fn, namedArgs, initializeGlobals: __initializeGlobals });

// Serve-only invokers: identical execution to the entries above, but they hand
// back a ServedInvocationOutcome (value/error + per-invocation usage snapshot)
// so the serve adapters can report authoritative cost. `discoverExports`
// requires all three; a bundle without them must be recompiled.
export const __invokeFunctionForServe = (fn: any, namedArgs: Record<string, unknown>, invocation?: InvocationOptions) => _runExportedFunctionForServe({ ctx: __globalCtx, fn, namedArgs, invocation, initializeGlobals: __initializeGlobals });
export const __invokeNodeForServe = (nodeName: string, data: Record<string, any>, invocation?: InvocationOptions) => _runNodeForServe({ ctx: __globalCtx, nodeName, data, invocation, initializeGlobals: __initializeGlobals });
type ServeResumeOptions = { overrides?: Record<string, unknown>; metadata?: Record<string, any>; invocation?: InvocationOptions };
export const __respondToInterruptsForServe = (interrupts: Interrupt[], responses: InterruptResponse[], opts?: ServeResumeOptions) => _respondToInterruptsForServe({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, invocation: opts?.invocation });

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

// Wrap stateful runtime functions as AgencyFunction instances. Each `_impl`
// takes the run first, as every AgencyFunction body does.
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

async function __initializeGlobals(__run) {
  const __ctx = __run.ctx;
  if (__ctx.globals.isInitialized("matchBlock.agency")) {
    return;
  }
  __ctx.globals.markInitialized("matchBlock.agency")
}
__registerGlobalsInit("matchBlock.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__run) {
  const __ctx = __run.ctx;
}
__registerCallbacksInit("matchBlock.agency", __registerTopLevelCallbacks);
__functionRefReviver.registry = __toolRegistry;
graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
  const __run = __setupData.run;
  const __stack = __setupData.stack;
const __step = __setupData.step;
const __self = __setupData.self;
const __ctx = __run.ctx;
let __forked;
let __functionCompleted = false;
  claimFrameForScope(__stack, "main", "matchBlock.agency", __run.log);
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "matchBlock.agency", scopeName: "main", stack: __run.stack, threads: __setupData.threads });
  try {
    await __withChildRun(__run, {
      ctx: __ctx,
      stack: __ctx.stateStack,
      threads: __setupData.threads
    }, "its body", async (__run) => {
      await runner.hook(0, __run, async (__run) => {
await callHook(__run, {
          name: "onNodeStart",
          data: {
            nodeName: "main"
          }
        })
      });
      await runner.step(1, __run, async (runner, __run) => {
//  Test match blocks (pattern matching)
//  Simple match with string literals
      });
      await runner.step(2, __run, async (runner, __run) => {
__stack.locals.action = `start`;
      });
      await runner.ifElse(3, __run, [

  {
    condition: async (__run) => __stack.locals.action === `start`,
    body: async (runner, __run) => {
await runner.step(0, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`Starting...`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.action === `stop`,
    body: async (runner, __run) => {
await runner.step(1, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`Stopping...`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.action === `restart`,
    body: async (runner, __run) => {
await runner.step(2, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`Restarting...`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

], async (runner, __run) => {
await runner.step(3, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
              type: "positional",
              args: [`Unknown action`]
            });
if (hasInterrupts(__funcResult)) {
              await __run.ctx.pendingPromises.awaitAll()
              runner.halt({
                ...__state,
                data: __funcResult
              })
              return;
            }
if (isAborted(__funcResult)) {
              throw __funcResult.toError()
            }
          });
});
      await runner.step(4, __run, async (runner, __run) => {
//  Match with number literals
      });
      await runner.step(5, __run, async (runner, __run) => {
__stack.locals.statusCode = 200;
      });
      await runner.ifElse(6, __run, [

  {
    condition: async (__run) => __stack.locals.statusCode === 200,
    body: async (runner, __run) => {
await runner.step(0, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`OK`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.statusCode === 404,
    body: async (runner, __run) => {
await runner.step(1, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`Not Found`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.statusCode === 500,
    body: async (runner, __run) => {
await runner.step(2, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`Internal Server Error`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

], async (runner, __run) => {
await runner.step(3, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
              type: "positional",
              args: [`Unknown status`]
            });
if (hasInterrupts(__funcResult)) {
              await __run.ctx.pendingPromises.awaitAll()
              runner.halt({
                ...__state,
                data: __funcResult
              })
              return;
            }
if (isAborted(__funcResult)) {
              throw __funcResult.toError()
            }
          });
});
      await runner.step(7, __run, async (runner, __run) => {
//  Match with variable assignment in body
      });
      await runner.step(8, __run, async (runner, __run) => {
__stack.locals.grade = `A`;
      });
      await runner.step(9, __run, async (runner, __run) => {
__stack.locals.points = 0;
      });
      await runner.ifElse(10, __run, [

  {
    condition: async (__run) => __stack.locals.grade === `A`,
    body: async (runner, __run) => {
await runner.step(0, __run, async (runner, __run) => {
__stack.locals.a = 100;
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.grade === `B`,
    body: async (runner, __run) => {
await runner.step(1, __run, async (runner, __run) => {
__stack.locals.b = 85;
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.grade === `C`,
    body: async (runner, __run) => {
await runner.step(2, __run, async (runner, __run) => {
__stack.locals.c = 70;
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.grade === `D`,
    body: async (runner, __run) => {
await runner.step(3, __run, async (runner, __run) => {
__stack.locals.d = 55;
            });
    },
  },

], async (runner, __run) => {
await runner.step(4, __run, async (runner, __run) => {
__stack.locals.e = 0;
          });
});
      await runner.step(11, __run, async (runner, __run) => {
//  Match with function calls in body
      });
      await runner.step(12, __run, async (runner, __run) => {
__stack.locals.level = `debug`;
      });
      await runner.ifElse(13, __run, [

  {
    condition: async (__run) => __stack.locals.level === `debug`,
    body: async (runner, __run) => {
await runner.step(0, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`Debug mode enabled`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.level === `info`,
    body: async (runner, __run) => {
await runner.step(1, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`Info level logging`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.level === `warn`,
    body: async (runner, __run) => {
await runner.step(2, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`Warning level`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.level === `error`,
    body: async (runner, __run) => {
await runner.step(3, __run, async (runner, __run) => {
const __funcResult = await __call(__run, print, {
                type: "positional",
                args: [`Error level`]
              });
if (hasInterrupts(__funcResult)) {
                await __run.ctx.pendingPromises.awaitAll()
                runner.halt({
                  ...__state,
                  data: __funcResult
                })
                return;
              }
if (isAborted(__funcResult)) {
                throw __funcResult.toError()
              }
            });
    },
  },

]);
      await runner.step(14, __run, async (runner, __run) => {
//  Match with array results
      });
      await runner.step(15, __run, async (runner, __run) => {
__stack.locals.resultType = `array`;
      });
      await runner.ifElse(16, __run, [

  {
    condition: async (__run) => __stack.locals.resultType === `array`,
    body: async (runner, __run) => {
await runner.step(0, __run, async (runner, __run) => {
__stack.locals.data1 = [1, 2, 3];
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.resultType === `object`,
    body: async (runner, __run) => {
await runner.step(1, __run, async (runner, __run) => {
__stack.locals.data2 = {
                "x": 1,
                "y": 2
              };
            });
    },
  },

], async (runner, __run) => {
await runner.step(2, __run, async (runner, __run) => {
__stack.locals.data3 = [];
          });
});
      await runner.step(17, __run, async (runner, __run) => {
//  Match with object results
      });
      await runner.step(18, __run, async (runner, __run) => {
__stack.locals.format = `json`;
      });
      await runner.ifElse(19, __run, [

  {
    condition: async (__run) => __stack.locals.format === `xml`,
    body: async (runner, __run) => {
await runner.step(0, __run, async (runner, __run) => {
__stack.locals.output1 = {
                "type": `xml`,
                "ext": `.xml`
              };
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.format === `json`,
    body: async (runner, __run) => {
await runner.step(1, __run, async (runner, __run) => {
__stack.locals.output2 = {
                "type": `json`,
                "ext": `.json`
              };
            });
    },
  },

  {
    condition: async (__run) => __stack.locals.format === `csv`,
    body: async (runner, __run) => {
await runner.step(2, __run, async (runner, __run) => {
__stack.locals.output3 = {
                "type": `csv`,
                "ext": `.csv`
              };
            });
    },
  },

], async (runner, __run) => {
await runner.step(3, __run, async (runner, __run) => {
__stack.locals.output4 = {
              "type": `unknown`,
              "ext": ``
            };
          });
});
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(20, __run, async (__run) => {
await callHook(__run, {
        name: "onNodeEnd",
        data: {
          nodeName: "main",
          data: undefined
        }
      })
    });
    return {
      messages: __run.threads,
      data: undefined
    };
  } catch (__error) {
    if (__error instanceof RunControlSignal) {
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
              __run.log?.error?.({
                errorType: "runtimeError",
                message: __errMsg,
                functionName: "main",
              });
            }
    return {
      messages: __run.threads,
      data: runtimeFailure(__error, { functionName: "main" })
    };
  }
})
export async function main({ messages: __invocationMessages, callbacks: __invocationCallbacks, config: __invocationConfig, traceId: __invocationTraceId, invocationInput: __invocationInput, abortSignal: __invocationAbortSignal, pauseSignal: __invocationPauseSignal }: ({ messages?: any; callbacks?: any; invocationInput?: unknown; abortSignal?: AbortSignal; pauseSignal?: AbortSignal } & InvocationOptions) = {}): Promise<RunNodeResult<any>> {
  return runNode({
    ctx: __globalCtx,
    nodeName: "main",
    data: {},
    messages: __invocationMessages,
    callbacks: __invocationCallbacks,
    invocation: {
      config: __invocationConfig,
      traceId: __invocationTraceId
    },
    input: __invocationInput,
    abortSignal: __invocationAbortSignal,
    pauseSignal: __invocationPauseSignal,
    initializeGlobals: __initializeGlobals
  });
}
export const __mainNodeParams = [];
if (__host.system.isMainModule(import.meta.url)) {
  try {
    const initialState = {
      messages: new ThreadStore(),
      data: {}
    };
    const __result = await runCliEntry({
      nodeNames: ["main"],
      startNode: (nodeName: string) => runNode({
        ctx: __globalCtx,
        nodeName: nodeName,
        data: initialState.data,
        messages: initialState.messages,
        initializeGlobals: __initializeGlobals
      }),
      resume: __resumeFromCheckpoint
    });
    await resolveCliInterrupts(__result, respondToInterrupts)
  } catch (__error: any) {
    await reportBudgetExceededAndExit(__error)
    console.error(`
Agent crashed: ${__error.message}`)
    await flushPendingStatelogPosts()
    throw __error
  }
}
export default graph
export const __sourceMap = {"matchBlock.agency:main":{"2":{"line":4,"col":2},"3":{"line":5,"col":2},"5":{"line":13,"col":2},"6":{"line":14,"col":2},"8":{"line":22,"col":2},"9":{"line":23,"col":2},"10":{"line":24,"col":2},"12":{"line":33,"col":2},"13":{"line":34,"col":2},"15":{"line":42,"col":2},"16":{"line":43,"col":2},"18":{"line":53,"col":2},"19":{"line":54,"col":2},"3.0":{"line":6,"col":15},"3.1":{"line":7,"col":14},"3.2":{"line":8,"col":17},"3.3":{"line":9,"col":9},"6.0":{"line":15,"col":11},"6.1":{"line":16,"col":11},"6.2":{"line":17,"col":11},"6.3":{"line":18,"col":9},"10.0":{"line":25,"col":11},"10.1":{"line":26,"col":11},"10.2":{"line":27,"col":11},"10.3":{"line":28,"col":11},"10.4":{"line":29,"col":9},"13.0":{"line":35,"col":15},"13.1":{"line":36,"col":14},"13.2":{"line":37,"col":14},"13.3":{"line":38,"col":15},"16.0":{"line":44,"col":15},"16.1":{"line":45,"col":16},"16.2":{"line":49,"col":9},"19.0":{"line":55,"col":13},"19.1":{"line":59,"col":14},"19.2":{"line":63,"col":13},"19.3":{"line":67,"col":9}}};