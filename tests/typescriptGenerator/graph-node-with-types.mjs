import { fileURLToPath } from "url";
import process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid, registerProvider, registerTextModel } from "agency-lang";
import * as smoltalk from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt } from "agency-lang/runtime";
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
const __cwd = process.cwd();

const __globalCtx = new RuntimeContext({
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
    statelog: { 
      host: "https://agency-lang.com",
      projectId: "smoltalk",
      apiKey: process.env.STATELOG_SMOLTALK_API_KEY || "",
      traceId: nanoid()
    }
  },
  dirname: __dirname,
});
const graph = __globalCtx.graph;

// Path-dependent builtin wrappers
function _builtinRead(filename: string): string {
  return _builtinReadRaw({ filename, dirname: __dirname });
}
function _builtinWrite(filename: string, content: string): void {
  _builtinWriteRaw({ filename, content, dirname: __dirname });
}
function _builtinReadImage(filename: string): string {
  return _builtinReadImageRaw({ filename, dirname: __dirname });
}
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// Interrupt re-exports bound to this module's context
export { interrupt, isInterrupt };
export const respondToInterrupt = (i: Interrupt, r: any, m?: any) => _respondToInterrupt({ ctx: __globalCtx, interrupt: i, interruptResponse: r, metadata: m });
export const approveInterrupt = (i: Interrupt, m?: any) => _approveInterrupt({ ctx: __globalCtx, interrupt: i, metadata: m });
export const rejectInterrupt = (i: Interrupt, m?: any) => _rejectInterrupt({ ctx: __globalCtx, interrupt: i, metadata: m });
export const modifyInterrupt = (i: Interrupt, a: any, m?: any) => _modifyInterrupt({ ctx: __globalCtx, interrupt: i, newArguments: a, metadata: m });
export const resolveInterrupt = (i: Interrupt, v: any, m?: any) => _resolveInterrupt({ ctx: __globalCtx, interrupt: i, value: v, metadata: m });
//  Test graph nodes with typed parameters



graph.node("greet", async (__state: GraphState) => {
    const { stack: __stack, step: __step, self: __self, threads: __threads } =
      setupNode({ state: __state });
    const __ctx = __state.ctx;
    const statelogClient = __ctx.statelogClient;
    const __graph = __ctx.graph;
    await callHook({ callbacks: __ctx.callbacks, name: "onNodeStart", data: { nodeName: "greet" } });

    if (__state.isResume) {
      __globalCtx.stateStack.globals = __state.ctx.stateStack.globals;
    }

    
    if (!__state.isResume) {
      __stack.args["name"] = __state.data.name;
    }
    
    if (__step <= 0) {

  __stack.step++;
}
if (__step <= 1) {
  
async function _greeting(name, __metadata): Promise<any> {
  __self.__removedTools = __self.__removedTools || [];
  return runPrompt({
    ctx: __ctx,
    prompt: `Say hello to ${name}`,
    messages: __metadata?.messages || new MessageThread(),
    
    tools: undefined,
    toolHandlers: [],
    clientConfig: {},
    stream: false,
    maxToolCallRounds: 10,
    interruptData: __state?.interruptData,
    removedTools: __self.__removedTools,
  });
}


__self.greeting = _greeting(__stack.args.name, {
      messages: new MessageThread()
    });



  
  __stack.step++;
}
if (__step <= 2) {
  [__self.greeting] = await Promise.all([__self.greeting]);
  __stack.step++;
}
if (__step <= 3) {
  await await _print(__stack.locals.greeting)
;

  
  __stack.step++;
}

    await callHook({ callbacks: __ctx.callbacks, name: "onNodeEnd", data: { nodeName: "greet", data: undefined } });
    return { messages: __threads, data: undefined };
});


export async function greet(name: string, { messages, callbacks }: { messages?: any; callbacks?: any } = {}) {


  return runNode({
    ctx: __globalCtx,
    nodeName: "greet",
    data: { name },
    messages,
    callbacks,
  });
}

export const __greetNodeParams = ["name"];
export default graph;