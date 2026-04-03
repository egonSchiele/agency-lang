import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify } from "/Users/adityabhargava/agency-lang/stdlib/index.js";
import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid, registerProvider, registerTextModel } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse, RewindCheckpoint } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint, getCheckpoint, restore,
  interrupt, isInterrupt, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupt as _respondToInterrupt,
  approveInterrupt as _approveInterrupt,
  rejectInterrupt as _rejectInterrupt,
  resolveInterrupt as _resolveInterrupt,
  modifyInterrupt as _modifyInterrupt,
  resumeFromState as _resumeFromState,
  rewindFrom as _rewindFrom,
  ToolCallError,
  RestoreSignal,
  deepClone as __deepClone,
  not, eq, neq, lt, lte, gt, gte, and, or,
  head, tail, empty,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  _builtinTool as __builtinTool,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = process.cwd();

const getDirname = () => __dirname;

const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://agency-lang.com",
    apiKey: process.env["STATELOG_API_KEY"] || "",
    projectId: "",
    debugMode: false
  },
  smoltalkDefaults: {
    openAiApiKey: process.env["OPENAI_API_KEY"] || "",
    googleApiKey: process.env["GEMINI_API_KEY"] || "",
    model: "gpt-4o-mini",
    logLevel: "warn",
    statelog: {
      host: "https://agency-lang.com",
      projectId: "smoltalk",
      apiKey: process.env["STATELOG_SMOLTALK_API_KEY"] || "",
      traceId: nanoid()
    }
  },
  dirname: __dirname
});
const graph = __globalCtx.graph;

// Path-dependent builtin wrappers
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// tool() function — looks up a tool by name from the module's __toolRegistry
function tool(__name: string) {
  return __builtinTool(__name, __toolRegistry);
}

// Handler result builtins
function approve(value?: any) { return { type: "approved" as const, value }; }
function reject(value?: any) { return { type: "rejected" as const, value }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, isDebugger };
export const respondToInterrupt = (interrupt: Interrupt, response: InterruptResponse, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupt({ ctx: __globalCtx, interrupt, interruptResponse: response, overrides: opts?.overrides, metadata: opts?.metadata });
export const approveInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _approveInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const rejectInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _rejectInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const modifyInterrupt = (interrupt: Interrupt, newArguments: Record<string, any>, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _modifyInterrupt({ ctx: __globalCtx, interrupt, newArguments, overrides: opts?.overrides, metadata: opts?.metadata });
export const resolveInterrupt = (interrupt: Interrupt, value: any, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _resolveInterrupt({ ctx: __globalCtx, interrupt, value, overrides: opts?.overrides, metadata: opts?.metadata });
export const rewindFrom = (checkpoint: RewindCheckpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });

export const __setDebugger = (dbg: any) => { __globalCtx.debuggerState = dbg; };
export const __getCheckpoints = () => __globalCtx.checkpoints;
function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("threadsAndSubthreads.agency")
}
export const __fooTool = {
  name: "foo",
  description: `No description provided.`,
  schema: z.object({})
};
export const __fooToolParams = [];
const __toolRegistry = {
  foo: {
    definition: __fooTool,
    handler: {
      name: "foo",
      params: __fooToolParams,
      execute: foo,
      isBuiltin: false
    }
  },
  readSkill: {
    definition: __readSkillTool,
    handler: {
      name: "readSkill",
      params: __readSkillToolParams,
      execute: readSkill,
      isBuiltin: true
    }
  }
};

export async function foo(__state: InternalFunctionState | undefined = undefined) {
  const __setupData = setupFunction({
    state: __state
  });
  // __state will be undefined if this function is being called as a tool by an llm
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
    __initializeGlobals(__ctx)
  }
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "foo",
      args: {},
      isBuiltin: false
    }
  })
  await __ctx.audit({
    type: "functionCall",
    functionName: "foo",
    args: {},
    result: undefined
  })
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {
      
            __stack.step++;
    }
    if (__step <= 1) {
            const __sub_1 = __stack.locals.__substep_1 ?? 0;
if (__sub_1 <= 0) {
  const __tid = __threads.create();
__threads.pushActive(__tid)

  __stack.locals.__substep_1 = 1;
}

if (__sub_1 <= 1) {
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
          interruptData: __state?.interruptData,
          removedTools: __self.__removedTools
        });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res1)) {
          await __ctx.pendingPromises.awaitAll()
          return __stack.locals.res1;
        }

  __stack.locals.__substep_1 = 2;
}

