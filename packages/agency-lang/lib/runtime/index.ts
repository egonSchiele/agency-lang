export type {
  GraphState,
  Rejected,
  Approved,
  HandlerFn,
  RunNodeResult,
  RunNodeCoreResult,
  NodeReturnValue,
} from "./types.js";
export type { Interrupt, InterruptResponse } from "./interrupts.js";

// The four names the generated header used to import from the package's main
// entry. That entry also exports the compiler, so importing it pulled the
// parser and type checker into every compiled program. Generated code imports
// these from here instead.
export { goToNode } from "../simplemachine/graph.js";
export { color } from "../utils/termcolors.js";
export { nanoid } from "nanoid";
export * as smoltalk from "smoltalk";
export type { InvocationOptions } from "./invocationOptions.js";
// The host: what a run takes from its platform. An app builds one and
// passes it through InvocationOptions. See docs/dev/runtime/host.md.
export {
  CAPABILITIES,
  FILE_WRITE_FUNCTIONS,
  PART_CAPABILITY,
  PLATFORM_CAPABILITIES,
  UnsupportedOnHostError,
  makeHost,
  requireCapabilities,
} from "../host/host.js";
export type {
  Capability,
  Entry,
  FileStat,
  Host,
  HostEnv,
  HostFiles,
  HostParts,
  HostRandom,
  HostSettings,
  HostSystem,
  HostTerminal,
  Located,
  OperatingSystem,
  Platform,
  Root,
  WritableFile,
  WriteMode,
  WriteOptions,
} from "../host/host.js";
export { nodeHost } from "../host/nodeHost.js";
export { memoryHost } from "../host/memoryHost.js";
export type { MemoryHost, MemoryHostOptions, MemoryHostState } from "../host/memoryHost.js";
export { defaultHost } from "#default-host";
// Agency code may call `path.join` and `os.homedir()` as free names; the
// generated header imports them from here, so it imports no Node module.
// This entry point is Node's; the browser entry point exports a portable
// `path` and a host-backed `os` in their place.
export { path, os } from "./agencyGlobals.node.js";
export type { NodeHostOptions } from "../host/nodeHost.js";
export { RuntimeContext } from "./state/context.js";
export { agency } from "./agency.js";
export type { InterruptOpts, ResumableScope, ResumableScopeOpts } from "./agency.js";
export type { LlmOpts } from "./agencyLlm.js";
export type { CallsiteLocation } from "./asyncContext.js";
/**
 * The exports below are the codegen-internal surface that generated
 * Agency code imports directly. They are NOT recommended for TS
 * helper authors — use the `agency.*` namespace above instead. Kept
 * here because every generated `prog.ts` references them via
 * `agency-lang/runtime`.
 */
export {
  getRuntimeContext,
  currentRun,
  callPlain,
  runInTestContext,
  runInBootstrapFrame,
  withRun,
  withChildRun,
  detachedRun,
  assertUsable,
  RunInUseError,
  freshState,
  type Run,
} from "./asyncContext.js";
export { StateStack, State, claimFrameForScope } from "./state/stateStack.js";
export { __codeLiteral } from "./template/codeLiteral.js";
export { GlobalStore } from "./state/globalStore.js";
export { MessageThread } from "./state/messageThread.js";
export { ThreadStore } from "./state/threadStore.js";
export { PendingPromiseStore } from "./state/pendingPromiseStore.js";
export { TraceWriter } from "./trace/traceWriter.js";
export { TraceReader } from "./trace/traceReader.js";
export type { TraceSink } from "./trace/sinks.js";
export { CallbackSink } from "./trace/sinks.js";
export { FileSink } from "./trace/fileSink.js";
export type { TraceLine, TraceEvent } from "./trace/types.js";

export {
  deepClone,
  deepFreeze,
  extractResponse,
  createReturnObject,
  updateTokenStats,
} from "./utils.js";

export { __UNINIT_STATIC, __readStatic } from "./staticInit.js";
export {
  __registerStaticInit,
  __registerGlobalsInit,
  __registerCallbacksInit,
  __awaitStaticInit,
  __awaitGlobalsInit,
} from "./crossModuleInitRegistry.js";
export {
  __registerAlwaysScope,
  adoptAlwaysScope,
  alwaysScopeFor,
  allAlwaysScopes,
  sameScopedFields,
} from "./alwaysScope.js";
export type { ScopedField } from "./alwaysScope.js";

export { functionRefReviver } from "./revivers/index.js";
export { AgencyFunction, UNSET } from "./agencyFunction.js";
export type { FuncParam, CallType, ToolDefinition, AgencyFunctionOpts } from "./agencyFunction.js";
export { __call, __callMethod } from "./call.js";

export { callHook, registerGlobalHook } from "./hooks.js";
export type { AgencyCallbacks, CallbackMap, CallbackReturn } from "./hooks.js";

