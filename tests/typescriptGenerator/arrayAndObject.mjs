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
  interrupt, isInterrupt, isDebugger, isRejected, isApproved, interruptWithHandlers,
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
function __initializeGlobals(__ctx) {
  __ctx.globals.set("arrayAndObject.agency", "nums", [1, 2, 3, 4, 5])
  __ctx.globals.set("arrayAndObject.agency", "names", [`Alice`, `Bob`, `Charlie`])
  __ctx.globals.set("arrayAndObject.agency", "matrix", [[1, 2], [3, 4], [5, 6]])
  __ctx.globals.set("arrayAndObject.agency", "person", {
    "name": `Alice`,
    "age": 30
  })
  __ctx.globals.set("arrayAndObject.agency", "address", {
    "street": `123 Main St`,
    "city": `NYC`,
    "zip": `10001`
  })
  __ctx.globals.set("arrayAndObject.agency", "user", {
    "name": `Bob`,
    "tags": [`admin`, `developer`]
  })
  __ctx.globals.set("arrayAndObject.agency", "users", [{
    "name": `Alice`,
    "age": 30
  }, {
    "name": `Bob`,
    "age": 25
  }])
  __ctx.globals.set("arrayAndObject.agency", "config", {
    "server": {
      "host": `localhost`,
      "port": 8080
    },
    "debug": true
  })
  __ctx.globals.set("arrayAndObject.agency", "firstNum", __ctx.globals.get("arrayAndObject.agency", "nums")[0])
  __ctx.globals.set("arrayAndObject.agency", "personName", __ctx.globals.get("arrayAndObject.agency", "person").name)
  __ctx.globals.markInitialized("arrayAndObject.agency")
}
const __toolRegistry = {
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

//  Test arrays and objects
//  Simple array

await print(__ctx.globals.get("arrayAndObject.agency", "nums"))
//  Array with strings

await print(__ctx.globals.get("arrayAndObject.agency", "names"))
//  Nested arrays

await print(__ctx.globals.get("arrayAndObject.agency", "matrix"))
//  Simple object

await print(__ctx.globals.get("arrayAndObject.agency", "person"))
//  Object with nested structure

await print(__ctx.globals.get("arrayAndObject.agency", "address"))
//  Object with array property

await print(__ctx.globals.get("arrayAndObject.agency", "user"))
//  Array of objects

await print(__ctx.globals.get("arrayAndObject.agency", "users"))
//  Nested object

await print(__ctx.globals.get("arrayAndObject.agency", "config"))
//  Array access
await print(__ctx.globals.get("arrayAndObject.agency", "firstNum"))
//  Object property access
await print(__ctx.globals.get("arrayAndObject.agency", "personName"))
export default graph
export const __sourceMap = {};