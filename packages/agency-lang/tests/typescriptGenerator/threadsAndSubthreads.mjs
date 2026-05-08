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
    program: "threadsAndSubthreads.agency"
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
  __ctx.globals.markInitialized("threadsAndSubthreads.agency")
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "threadsAndSubthreads.agency",
  fn: readSkill,
  params: __readSkillToolParams.map(p => ({ name: p, hasDefault: false, defaultValue: undefined, variadic: false })),
  toolDefinition: __readSkillTool,
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
async function __foo_impl(__state: InternalFunctionState | undefined = undefined) {
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
  if (!__ctx.globals.isInitialized("threadsAndSubthreads.agency")) {
    await __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "foo",
      args: {},
      isBuiltin: false,
      moduleId: "threadsAndSubthreads.agency"
    }
  })
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "threadsAndSubthreads.agency", scopeName: "foo" });
  let __resultCheckpointId = -1;
if (__ctx.stateStack.currentNodeId()) {
  __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "foo", stepPath: "", label: "result-entry" });
}
if (__ctx._pendingArgOverrides) {
  const __overrides = __ctx._pendingArgOverrides;
  __ctx._pendingArgOverrides = undefined;

}

  try {
    await runner.thread(0, __threads, "create", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res1 = await runPrompt({
          ctx: __ctx,
          prompt: `What are the first 5 prime numbers?`,
          messages: __threads.getOrCreateActive(),
          responseFormat: z.object({
            response: z.array(z.number())
          }),
          clientConfig: {},
          maxToolCallRounds: 10,
          stateStack: __stateStack,
          removedTools: __self.__removedTools,
          checkpointInfo: runner.getCheckpointInfo()
        });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res1)) {
          await __ctx.pendingPromises.awaitAll()
          runner.halt(__stack.locals.res1)
          return;
        }
      });
await runner.thread(1, __threads, "createSubthread", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res2 = await runPrompt({
            ctx: __ctx,
            prompt: `What are the next 2 prime numbers after those?`,
            messages: __threads.getOrCreateActive(),
            responseFormat: z.object({
              response: z.array(z.number())
            }),
            clientConfig: {},
            maxToolCallRounds: 10,
            stateStack: __stateStack,
            removedTools: __self.__removedTools,
            checkpointInfo: runner.getCheckpointInfo()
          });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res2)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.res2)
            return;
          }
        });
await runner.thread(1, __threads, "createSubthread", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res3 = await runPrompt({
              ctx: __ctx,
              prompt: `And what is the sum of all those numbers combined?`,
              messages: __threads.getOrCreateActive(),
              responseFormat: z.object({
                response: z.number()
              }),
              clientConfig: {},
              maxToolCallRounds: 10,
              stateStack: __stateStack,
              removedTools: __self.__removedTools,
              checkpointInfo: runner.getCheckpointInfo()
            });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res3)) {
              await __ctx.pendingPromises.awaitAll()
              runner.halt(__stack.locals.res3)
              return;
            }
          });
        });
await runner.thread(2, __threads, "create", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res5 = await runPrompt({
              ctx: __ctx,
              prompt: `And what is the sum of all those numbers combined?`,
              messages: __threads.getOrCreateActive(),
              responseFormat: z.object({
                response: z.number()
              }),
              clientConfig: {},
              maxToolCallRounds: 10,
              stateStack: __stateStack,
              removedTools: __self.__removedTools,
              checkpointInfo: runner.getCheckpointInfo()
            });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res5)) {
              await __ctx.pendingPromises.awaitAll()
              runner.halt(__stack.locals.res5)
              return;
            }
          });
        });
      });
