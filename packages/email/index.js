import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify, range, mostCommon, keys, values, entries, emit } from "agency-lang/stdlib/index.js";
import { sendEmail as sendEmailImpl } from "./dist/src/email.js";
import { fileURLToPath } from "url";
import __process from "process";
import { z } from "zod";
import { nanoid } from "agency-lang";
import path from "path";
import {
  RuntimeContext,
  Runner,
  setupFunction,
  callHook,
  checkpoint as __checkpoint_impl,
  getCheckpoint as __getCheckpoint_impl,
  restore as __restore_impl,
  interrupt,
  isInterrupt,
  hasInterrupts,
  isDebugger,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  RestoreSignal,
  failure,
  isFailure,
  __tryCall,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  AgencyFunction as __AgencyFunction,
  UNSET as __UNSET,
  __call,
  functionRefReviver as __functionRefReviver
} from "agency-lang/runtime";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __cwd = __process.cwd();
const getDirname = () => __dirname;
const __globalCtx = new RuntimeContext({
  statelogConfig: {
    host: "https://statelog.adit.io",
    apiKey: __process.env["STATELOG_API_KEY"] || "",
    projectId: "agency-lang",
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
    program: "../email/index.agency",
    traceDir: "traces"
  }
});
const graph = __globalCtx.graph;
function readSkill({ filepath }) {
  return _readSkillRaw({ filepath, dirname: __dirname });
}
function approve(value) {
  return { type: "approve", value };
}
function reject(value) {
  return { type: "reject", value };
}
function propagate() {
  return { type: "propagate" };
}
const respondToInterrupts = (interrupts, responses, opts) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata });
const rewindFrom = (checkpoint2, overrides, opts) => _rewindFrom({ ctx: __globalCtx, checkpoint: checkpoint2, overrides, metadata: opts?.metadata });
const __setDebugger = (dbg) => {
  __globalCtx.debuggerState = dbg;
};
const __setTraceWriter = (tw) => {
  __globalCtx.traceWriter = tw;
};
const __getCheckpoints = () => __globalCtx.checkpoints;
const __toolRegistry = {};
function __registerTool(value, name) {
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[name ?? value.name] = value;
  }
}
const checkpoint = __AgencyFunction.create({ name: "checkpoint", module: "__runtime", fn: __checkpoint_impl, params: [], toolDefinition: null }, __toolRegistry);
const getCheckpoint = __AgencyFunction.create({ name: "getCheckpoint", module: "__runtime", fn: __getCheckpoint_impl, params: [{ name: "checkpointId", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const restore = __AgencyFunction.create({ name: "restore", module: "__runtime", fn: __restore_impl, params: [{ name: "checkpointIdOrCheckpoint", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "options", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
function setLLMClient(client) {
  __globalCtx.setLLMClient(client);
}
function registerTools(tools) {
  for (const tool of tools) {
    if (__AgencyFunction.isAgencyFunction(tool)) {
      __toolRegistry[tool.name] = tool;
    }
  }
}
__registerTool(print);
__registerTool(printJSON);
__registerTool(input);
__registerTool(sleep);
__registerTool(round);
__registerTool(fetch);
__registerTool(fetchJSON);
__registerTool(read);
__registerTool(write);
__registerTool(readImage);
__registerTool(notify);
__registerTool(range);
__registerTool(mostCommon);
__registerTool(keys);
__registerTool(values);
__registerTool(entries);
__registerTool(emit);
async function __initializeGlobals(__ctx) {
  __ctx.globals.markInitialized("../email/index.agency");
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "../email/index.agency",
  fn: readSkill,
  params: __readSkillToolParams.map((p) => ({ name: p, hasDefault: false, defaultValue: void 0, variadic: false })),
  toolDefinition: __readSkillTool
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
async function __sendEmail_impl(from, to, subject, html = __UNSET, text = __UNSET, cc = __UNSET, bcc = __UNSET, replyTo = __UNSET, host = __UNSET, port = __UNSET, secure = __UNSET, user = __UNSET, pass = __UNSET, __state = void 0) {
  const __setupData = setupFunction({
    state: __state
  });
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
  if (!__ctx.globals.isInitialized("../email/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
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
        pass
      },
      isBuiltin: false,
      moduleId: "../email/index.agency"
    }
  });
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
  __stack.args["pass"] = pass === __UNSET ? `` : pass;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../email/index.agency", scopeName: "sendEmail" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../email/index.agency", scopeName: "sendEmail", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
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
      pass = __overrides["pass"];
      __stack.args["pass"] = pass;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
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
          "secure": __stack.args.secure,
          "user": __stack.args.user,
          "pass": __stack.args.pass
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
      }), {
        checkpoint: __ctx.getResultCheckpoint(),
        functionName: "sendEmail",
        args: __stack.args
      }));
      return;
    });
    if (runner.halted) {
      if (isFailure(runner.haltResult)) {
        runner.haltResult.retryable = runner.haltResult.retryable && __self.__retryable;
      }
      return runner.haltResult;
    }
  } catch (__error) {
    if (__error instanceof RestoreSignal) {
      throw __error;
    }
    return failure(
      __error instanceof Error ? __error.message : String(__error),
      {
        checkpoint: __ctx.getResultCheckpoint(),
        retryable: __self.__retryable,
        functionName: "sendEmail",
        args: __stack.args
      }
    );
  } finally {
    __stateStack.pop();
    if (__functionCompleted) {
      await callHook({
        callbacks: __ctx.callbacks,
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
  module: "../email/index.agency",
  fn: __sendEmail_impl,
  params: [{
    name: "from",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "to",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "subject",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "html",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "text",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "cc",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "bcc",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "replyTo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "host",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "port",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "secure",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "user",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "pass",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "sendEmail",
    description: `Send an email via SMTP using Nodemailer. Works with any email provider (Gmail, Outlook, Yahoo, self-hosted, etc). Requires SMTP_HOST, SMTP_USER, and SMTP_PASS env vars, or pass host/user/pass directly.`,
    schema: z.object({ "from": z.string(), "to": z.string(), "subject": z.string(), "html": z.string().nullable().describe("Default: "), "text": z.string().nullable().describe("Default: "), "cc": z.string().nullable().describe("Default: "), "bcc": z.string().nullable().describe("Default: "), "replyTo": z.string().nullable().describe("Default: "), "host": z.string().nullable().describe("Default: "), "port": z.number().nullable().describe("Default: 0"), "secure": z.boolean().nullable().describe("Default: false"), "user": z.string().nullable().describe("Default: "), "pass": z.string().nullable().describe("Default: ") })
  }
}, __toolRegistry);
var stdin_default = graph;
const __sourceMap = { "../email/index.agency:sendEmail": { "0": { "line": 48, "col": 2 } } };
export {
  __getCheckpoints,
  __setDebugger,
  __setTraceWriter,
  __sourceMap,
  approve,
  stdin_default as default,
  hasInterrupts,
  interrupt,
  isDebugger,
  isInterrupt,
  readSkill,
  reject,
  respondToInterrupts,
  rewindFrom,
  sendEmail
};
