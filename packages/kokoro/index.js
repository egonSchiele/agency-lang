import { print, printJSON, input, sleep, saveDraft, _guard, _pairsOf, read, write, writeBinary, readBinary, range, callback, map, mapWithIndex, filter, exclude, find, findIndex, reduce, flatMap, every, some, count, sortBy, unique, groupBy, flatten, setAgentCwd, getAgentCwd, applyAgentCwd } from "agency-lang/stdlib/index.js";
import { _realTarget } from "agency-lang/stdlib-lib/contained.js";
import { _speak, _download, _modelStatus, _validateSpeakArgs, _voices } from "./dist/src/agency.js";
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
  isRejected,
  isApproved,
  interruptWithHandlers,
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
  isAborted,
  __registerGlobalsInit,
  __registerCallbacksInit,
  registerModuleFingerprint as __registerModuleFingerprint,
  runtimeFailure,
  isFailure,
  stampFailureBoundary,
  __tryCall,
  __eq,
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
__registerModuleFingerprint("index.agency", "61136e9d6df39d235bc6f06d26be91a6321672ffce3de91a997c08706ea61e35", import.meta.url);
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
const Voice = z.object({ "id": z.string(), "name": z.string(), "language": z.string(), "gender": z.string(), "grade": z.string() });
async function __realOutput_impl(outputFile) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  claimFrameForScope(__stack, "realOutput", "index.agency");
  if (!__globals().isInitialized("index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  __stack.args["outputFile"] = outputFile;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "index.agency", scopeName: "realOutput", threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides?.moduleId === __stack.moduleId && __ctx._pendingArgOverrides?.scopeName === __stack.scopeName) {
    const __overrides = __ctx._pendingArgOverrides.values;
    __ctx._pendingArgOverrides = void 0;
    if ("outputFile" in __overrides) {
      outputFile = __overrides["outputFile"];
      __stack.args["outputFile"] = outputFile;
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
            functionName: "realOutput",
            args: {
              outputFile
            },
            moduleId: "index.agency"
          }
        });
      });
      await runner.ifElse(1, [
        {
          condition: async () => __eq(__stack.args.outputFile, ``),
          body: async (runner2) => {
            await runner2.step(0, async (runner3) => {
              __functionCompleted = true;
              runner3.halt(``);
              return;
            });
          }
        }
      ]);
      await runner.step(2, async (runner2) => {
        __stack.locals.real = await __tryCall(async () => await __call(_realTarget, {
          type: "positional",
          args: [__stack.args.outputFile]
        }), {
          checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
          functionName: "realOutput",
          args: __stack.args
        });
        if (hasInterrupts(__stack.locals.real)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.real);
          return;
        }
        if (isAborted(__stack.locals.real)) {
          runner2.halt(__stack.locals.real.carryThrough(__stack, "realOutput"));
          return;
        }
      });
      await runner.step(3, async (runner2) => {
        __stack.locals.__hoist_0 = await isFailure(__stack.locals.real);
        if (hasInterrupts(__stack.locals.__hoist_0)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.__hoist_0);
          return;
        }
        if (isAborted(__stack.locals.__hoist_0)) {
          runner2.halt(__stack.locals.__hoist_0.carryThrough(__stack, "realOutput"));
          return;
        }
      });
      await runner.ifElse(4, [
        {
          condition: async () => __stack.locals.__hoist_0,
          body: async (runner2) => {
            await runner2.step(0, async (runner3) => {
              __stack.locals.why = __stack.locals.real.error;
            });
            await runner2.step(1, async (runner3) => {
              throw new Error(`${__stack.locals.why}`);
            });
          }
        }
      ]);
      await runner.step(5, async (runner2) => {
        __functionCompleted = true;
        runner2.halt(__stack.locals.real.value);
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
      return AbortedResult.fromError(__error, __stack, "realOutput");
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function realOutput threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "realOutput"
      });
    }
    return runtimeFailure(__error, {
      checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
      destructiveRan: __self.__destructiveRan,
      functionName: "realOutput",
      args: __stack.args
    });
  } finally {
    __stateStack()?.pop();
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "realOutput",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const realOutput = __AgencyFunction.create({
  name: "realOutput",
  module: "index.agency",
  fn: __realOutput_impl,
  params: [{
    name: "outputFile",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "realOutput",
    description: "No description provided.",
    schema: z.object({ "outputFile": z.string() })
  },
  exported: false
}, __toolRegistry);
async function __speak_impl(text, outputFile = __UNSET, voice = __UNSET, model = __UNSET, speed = __UNSET, allowedPaths = __UNSET, format = __UNSET, modelsDir = __UNSET) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  claimFrameForScope(__stack, "speak", "index.agency");
  if (!__globals().isInitialized("index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  __stack.args["text"] = text;
  __stack.args["outputFile"] = outputFile === __UNSET ? `` : outputFile;
  __stack.args["voice"] = voice === __UNSET ? `af_heart` : voice;
  __stack.args["model"] = model === __UNSET ? `fp32` : model;
  __stack.args["speed"] = speed === __UNSET ? 1 : speed;
  __stack.args["allowedPaths"] = allowedPaths === __UNSET ? [] : allowedPaths;
  __stack.args["format"] = format === __UNSET ? `` : format;
  __stack.args["modelsDir"] = modelsDir === __UNSET ? null : modelsDir;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "index.agency", scopeName: "speak", threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides?.moduleId === __stack.moduleId && __ctx._pendingArgOverrides?.scopeName === __stack.scopeName) {
    const __overrides = __ctx._pendingArgOverrides.values;
    __ctx._pendingArgOverrides = void 0;
    if ("text" in __overrides) {
      text = __overrides["text"];
      __stack.args["text"] = text;
    }
    if ("outputFile" in __overrides) {
      outputFile = __overrides["outputFile"];
      __stack.args["outputFile"] = outputFile;
    }
    if ("voice" in __overrides) {
      voice = __overrides["voice"];
      __stack.args["voice"] = voice;
    }
    if ("model" in __overrides) {
      model = __overrides["model"];
      __stack.args["model"] = model;
    }
    if ("speed" in __overrides) {
      speed = __overrides["speed"];
      __stack.args["speed"] = speed;
    }
    if ("allowedPaths" in __overrides) {
      allowedPaths = __overrides["allowedPaths"];
      __stack.args["allowedPaths"] = allowedPaths;
    }
    if ("format" in __overrides) {
      format = __overrides["format"];
      __stack.args["format"] = format;
    }
    if ("modelsDir" in __overrides) {
      modelsDir = __overrides["modelsDir"];
      __stack.args["modelsDir"] = modelsDir;
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
            functionName: "speak",
            args: {
              text,
              outputFile,
              voice,
              model,
              speed,
              allowedPaths,
              format,
              modelsDir
            },
            moduleId: "index.agency"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        __stack.locals.audioFormat = await __call(_validateSpeakArgs, {
          type: "positional",
          args: [__stack.args.text, __stack.args.outputFile, __stack.args.voice, __stack.args.model, __stack.args.speed, __stack.args.format]
        });
        if (hasInterrupts(__stack.locals.audioFormat)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.audioFormat);
          return;
        }
        if (isAborted(__stack.locals.audioFormat)) {
          runner2.halt(__stack.locals.audioFormat.carryThrough(__stack, "speak"));
          return;
        }
      });
      await runner.step(2, async (runner2) => {
        __stack.locals.status = await __call(_modelStatus, {
          type: "positional",
          args: [__stack.args.model, __stack.args.modelsDir]
        });
        if (hasInterrupts(__stack.locals.status)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.status);
          return;
        }
        if (isAborted(__stack.locals.status)) {
          runner2.halt(__stack.locals.status.carryThrough(__stack, "speak"));
          return;
        }
      });
      await runner.ifElse(3, [
        {
          condition: async () => __eq(__stack.locals.status.installed, false),
          body: async (runner2) => {
            await runner2.step(0, async (runner3) => {
              const __response = getRuntimeContext().ctx.getInterruptResponse(__self.__interruptId_3_0);
              if (__response) {
                if (__response.type === "approve") {
                } else if (__response.type === "reject") {
                  runner3.halt(runtimeFailure(__response.value ?? "interrupt rejected", { rejected: true, checkpoint: getRuntimeContext().ctx.getResultCheckpoint() }));
                  return;
                }
              } else {
                const __handlerResult = await interruptWithHandlers("kokoro::download", `Download the Kokoro text-to-speech model?`, {
                  "model": __stack.args.model,
                  "sizeBytes": __stack.locals.status.sizeBytes,
                  "source": __stack.locals.status.source,
                  "dir": __stack.locals.status.dir
                }, "./index.agency", __ctx, __stateStack());
                if (isRejected(__handlerResult)) {
                  runner3.halt(runtimeFailure(__handlerResult.value ?? "interrupt rejected", { rejected: true, checkpoint: getRuntimeContext().ctx.checkpoints.get(__resultCheckpointId) }));
                  return;
                }
                if (!isApproved(__handlerResult)) {
                  __self.__interruptId_3_0 = __handlerResult[0].interruptId;
                  const __checkpointId = getRuntimeContext().ctx.checkpoints.create(__stateStack(), __ctx, { moduleId: "index.agency", scopeName: "speak", stepPath: "3.0" });
                  __handlerResult[0].checkpointId = __checkpointId;
                  __handlerResult[0].checkpoint = getRuntimeContext().ctx.checkpoints.get(__checkpointId);
                  runner3.halt(__handlerResult);
                  return;
                }
              }
            });
            await runner2.step(1, async (runner3) => {
              const __funcResult = await __call(_download, {
                type: "positional",
                args: [__stack.args.model, __stack.args.modelsDir]
              });
              if (hasInterrupts(__funcResult)) {
                await getRuntimeContext().ctx.pendingPromises.awaitAll();
                runner3.halt(__funcResult);
                return;
              }
              if (isAborted(__funcResult)) {
                runner3.halt(__funcResult.carryThrough(__stack, "speak"));
                return;
              }
            });
          }
        }
      ]);
      await runner.step(4, async (runner2) => {
        __stack.locals.out = await __call(realOutput, {
          type: "positional",
          args: [__stack.args.outputFile]
        });
        if (hasInterrupts(__stack.locals.out)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.out);
          return;
        }
        if (isAborted(__stack.locals.out)) {
          runner2.halt(__stack.locals.out.carryThrough(__stack, "speak"));
          return;
        }
      });
      await runner.step(5, async (runner2) => {
        const __response = getRuntimeContext().ctx.getInterruptResponse(__self.__interruptId_5);
        if (__response) {
          if (__response.type === "approve") {
          } else if (__response.type === "reject") {
            runner2.halt(runtimeFailure(__response.value ?? "interrupt rejected", { rejected: true, checkpoint: getRuntimeContext().ctx.getResultCheckpoint() }));
            return;
          }
        } else {
          const __handlerResult = await interruptWithHandlers("kokoro::speak", `Allow Kokoro to write an audio file?`, {
            "textLength": __stack.args.text.length,
            "voice": __stack.args.voice,
            "outputFile": __stack.locals.out,
            "format": __stack.locals.audioFormat
          }, "./index.agency", __ctx, __stateStack());
          if (isRejected(__handlerResult)) {
            runner2.halt(runtimeFailure(__handlerResult.value ?? "interrupt rejected", { rejected: true, checkpoint: getRuntimeContext().ctx.checkpoints.get(__resultCheckpointId) }));
            return;
          }
          if (!isApproved(__handlerResult)) {
            __self.__interruptId_5 = __handlerResult[0].interruptId;
            const __checkpointId = getRuntimeContext().ctx.checkpoints.create(__stateStack(), __ctx, { moduleId: "index.agency", scopeName: "speak", stepPath: "5" });
            __handlerResult[0].checkpointId = __checkpointId;
            __handlerResult[0].checkpoint = getRuntimeContext().ctx.checkpoints.get(__checkpointId);
            runner2.halt(__handlerResult);
            return;
          }
        }
      });
      await runner.step(6, async (runner2) => {
        __functionCompleted = true;
        runner2.halt(await __call(_speak, {
          type: "positional",
          args: [__stack.args.text, __stack.locals.out, __stack.args.voice, __stack.args.model, __stack.args.speed, __stack.args.allowedPaths, __stack.locals.audioFormat, __stack.args.modelsDir]
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
      return AbortedResult.fromError(__error, __stack, "speak");
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function speak threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "speak"
      });
    }
    return runtimeFailure(__error, {
      checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
      destructiveRan: __self.__destructiveRan,
      functionName: "speak",
      args: __stack.args
    });
  } finally {
    __stateStack()?.pop();
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "speak",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const speak = __AgencyFunction.create({
  name: "speak",
  module: "index.agency",
  fn: __speak_impl,
  params: [{
    name: "text",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "outputFile",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "voice",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "model",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "speed",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "allowedPaths",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "format",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "modelsDir",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "speak",
    description: `Speak text into an audio file. Returns the file path.

  @param text - The text to speak, at most 50,000 characters
  @param outputFile - Where to write the file. Leave empty for a new temp file. An existing file is never overwritten.
  @param voice - A voice id from voices(), such as "af_heart"
  @param model - "fp32" or "q8"
  @param speed - Speaking speed, from 0.5 to 2
  @param allowedPaths - Directories that outputFile must be inside
  @param format - "wav", "mp3", or "m4a". Leave empty to use the output file's extension, or wav when it has none.
  @param modelsDir - Where models are kept. Leave null for the default.`,
    schema: z.object({ "text": z.string(), "outputFile": z.string().nullable().describe("Default: "), "voice": z.string().nullable().describe("Default: af_heart"), "model": z.string().nullable().describe("Default: fp32"), "speed": z.number().nullable().describe("Default: 1"), "allowedPaths": z.array(z.string()).nullable().describe("Default: []"), "format": z.string().nullable().describe("Default: "), "modelsDir": z.union([z.string(), z.null()]).describe("Default: null") })
  },
  exported: true
}, __toolRegistry);
async function __download_impl(model = __UNSET, modelsDir = __UNSET) {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  claimFrameForScope(__stack, "download", "index.agency");
  if (!__globals().isInitialized("index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  __stack.args["model"] = model === __UNSET ? `fp32` : model;
  __stack.args["modelsDir"] = modelsDir === __UNSET ? null : modelsDir;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "index.agency", scopeName: "download", threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides?.moduleId === __stack.moduleId && __ctx._pendingArgOverrides?.scopeName === __stack.scopeName) {
    const __overrides = __ctx._pendingArgOverrides.values;
    __ctx._pendingArgOverrides = void 0;
    if ("model" in __overrides) {
      model = __overrides["model"];
      __stack.args["model"] = model;
    }
    if ("modelsDir" in __overrides) {
      modelsDir = __overrides["modelsDir"];
      __stack.args["modelsDir"] = modelsDir;
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
            functionName: "download",
            args: {
              model,
              modelsDir
            },
            moduleId: "index.agency"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        __stack.locals.status = await __call(_modelStatus, {
          type: "positional",
          args: [__stack.args.model, __stack.args.modelsDir]
        });
        if (hasInterrupts(__stack.locals.status)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.status);
          return;
        }
        if (isAborted(__stack.locals.status)) {
          runner2.halt(__stack.locals.status.carryThrough(__stack, "download"));
          return;
        }
      });
      await runner.ifElse(2, [
        {
          condition: async () => __stack.locals.status.installed,
          body: async (runner2) => {
            await runner2.step(0, async (runner3) => {
              __functionCompleted = true;
              runner3.halt(__stack.locals.status.dir);
              return;
            });
          }
        }
      ]);
      await runner.step(3, async (runner2) => {
        const __response = getRuntimeContext().ctx.getInterruptResponse(__self.__interruptId_3);
        if (__response) {
          if (__response.type === "approve") {
          } else if (__response.type === "reject") {
            runner2.halt(runtimeFailure(__response.value ?? "interrupt rejected", { rejected: true, checkpoint: getRuntimeContext().ctx.getResultCheckpoint() }));
            return;
          }
        } else {
          const __handlerResult = await interruptWithHandlers("kokoro::download", `Download the Kokoro text-to-speech model?`, {
            "model": __stack.args.model,
            "sizeBytes": __stack.locals.status.sizeBytes,
            "source": __stack.locals.status.source,
            "dir": __stack.locals.status.dir
          }, "./index.agency", __ctx, __stateStack());
          if (isRejected(__handlerResult)) {
            runner2.halt(runtimeFailure(__handlerResult.value ?? "interrupt rejected", { rejected: true, checkpoint: getRuntimeContext().ctx.checkpoints.get(__resultCheckpointId) }));
            return;
          }
          if (!isApproved(__handlerResult)) {
            __self.__interruptId_3 = __handlerResult[0].interruptId;
            const __checkpointId = getRuntimeContext().ctx.checkpoints.create(__stateStack(), __ctx, { moduleId: "index.agency", scopeName: "download", stepPath: "3" });
            __handlerResult[0].checkpointId = __checkpointId;
            __handlerResult[0].checkpoint = getRuntimeContext().ctx.checkpoints.get(__checkpointId);
            runner2.halt(__handlerResult);
            return;
          }
        }
      });
      await runner.step(4, async (runner2) => {
        const __funcResult = await __call(_download, {
          type: "positional",
          args: [__stack.args.model, __stack.args.modelsDir]
        });
        if (hasInterrupts(__funcResult)) {
          await getRuntimeContext().ctx.pendingPromises.awaitAll();
          runner2.halt(__funcResult);
          return;
        }
        if (isAborted(__funcResult)) {
          runner2.halt(__funcResult.carryThrough(__stack, "download"));
          return;
        }
      });
      await runner.step(5, async (runner2) => {
        __functionCompleted = true;
        runner2.halt(__stack.locals.status.dir);
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
      return AbortedResult.fromError(__error, __stack, "download");
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function download threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "download"
      });
    }
    return runtimeFailure(__error, {
      checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
      destructiveRan: __self.__destructiveRan,
      functionName: "download",
      args: __stack.args
    });
  } finally {
    __stateStack()?.pop();
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "download",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const download = __AgencyFunction.create({
  name: "download",
  module: "index.agency",
  fn: __download_impl,
  params: [{
    name: "model",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "modelsDir",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "download",
    description: `Download a Kokoro text-to-speech model. Returns the directory it is in. Does nothing when it is already there.

  @param model - "fp32" (326 MB) or "q8" (92 MB)
  @param modelsDir - Where models are kept. Leave null for the default.`,
    schema: z.object({ "model": z.string().nullable().describe("Default: fp32"), "modelsDir": z.union([z.string(), z.null()]).describe("Default: null") })
  },
  exported: true
}, __toolRegistry);
async function __voices_impl() {
  const __setupData = setupFunction();
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = getRuntimeContext().ctx;
  let __forked;
  let __functionCompleted = false;
  claimFrameForScope(__stack, "voices", "index.agency");
  if (!__globals().isInitialized("index.agency")) {
    await __initializeGlobals(__ctx);
  }
  let __funcStartTime = performance.now();
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "index.agency", scopeName: "voices", threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides?.moduleId === __stack.moduleId && __ctx._pendingArgOverrides?.scopeName === __stack.scopeName) {
    const __overrides = __ctx._pendingArgOverrides.values;
    __ctx._pendingArgOverrides = void 0;
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
            functionName: "voices",
            args: {},
            moduleId: "index.agency"
          }
        });
      });
      await runner.step(1, async (runner2) => {
        __functionCompleted = true;
        runner2.halt(await __call(_voices, {
          type: "positional",
          args: []
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
      return AbortedResult.fromError(__error, __stack, "voices");
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function voices threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __ctx.statelogClient?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "voices"
      });
    }
    return runtimeFailure(__error, {
      checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
      destructiveRan: __self.__destructiveRan,
      functionName: "voices",
      args: __stack.args
    });
  } finally {
    __stateStack()?.pop();
    if (__functionCompleted) {
      await callHook({
        name: "onFunctionEnd",
        data: {
          functionName: "voices",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const voices = __AgencyFunction.create({
  name: "voices",
  module: "index.agency",
  fn: __voices_impl,
  params: [],
  toolDefinition: {
    name: "voices",
    description: `List the Kokoro voices. Each voice has an id, name, language, gender, and a
  quality grade from A (best) to F.`,
    schema: z.object({})
  },
  exported: true
}, __toolRegistry);
var stdin_default = graph;
const __sourceMap = { "index.agency:realOutput": { "1": { "line": 48, "col": 2 }, "2": { "line": 51, "col": 2 }, "3": { "line": 52, "col": 14 }, "4": { "line": 52, "col": 2 }, "5": { "line": 55, "col": 2 }, "1.0": { "line": 49, "col": 4 }, "4.0": { "line": 52, "col": 2 }, "4.1": { "line": 53, "col": 4 } }, "index.agency:speak": { "1": { "line": 91, "col": 2 }, "2": { "line": 92, "col": 2 }, "3": { "line": 93, "col": 2 }, "4": { "line": 102, "col": 2 }, "5": { "line": 103, "col": 2 }, "6": { "line": 109, "col": 2 }, "3.0": { "line": 94, "col": 4 }, "3.1": { "line": 100, "col": 4 } }, "index.agency:download": { "1": { "line": 124, "col": 2 }, "2": { "line": 125, "col": 2 }, "3": { "line": 128, "col": 2 }, "4": { "line": 134, "col": 2 }, "5": { "line": 135, "col": 2 }, "2.0": { "line": 126, "col": 4 } }, "index.agency:voices": { "1": { "line": 143, "col": 2 } } };
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
  download,
  hasInterrupts,
  interrupt,
  isDebugger,
  isInterrupt,
  isPaused,
  realOutput,
  reject,
  respondToInterrupts,
  resumeFromCheckpoint,
  rewindFrom,
  speak,
  voices
};
