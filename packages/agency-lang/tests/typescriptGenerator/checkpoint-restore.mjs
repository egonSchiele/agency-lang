import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "agency-lang/zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import os from "os";
import type { Run as __Run, GraphState, Interrupt, InterruptResponse, Checkpoint, PausedCheckpoint, LLMClient, InvocationOptions, ResumeOverrides } from "agency-lang/runtime";
import {
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
  DeterministicClient as __DeterministicClient,
  installFetchMock as __installFetchMock,
  createLogger as __createLogger,
  runCliEntry,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = __process.cwd();

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "",
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
    model: "gpt-5-mini",
    logLevel: "warn",
    provider: "openai-responses"
  },
  dirname: __dirname,
  logLevel: "info",
  traceConfig: {
    program: "checkpoint-restore.agency"
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
  if (__ctx.globals.isInitialized("checkpoint-restore.agency")) {
    return;
  }
  __ctx.globals.markInitialized("checkpoint-restore.agency")
}
__registerGlobalsInit("checkpoint-restore.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__run) {
  const __ctx = __run.ctx;
}
__registerCallbacksInit("checkpoint-restore.agency", __registerTopLevelCallbacks);
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
  claimFrameForScope(__stack, "main", "checkpoint-restore.agency", __run.log);
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "checkpoint-restore.agency", scopeName: "main", stack: __run.stack, threads: __setupData.threads });
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
__stack.locals.cp = await __call(__run, checkpoint, {
          type: "positional",
          args: []
        });
if (hasInterrupts(__stack.locals.cp)) {
          await __run.ctx.pendingPromises.awaitAll()
          runner.halt({
            ...__state,
            data: __stack.locals.cp
          })
          return;
        }
if (isAborted(__stack.locals.cp)) {
          throw __stack.locals.cp.toError()
        }
      });
      await runner.step(2, __run, async (runner, __run) => {
__stack.locals.x = 1;
      });
      await runner.step(3, __run, async (runner, __run) => {
const __funcResult = await __call(__run, restore, {
          type: "positional",
          args: [__stack.locals.cp, {}]
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
      await runner.step(4, __run, async (runner, __run) => {
runner.halt({
          messages: __run.threads,
          data: __stack.locals.x
        })
return;
      });
    })
    if (runner.halted) return runner.haltResult;
    await runner.hook(5, __run, async (__run) => {
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
if (__process.argv[1] === fileURLToPath(import.meta.url)) {
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
export const __sourceMap = {"checkpoint-restore.agency:main":{"1":{"line":1,"col":2},"2":{"line":2,"col":2},"3":{"line":3,"col":2},"4":{"line":4,"col":2}}};