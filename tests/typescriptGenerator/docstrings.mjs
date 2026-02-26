import { fileURLToPath } from "url";
import process from "process";
import { z } from "zod";
import { goToNode } from "agency-lang";
import path from "path";
import {
  RuntimeContext, MessageThread, ThreadStore,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  interrupt, isInterrupt,
  respondToInterrupt as _respondToInterrupt,
  approveInterrupt as _approveInterrupt,
  rejectInterrupt as _rejectInterrupt,
  resolveInterrupt as _resolveInterrupt,
  modifyInterrupt as _modifyInterrupt,
  deepClone as __deepClone,
  not, eq, neq, lt, lte, gt, gte, and, or,
  head, tail, empty,
  builtinFetch as _builtinFetch,
  builtinFetchJSON as _builtinFetchJSON,
  builtinInput as _builtinInput,
  builtinRead as _builtinReadRaw,
  builtinWrite as _builtinWriteRaw,
  builtinReadImage as _builtinReadImageRaw,
  builtinSleep as _builtinSleep,
  builtinRound as _builtinRound,
  printJSON as _printJSON,
  print as _print,
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

const __ctx = new RuntimeContext({
  statelogConfig: {
    host: "https://agency-lang.com",
    
    
    apiKey: process.env.STATELOG_API_KEY || "",
    
    projectId: "",
    debugMode: false,
  },
  smoltalkDefaults: {
    
    
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    
    
    
    googleApiKey: process.env.GEMINI_API_KEY || "",
    
    model: "gpt-4o-mini",
    logLevel: "warn",
  },
  dirname: __dirname,
});
const graph = __ctx.graph;

// Path-dependent builtin wrappers
function _builtinRead(filename) {
  return _builtinReadRaw({ filename, dirname: __dirname });
}
function _builtinWrite(filename, content) {
  return _builtinWriteRaw({ filename, content, dirname: __dirname });
}
function _builtinReadImage(filename) {
  return _builtinReadImageRaw({ filename, dirname: __dirname });
}
export function readSkill({filepath}) {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// Interrupt re-exports bound to this module's context
export { interrupt, isInterrupt };
export const respondToInterrupt = (i, r, m) => _respondToInterrupt({ ctx: __ctx, interruptObj: i, interruptResponse: r, metadata: m });
export const approveInterrupt = (i, m) => _approveInterrupt({ ctx: __ctx, interruptObj: i, metadata: m });
export const rejectInterrupt = (i, m) => _rejectInterrupt({ ctx: __ctx, interruptObj: i, metadata: m });
export const modifyInterrupt = (i, a, m) => _modifyInterrupt({ ctx: __ctx, interruptObj: i, newArguments: a, metadata: m });
export const resolveInterrupt = (i, v, m) => _resolveInterrupt({ ctx: __ctx, interruptObj: i, value: v, metadata: m });

// Re-export builtin tools
export { __readSkillTool, __readSkillToolParams };
export { __printTool, __printToolParams };
export { __printJSONTool, __printJSONToolParams };
export { __inputTool, __inputToolParams };
export { __readTool, __readToolParams };
export { __readImageTool, __readImageToolParams };
export { __writeTool, __writeToolParams };
export { __fetchTool, __fetchToolParams };
export { __fetchJSONTool, __fetchJSONToolParams };
export { __fetchJsonTool, __fetchJsonToolParams };
export { __sleepTool, __sleepToolParams };
export { __roundTool, __roundToolParams };
export { __deepClone };
export const __addTool = {
  name: "add",
  description: `Add two numbers together.
This is a simple addition function.`,
  schema: z.object({"a": z.string(), "b": z.string(), })
};

export const __addToolParams = ["a","b"];
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

export const __calculateAreaToolParams = ["width","height"];
export const __processDataTool = {
  name: "processData",
  description: `Single line docstring`,
  schema: z.object({})
};

export const __processDataToolParams = [];
//  Test docstrings in functions

export async function add(a, b, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["a"] = a;
    __stack.args["b"] = b;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      
}

export async function greet(name, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["name"] = name;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      
}

export async function calculateArea(width, height, __metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    __stack.args["width"] = width;
    __stack.args["height"] = height;

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      
}

export async function processData(__metadata={}) {
    const { stack: __stack, step: __step, self: __self, threads: __threads, statelogClient, graph: __graph } =
      setupFunction({ ctx: __ctx, metadata: __metadata });

    

    
      if (__step <= 0) {
        
        __stack.step++;
      }
      
}

export default graph;