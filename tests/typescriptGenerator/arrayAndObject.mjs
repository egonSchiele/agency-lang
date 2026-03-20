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
  _builtinTool as __builtinTool,
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

// tool() function — looks up a tool by name from the module's __toolRegistry
function tool(__name: string) {
  return __builtinTool(__name, __toolRegistry);
}

// Interrupt re-exports bound to this module's context
export { interrupt, isInterrupt };
export const respondToInterrupt = (interrupt: Interrupt, response: InterruptResponse, metadata?: Record<string, any>) => _respondToInterrupt({ ctx: __globalCtx, interrupt, interruptResponse: response, metadata });
export const approveInterrupt = (interrupt: Interrupt, metadata?: Record<string, any>) => _approveInterrupt({ ctx: __globalCtx, interrupt, metadata });
export const rejectInterrupt = (interrupt: Interrupt, metadata?: Record<string, any>) => _rejectInterrupt({ ctx: __globalCtx, interrupt, metadata });
export const modifyInterrupt = (interrupt: Interrupt, newArguments: Record<string, any>, metadata?: Record<string, any>) => _modifyInterrupt({ ctx: __globalCtx, interrupt, newArguments, metadata });
export const resolveInterrupt = (interrupt: Interrupt, value: any, metadata?: Record<string, any>) => _resolveInterrupt({ ctx: __globalCtx, interrupt, value, metadata });
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
  },
  print: {
    definition: __printTool,
    handler: {
      name: "print",
      params: __printToolParams,
      execute: print,
      isBuiltin: true
    }
  },
  printJSON: {
    definition: __printJSONTool,
    handler: {
      name: "printJSON",
      params: __printJSONToolParams,
      execute: printJSON,
      isBuiltin: true
    }
  },
  input: {
    definition: __inputTool,
    handler: {
      name: "input",
      params: __inputToolParams,
      execute: input,
      isBuiltin: true
    }
  },
  read: {
    definition: __readTool,
    handler: {
      name: "read",
      params: __readToolParams,
      execute: read,
      isBuiltin: true
    }
  },
  readImage: {
    definition: __readImageTool,
    handler: {
      name: "readImage",
      params: __readImageToolParams,
      execute: readImage,
      isBuiltin: true
    }
  },
  write: {
    definition: __writeTool,
    handler: {
      name: "write",
      params: __writeToolParams,
      execute: write,
      isBuiltin: true
    }
  },
  fetch: {
    definition: __fetchTool,
    handler: {
      name: "fetch",
      params: __fetchToolParams,
      execute: _builtinFetch,
      isBuiltin: true
    }
  },
  fetchJSON: {
    definition: __fetchJSONTool,
    handler: {
      name: "fetchJSON",
      params: __fetchJSONToolParams,
      execute: _builtinFetchJSON,
      isBuiltin: true
    }
  },
  fetchJson: {
    definition: __fetchJsonTool,
    handler: {
      name: "fetchJson",
      params: __fetchJsonToolParams,
      execute: _builtinFetchJSON,
      isBuiltin: true
    }
  },
  sleep: {
    definition: __sleepTool,
    handler: {
      name: "sleep",
      params: __sleepToolParams,
      execute: sleep,
      isBuiltin: true
    }
  },
  round: {
    definition: __roundTool,
    handler: {
      name: "round",
      params: __roundToolParams,
      execute: round,
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