export { head, tail, empty, builtinSleep } from "./builtins.js";

export {
  interrupt,
  isInterrupt,
  hasInterrupts,
  reportUnhandledInterrupts,
  isDebugger,
  isRejected,
  isApproved,
  approve,
  reject,
  pass,
  interruptWithHandlers,
  respondToInterrupts,
  respondToInterruptsForServe,
  resumeCliFromCheckpoint,
  resumeFromCheckpoint,
} from "./interrupts.js";
export type { ResumeCliFromCheckpointArgs, ResumeFromCheckpointArgs } from "./interrupts.js";

export { checkPolicy, checkPolicyExplicit, validatePolicy, escapeGlob } from "./policy.js";

export { resolveCliInterrupts } from "./cliInterruptResolution.js";
export { runCliEntry } from "./cliEntry.js";

export { isGenerator, handleStreamingResponse } from "./streaming.js";

export { runPrompt } from "./prompt.js";

export { SmoltalkClient } from "./llmClient.js";
export { SimpleOpenAIClient } from "./simpleOpenAIClient.js";
export type { LLMClient, PromptConfig, ToolCall } from "./llmClient.js";
export { DeterministicClient } from "./deterministicClient.js";
export type { LLMMock, ReturnMock, ToolCallMock } from "./deterministicClient.js";
export { installFetchMock } from "./fetchMock.js";
export type { FetchMock } from "./fetchMock.js";

export {
  ConcurrentInterruptError,
  CheckpointError,
  CheckpointCodeChangedError,
  RestoreSignal,
  PauseSignal,
  RunControlSignal,
  AgencyAbort,
  AgencyCancelledError,
  CallDepthExceededError,
  isAbortError,
} from "./errors.js";
export { isPaused, pausedResult } from "./pause.js";
export type { PausedCheckpoint } from "./pause.js";
export { GuardExceededError, isGuardExceededError } from "./guard.js";
export { AbortedResult, isAborted, previewForLog } from "./abortedResult.js";
export type { Guard, GuardJSON } from "./guard.js";
export { CostGuard, TimeGuard, guardFromJSON } from "./guard.js";
export type { RestoreOptions } from "./errors.js";

export {
  checkpoint,
  checkpointFor,
  getCheckpoint,
  getCheckpointFor,
  restore,
  restoreFor,
} from "./checkpoint.js";
export { _run, _runFor } from "./ipc.js";

export { registerModuleFingerprint, getModuleFingerprint } from "./moduleFingerprintRegistry.js";
export { CheckpointStore, RESULT_ENTRY_LABEL } from "./state/checkpointStore.js";
export { Checkpoint } from "./state/checkpointStore.js";
export { verifyCheckpointChecksum, CheckpointKeyTooShortError } from "./checkpointChecksum.js";

export {
  setupNode,
  setupFunction,
  runNode,
  runExportedFunction,
  runNodeForServe,
  runExportedFunctionForServe,
} from "./node.js";
export type { RunUsage, ServedInvocationOutcome, UsageEntry } from "./invocationUsage.js";
export { reportBudgetExceededAndExit, formatBudgetExceeded } from "./budgetExit.js";
export { flushPendingStatelogPosts } from "../statelogSender.js";
export { exitProcess } from "./exitProcess.js";
export { Runner } from "./runner.js";

export { rewindFrom, applyOverrides } from "./rewind.js";
export { applyLocalOverrides, applyRestoreOverrides, restoreForResume } from "./resumeSetup.js";
export type { ResumeOverrides, ResumeMetadata, ResumeRequest } from "./resumeSetup.js";

export { debugStep } from "./debugger.js";
export { DebuggerState } from "../debugger/debuggerState.js";

export {
  success,
  failure,
  runtimeFailure,
  isSuccess,
  isFailure,
  stampFailureBoundary,
  markDestructiveWork,
  __pipeBind,
  __tryCall,
  __catchResult,
} from "./result.js";
export type { ResultValue, ResultSuccess, ResultFailure, SkippedFunction } from "./result.js";
export { acceptsFailures } from "./failurePropagation.js";
export { Schema, __validateType } from "./schema.js";
export { __invalidArgument } from "./invalidArgument.js";
export { __coarseTypeTest } from "./typeTest.js";
export { __eq } from "./eq.js";
export { __requireLength } from "./requireLength.js";
export { __nn } from "./nn.js";
export {
  __validateChain,
  __validateChainRecursive,
  __withUseSiteValidators,
} from "./validateChain.js";
export type {
  AgencyValidator,
  TypeValidationDescriptor,
  RecursiveValidationOpts,
} from "./validateChain.js";
export { CoverageCollector } from "./coverageCollector.js";
export type { MemoryConfig } from "./memory/types.js";
export { createLogger } from "../logger.js";
export type { LogLevel, Logger } from "../logger.js";
