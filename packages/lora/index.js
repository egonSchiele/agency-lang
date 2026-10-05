import { print, printJSON, input, sleep, saveDraft, _guard, _pairsOf, read, write, writeBinary, readBinary, range, callback, map, mapWithIndex, filter, exclude, find, findIndex, reduce, flatMap, every, some, count, sortBy, unique, groupBy, flatten, setAgentCwd, getAgentCwd, applyAgentCwd } from "agency-lang/stdlib/index.js";
import { _planTraining, _train, _loraInfo } from "./dist/src/agency.js";
import { _realTarget } from "agency-lang/stdlib-lib/contained.js";
import { dirname, basename } from "agency-lang/stdlib/path.js";
import { fileURLToPath } from "url";
import __process from "process";
import { readFileSync } from "fs";
import { z } from "agency-lang/zod";
import path from "path";
import {
  RuntimeContext,
  Runner,
  setupFunction,
  claimFrameForScope,
  callHook,
  checkpointFor as __checkpoint_impl,
  getCheckpointFor as __getCheckpoint_impl,
  restoreFor as __restore_impl,
  _runFor as __runtime_run_impl,
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
  deepFreeze as __deepFreeze,
  __UNINIT_STATIC,
  __registerStaticInit,
  __registerGlobalsInit,
  __registerCallbacksInit,
  __registerAlwaysScope,
  registerModuleFingerprint as __registerModuleFingerprint,
  runtimeFailure,
  isFailure,
  stampFailureBoundary,
  __tryCall,
  AgencyFunction as __AgencyFunction,
  UNSET as __UNSET,
  __call,
  withChildRun as __withChildRun,
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
    host: "",
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
const respondToInterrupts = (interrupts, responses, opts) => _respondToInterrupts({ ctx: __globalCtx, interrupts, responses, overrides: opts?.overrides, metadata: opts?.metadata, abortSignal: opts?.abortSignal, pauseSignal: opts?.pauseSignal, invocation: opts?.invocation });
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
__registerModuleFingerprint("index.agency", "a489ef1a3ffa91dc461e799ccd9bf384e010b526d9354af59766c290e12a15ea", import.meta.url);
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
__registerTool(dirname);
__registerTool(basename);
__registerAlwaysScope("lora::train", [{ "field": "outDir", "matchSubpaths": true }, { "field": "imagesDir", "matchSubpaths": true }]);
__registerAlwaysScope("lora::info", [{ "field": "dir", "matchSubpaths": true }]);
let __staticInitPromise = null;
let STYLE_TAGS = __UNINIT_STATIC;
async function __initializeStatic(__run) {
  const __ctx = __run.ctx;
  if (__staticInitPromise) {
    return __staticInitPromise;
  }
  __staticInitPromise = (async () => {
    STYLE_TAGS = __deepFreeze([`monochrome`, `greyscale`, `white background`, `simple background`, `traditional media`, `sketch`, `lineart`, `signature`, `text focus`, `no humans`]);
  })();
  return __staticInitPromise;
}
function __getStaticVars() {
  return {
    STYLE_TAGS
  };
}
__globalCtx.getStaticVars = __getStaticVars;
__registerStaticInit("index.agency", __initializeStatic);
async function __initializeGlobals(__run) {
  const __ctx = __run.ctx;
  if (__ctx.globals.isInitialized("index.agency")) {
    return;
  }
  __ctx.globals.markInitialized("index.agency");
  await __initializeStatic(__run);
  await __ctx.writeStaticStateToTrace(__globalCtx.getStaticVars());
}
__registerGlobalsInit("index.agency", __initializeGlobals);
async function __registerTopLevelCallbacks(__run) {
  const __ctx = __run.ctx;
}
__registerCallbacksInit("index.agency", __registerTopLevelCallbacks);
__functionRefReviver.registry = __toolRegistry;
const TrainedLora = z.object({ "path": z.string(), "steps": z.number(), "images": z.number(), "minutes": z.number(), "samples": z.array(z.string()) });
const LoraInfo = z.object({ "base": z.string(), "trigger": z.string(), "rank": z.number(), "steps": z.number(), "sizeBytes": z.number() });
async function __trainLora_impl(__run, imagesDir, trigger, base, outPath, steps = __UNSET, rank = __UNSET, learningRate = __UNSET, resolution = __UNSET, flip = __UNSET, seed = __UNSET, samplePrompts = __UNSET, sampleEvery = __UNSET) {
  const __setupData = setupFunction(__run);
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = __run.ctx;
  let __forked;
  let __functionCompleted = false;
  claimFrameForScope(__stack, "trainLora", "index.agency", __run.log);
  if (!__run.globals.isInitialized("index.agency")) {
    await __initializeGlobals(__run);
  }
  let __funcStartTime = performance.now();
  __stack.args["imagesDir"] = imagesDir;
  __stack.args["trigger"] = trigger;
  __stack.args["base"] = base;
  __stack.args["outPath"] = outPath;
  __stack.args["steps"] = steps === __UNSET ? 1e3 : steps;
  __stack.args["rank"] = rank === __UNSET ? 16 : rank;
  __stack.args["learningRate"] = learningRate === __UNSET ? 1e-4 : learningRate;
  __stack.args["resolution"] = resolution === __UNSET ? 1024 : resolution;
  __stack.args["flip"] = flip === __UNSET ? false : flip;
  __stack.args["seed"] = seed === __UNSET ? 1 : seed;
  __stack.args["samplePrompts"] = samplePrompts === __UNSET ? [] : samplePrompts;
  __stack.args["sampleEvery"] = sampleEvery === __UNSET ? 250 : sampleEvery;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "index.agency", scopeName: "trainLora", stack: __run.stack, threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides?.moduleId === __stack.moduleId && __ctx._pendingArgOverrides?.scopeName === __stack.scopeName) {
    const __overrides = __ctx._pendingArgOverrides.values;
    __ctx._pendingArgOverrides = void 0;
    if ("imagesDir" in __overrides) {
      imagesDir = __overrides["imagesDir"];
      __stack.args["imagesDir"] = imagesDir;
    }
    if ("trigger" in __overrides) {
      trigger = __overrides["trigger"];
      __stack.args["trigger"] = trigger;
    }
    if ("base" in __overrides) {
      base = __overrides["base"];
      __stack.args["base"] = base;
    }
    if ("outPath" in __overrides) {
      outPath = __overrides["outPath"];
      __stack.args["outPath"] = outPath;
    }
    if ("steps" in __overrides) {
      steps = __overrides["steps"];
      __stack.args["steps"] = steps;
    }
    if ("rank" in __overrides) {
      rank = __overrides["rank"];
      __stack.args["rank"] = rank;
    }
    if ("learningRate" in __overrides) {
      learningRate = __overrides["learningRate"];
      __stack.args["learningRate"] = learningRate;
    }
    if ("resolution" in __overrides) {
      resolution = __overrides["resolution"];
      __stack.args["resolution"] = resolution;
    }
    if ("flip" in __overrides) {
      flip = __overrides["flip"];
      __stack.args["flip"] = flip;
    }
    if ("seed" in __overrides) {
      seed = __overrides["seed"];
      __stack.args["seed"] = seed;
    }
    if ("samplePrompts" in __overrides) {
      samplePrompts = __overrides["samplePrompts"];
      __stack.args["samplePrompts"] = samplePrompts;
    }
    if ("sampleEvery" in __overrides) {
      sampleEvery = __overrides["sampleEvery"];
      __stack.args["sampleEvery"] = sampleEvery;
    }
  }
  try {
    await __withChildRun(__run, {
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, "its body", async (__run2) => {
      await runner.hook(0, __run2, async (__run3) => {
        await callHook(__run3, {
          name: "onFunctionStart",
          data: {
            functionName: "trainLora",
            args: {
              imagesDir,
              trigger,
              base,
              outPath,
              steps,
              rank,
              learningRate,
              resolution,
              flip,
              seed,
              samplePrompts,
              sampleEvery
            },
            moduleId: "index.agency"
          }
        });
      });
      await runner.step(1, __run2, async (runner2, __run3) => {
        __stack.locals.plan = await __tryCall(__run3.log, async () => await __call(__run3, _planTraining, {
          type: "positional",
          args: [__stack.args.imagesDir, __stack.args.trigger, __stack.args.base, __stack.args.outPath, __stack.args.steps, __stack.args.rank, __stack.args.learningRate, __stack.args.resolution, __stack.args.flip, __stack.args.seed, __stack.args.samplePrompts, __stack.args.sampleEvery]
        }), {
          checkpoint: __run3.ctx.getResultCheckpoint(),
          functionName: "trainLora",
          args: __stack.args
        });
        if (hasInterrupts(__stack.locals.plan)) {
          await __run3.ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.plan);
          return;
        }
        if (isAborted(__stack.locals.plan)) {
          runner2.halt(__stack.locals.plan.carryThrough(__run3.log, __stack, "trainLora"));
          return;
        }
      });
      await runner.step(2, __run2, async (runner2, __run3) => {
        __stack.locals.__hoist_0 = await isFailure(__stack.locals.plan);
        if (hasInterrupts(__stack.locals.__hoist_0)) {
          await __run3.ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.__hoist_0);
          return;
        }
        if (isAborted(__stack.locals.__hoist_0)) {
          runner2.halt(__stack.locals.__hoist_0.carryThrough(__run3.log, __stack, "trainLora"));
          return;
        }
      });
      await runner.ifElse(3, __run2, [
        {
          condition: async (__run3) => __stack.locals.__hoist_0,
          body: async (runner2, __run3) => {
            await runner2.step(0, __run3, async (runner3, __run4) => {
              __functionCompleted = true;
              runner3.halt(__stack.locals.plan);
              return;
            });
          }
        }
      ]);
      await runner.step(4, __run2, async (runner2, __run3) => {
        __stack.locals.__hoist_1 = await __call(__run3, dirname, {
          type: "positional",
          args: [__stack.locals.plan.value.outPath]
        });
        if (hasInterrupts(__stack.locals.__hoist_1)) {
          await __run3.ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.__hoist_1);
          return;
        }
        if (isAborted(__stack.locals.__hoist_1)) {
          runner2.halt(__stack.locals.__hoist_1.carryThrough(__run3.log, __stack, "trainLora"));
          return;
        }
      });
      await runner.step(5, __run2, async (runner2, __run3) => {
        __stack.locals.__hoist_2 = await __call(__run3, basename, {
          type: "positional",
          args: [__stack.locals.plan.value.outPath]
        });
        if (hasInterrupts(__stack.locals.__hoist_2)) {
          await __run3.ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.__hoist_2);
          return;
        }
        if (isAborted(__stack.locals.__hoist_2)) {
          runner2.halt(__stack.locals.__hoist_2.carryThrough(__run3.log, __stack, "trainLora"));
          return;
        }
      });
      await runner.step(6, __run2, async (runner2, __run3) => {
        const __response = __run3.ctx.getInterruptResponse(__self.__interruptId_6);
        if (__response) {
          if (__response.type === "approve") {
          } else if (__response.type === "reject") {
            runner2.halt(runtimeFailure(__response.value ?? "interrupt rejected", { rejected: true, checkpoint: __run3.ctx.getResultCheckpoint() }));
            return;
          }
        } else {
          const __handlerResult = await interruptWithHandlers(__run3, "lora::train", `Train a LoRA adapter on the images in ${__stack.locals.plan.value.imagesDir} for ${__stack.locals.plan.value.steps} steps, about ${__stack.locals.plan.value.estimatedMinutes} minutes on the GPU plus a few seconds an image, writing ${__stack.locals.plan.value.outPath}?`, {
            "imagesDir": __stack.locals.plan.value.imagesDir,
            "base": __stack.locals.plan.value.base,
            "outDir": __stack.locals.__hoist_1,
            "outFilename": __stack.locals.__hoist_2,
            "steps": __stack.locals.plan.value.steps,
            "estimatedMinutes": __stack.locals.plan.value.estimatedMinutes
          }, "./index.agency");
          if (isRejected(__handlerResult)) {
            runner2.halt(runtimeFailure(__handlerResult.value ?? "interrupt rejected", { rejected: true, checkpoint: __run3.ctx.checkpoints.get(__resultCheckpointId) }));
            return;
          }
          if (!isApproved(__handlerResult)) {
            __self.__interruptId_6 = __handlerResult[0].interruptId;
            const __checkpointId = __run3.ctx.checkpoints.create(__run3.stack, __ctx, { moduleId: "index.agency", scopeName: "trainLora", stepPath: "6" });
            __handlerResult[0].checkpointId = __checkpointId;
            __handlerResult[0].checkpoint = __run3.ctx.checkpoints.get(__checkpointId);
            runner2.halt(__handlerResult);
            return;
          }
        }
      });
      await runner.step(7, __run2, async (runner2, __run3) => {
        __functionCompleted = true;
        runner2.halt(await __tryCall(__run3.log, async () => await __call(__run3, _train, {
          type: "positional",
          args: [__stack.locals.plan.value]
        }), {
          checkpoint: __run3.ctx.getResultCheckpoint(),
          functionName: "trainLora",
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
      return AbortedResult.fromError(__run.log, __error, __stack, "trainLora");
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function trainLora threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __run.log?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "trainLora"
      });
    }
    return runtimeFailure(__error, {
      checkpoint: __run.ctx.getResultCheckpoint(),
      destructiveRan: __self.__destructiveRan,
      functionName: "trainLora",
      args: __stack.args
    });
  } finally {
    __run.stack.pop();
    if (__functionCompleted) {
      await callHook(__run, {
        name: "onFunctionEnd",
        data: {
          functionName: "trainLora",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const trainLora = __AgencyFunction.create({
  name: "trainLora",
  module: "index.agency",
  fn: __trainLora_impl,
  params: [{
    name: "imagesDir",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "trigger",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "base",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "outPath",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "steps",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "rank",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "learningRate",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "resolution",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "flip",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "seed",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "samplePrompts",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }, {
    name: "sampleEvery",
    hasDefault: true,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "trainLora",
    description: `Train a LoRA adapter for an SDXL image model from a folder of images,
  each with an optional caption file (\`a.txt\` beside \`a.png\`, comma-separated
  tags). The trigger word is put in front of every caption. Takes minutes
  on a Mac GPU and writes the adapter as a .safetensors file, plus a
  before-and-after sample grid at every sampleEvery steps beside it.
  Everything runs on this machine, with the Python agency local serve
  uses. Returns the adapter's path and the sample grids.

  @param imagesDir - The folder of training images, PNG or JPEG, with optional .txt captions beside them
  @param trigger - The word the adapter answers to. A real phrase learns faster and keeps the base model's idea of it; a nonsense word owns the token
  @param base - The SDXL model to train on: a catalog name, a diffusers: URI, or a model directory, already downloaded
  @param outPath - The .safetensors file to write. It must not exist yet
  @param steps - How long to train. Too few and the style is faint; too many and every output is a training image. Judge by the sample grids
  @param rank - How much the adapter can hold: 8 for a style, 16 for a character, 32 for a character with a wardrobe. Doubling the rank doubles the file
  @param learningRate - Halve it if the grids get worse after getting better
  @param resolution - The training size. 768 trains twice as fast for a first look; 1024 for the real run
  @param flip - Also train on mirrored copies, which doubles a small set. Off for an asymmetric character
  @param seed - Fixes the randomness, so a run is repeatable
  @param samplePrompts - Prompts to render before and after at each checkpoint, to judge the run. Use the trigger word in them
  @param sampleEvery - Steps between sample grids. 0 for none`,
    schema: z.object({ "imagesDir": z.string(), "trigger": z.string(), "base": z.string(), "outPath": z.string(), "steps": z.number().nullable().describe("Default: 1000"), "rank": z.number().nullable().describe("Default: 16"), "learningRate": z.number().nullable().describe("Default: 0.0001"), "resolution": z.number().nullable().describe("Default: 1024"), "flip": z.boolean().nullable().describe("Default: false"), "seed": z.number().nullable().describe("Default: 1"), "samplePrompts": z.array(z.string()).nullable().describe("Default: []"), "sampleEvery": z.number().nullable().describe("Default: 250") })
  },
  exported: true
}, __toolRegistry);
async function __loraInfo_impl(__run, path2) {
  const __setupData = setupFunction(__run);
  const __stack = __setupData.stack;
  const __step = __setupData.step;
  const __self = __setupData.self;
  const __ctx = __run.ctx;
  let __forked;
  let __functionCompleted = false;
  claimFrameForScope(__stack, "loraInfo", "index.agency", __run.log);
  if (!__run.globals.isInitialized("index.agency")) {
    await __initializeGlobals(__run);
  }
  let __funcStartTime = performance.now();
  __stack.args["path"] = path2;
  __self.__destructiveRan = __self.__destructiveRan ?? false;
  const runner = new Runner(__ctx, __stack, { state: __stack, moduleId: "index.agency", scopeName: "loraInfo", stack: __run.stack, threads: __setupData.threads });
  let __resultCheckpointId = -1;
  if (__ctx._pendingArgOverrides?.moduleId === __stack.moduleId && __ctx._pendingArgOverrides?.scopeName === __stack.scopeName) {
    const __overrides = __ctx._pendingArgOverrides.values;
    __ctx._pendingArgOverrides = void 0;
    if ("path" in __overrides) {
      path2 = __overrides["path"];
      __stack.args["path"] = path2;
    }
  }
  try {
    await __withChildRun(__run, {
      ctx: __ctx,
      stack: __setupData.stateStack,
      threads: __setupData.threads
    }, "its body", async (__run2) => {
      await runner.hook(0, __run2, async (__run3) => {
        await callHook(__run3, {
          name: "onFunctionStart",
          data: {
            functionName: "loraInfo",
            args: {
              path: path2
            },
            moduleId: "index.agency"
          }
        });
      });
      await runner.step(1, __run2, async (runner2, __run3) => {
        __stack.locals.real = await __tryCall(__run3.log, async () => await __call(__run3, _realTarget, {
          type: "positional",
          args: [__stack.args.path]
        }), {
          checkpoint: __run3.ctx.getResultCheckpoint(),
          functionName: "loraInfo",
          args: __stack.args
        });
        if (hasInterrupts(__stack.locals.real)) {
          await __run3.ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.real);
          return;
        }
        if (isAborted(__stack.locals.real)) {
          runner2.halt(__stack.locals.real.carryThrough(__run3.log, __stack, "loraInfo"));
          return;
        }
      });
      await runner.step(2, __run2, async (runner2, __run3) => {
        __stack.locals.__hoist_0 = await isFailure(__stack.locals.real);
        if (hasInterrupts(__stack.locals.__hoist_0)) {
          await __run3.ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.__hoist_0);
          return;
        }
        if (isAborted(__stack.locals.__hoist_0)) {
          runner2.halt(__stack.locals.__hoist_0.carryThrough(__run3.log, __stack, "loraInfo"));
          return;
        }
      });
      await runner.ifElse(3, __run2, [
        {
          condition: async (__run3) => __stack.locals.__hoist_0,
          body: async (runner2, __run3) => {
            await runner2.step(0, __run3, async (runner3, __run4) => {
              __functionCompleted = true;
              runner3.halt(__stack.locals.real);
              return;
            });
          }
        }
      ]);
      await runner.step(4, __run2, async (runner2, __run3) => {
        __stack.locals.__hoist_1 = await __call(__run3, dirname, {
          type: "positional",
          args: [__stack.locals.real.value]
        });
        if (hasInterrupts(__stack.locals.__hoist_1)) {
          await __run3.ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.__hoist_1);
          return;
        }
        if (isAborted(__stack.locals.__hoist_1)) {
          runner2.halt(__stack.locals.__hoist_1.carryThrough(__run3.log, __stack, "loraInfo"));
          return;
        }
      });
      await runner.step(5, __run2, async (runner2, __run3) => {
        __stack.locals.__hoist_2 = await __call(__run3, basename, {
          type: "positional",
          args: [__stack.locals.real.value]
        });
        if (hasInterrupts(__stack.locals.__hoist_2)) {
          await __run3.ctx.pendingPromises.awaitAll();
          runner2.halt(__stack.locals.__hoist_2);
          return;
        }
        if (isAborted(__stack.locals.__hoist_2)) {
          runner2.halt(__stack.locals.__hoist_2.carryThrough(__run3.log, __stack, "loraInfo"));
          return;
        }
      });
      await runner.step(6, __run2, async (runner2, __run3) => {
        const __response = __run3.ctx.getInterruptResponse(__self.__interruptId_6);
        if (__response) {
          if (__response.type === "approve") {
          } else if (__response.type === "reject") {
            runner2.halt(runtimeFailure(__response.value ?? "interrupt rejected", { rejected: true, checkpoint: __run3.ctx.getResultCheckpoint() }));
            return;
          }
        } else {
          const __handlerResult = await interruptWithHandlers(__run3, "lora::info", `Read this adapter's header?`, {
            "dir": __stack.locals.__hoist_1,
            "filename": __stack.locals.__hoist_2
          }, "./index.agency");
          if (isRejected(__handlerResult)) {
            runner2.halt(runtimeFailure(__handlerResult.value ?? "interrupt rejected", { rejected: true, checkpoint: __run3.ctx.checkpoints.get(__resultCheckpointId) }));
            return;
          }
          if (!isApproved(__handlerResult)) {
            __self.__interruptId_6 = __handlerResult[0].interruptId;
            const __checkpointId = __run3.ctx.checkpoints.create(__run3.stack, __ctx, { moduleId: "index.agency", scopeName: "loraInfo", stepPath: "6" });
            __handlerResult[0].checkpointId = __checkpointId;
            __handlerResult[0].checkpoint = __run3.ctx.checkpoints.get(__checkpointId);
            runner2.halt(__handlerResult);
            return;
          }
        }
      });
      await runner.step(7, __run2, async (runner2, __run3) => {
        __functionCompleted = true;
        runner2.halt(await __tryCall(__run3.log, async () => await __call(__run3, _loraInfo, {
          type: "positional",
          args: [__stack.locals.real.value]
        }), {
          checkpoint: __run3.ctx.getResultCheckpoint(),
          functionName: "loraInfo",
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
      return AbortedResult.fromError(__run.log, __error, __stack, "loraInfo");
    }
    {
      const __errMsg = __error instanceof Error ? __error.message : String(__error);
      const __errStack = __error instanceof Error && __error.stack ? __error.stack : "";
      const __log = __createLogger(__ctx.logLevel);
      __log.error("Function loraInfo threw an exception (converted to Failure): " + __errMsg);
      if (__errStack) __log.error(__errStack);
      __run.log?.error?.({
        errorType: "runtimeError",
        message: __errMsg,
        functionName: "loraInfo"
      });
    }
    return runtimeFailure(__error, {
      checkpoint: __run.ctx.getResultCheckpoint(),
      destructiveRan: __self.__destructiveRan,
      functionName: "loraInfo",
      args: __stack.args
    });
  } finally {
    __run.stack.pop();
    if (__functionCompleted) {
      await callHook(__run, {
        name: "onFunctionEnd",
        data: {
          functionName: "loraInfo",
          timeTaken: performance.now() - __funcStartTime
        }
      });
    }
  }
}
const loraInfo = __AgencyFunction.create({
  name: "loraInfo",
  module: "index.agency",
  fn: __loraInfo_impl,
  params: [{
    name: "path",
    hasDefault: false,
    defaultValue: void 0,
    variadic: false,
    isFunctionTyped: false,
    acceptsResult: false
  }],
  toolDefinition: {
    name: "loraInfo",
    description: `What an adapter file says about itself: the base model it was trained
  for, its trigger word, its rank, the steps it trained, and its size.
  Reads the file's header only.

  @param path - A .safetensors adapter written by trainLora`,
    schema: z.object({ "path": z.string() })
  },
  exported: true,
  markers: {
    idempotent: true
  }
}, __toolRegistry);
var stdin_default = graph;
const __sourceMap = { "index.agency:trainLora": { "1": { "line": 126, "col": 2 }, "2": { "line": 127, "col": 6 }, "3": { "line": 127, "col": 2 }, "4": { "line": 133, "col": 12 }, "5": { "line": 134, "col": 17 }, "6": { "line": 130, "col": 2 }, "7": { "line": 138, "col": 2 }, "3.0": { "line": 128, "col": 4 } }, "index.agency:loraInfo": { "1": { "line": 149, "col": 2 }, "2": { "line": 150, "col": 6 }, "3": { "line": 150, "col": 2 }, "4": { "line": 154, "col": 9 }, "5": { "line": 155, "col": 14 }, "6": { "line": 153, "col": 2 }, "7": { "line": 157, "col": 2 }, "3.0": { "line": 151, "col": 4 } } };
export {
  LoraInfo,
  STYLE_TAGS,
  TrainedLora,
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
  loraInfo,
  reject,
  respondToInterrupts,
  resumeFromCheckpoint,
  rewindFrom,
  trainLora
};
