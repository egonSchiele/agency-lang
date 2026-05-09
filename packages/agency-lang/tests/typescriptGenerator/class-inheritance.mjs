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
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl, _run as __run_impl,
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
    program: "class-inheritance.agency"
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
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: undefined, variadic: false }, { name: "options", hasDefault: false, defaultValue: undefined, variadic: false }], toolDefinition: null }, __toolRegistry);
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
  __ctx.globals.markInitialized("class-inheritance.agency")
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "class-inheritance.agency",
  fn: readSkill,
  params: __readSkillToolParams.map(p => ({ name: p, hasDefault: false, defaultValue: undefined, variadic: false })),
  toolDefinition: __readSkillTool,
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
class Animal {

  name: string;


  constructor(name: string) {


    this.name = name;

  }


  async speak(__state: any = undefined) {
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
if (!__ctx.globals.isInitialized("class-inheritance.agency")) {
      await __initializeGlobals(__ctx)
    }
let __funcStartTime: number = performance.now();
await callHook({
      callbacks: __ctx.callbacks,
      name: "onFunctionStart",
      data: {
        functionName: "Animal.speak",
        args: {},
        isBuiltin: false,
        moduleId: "class-inheritance.agency"
      }
    })
__self.__retryable = __self.__retryable ?? true;
const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "class-inheritance.agency", scopeName: "Animal.speak" });
let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "class-inheritance.agency", scopeName: "Animal.speak", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;

}

try {
      await runner.step(0, async (runner) => {
__stack.locals.n = this.name;
      });
      await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.n + ` makes a sound`)
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
    functionName: "Animal.speak",
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
            functionName: "Animal.speak",
            timeTaken: performance.now() - __funcStartTime
          }
        })
      }
    }
  }


  toJSON(): object {
    return {

      __class: "class-inheritance.agency::Animal",

      name: this.name,

    };
  }

  static fromJSON(data: any): Animal {
    const instance = Object.create(Animal.prototype);

    instance.name = data.name;

    return instance;
  }
}

__globalCtx.registerClass("class-inheritance.agency::Animal", Animal);
class Dog extends Animal {

  breed: string;


  constructor(name: string, breed: string) {

    super(name);


    this.breed = breed;

  }


  async speak(__state: any = undefined) {
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
if (!__ctx.globals.isInitialized("class-inheritance.agency")) {
      await __initializeGlobals(__ctx)
    }
let __funcStartTime: number = performance.now();
await callHook({
      callbacks: __ctx.callbacks,
      name: "onFunctionStart",
      data: {
        functionName: "Dog.speak",
        args: {},
        isBuiltin: false,
        moduleId: "class-inheritance.agency"
      }
    })
__self.__retryable = __self.__retryable ?? true;
const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "class-inheritance.agency", scopeName: "Dog.speak" });
let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "class-inheritance.agency", scopeName: "Dog.speak", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;

}

try {
      await runner.step(0, async (runner) => {
__stack.locals.n = this.name;
      });
      await runner.step(1, async (runner) => {
__functionCompleted = true;
runner.halt(__stack.locals.n + ` barks`)
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
    functionName: "Dog.speak",
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
            functionName: "Dog.speak",
            timeTaken: performance.now() - __funcStartTime
          }
        })
      }
    }
  }


  toJSON(): object {
    return {

      ...super.toJSON(),

      __class: "class-inheritance.agency::Dog",

      breed: this.breed,

    };
  }

  static fromJSON(data: any): Dog {
    const instance = Object.create(Dog.prototype);

    instance.name = data.name;

    instance.breed = data.breed;

    return instance;
  }
}

__globalCtx.registerClass("class-inheritance.agency::Dog", Dog);
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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "class-inheritance.agency", scopeName: "main" });
  try {
    await runner.step(0, async (runner) => {
__stack.locals.dog = new Dog(`Rex`, `Labrador`);
    });
    await runner.step(1, async (runner) => {
__stack.locals.result = await __callMethod(__stack.locals.dog, "speak", {
        type: "positional",
        args: []
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
    });
    await runner.step(2, async (runner) => {
runner.halt({
        messages: __threads,
        data: __stack.locals.result
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
export const __sourceMap = {"class-inheritance.agency:Animal.speak":{"0":{"line":4,"col":4},"1":{"line":5,"col":4}},"class-inheritance.agency:Dog.speak":{"0":{"line":13,"col":4},"1":{"line":14,"col":4}},"class-inheritance.agency:main":{"0":{"line":19,"col":2},"1":{"line":20,"col":2},"2":{"line":21,"col":2}}};