await runner.thread(2, __threads, "createSubthread", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res4 = await runPrompt({
            ctx: __ctx,
            prompt: `And what is the sum of all those numbers combined?`,
            messages: __threads.getOrCreateActive(),
            responseFormat: z.object({
              response: z.number()
            }),
            clientConfig: {},
            maxToolCallRounds: 10,
            stateStack: __stateStack,
            removedTools: __self.__removedTools,
            checkpointInfo: runner.getCheckpointInfo()
          });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res4)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt(__stack.locals.res4)
            return;
          }
        });
      });
    });
    await runner.step(1, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res1`, __stack.locals.res1]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__funcResult)
        return;
      }
    });
    await runner.step(2, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res2`, __stack.locals.res2]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__funcResult)
        return;
      }
    });
    await runner.step(3, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res3`, __stack.locals.res3]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__funcResult)
        return;
      }
    });
    await runner.step(4, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res4`, __stack.locals.res4]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__funcResult)
        return;
      }
    });
    await runner.step(5, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res5`, __stack.locals.res5]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt(__funcResult)
        return;
      }
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
    functionName: "foo",
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
          functionName: "foo",
          timeTaken: performance.now() - __funcStartTime
        }
      })
    }
  }
}
const foo = __AgencyFunction.create({
  name: "foo",
  module: "threadsAndSubthreads.agency",
  fn: __foo_impl,
  params: [],
  toolDefinition: {
    name: "foo",
    description: `No description provided.`,
    schema: z.object({})
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
  const runner = new Runner(__ctx, __stack, { nodeContext: true, state: __stack, moduleId: "threadsAndSubthreads.agency", scopeName: "main" });
  try {
    await runner.thread(0, __threads, "create", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res1 = await runPrompt({
          ctx: __ctx,
          prompt: `What are the first 5 prime numbers?`,
          messages: __threads.getOrCreateActive(),
          responseFormat: z.object({
            response: z.array(z.number())
          }),
          clientConfig: {},
          maxToolCallRounds: 10,
          stateStack: __stateStack,
          removedTools: __self.__removedTools,
          checkpointInfo: runner.getCheckpointInfo()
        });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res1)) {
          await __ctx.pendingPromises.awaitAll()
          runner.halt({
            messages: __threads,
            data: __stack.locals.res1
          })
          return;
        }
      });
await runner.thread(1, __threads, "createSubthread", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res2 = await runPrompt({
            ctx: __ctx,
            prompt: `What are the next 2 prime numbers after those?`,
            messages: __threads.getOrCreateActive(),
            responseFormat: z.object({
              response: z.array(z.number())
            }),
            clientConfig: {},
            maxToolCallRounds: 10,
            stateStack: __stateStack,
            removedTools: __self.__removedTools,
            checkpointInfo: runner.getCheckpointInfo()
          });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res2)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt({
              messages: __threads,
              data: __stack.locals.res2
            })
            return;
          }
        });
await runner.thread(1, __threads, "createSubthread", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res3 = await runPrompt({
              ctx: __ctx,
              prompt: `And what is the sum of all those numbers combined?`,
              messages: __threads.getOrCreateActive(),
              responseFormat: z.object({
                response: z.number()
              }),
              clientConfig: {},
              maxToolCallRounds: 10,
              stateStack: __stateStack,
              removedTools: __self.__removedTools,
              checkpointInfo: runner.getCheckpointInfo()
            });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res3)) {
              await __ctx.pendingPromises.awaitAll()
              runner.halt({
                messages: __threads,
                data: __stack.locals.res3
              })
              return;
            }
          });
        });
await runner.thread(2, __threads, "create", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res5 = await runPrompt({
              ctx: __ctx,
              prompt: `And what is the sum of all those numbers combined?`,
              messages: __threads.getOrCreateActive(),
              responseFormat: z.object({
                response: z.number()
              }),
              clientConfig: {},
              maxToolCallRounds: 10,
              stateStack: __stateStack,
              removedTools: __self.__removedTools,
              checkpointInfo: runner.getCheckpointInfo()
            });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res5)) {
              await __ctx.pendingPromises.awaitAll()
              runner.halt({
                messages: __threads,
                data: __stack.locals.res5
              })
              return;
            }
          });
        });
      });
await runner.thread(2, __threads, "createSubthread", async (runner) => {
await runner.step(0, async (runner) => {
__self.__removedTools = __self.__removedTools || [];
__stack.locals.res4 = await runPrompt({
            ctx: __ctx,
            prompt: `And what is the sum of all those numbers combined?`,
            messages: __threads.getOrCreateActive(),
            responseFormat: z.object({
              response: z.number()
            }),
            clientConfig: {},
            maxToolCallRounds: 10,
            stateStack: __stateStack,
            removedTools: __self.__removedTools,
            checkpointInfo: runner.getCheckpointInfo()
          });
// halt if this is an interrupt
if (hasInterrupts(__stack.locals.res4)) {
            await __ctx.pendingPromises.awaitAll()
            runner.halt({
              messages: __threads,
              data: __stack.locals.res4
            })
            return;
          }
        });
      });
    });
    await runner.step(1, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res1`, __stack.locals.res1]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __funcResult
        })
        return;
      }
    });
    await runner.step(2, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res2`, __stack.locals.res2]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __funcResult
        })
        return;
      }
    });
    await runner.step(3, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res3`, __stack.locals.res3]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __funcResult
        })
        return;
      }
    });
    await runner.step(4, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res4`, __stack.locals.res4]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __funcResult
        })
        return;
      }
    });
    await runner.step(5, async (runner) => {
const __funcResult = await __call(print, {
        type: "positional",
        args: [`res5`, __stack.locals.res5]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      });
if (hasInterrupts(__funcResult)) {
        await __ctx.pendingPromises.awaitAll()
        runner.halt({
          ...__state,
          data: __funcResult
        })
        return;
      }
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
export const __sourceMap = {"threadsAndSubthreads.agency:foo":{"0":{"line":1,"col":2},"1":{"line":16,"col":2},"2":{"line":17,"col":2},"3":{"line":18,"col":2},"4":{"line":19,"col":2},"5":{"line":20,"col":2},"0.0":{"line":2,"col":4},"0.1.0":{"line":4,"col":6},"0.1.1.0":{"line":6,"col":8},"0.1.1":{"line":5,"col":6},"0.1.2.0":{"line":9,"col":8},"0.1.2":{"line":8,"col":6},"0.1":{"line":3,"col":4},"0.2.0":{"line":13,"col":6},"0.2":{"line":12,"col":4}},"threadsAndSubthreads.agency:main":{"0":{"line":24,"col":2},"1":{"line":39,"col":2},"2":{"line":40,"col":2},"3":{"line":41,"col":2},"4":{"line":42,"col":2},"5":{"line":43,"col":2},"0.0":{"line":25,"col":4},"0.1.0":{"line":27,"col":6},"0.1.1.0":{"line":29,"col":8},"0.1.1":{"line":28,"col":6},"0.1.2.0":{"line":32,"col":8},"0.1.2":{"line":31,"col":6},"0.1":{"line":26,"col":4},"0.2.0":{"line":36,"col":6},"0.2":{"line":35,"col":4}}};