if (__sub_1 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "foo", stepPath: "1.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res1",
          prompt: `What are the first 5 prime numbers?`,
          response: __stack.locals.res1,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1 = 3;
}

if (__sub_1 <= 3) {
  const __sub_1_3 = __stack.locals.__substep_1_3 ?? 0;
if (__sub_1_3 <= 0) {
  const __tid = __threads.createSubthread();
__threads.pushActive(__tid)

  __stack.locals.__substep_1_3 = 1;
}

if (__sub_1_3 <= 1) {
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
            interruptData: __state?.interruptData,
            removedTools: __self.__removedTools
          });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res2)) {
            await __ctx.pendingPromises.awaitAll()
            return __stack.locals.res2;
          }

  __stack.locals.__substep_1_3 = 2;
}

if (__sub_1_3 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "foo", stepPath: "1.3.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res2",
          prompt: `What are the next 2 prime numbers after those?`,
          response: __stack.locals.res2,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1_3 = 3;
}

if (__sub_1_3 <= 3) {
  const __sub_1_3_3 = __stack.locals.__substep_1_3_3 ?? 0;
if (__sub_1_3_3 <= 0) {
  const __tid = __threads.createSubthread();
__threads.pushActive(__tid)

  __stack.locals.__substep_1_3_3 = 1;
}

if (__sub_1_3_3 <= 1) {
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
              interruptData: __state?.interruptData,
              removedTools: __self.__removedTools
            });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res3)) {
              await __ctx.pendingPromises.awaitAll()
              return __stack.locals.res3;
            }

  __stack.locals.__substep_1_3_3 = 2;
}

if (__sub_1_3_3 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "foo", stepPath: "1.3.3.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res3",
          prompt: `And what is the sum of all those numbers combined?`,
          response: __stack.locals.res3,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1_3_3 = 3;
}

__threads.popActive();


  __stack.locals.__substep_1_3 = 4;
}

if (__sub_1_3 <= 4) {
  const __sub_1_3_4 = __stack.locals.__substep_1_3_4 ?? 0;
if (__sub_1_3_4 <= 0) {
  const __tid = __threads.create();
__threads.pushActive(__tid)

  __stack.locals.__substep_1_3_4 = 1;
}

if (__sub_1_3_4 <= 1) {
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
              interruptData: __state?.interruptData,
              removedTools: __self.__removedTools
            });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res5)) {
              await __ctx.pendingPromises.awaitAll()
              return __stack.locals.res5;
            }

  __stack.locals.__substep_1_3_4 = 2;
}

if (__sub_1_3_4 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "foo", stepPath: "1.3.4.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res5",
          prompt: `And what is the sum of all those numbers combined?`,
          response: __stack.locals.res5,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1_3_4 = 3;
}

__threads.popActive();


  __stack.locals.__substep_1_3 = 5;
}

__threads.popActive();


  __stack.locals.__substep_1 = 4;
}

if (__sub_1 <= 4) {
  const __sub_1_4 = __stack.locals.__substep_1_4 ?? 0;
if (__sub_1_4 <= 0) {
  const __tid = __threads.createSubthread();
__threads.pushActive(__tid)

  __stack.locals.__substep_1_4 = 1;
}

if (__sub_1_4 <= 1) {
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
            interruptData: __state?.interruptData,
            removedTools: __self.__removedTools
          });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res4)) {
            await __ctx.pendingPromises.awaitAll()
            return __stack.locals.res4;
          }

  __stack.locals.__substep_1_4 = 2;
}

if (__sub_1_4 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "foo", stepPath: "1.4.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res4",
          prompt: `And what is the sum of all those numbers combined?`,
          response: __stack.locals.res4,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1_4 = 3;
}

