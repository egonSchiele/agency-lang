import { print, printJSON, input, sleep, saveDraft, _guard, _pairsOf, read, write, writeBinary, readBinary, range, callback, map, mapWithIndex, filter, exclude, find, findIndex, reduce, flatMap, every, some, count, sortBy, unique, groupBy, flatten, setAgentCwd, getAgentCwd, applyAgentCwd } from "agency-lang/stdlib/index.js";
import { sendEmail as sendEmailImpl } from "./dist/src/email.js";
import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync } from "fs";
import { z } from "agency-lang/zod";
import { nanoid } from "agency-lang";
import path from "path";
import {
  RuntimeContext,
  Runner,
  setupFunction,
  claimFrameForScope,
  callHook,
  checkpoint as __checkpoint_impl,
  getCheckpoint as __getCheckpoint_impl,
  restore as __restore_impl,
  _run as __runtime_run_impl,
  interrupt,
  isInterrupt,
  hasInterrupts,
  isDebugger,
  isPaused,
  respondToInterrupts as _respondToInterrupts,
  respondToInterruptsForServe as _respondToInterruptsForServe,
  resumeFromCheckpoint as _resumeFromCheckpoint,
  resumeCliFromCheckpoint as _resumeCliFromCheckpoint,
  rewindFrom as _rewindFrom,
  runExportedFunction as _runExportedFunction,
  runExportedFunctionForServe as _runExportedFunctionForServe,
  runNodeForServe as _runNodeForServe,
  RunControlSignal,
  AgencyAbort,
  AbortedResult,
  __registerGlobalsInit,
  __registerCallbacksInit,
  registerModuleFingerprint as __registerModuleFingerprint,
  runtimeFailure,
  isFailure,
  stampFailureBoundary,
  __tryCall,
  AgencyFunction as __AgencyFunction,
  UNSET as __UNSET,
  __call,
  __stateStack,
  __globals,
  getRuntimeContext,
  agencyStore,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient,
  installFetchMock as __installFetchMock,
  createLogger as __createLogger
} from "agency-lang/runtime";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = __process.cwd();
const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://statelog.adit.io",
    apiKey: __process.env["STATELOG_API_KEY"] || "",
    projectId: "",
    debugMode: false,
    observability: false
  },
  smoltalkDefaults: {
    apiKey: {
      openAi: __process.env["OPENAI_API_KEY"] || "",
      google: __process.env["GEMINI_API_KEY"] || "",
      anthropic: __process.env["ANTHROPIC_API_KEY"] || "",
      openRouter: __process.env["OPENROUTER_API_KEY"] || "",
      deepInfra: __process.env["DEEPINFRA_API_KEY"] || "",
      liteLlm: __process.env["LITELLM_API_KEY"] || "",
      openAiCompat: __process.env["OPENAI_COMPAT_API_KEY"] || ""
    },
    baseUrl: {
      liteLlm: __process.env["LITELLM_BASE_URL"] || "",
      openAiCompat: __process.env["OPENAI_COMPAT_BASE_URL"] || ""
    },
    model: "gpt-5-mini",
    logLevel: "warn",
    statelog: {
      host: "https://statelog.adit.io",
      projectId: "smoltalk",
      apiKey: __process.env["STATELOG_SMOLTALK_API_KEY"] || "",
      traceId: nanoid()
    },
    provider: "openai-responses"
  },
  dirname: __dirname,
  logLevel: "info",
  traceConfig: {
    program: "index.agency"
  }
});
const graph = __globalCtx.graph;
function approve(value) {
  return { type: "approve", value };
}
function reject(reason) {
  return { type: "reject", value: reason };
}
function propagate() {
  return { type: "propagate" };
}
function pass() {
  return { type: "pass" };
}
const respondToInterrupts = (interrupts, responses, opts) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, abortSignal: opts?.abortSignal, pauseSignal: opts?.pauseSignal });
const resumeFromCheckpoint = (paused, opts) => _resumeFromCheckpoint({ ctx: __globalCtx, paused, metadata: opts?.metadata, abortSignal: opts?.abortSignal, pauseSignal: opts?.pauseSignal, invocation: opts?.invocation });
const rewindFrom = (checkpoint2, overrides, opts) => _rewindFrom({ ctx: __globalCtx, checkpoint: checkpoint2, overrides, metadata: opts?.metadata });
const __resumeFromCheckpoint = (checkpoint2, overrides) => _resumeCliFromCheckpoint({ ctx: __globalCtx, checkpoint: checkpoint2, overrides });
const __invokeFunction = (fn, namedArgs) => _runExportedFunction({ ctx: __globalCtx, fn, namedArgs, initializeGlobals: __initializeGlobals });
const __invokeFunctionForServe = (fn, namedArgs, invocation) => _runExportedFunctionForServe({ ctx: __globalCtx, fn, namedArgs, invocation, initializeGlobals: __initializeGlobals });
const __invokeNodeForServe = (nodeName, data, invocation) => _runNodeForServe({ ctx: __globalCtx, nodeName, data, invocation, initializeGlobals: __initializeGlobals });
const __respondToInterruptsForServe = (interrupts, responses, opts) => _respondToInterruptsForServe({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, invocation: opts?.invocation });
const __setDebugger = (dbg) => {
  __globalCtx.debuggerState = dbg;
};
const __setTraceFile = (filePath) => {
  __globalCtx.traceConfig.traceFile = filePath;
};
const __setLLMClient = (client) => {
  __globalCtx.setLLMClient(client);
};
const __getCheckpoints = () => __globalCtx.checkpoints;
if (__process.env.AGENCY_LLM_MOCKS) {
  __globalCtx.setLLMClient(
    new __DeterministicClient(JSON.parse(__process.env.AGENCY_LLM_MOCKS))
  );
}
if (__process.env.AGENCY_FETCH_MOCKS_FILE) {
  __installFetchMock(JSON.parse(readFileSync(__process.env.AGENCY_FETCH_MOCKS_FILE, "utf-8")));
}
const __toolRegistry = __functionRefReviver.registry ??= {};
function __registerTool(value, _aliasName) {
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[`${value.module}:${value.name}`] = value;
  }
}
const checkpoint = __AgencyFunction.create({ name: "checkpoint", module: "__runtime", fn: __checkpoint_impl, params: [], toolDefinition: null }, __toolRegistry);
const getCheckpoint = __AgencyFunction.create({ name: "getCheckpoint", module: "__runtime", fn: __getCheckpoint_impl, params: [{ name: "checkpointId", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const restore = __AgencyFunction.create({ name: "restore", module: "__runtime", fn: __restore_impl, params: [{ name: "checkpointIdOrCheckpoint", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "options", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __runtime_run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "node", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "args", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "wallClock", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "memory", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "ipcPayload", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "stdout", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "configOverrides", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "cwd", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "maxDepth", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
function setLLMClient(client) {
  __globalCtx.setLLMClient(client);
}
function registerTools(tools) {
  for (const tool of tools) {
    if (__AgencyFunction.isAgencyFunction(tool)) {
      __toolRegistry[`${tool.module}:${tool.name}`] = tool;
    }
  }
}
__registerModuleFingerprint("index.agency", "808a5cf84459255a2737da7499265606320338f08505a10c345b99612bda625f", import.meta.url);
__registerTool(print);
__registerTool(printJSON);
__registerTool(input);
__registerTool(sleep);
__registerTool(saveDraft);
__registerTool(_guard);
__registerTool(_pairsOf);
__registerTool(read);
__registerTool(write);
__registerTool(writeBinary);
__registerTool(readBinary);
__registerTool(range);
__registerTool(callback);
__registerTool(map);
__registerTool(mapWithIndex);
__registerTool(filter);
__registerTool(exclude);
__registerTool(find);
__registerTool(findIndex);
__registerTool(reduce);
__registerTool(flatMap);
__registerTool(every);
__registerTool(some);
__registerTool(count);
__registerTool(sortBy);
__registerTool(unique);
__registerTool(groupBy);
__registerTool(flatten);
__registerTool(setAgentCwd);
__registerTool(getAgentCwd);
__registerTool(applyAgentCwd);
async function __initializeGlobals(__ctx) {
  if (__ctx.globals.isInitialized("index.agency")) {
    return;
  }
  __ctx.globals.markInitialized("index.agency");
}
__registerGlobalsInit("index.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__ctx) {
}
__registerCallbacksInit("index.agency", __registerTopLevelCallbacks);
__functionRefReviver.registry = __toolRegistry;
async function __sendEmail_impl(from, to, subject, html = __UNSET, text = __UNSET, cc = __UNSET, bcc = __UNSET, replyTo = __UNSET, host = __UNSET, port = __UNSET, secure = __UNSET, user = __UNSET, pass2 = __UNSET) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  claimFrameForScope(__stack, "sendEmail", "index.agency");
  if (!__globals().isInitialized("index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  __stack.args["from"] = from;
  __stack.args["to"] = to;
  __stack.args["subject"] = subject;
  __stack.args["html"] = html === __UNSET ? `` : html;
  __stack.args["text"] = text === __UNSET ? `` : text;
  __stack.args["cc"] = cc === __UNSET ? `` : cc;
  __stack.args["bcc"] = bcc === __UNSET ? `` : bcc;
  __stack.args["replyTo"] = replyTo === __UNSET ? `` : replyTo;
  __stack.args["host"] = host === __UNSET ? `` : host;
  __stack.args["port"] = port === __UNSET ? 0 : port;
  __stack.args["secure"] = secure === __UNSET ? false : secure;
  __stack.args["user"] = user === __UNSET ? `` : user;
  __stack.args["pass"] = pass2 === __UNSET ? `` : pass2;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "index.agency", scopeName: "sendEmail", threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides?.moduleId === __stack.moduleId && __ctx._pendingArgOverrides?.scopeName === __stack.scopeName) {
    const __overrides = __ctx._pendingArgOverrides.values;
    __ctx._pendingArgOverrides = void 0;
    if ("from" in __overrides) {
      from = __overrides["from"];
      __stack.args["from"] = from;
    }
    if ("to" in __overrides) {
      to = __overrides["to"];
      __stack.args["to"] = to;
    }
    if ("subject" in __overrides) {
      subject = __overrides["subject"];
      __stack.args["subject"] = subject;
    }
    if ("html" in __overrides) {
      html = __overrides["html"];
      __stack.args["html"] = html;
    }
    if ("text" in __overrides) {
      text = __overrides["text"];
      __stack.args["text"] = text;
    }
    if ("cc" in __overrides) {
      cc = __overrides["cc"];
      __stack.args["cc"] = cc;
    }
    if ("bcc" in __overrides) {
      bcc = __overrides["bcc"];
      __stack.args["bcc"] = bcc;
    }
    if ("replyTo" in __overrides) {
      replyTo = __overrides["replyTo"];
      __stack.args["replyTo"] = replyTo;
    }
    if ("host" in __overrides) {
      host = __overrides["host"];
      __stack.args["host"] = host;
    }
    if ("port" in __overrides) {
      port = __overrides["port"];
      __stack.args["port"] = port;
    }
    if ("secure" in __overrides) {
      secure = __overrides["secure"];
      __stack.args["secure"] = secure;
    }
    if ("user" in __overrides) {
      user = __overrides["user"];
      __stack.args["user"] = user;
    }
    if ("pass" in __overrides) {
      pass2 = __overrides["pass"];
      __stack.args["pass"] = pass2;
    }
  }
  try {
    await agencyStore.run({
      ...getRuntimeContext(),
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, async () => {
      await runner.hook(0, async () => {
        await callHook({
          name: "onFunctionStart",
          data: {
            functionName: "sendEmail",
            args: {
              from,
              to,
              subject,
              html,
              text,
              cc,
              bcc,
              replyTo,
              host,
              port,
              secure,
              user,
              pass: pass2
            },
            moduleId: "index.agency"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        __functionCompleted = true;
        runner2.halt(await __tryCall(async () => await __call(sendEmailImpl, {
          type: "positional",
          args: [{
            "from": __stack.args.from,
            "to": __stack.args.to,
            "subject": __stack.args.subject,
            "html": __stack.args.html,
            "text": __stack.args.text,
            "cc": __stack.args.cc,
            "bcc": __stack.args.bcc,
            "replyTo": __stack.args.replyTo
          }, {
            "host": __stack.args.host,
            "port": __stack.args.port,
            "user": __stack.args.user,
            "pass": __stack.args.pass
          }]
        }), {
          checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
          functionName: "sendEmail",
          args: __stack.args
        }));
        return;
      });
    });
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        stampFailureBoundary(runner.haltResult, __self.__destructiveRan);
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RunControlSignal) {
      throw __error;
    }
    if (__error instanceof AgencyAbort) {
      return AbortedResult.fromError(__error, __stack, "sendEmail");
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function sendEmail threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "sendEmail"
      });
    }
    return runtimeFailure(__error, {
      checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
      destructiveRan: __self.__destructiveRan,
      functionName: "sendEmail",
      args: __stack.args
    });
  } finally {
    __stateStack()?.pop();
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "sendEmail",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const sendEmail = __AgencyFunction.create({
  name: "sendEmail",
  module: "index.agency",
  fn: __sendEmail_impl,
  params: [{
    name: "from",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "to",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "subject",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "html",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "text",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "cc",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "bcc",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "replyTo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "host",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "port",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "secure",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "user",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "pass",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "sendEmail",
    description: `Send an email via SMTP using Nodemailer. Works with any email provider (Gmail, Outlook, Yahoo, self-hosted, etc). Requires SMTP_HOST env var or pass host directly. Authentication (SMTP_USER/SMTP_PASS) is optional. Set port to 0 for auto-detection (default 587). Secure is auto-detected from port and SMTP_SECURE env var when not explicitly set.`,
    schema: z.object({ "from": z.string(), "to": z.string(), "subject": z.string(), "html": z.string().nullable().describe("Default: "), "text": z.string().nullable().describe("Default: "), "cc": z.string().nullable().describe("Default: "), "bcc": z.string().nullable().describe("Default: "), "replyTo": z.string().nullable().describe("Default: "), "host": z.string().nullable().describe("Default: "), "port": z.number().nullable().describe("Default: 0"), "secure": z.boolean().nullable().describe("Default: false"), "user": z.string().nullable().describe("Default: "), "pass": z.string().nullable().describe("Default: ") })
  },
  exported: true
}, __toolRegistry);
var stdin_default = graph;
const __sourceMap = { "index.agency:sendEmail": { "1": { "line": 47, "col": 2 } } };
export {
  __getCheckpoints,
  __invokeFunction,
  __invokeFunctionForServe,
  __invokeNodeForServe,
  __respondToInterruptsForServe,
  __setDebugger,
  __setLLMClient,
  __setTraceFile,
  __sourceMap,
  __toolRegistry,
  approve,
  stdin_default as default,
  hasInterrupts,
  interrupt,
  isDebugger,
  isInterrupt,
  isPaused,
  reject,
  respondToInterrupts,
  resumeFromCheckpoint,
  rewindFrom,
  sendEmail
};
