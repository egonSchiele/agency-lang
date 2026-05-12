import { print, printJSON, input, sleep, round, fetch, fetchJSON, read, write, readImage, notify, range, mostCommon, keys, values, entries, emit } from "agency-lang/stdlib/index.js";
import { createBranch as createBranchImpl } from "./dist/src/branches.js";
import { deleteBranch as deleteBranchImpl } from "./dist/src/branches.js";
import { branchExists as branchExistsImpl } from "./dist/src/branches.js";
import { commitFiles as commitFilesImpl } from "./dist/src/commits.js";
import { openPullRequest as openPullRequestImpl } from "./dist/src/prs.js";
import { listPullRequests as listPullRequestsImpl } from "./dist/src/prs.js";
import { commentOnPullRequest as commentOnPullRequestImpl } from "./dist/src/prs.js";
import { addLabel as addLabelImpl } from "./dist/src/prs.js";
import { requestReview as requestReviewImpl } from "./dist/src/prs.js";
import { listIssues as listIssuesImpl } from "./dist/src/issues.js";
import { commentOnIssue as commentOnIssueImpl } from "./dist/src/issues.js";
import { createIssue as createIssueImpl } from "./dist/src/issues.js";
import { defaultBranch as defaultBranchImpl } from "./dist/src/meta.js";
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
  _run as __runtime_run_impl,
  interrupt,
  isInterrupt,
  hasInterrupts,
  isDebugger,
  respondToInterrupts as _respondToInterrupts,
  rewindFrom as _rewindFrom,
  RestoreSignal,
  failure,
  isFailure,
  readSkill as _readSkillRaw,
  readSkillTool as __readSkillTool,
  readSkillToolParams as __readSkillToolParams,
  AgencyFunction as __AgencyFunction,
  UNSET as __UNSET,
  __call,
  functionRefReviver as __functionRefReviver,
  DeterministicClient as __DeterministicClient
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
    program: "../github/index.agency",
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
const __setLLMClient = (client) => {
  __globalCtx.setLLMClient(client);
};
const __getCheckpoints = () => __globalCtx.checkpoints;
if (__process.env.AGENCY_LLM_MOCKS) {
  __globalCtx.setLLMClient(
    new __DeterministicClient(JSON.parse(__process.env.AGENCY_LLM_MOCKS))
  );
}
const __toolRegistry = {};
function __registerTool(value, name) {
  if (__AgencyFunction.isAgencyFunction(value)) {
    __toolRegistry[name ?? value.name] = value;
  }
}
const checkpoint = __AgencyFunction.create({ name: "checkpoint", module: "__runtime", fn: __checkpoint_impl, params: [], toolDefinition: null }, __toolRegistry);
const getCheckpoint = __AgencyFunction.create({ name: "getCheckpoint", module: "__runtime", fn: __getCheckpoint_impl, params: [{ name: "checkpointId", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const restore = __AgencyFunction.create({ name: "restore", module: "__runtime", fn: __restore_impl, params: [{ name: "checkpointIdOrCheckpoint", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "options", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
const _run = __AgencyFunction.create({ name: "_run", module: "__runtime", fn: __runtime_run_impl, params: [{ name: "compiled", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "node", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "args", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "wallClock", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "memory", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "ipcPayload", hasDefault: false, defaultValue: void 0, variadic: false }, { name: "stdout", hasDefault: false, defaultValue: void 0, variadic: false }], toolDefinition: null }, __toolRegistry);
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
  __ctx.globals.markInitialized("../github/index.agency");
}
__toolRegistry["readSkill"] = __AgencyFunction.create({
  name: "readSkill",
  module: "../github/index.agency",
  fn: readSkill,
  params: __readSkillToolParams.map((p) => ({ name: p, hasDefault: false, defaultValue: void 0, variadic: false })),
  toolDefinition: __readSkillTool
}, __toolRegistry);
__functionRefReviver.registry = __toolRegistry;
async function __createBranch_impl(name, from = __UNSET, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "createBranch",
      args: {
        name,
        from,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["name"] = name;
  __stack.args["from"] = from === __UNSET ? `` : from;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "createBranch" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "createBranch", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("name" in __overrides) {
      name = __overrides["name"];
      __stack.args["name"] = name;
    }
    if ("from" in __overrides) {
      from = __overrides["from"];
      __stack.args["from"] = from;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(createBranchImpl, {
        type: "positional",
        args: [{
          "name": __stack.args.name,
          "from": __stack.args.from,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "createBranch",
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
          functionName: "createBranch",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const createBranch = __AgencyFunction.create({
  name: "createBranch",
  module: "../github/index.agency",
  fn: __createBranch_impl,
  params: [{
    name: "name",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "from",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "createBranch",
    description: `No description provided.`,
    schema: z.object({ "name": z.string(), "from": z.string().nullable().describe("Default: "), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
async function __deleteBranch_impl(name, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "deleteBranch",
      args: {
        name,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["name"] = name;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "deleteBranch" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "deleteBranch", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("name" in __overrides) {
      name = __overrides["name"];
      __stack.args["name"] = name;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(deleteBranchImpl, {
        type: "positional",
        args: [{
          "name": __stack.args.name,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "deleteBranch",
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
          functionName: "deleteBranch",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const deleteBranch = __AgencyFunction.create({
  name: "deleteBranch",
  module: "../github/index.agency",
  fn: __deleteBranch_impl,
  params: [{
    name: "name",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "deleteBranch",
    description: `No description provided.`,
    schema: z.object({ "name": z.string(), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
async function __branchExists_impl(name, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "branchExists",
      args: {
        name,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["name"] = name;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "branchExists" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "branchExists", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("name" in __overrides) {
      name = __overrides["name"];
      __stack.args["name"] = name;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __functionCompleted = true;
      runner2.halt(await __call(branchExistsImpl, {
        type: "positional",
        args: [{
          "name": __stack.args.name,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "branchExists",
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
          functionName: "branchExists",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const branchExists = __AgencyFunction.create({
  name: "branchExists",
  module: "../github/index.agency",
  fn: __branchExists_impl,
  params: [{
    name: "name",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "branchExists",
    description: `No description provided.`,
    schema: z.object({ "name": z.string(), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: true,
  exported: true
}, __toolRegistry);
async function __commitFiles_impl(message, files = __UNSET, authorName = __UNSET, authorEmail = __UNSET, push = __UNSET, branch = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "commitFiles",
      args: {
        message,
        files,
        authorName,
        authorEmail,
        push,
        branch
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["message"] = message;
  __stack.args["files"] = files === __UNSET ? [] : files;
  __stack.args["authorName"] = authorName === __UNSET ? `` : authorName;
  __stack.args["authorEmail"] = authorEmail === __UNSET ? `` : authorEmail;
  __stack.args["push"] = push === __UNSET ? true : push;
  __stack.args["branch"] = branch === __UNSET ? `` : branch;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "commitFiles" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "commitFiles", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("message" in __overrides) {
      message = __overrides["message"];
      __stack.args["message"] = message;
    }
    if ("files" in __overrides) {
      files = __overrides["files"];
      __stack.args["files"] = files;
    }
    if ("authorName" in __overrides) {
      authorName = __overrides["authorName"];
      __stack.args["authorName"] = authorName;
    }
    if ("authorEmail" in __overrides) {
      authorEmail = __overrides["authorEmail"];
      __stack.args["authorEmail"] = authorEmail;
    }
    if ("push" in __overrides) {
      push = __overrides["push"];
      __stack.args["push"] = push;
    }
    if ("branch" in __overrides) {
      branch = __overrides["branch"];
      __stack.args["branch"] = branch;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(commitFilesImpl, {
        type: "positional",
        args: [{
          "message": __stack.args.message,
          "files": __stack.args.files,
          "authorName": __stack.args.authorName,
          "authorEmail": __stack.args.authorEmail,
          "push": __stack.args.push,
          "branch": __stack.args.branch
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "commitFiles",
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
          functionName: "commitFiles",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const commitFiles = __AgencyFunction.create({
  name: "commitFiles",
  module: "../github/index.agency",
  fn: __commitFiles_impl,
  params: [{
    name: "message",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "files",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "authorName",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "authorEmail",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "push",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "branch",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "commitFiles",
    description: `No description provided.`,
    schema: z.object({ "message": z.string(), "files": z.array(z.string()).nullable().describe("Default: []"), "authorName": z.string().nullable().describe("Default: "), "authorEmail": z.string().nullable().describe("Default: "), "push": z.boolean().nullable().describe("Default: true"), "branch": z.string().nullable().describe("Default: ") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
async function __openPullRequest_impl(title, body, head2, base = __UNSET, draft = __UNSET, labels = __UNSET, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "openPullRequest",
      args: {
        title,
        body,
        head: head2,
        base,
        draft,
        labels,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["title"] = title;
  __stack.args["body"] = body;
  __stack.args["head"] = head2;
  __stack.args["base"] = base === __UNSET ? `` : base;
  __stack.args["draft"] = draft === __UNSET ? false : draft;
  __stack.args["labels"] = labels === __UNSET ? [] : labels;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "openPullRequest" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "openPullRequest", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("title" in __overrides) {
      title = __overrides["title"];
      __stack.args["title"] = title;
    }
    if ("body" in __overrides) {
      body = __overrides["body"];
      __stack.args["body"] = body;
    }
    if ("head" in __overrides) {
      head2 = __overrides["head"];
      __stack.args["head"] = head2;
    }
    if ("base" in __overrides) {
      base = __overrides["base"];
      __stack.args["base"] = base;
    }
    if ("draft" in __overrides) {
      draft = __overrides["draft"];
      __stack.args["draft"] = draft;
    }
    if ("labels" in __overrides) {
      labels = __overrides["labels"];
      __stack.args["labels"] = labels;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(openPullRequestImpl, {
        type: "positional",
        args: [{
          "title": __stack.args.title,
          "body": __stack.args.body,
          "head": __stack.args.head,
          "base": __stack.args.base,
          "draft": __stack.args.draft,
          "labels": __stack.args.labels,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "openPullRequest",
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
          functionName: "openPullRequest",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const openPullRequest = __AgencyFunction.create({
  name: "openPullRequest",
  module: "../github/index.agency",
  fn: __openPullRequest_impl,
  params: [{
    name: "title",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "body",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "head",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "base",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "draft",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "labels",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "openPullRequest",
    description: `No description provided.`,
    schema: z.object({ "title": z.string(), "body": z.string(), "head": z.string(), "base": z.string().nullable().describe("Default: "), "draft": z.boolean().nullable().describe("Default: false"), "labels": z.array(z.string()).nullable().describe("Default: []"), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
async function __listPullRequests_impl(state = __UNSET, base = __UNSET, head2 = __UNSET, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "listPullRequests",
      args: {
        state,
        base,
        head: head2,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["state"] = state === __UNSET ? `open` : state;
  __stack.args["base"] = base === __UNSET ? `` : base;
  __stack.args["head"] = head2 === __UNSET ? `` : head2;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "listPullRequests" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "listPullRequests", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("state" in __overrides) {
      state = __overrides["state"];
      __stack.args["state"] = state;
    }
    if ("base" in __overrides) {
      base = __overrides["base"];
      __stack.args["base"] = base;
    }
    if ("head" in __overrides) {
      head2 = __overrides["head"];
      __stack.args["head"] = head2;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __functionCompleted = true;
      runner2.halt(await __call(listPullRequestsImpl, {
        type: "positional",
        args: [{
          "state": __stack.args.state,
          "base": __stack.args.base,
          "head": __stack.args.head,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "listPullRequests",
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
          functionName: "listPullRequests",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const listPullRequests = __AgencyFunction.create({
  name: "listPullRequests",
  module: "../github/index.agency",
  fn: __listPullRequests_impl,
  params: [{
    name: "state",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "base",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "head",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "listPullRequests",
    description: `No description provided.`,
    schema: z.object({ "state": z.string().nullable().describe("Default: open"), "base": z.string().nullable().describe("Default: "), "head": z.string().nullable().describe("Default: "), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: true,
  exported: true
}, __toolRegistry);
async function __commentOnPullRequest_impl(number, body, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "commentOnPullRequest",
      args: {
        number,
        body,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["number"] = number;
  __stack.args["body"] = body;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "commentOnPullRequest" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "commentOnPullRequest", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("number" in __overrides) {
      number = __overrides["number"];
      __stack.args["number"] = number;
    }
    if ("body" in __overrides) {
      body = __overrides["body"];
      __stack.args["body"] = body;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(commentOnPullRequestImpl, {
        type: "positional",
        args: [{
          "number": __stack.args.number,
          "body": __stack.args.body,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "commentOnPullRequest",
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
          functionName: "commentOnPullRequest",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const commentOnPullRequest = __AgencyFunction.create({
  name: "commentOnPullRequest",
  module: "../github/index.agency",
  fn: __commentOnPullRequest_impl,
  params: [{
    name: "number",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "body",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "commentOnPullRequest",
    description: `No description provided.`,
    schema: z.object({ "number": z.number(), "body": z.string(), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
async function __addLabel_impl(number, labels, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "addLabel",
      args: {
        number,
        labels,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["number"] = number;
  __stack.args["labels"] = labels;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "addLabel" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "addLabel", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("number" in __overrides) {
      number = __overrides["number"];
      __stack.args["number"] = number;
    }
    if ("labels" in __overrides) {
      labels = __overrides["labels"];
      __stack.args["labels"] = labels;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(addLabelImpl, {
        type: "positional",
        args: [{
          "number": __stack.args.number,
          "labels": __stack.args.labels,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "addLabel",
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
          functionName: "addLabel",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const addLabel = __AgencyFunction.create({
  name: "addLabel",
  module: "../github/index.agency",
  fn: __addLabel_impl,
  params: [{
    name: "number",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "labels",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "addLabel",
    description: `No description provided.`,
    schema: z.object({ "number": z.number(), "labels": z.array(z.string()), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
async function __requestReview_impl(number, reviewers = __UNSET, teamReviewers = __UNSET, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "requestReview",
      args: {
        number,
        reviewers,
        teamReviewers,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["number"] = number;
  __stack.args["reviewers"] = reviewers === __UNSET ? [] : reviewers;
  __stack.args["teamReviewers"] = teamReviewers === __UNSET ? [] : teamReviewers;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "requestReview" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "requestReview", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("number" in __overrides) {
      number = __overrides["number"];
      __stack.args["number"] = number;
    }
    if ("reviewers" in __overrides) {
      reviewers = __overrides["reviewers"];
      __stack.args["reviewers"] = reviewers;
    }
    if ("teamReviewers" in __overrides) {
      teamReviewers = __overrides["teamReviewers"];
      __stack.args["teamReviewers"] = teamReviewers;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(requestReviewImpl, {
        type: "positional",
        args: [{
          "number": __stack.args.number,
          "reviewers": __stack.args.reviewers,
          "teamReviewers": __stack.args.teamReviewers,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "requestReview",
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
          functionName: "requestReview",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const requestReview = __AgencyFunction.create({
  name: "requestReview",
  module: "../github/index.agency",
  fn: __requestReview_impl,
  params: [{
    name: "number",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "reviewers",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "teamReviewers",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "requestReview",
    description: `No description provided.`,
    schema: z.object({ "number": z.number(), "reviewers": z.array(z.string()).nullable().describe("Default: []"), "teamReviewers": z.array(z.string()).nullable().describe("Default: []"), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
async function __listIssues_impl(state = __UNSET, labels = __UNSET, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "listIssues",
      args: {
        state,
        labels,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["state"] = state === __UNSET ? `open` : state;
  __stack.args["labels"] = labels === __UNSET ? [] : labels;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "listIssues" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "listIssues", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("state" in __overrides) {
      state = __overrides["state"];
      __stack.args["state"] = state;
    }
    if ("labels" in __overrides) {
      labels = __overrides["labels"];
      __stack.args["labels"] = labels;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __functionCompleted = true;
      runner2.halt(await __call(listIssuesImpl, {
        type: "positional",
        args: [{
          "state": __stack.args.state,
          "labels": __stack.args.labels,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "listIssues",
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
          functionName: "listIssues",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const listIssues = __AgencyFunction.create({
  name: "listIssues",
  module: "../github/index.agency",
  fn: __listIssues_impl,
  params: [{
    name: "state",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "labels",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "listIssues",
    description: `No description provided.`,
    schema: z.object({ "state": z.string().nullable().describe("Default: open"), "labels": z.array(z.string()).nullable().describe("Default: []"), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: true,
  exported: true
}, __toolRegistry);
async function __commentOnIssue_impl(number, body, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "commentOnIssue",
      args: {
        number,
        body,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["number"] = number;
  __stack.args["body"] = body;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "commentOnIssue" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "commentOnIssue", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("number" in __overrides) {
      number = __overrides["number"];
      __stack.args["number"] = number;
    }
    if ("body" in __overrides) {
      body = __overrides["body"];
      __stack.args["body"] = body;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(commentOnIssueImpl, {
        type: "positional",
        args: [{
          "number": __stack.args.number,
          "body": __stack.args.body,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "commentOnIssue",
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
          functionName: "commentOnIssue",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const commentOnIssue = __AgencyFunction.create({
  name: "commentOnIssue",
  module: "../github/index.agency",
  fn: __commentOnIssue_impl,
  params: [{
    name: "number",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "body",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "commentOnIssue",
    description: `No description provided.`,
    schema: z.object({ "number": z.number(), "body": z.string(), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
async function __createIssue_impl(title, body, labels = __UNSET, owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "createIssue",
      args: {
        title,
        body,
        labels,
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["title"] = title;
  __stack.args["body"] = body;
  __stack.args["labels"] = labels === __UNSET ? [] : labels;
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "createIssue" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "createIssue", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("title" in __overrides) {
      title = __overrides["title"];
      __stack.args["title"] = title;
    }
    if ("body" in __overrides) {
      body = __overrides["body"];
      __stack.args["body"] = body;
    }
    if ("labels" in __overrides) {
      labels = __overrides["labels"];
      __stack.args["labels"] = labels;
    }
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __self.__retryable = false;
      __functionCompleted = true;
      runner2.halt(await __call(createIssueImpl, {
        type: "positional",
        args: [{
          "title": __stack.args.title,
          "body": __stack.args.body,
          "labels": __stack.args.labels,
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "createIssue",
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
          functionName: "createIssue",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const createIssue = __AgencyFunction.create({
  name: "createIssue",
  module: "../github/index.agency",
  fn: __createIssue_impl,
  params: [{
    name: "title",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "body",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "labels",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "createIssue",
    description: `No description provided.`,
    schema: z.object({ "title": z.string(), "body": z.string(), "labels": z.array(z.string()).nullable().describe("Default: []"), "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: false,
  exported: true
}, __toolRegistry);
async function __defaultBranch_impl(owner = __UNSET, repo = __UNSET, token = __UNSET, __state = void 0) {
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
  if (!__ctx.globals.isInitialized("../github/index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  await callHook({
    callbacks: __ctx.callbacks,
    name: "onFunctionStart",
    data: {
      functionName: "defaultBranch",
      args: {
        owner,
        repo,
        token
      },
      isBuiltin: false,
      moduleId: "../github/index.agency"
    }
  });
  __stack.args["owner"] = owner === __UNSET ? `` : owner;
  __stack.args["repo"] = repo === __UNSET ? `` : repo;
  __stack.args["token"] = token === __UNSET ? `` : token;
  __self.__retryable = __self.__retryable ?? true;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "../github/index.agency", scopeName: "defaultBranch" });
  let __resultCheckpointId = -1;
  if (__ctx.stateStack.currentNodeId()) {
    __resultCheckpointId = __ctx.checkpoints.createPinned(__stateStack, __ctx, { moduleId: "../github/index.agency", scopeName: "defaultBranch", stepPath: "", label: "result-entry" });
  }
  if (__ctx._pendingArgOverrides) {
    const __overrides = __ctx._pendingArgOverrides;
    __ctx._pendingArgOverrides = void 0;
    if ("owner" in __overrides) {
      owner = __overrides["owner"];
      __stack.args["owner"] = owner;
    }
    if ("repo" in __overrides) {
      repo = __overrides["repo"];
      __stack.args["repo"] = repo;
    }
    if ("token" in __overrides) {
      token = __overrides["token"];
      __stack.args["token"] = token;
    }
  }
  try {
    await runner.step(0, async (runner2) => {
      __functionCompleted = true;
      runner2.halt(await __call(defaultBranchImpl, {
        type: "positional",
        args: [{
          "owner": __stack.args.owner,
          "repo": __stack.args.repo,
          "token": __stack.args.token
        }]
      }, {
        ctx: __ctx,
        threads: __threads,
        stateStack: __stateStack
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
        functionName: "defaultBranch",
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
          functionName: "defaultBranch",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const defaultBranch = __AgencyFunction.create({
  name: "defaultBranch",
  module: "../github/index.agency",
  fn: __defaultBranch_impl,
  params: [{
    name: "owner",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "repo",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }, {
    name: "token",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false
  }],
  toolDefinition: {
    name: "defaultBranch",
    description: `No description provided.`,
    schema: z.object({ "owner": z.string().nullable().describe("Default: "), "repo": z.string().nullable().describe("Default: "), "token": z.string().nullable().describe("Default: ") })
  },
  safe: true,
  exported: true
}, __toolRegistry);
var stdin_default = graph;
const __sourceMap = { "../github/index.agency:createBranch": { "0": { "line": 20, "col": 2 } }, "../github/index.agency:deleteBranch": { "0": { "line": 25, "col": 2 } }, "../github/index.agency:branchExists": { "0": { "line": 30, "col": 2 } }, "../github/index.agency:commitFiles": { "0": { "line": 35, "col": 2 } }, "../github/index.agency:openPullRequest": { "0": { "line": 47, "col": 2 } }, "../github/index.agency:listPullRequests": { "0": { "line": 52, "col": 2 } }, "../github/index.agency:commentOnPullRequest": { "0": { "line": 57, "col": 2 } }, "../github/index.agency:addLabel": { "0": { "line": 62, "col": 2 } }, "../github/index.agency:requestReview": { "0": { "line": 67, "col": 2 } }, "../github/index.agency:listIssues": { "0": { "line": 72, "col": 2 } }, "../github/index.agency:commentOnIssue": { "0": { "line": 77, "col": 2 } }, "../github/index.agency:createIssue": { "0": { "line": 82, "col": 2 } }, "../github/index.agency:defaultBranch": { "0": { "line": 87, "col": 2 } } };
export {
  __getCheckpoints,
  __setDebugger,
  __setLLMClient,
  __setTraceWriter,
  __sourceMap,
  __toolRegistry,
  addLabel,
  approve,
  branchExists,
  commentOnIssue,
  commentOnPullRequest,
  commitFiles,
  createBranch,
  createIssue,
  stdin_default as default,
  defaultBranch,
  deleteBranch,
  hasInterrupts,
  interrupt,
  isDebugger,
  isInterrupt,
  listIssues,
  listPullRequests,
  openPullRequest,
  readSkill,
  reject,
  requestReview,
  respondToInterrupts,
  rewindFrom
};