__threads.popActive();


  __stack.locals.__substep_1 = 5;
}

__threads.popActive();


            __stack.step++;
    }
    if (__step <= 2) {
            __self.__retryable = false;
      await print(`res1`, __stack.locals.res1)
            __stack.step++;
    }
    if (__step <= 3) {
            __self.__retryable = false;
      await print(`res2`, __stack.locals.res2)
            __stack.step++;
    }
    if (__step <= 4) {
            __self.__retryable = false;
      await print(`res3`, __stack.locals.res3)
            __stack.step++;
    }
    if (__step <= 5) {
            __self.__retryable = false;
      await print(`res4`, __stack.locals.res4)
            __stack.step++;
    }
    if (__step <= 6) {
            __self.__retryable = false;
      await print(`res5`, __stack.locals.res5)
            __stack.step++;
    }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error
    }
    if (__error instanceof ToolCallError) {
      __error.retryable = __error.retryable && __self.__retryable
      throw __error
    }
    throw new ToolCallError(__error, { retryable: __self.__retryable })
  } finally {
    if (!__state?.isForked) { __ctx.stateStack.pop() }
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
graph.node("main", async (__state: GraphState) => {
  const __setupData = setupNode({
    state: __state
  });
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
  if (__step <= 0) {
      
          __stack.step++;
  }
  if (__step <= 1) {
          const __sub_1 = __stack.locals.__substep_1 ?? 0;
if (__sub_1 <= 0) {
  const __tid = __threads.create();
__threads.pushActive(__tid)

  __stack.locals.__substep_1 = 1;
}

if (__sub_1 <= 1) {
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
        interruptData: __state?.interruptData,
        removedTools: __self.__removedTools
      });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res1)) {
        await __ctx.pendingPromises.awaitAll()
        return {
          messages: __threads,
          data: __stack.locals.res1
        };
      }

  __stack.locals.__substep_1 = 2;
}

if (__sub_1 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "main", stepPath: "1.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res1",
          prompt: `What are the first 5 prime numbers?`,
          response: __stack.locals.res1,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1 = 3;
}

if (__sub_1 <= 3) {
  const __sub_1_3 = __stack.locals.__substep_1_3 ?? 0;
if (__sub_1_3 <= 0) {
  const __tid = __threads.createSubthread();
__threads.pushActive(__tid)

  __stack.locals.__substep_1_3 = 1;
}

if (__sub_1_3 <= 1) {
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
          interruptData: __state?.interruptData,
          removedTools: __self.__removedTools
        });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res2)) {
          await __ctx.pendingPromises.awaitAll()
          return {
            messages: __threads,
            data: __stack.locals.res2
          };
        }

  __stack.locals.__substep_1_3 = 2;
}

if (__sub_1_3 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "main", stepPath: "1.3.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res2",
          prompt: `What are the next 2 prime numbers after those?`,
          response: __stack.locals.res2,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1_3 = 3;
}

if (__sub_1_3 <= 3) {
  const __sub_1_3_3 = __stack.locals.__substep_1_3_3 ?? 0;
if (__sub_1_3_3 <= 0) {
  const __tid = __threads.createSubthread();
__threads.pushActive(__tid)

  __stack.locals.__substep_1_3_3 = 1;
}

if (__sub_1_3_3 <= 1) {
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
            interruptData: __state?.interruptData,
            removedTools: __self.__removedTools
          });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res3)) {
            await __ctx.pendingPromises.awaitAll()
            return {
              messages: __threads,
              data: __stack.locals.res3
            };
          }

  __stack.locals.__substep_1_3_3 = 2;
}

if (__sub_1_3_3 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "main", stepPath: "1.3.3.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res3",
          prompt: `And what is the sum of all those numbers combined?`,
          response: __stack.locals.res3,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1_3_3 = 3;
}

__threads.popActive();


  __stack.locals.__substep_1_3 = 4;
}

