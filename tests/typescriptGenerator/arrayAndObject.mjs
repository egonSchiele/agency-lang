import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import { goToNode, color, nanoid } from "agency-lang";
import { smoltalk } from "agency-lang";
import path from "path";
import type { GraphState, InternalFunctionState, Interrupt, InterruptResponse, RewindCheckpoint } from "agency-lang/runtime";
import {
  RuntimeContext, MessageThread, ThreadStore, Runner, McpManager,
  setupNode, setupFunction, runNode, runPrompt, callHook,
  checkpoint as __checkpoint_impl, getCheckpoint as __getCheckpoint_impl, restore as __restore_impl,
  interrupt, isInterrupt, isDebugger, isRejected, isApproved, interruptWithHandlers, debugStep,
  respondToInterrupt as _respondToInterrupt,
  approveInterrupt as _approveInterrupt,
  rejectInterrupt as _rejectInterrupt,
  resolveInterrupt as _resolveInterrupt,
  modifyInterrupt as _modifyInterrupt,
  rewindFrom as _rewindFrom,
  RestoreSignal,
  deepClone as __deepClone,
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
    program: "arrayAndObject.agency"
  }
});
const graph = __globalCtx.graph;

// Path-dependent builtin wrappers
export function readSkill({filepath}: {filepath: string}): string {
  return _readSkillRaw({ filepath, dirname: __dirname });
}

// Handler result builtins
function approve(value?: any) { return { type: "approved" as const, value }; }
function reject(value?: any) { return { type: "rejected" as const, value }; }
function propagate() { return { type: "propagated" as const }; }

// Interrupt and rewind re-exports bound to this module's context
export { interrupt, isInterrupt, isDebugger };
export const respondToInterrupt = (interrupt: Interrupt, response: InterruptResponse, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _respondToInterrupt({ ctx: __globalCtx, interrupt, interruptResponse: response, overrides: opts?.overrides, metadata: opts?.metadata });
export const approveInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _approveInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const rejectInterrupt = (interrupt: Interrupt, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _rejectInterrupt({ ctx: __globalCtx, interrupt, overrides: opts?.overrides, metadata: opts?.metadata });
export const modifyInterrupt = (interrupt: Interrupt, newArguments: Record<string, any>, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _modifyInterrupt({ ctx: __globalCtx, interrupt, newArguments, overrides: opts?.overrides, metadata: opts?.metadata });
export const resolveInterrupt = (interrupt: Interrupt, value: any, opts?: { overrides?: Record<string, unknown>; metadata?: Record<string, any> }) => _resolveInterrupt({ ctx: __globalCtx, interrupt, value, overrides: opts?.overrides, metadata: opts?.metadata });
export const rewindFrom = (checkpoint: RewindCheckpoint, overrides: Record<string, unknown>, opts?: { metadata?: Record<string, any> }) => _rewindFrom({ ctx: __globalCtx, checkpoint, overrides, metadata: opts?.metadata });

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
async function mcp(serverName: string) {
  return __globalCtx.mcpManager.getTools(serverName);
}
async function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("arrayAndObject.agency")
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
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "arrayAndObject.agency",
  fn: readSkill,
  params: __readSkillToolParams.map(p => ({ name: p, hasDefault: false, defaultValue: undefined, variadic: false })),
  toolDefinition: __readSkillTool,
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
//  Test arrays and objects
//  Simple array
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "nums")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
//  Array with strings
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "names")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
//  Nested arrays
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "matrix")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
//  Simple object
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "person")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
//  Object with nested structure
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "address")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
//  Object with array property
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "user")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
//  Array of objects
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "users")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
//  Nested object
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "config")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
//  Array access
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "firstNum")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
//  Object property access
await __call(print, {
  type: "positional",
  args: [__ctx.globals.get("arrayAndObject.agency", "personName")]
}, {
  ctx: __ctx,
  threads: __threads,
  interruptData: __state?.interruptData
})
export default graph
export const __sourceMap = {};