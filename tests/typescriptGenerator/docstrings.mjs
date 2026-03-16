import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid, registerProvider, registerTextModel } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  interrupt, isInterrupt,
  respondToInterrupt as _respondToInterrupt,
  approveInterrupt as _approveInterrupt,
  rejectInterrupt as _rejectInterrupt,
  resolveInterrupt as _resolveInterrupt,
  modifyInterrupt as _modifyInterrupt,
  resumeFromState as _resumeFromState,
  ToolCallError,
  deepClone as __deepClone,
  not, eq, neq, lt, lte, gt, gte, and, or,
  head, tail, empty,
  builtinFetch as _builtinFetch,
  builtinFetchJSON as _builtinFetchJSON,
  builtinInput as input,
  builtinRead as _builtinReadRaw,
  builtinWrite as _builtinWriteRaw,
  builtinReadImage as _builtinReadImageRaw,
  builtinSleep as sleep,
  builtinRound as round,
  printJSON,
  print,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  printTool as __printTool,
  printToolParams as __printToolParams,
  printJSONTool as __printJSONTool,
  printJSONToolParams as __printJSONToolParams,
  inputTool as __inputTool,
  inputToolParams as __inputToolParams,
  readTool as __readTool,
  readToolParams as __readToolParams,
  readImageTool as __readImageTool,
  readImageToolParams as __readImageToolParams,
  writeTool as __writeTool,
  writeToolParams as __writeToolParams,
  fetchTool as __fetchTool,
  fetchToolParams as __fetchToolParams,
  fetchJSONTool as __fetchJSONTool,
  fetchJSONToolParams as __fetchJSONToolParams,
  fetchJsonTool as __fetchJsonTool,
  fetchJsonToolParams as __fetchJsonToolParams,
  sleepTool as __sleepTool,
  sleepToolParams as __sleepToolParams,
  roundTool as __roundTool,
  roundToolParams as __roundToolParams,
} from "agency-lang/runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = process.cwd();

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
function read(filename: string): string {
  return _builtinReadRaw({ filename, dirname: __dirname });
}
function write(filename: string, content: string): void {
  _builtinWriteRaw({ filename, content, dirname: __dirname });
}
function readImage(filename: string): string {
  return _builtinReadImageRaw({ filename, dirname: __dirname });
}
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// Interrupt re-exports bound to this module's context
export { interrupt, isInterrupt };
export const respondToInterrupt = (interrupt: Interrupt, response: InterruptResponse, metadata?: Record<string, any>) => _respondToInterrupt({ ctx: __globalCtx, interrupt, interruptResponse: response, metadata });
export const approveInterrupt = (interrupt: Interrupt, metadata?: Record<string, any>) => _approveInterrupt({ ctx: __globalCtx, interrupt, metadata });
export const rejectInterrupt = (interrupt: Interrupt, metadata?: Record<string, any>) => _rejectInterrupt({ ctx: __globalCtx, interrupt, metadata });
export const modifyInterrupt = (interrupt: Interrupt, newArguments: Record<string, any>, metadata?: Record<string, any>) => _modifyInterrupt({ ctx: __globalCtx, interrupt, newArguments, metadata });
export const resolveInterrupt = (interrupt: Interrupt, value: any, metadata?: Record<string, any>) => _resolveInterrupt({ ctx: __globalCtx, interrupt, value, metadata });
function __initializeGlobals(__ctx) {

}
export const __addTool = {
  name: "add",
  description: `Add two numbers together.
This is a simple addition function.`,
  schema: z.object({"a": z.string(), "b": z.string(), })
};
export const __addToolParams = ["a", "b"];
export const __greetTool = {
  name: "greet",
  description: `Generate a greeting message for the given name.`,
  schema: z.object({"name": z.string(), })
};
export const __greetToolParams = ["name"];
export const __calculateAreaTool = {
  name: "calculateArea",
  description: `Calculate the area of a rectangle.

Parameters:
- width: the width of the rectangle
- height: the height of the rectangle

Returns: the area as a number`,
  schema: z.object({"width": z.string(), "height": z.string(), })
};
export const __calculateAreaToolParams = ["width", "height"];
export const __processDataTool = {
  name: "processData",
  description: `Single line docstring`,
  schema: z.object({})
};
export const __processDataToolParams = [];
//  Test docstrings in functions


export async function add(a: any, b: any, __state: InternalFunctionState | undefined = undefined) {
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
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "add",
      args: {
        a: a,
        b: b
      },
      isBuiltin: false
    }
  })
  __stack.args["a"] = a;
  __stack.args["b"] = b;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
  } catch (__error) {
    if (__error instanceof ToolCallError) {
      throw __error
    }
    throw new ToolCallError(__error, { retryable: __self.__retryable })
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "add",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


export async function greet(name: any, __state: InternalFunctionState | undefined = undefined) {
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
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "greet",
      args: {
        name: name
      },
      isBuiltin: false
    }
  })
  __stack.args["name"] = name;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
  } catch (__error) {
    if (__error instanceof ToolCallError) {
      throw __error
    }
    throw new ToolCallError(__error, { retryable: __self.__retryable })
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "greet",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


export async function calculateArea(width: any, height: any, __state: InternalFunctionState | undefined = undefined) {
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
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "calculateArea",
      args: {
        width: width,
        height: height
      },
      isBuiltin: false
    }
  })
  __stack.args["width"] = width;
  __stack.args["height"] = height;
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
  } catch (__error) {
    if (__error instanceof ToolCallError) {
      throw __error
    }
    throw new ToolCallError(__error, { retryable: __self.__retryable })
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "calculateArea",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


export async function processData(__state: InternalFunctionState | undefined = undefined) {
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
  let __funcStartTime: number = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "processData",
      args: {},
      isBuiltin: false
    }
  })
  __self.__retryable = __self.__retryable ?? true;
  try {
    if (__step <= 0) {

      __stack.step++;
    }
  } catch (__error) {
    if (__error instanceof ToolCallError) {
      throw __error
    }
    throw new ToolCallError(__error, { retryable: __self.__retryable })
  }
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionEnd",
    data: {
      functionName: "processData",
      timeTaken: performance.now() - __funcStartTime
    }
  })
}


export default graph