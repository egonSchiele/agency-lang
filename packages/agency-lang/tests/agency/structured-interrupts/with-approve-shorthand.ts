// @ts-nocheck
import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify, range, mostCommon, keys, values, entries, emit } from "agency-lang/stdlib/index.js";
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
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl,
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
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = __process.cwd();

const getDirname = () => __dirname;

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://statelog.adit.io",
    apiKey: __process.env["STATELOG_API_KEY"] || "",
    projectId: "agency-lang",
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
    program: "tests/agency/structured-interrupts/with-approve-shorthand.agency",
    traceDir: "traces"
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
export const __getCheckpoints = () => __globalCtx.checkpoints;

const __toolRegistry: Record<string, any> = {};

function __registerTool(value: unknown, name?: string) {
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[name ?? value.name] = value;
  }
}

// Wrap stateful runtime functions as AgencyFunction instances
const checkpoint = __AgencyFunction.create({ name: "checkpoint", module: "__runtime", fn: __checkpoint_impl, params: [], toolDefinition: null }, __toolRegistry);
const getCheckpoint = __AgencyFunction.create({ name: "getCheckpoint", module: "__runtime", fn: __getCheckpoint_impl, params: [{ name: "checkpointId", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
const restore = __AgencyFunction.create({ name: "restore", module: "__runtime", fn: __restore_impl, params: [{ name: "checkpointIdOrCheckpoint", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "options", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
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

__registerTool(print);
__registerTool(printJSON);
__registerTool(input);
__registerTool(sleep);
__registerTool(round);
__registerTool(fetch);
__registerTool(fetchJSON);
__registerTool(read);
__registerTool(write);
__registerTool(readImage);
__registerTool(notify);
__registerTool(range);
__registerTool(mostCommon);
__registerTool(keys);
__registerTool(values);
__registerTool(entries);
__registerTool(emit);
async function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("tests/agency/structured-interrupts/with-approve-shorthand.agency")
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "tests/agency/structured-interrupts/with-approve-shorthand.agency",
  fn: readSkill,
  params: __readSkillToolParams.map(p => ({ name: p, hasDefault: false, defaultValue: undefined, variadic: false })),
  toolDefinition: __readSkillTool,
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;

async function __check_impl(__state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("tests/agency/structured-interrupts/with-approve-shorthand.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "check",
      args: {},
      isBuiltin: false,
      moduleId: "tests/agency/structured-interrupts/with-approve-shorthand.agency"
    }
  })
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "tests/agency/structured-interrupts/with-approve-shorthand.agency", scopeName: "check" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "tests/agency/structured-interrupts/with-approve-shorthand.agency", scopeName: "check", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;

}

  try {
    await runner.step(0, async (runner) => {
// Resume path: check for a response by interruptId
const __response = __ctx.getInterruptResponse(__self.__interruptId_0);
if (__response) {
  if (__response.type === "approve") {
    // approved, continue execution
  } else if (__response.type === "reject") {
    // rejected, halt
    
    
    runner.halt(failure("interrupt rejected", { retryable: false, checkpoint: __ctx.getResultCheckpoint() }));
    
    return;
  }
} else {
  // First run: call handlers, then propagate if unhandled
  const __handlerResult = await interruptWithHandlers("mytest::check", `confirm`, {}, "./tests/agency/structured-interrupts/with-approve-shorthand.agency", __ctx, __stateStack);
  if (isRejected(__handlerResult)) {
    
    
    runner.halt(failure(__handlerResult.value ?? "interrupt rejected", { retryable: false, checkpoint: __ctx.checkpoints.get(__resultCheckpointId) }));
    
    return;
  }
  if (!isApproved(__handlerResult)) {
    // No handler — propagate interrupt array to TypeScript caller
    // Store interruptId on frame BEFORE checkpoint so it's captured in the snapshot
    __self.__interruptId_0 = __handlerResult[0].interruptId;
    const __checkpointId = __ctx.checkpoints.create(__stateStack, __ctx, { moduleId: "tests/agency/structured-interrupts/with-approve-shorthand.agency", scopeName: "check", stepPath: "0" });
    __handlerResult[0].checkpointId = __checkpointId;
    __handlerResult[0].checkpoint = __ctx.checkpoints.get(__checkpointId);
    
    
    runner.halt(__handlerResult);
    
    return;
  }
  // Approved — continue execution past interrupt
}

    });
    await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(`ok`)
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
    functionName: "check",
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
          functionName: "check",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const check = __AgencyFunction.create({
  name: "check",
  module: "tests/agency/structured-interrupts/with-approve-shorthand.agency",
  fn: __check_impl,
  params: [],
  toolDefinition: {
    name: "check",
    description: `No description provided.`,
    schema: z.object({})
  }
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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "tests/agency/structured-interrupts/with-approve-shorthand.agency", scopeName: "main" });
  try {
    await runner.step(0, async (runner) => {
runner.halt({
        messages: __threads,
        data: await __call(check, {
          type: "positional",
          args: []
        }, {
          ctx: __ctx,
          threads: __threads,
          stateStack: __stateStack
        })
      })
return;
    });
    await runner.step(1, async (runner) => {
with
    });
    await runner.step(2, async (runner) => {
approve
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
export const __sourceMap = {"tests/agency/structured-interrupts/with-approve-shorthand.agency:check":{"0":{"line":1,"col":2},"1":{"line":2,"col":2}},"tests/agency/structured-interrupts/with-approve-shorthand.agency:main":{"0":{"line":6,"col":2},"1":{"line":6,"col":17},"2":{"line":6,"col":22}}};