if (__sub_1_3 <= 4) {
  const __sub_1_3_4 = __stack.locals.__substep_1_3_4 ?? 0;
if (__sub_1_3_4 <= 0) {
  const __tid = __threads.create();
__threads.pushActive(__tid)

  __stack.locals.__substep_1_3_4 = 1;
}

if (__sub_1_3_4 <= 1) {
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
            interruptData: __state?.interruptData,
            removedTools: __self.__removedTools
          });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res5)) {
            await __ctx.pendingPromises.awaitAll()
            return {
              messages: __threads,
              data: __stack.locals.res5
            };
          }

  __stack.locals.__substep_1_3_4 = 2;
}

if (__sub_1_3_4 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "main", stepPath: "1.3.4.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res5",
          prompt: `And what is the sum of all those numbers combined?`,
          response: __stack.locals.res5,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1_3_4 = 3;
}

__threads.popActive();


  __stack.locals.__substep_1_3 = 5;
}

__threads.popActive();


  __stack.locals.__substep_1 = 4;
}

if (__sub_1 <= 4) {
  const __sub_1_4 = __stack.locals.__substep_1_4 ?? 0;
if (__sub_1_4 <= 0) {
  const __tid = __threads.createSubthread();
__threads.pushActive(__tid)

  __stack.locals.__substep_1_4 = 1;
}

if (__sub_1_4 <= 1) {
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
          interruptData: __state?.interruptData,
          removedTools: __self.__removedTools
        });
// return early from node if this is an interrupt
if (isInterrupt(__stack.locals.res4)) {
          await __ctx.pendingPromises.awaitAll()
          return {
            messages: __threads,
            data: __stack.locals.res4
          };
        }

  __stack.locals.__substep_1_4 = 2;
}

if (__sub_1_4 <= 2) {
  if (__ctx.callbacks.onCheckpoint) {
  if (__ctx._skipNextCheckpoint) {
    __ctx._skipNextCheckpoint = false;
  } else {
    const __cpId = __ctx.checkpoints.create(__ctx, { moduleId: "threadsAndSubthreads.agency", scopeName: "main", stepPath: "1.4.2" });
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: __stack.step,
          targetVariable: "res4",
          prompt: `And what is the sum of all those numbers combined?`,
          response: __stack.locals.res4,
          model: __ctx.getSmoltalkConfig().model || "unknown",
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);
  }
}

  __stack.locals.__substep_1_4 = 3;
}

__threads.popActive();


  __stack.locals.__substep_1 = 5;
}

__threads.popActive();


          __stack.step++;
  }
  if (__step <= 2) {
          __self.__retryable = false;
    await print(`res1`, __stack.locals.res1)
          __stack.step++;
  }
  if (__step <= 3) {
          __self.__retryable = false;
    await print(`res2`, __stack.locals.res2)
          __stack.step++;
  }
  if (__step <= 4) {
          __self.__retryable = false;
    await print(`res3`, __stack.locals.res3)
          __stack.step++;
  }
  if (__step <= 5) {
          __self.__retryable = false;
    await print(`res4`, __stack.locals.res4)
          __stack.step++;
  }
  if (__step <= 6) {
          __self.__retryable = false;
    await print(`res5`, __stack.locals.res5)
          __stack.step++;
  }
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
})
export async function main({ messages, callbacks }: { messages?: any; callbacks?: any } = {}) {
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
if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
export const __sourceMap = {"threadsAndSubthreads.agency:foo":{"2":{"line":16,"col":2},"3":{"line":17,"col":2},"4":{"line":18,"col":2},"5":{"line":19,"col":2},"6":{"line":20,"col":2},"1.1":{"line":2,"col":4},"1.3.1":{"line":4,"col":6},"1.3.3.1":{"line":6,"col":8},"1.3.4.1":{"line":9,"col":8},"1.4.1":{"line":13,"col":6}},"threadsAndSubthreads.agency:main":{"2":{"line":39,"col":2},"3":{"line":40,"col":2},"4":{"line":41,"col":2},"5":{"line":42,"col":2},"6":{"line":43,"col":2},"1.1":{"line":25,"col":4},"1.3.1":{"line":27,"col":6},"1.3.3.1":{"line":29,"col":8},"1.3.4.1":{"line":32,"col":8},"1.4.1":{"line":36,"col":6}}};