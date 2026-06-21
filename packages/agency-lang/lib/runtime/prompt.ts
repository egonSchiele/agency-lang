import * as smoltalk from "smoltalk";
import { PromptResult, ToolCallJSON } from "smoltalk";
import { createLogger } from "../logger.js";
import { AgencyFunction } from "./agencyFunction.js";
import { agencyStore, getRuntimeContext, __threads } from "./asyncContext.js";
import { AgencyCancelledError, isAbortError } from "./errors.js";
import { isGuardExceededError } from "./guard.js";
import { callHook, invokeCallbacks } from "./hooks.js";
import { hasInterrupts, isRejected } from "./interrupts.js";
import type { PromptConfig } from "./llmClient.js";
import { setupFunction } from "./node.js";
// See docs/dev/promptRunner.md for the control-flow abstraction used here.
import { PromptBailout, PromptRunner } from "./promptRunner.js";
import { isFailure } from "./result.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { LlmDefaults } from "../stdlib/llm.js";
import { MessageThread } from "./state/messageThread.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { handleStreamingResponse } from "./streaming.js";
import { GraphState } from "./types.js";
import { extractResponse, updateTokenStats } from "./utils.js";

type Tool = {
  name: string;
  description?: string;
  schema: any;
};

/** Result of `_runPrompt`. Callback bodies cannot raise interrupts
 *  (typechecker-enforced), so the result is always a plain `{messages,
 *  toolCalls}` shape — the LLM hooks (onLLMCallStart, onLLMCallEnd)
 *  fire as side effects only. */
export type RunPromptResult = {
  messages: MessageThread;
  toolCalls: smoltalk.ToolCallJSON[];
};

/** Dispatch the LLM request and extract `{completion, toolCalls}`,
 *  branching on the `stream` flag. Streaming uses `handleStreamingResponse`
 *  to accumulate chunks; non-streaming awaits the single response Promise.
 *  Throws on transport/protocol errors. */
async function dispatchLLMRequest({
  ctx,
  promptConfig,
  prompt,
  stream,
}: {
  ctx: RuntimeContext<GraphState>;
  promptConfig: PromptConfig;
  prompt: string;
  stream: boolean;
}): Promise<{ completion: PromptResult; toolCalls: ToolCallJSON[] }> {
  if (stream) {
    const streamGen = ctx.llmClient.textStream(promptConfig);
    const response = await handleStreamingResponse({
      ctx,
      completion: streamGen,
      prompt,
    });
    if (!response) {
      throw new Error(
        `No completion returned from streaming LLM call! This shouldn't happen.`,
      );
    }
    if (!response.success) {
      throw new Error(
        `Error getting completion from streaming response: ${response.error}`,
      );
    }
    return {
      completion: response.value.completion,
      toolCalls: response.value.toolCalls,
    };
  }
  const response = await ctx.llmClient.text(promptConfig);
  if (!response.success) {
    throw new Error(`Error getting completion: ${response.error}`);
  }
  return {
    completion: response.value,
    toolCalls: response.value.toolCalls || [],
  };
}

/** Default cap on characters of a single tool result fed back to the
 *  LLM. A recursive `ls`/`grep` can return megabytes; without a cap one
 *  tool call can blow the context window. The FULL result is still
 *  returned to Agency code — only what the model sees is truncated. */
const DEFAULT_TOOL_RESULT_CHARS = 100_000;

/** Coerce an arbitrary tool result to the string the LLM would see.
 *  Strings pass through; everything else is JSON-stringified, with a
 *  `String()` fallback for values JSON can't represent (e.g. circular). */
function stringifyToolResult(result: any): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** Truncate a tool result for the LLM if its serialized form exceeds
 *  `cap` characters. Returns the ORIGINAL value untouched when within
 *  the cap (so smoltalk serializes it exactly as before) or when the cap
 *  is disabled (`cap <= 0` or non-finite). Over the cap, returns the
 *  first `cap` characters plus a marker noting the original length, so
 *  the model knows it was cut. */
function capToolResultForLlm(result: any, cap: number): any {
  if (!Number.isFinite(cap) || cap <= 0) return result;
  const text = stringifyToolResult(result);
  if (text.length <= cap) return result;
  return (
    text.slice(0, cap) +
    `\n\n[tool result truncated: showing ${cap} of ${text.length} chars]`
  );
}

/** Provider APIs (Anthropic, OpenAI) reject an LLM request whose tool list
 *  contains duplicate names, and tool-call dispatch here matches handlers by
 *  name — so duplicate names are always a bug. They're easy to introduce
 *  by accident because `.partial()` / `.describe()` preserve the base
 *  function's name (e.g. `skillsDir` returns `read.partial(dir)`, so four
 *  skill tools are all named `read`). Catch it before the request hits the
 *  wire with a message that names the collision and points at `.rename()`,
 *  instead of an opaque transport-layer 400 that never reaches the statelog. */
function assertUniqueToolNames(tools: { name: string }[]): void {
  const counts: Record<string, number> = {};
  for (const t of tools) {
    counts[t.name] = (counts[t.name] || 0) + 1;
  }
  const dups = Object.keys(counts).filter((n) => counts[n] > 1);
  if (dups.length > 0) {
    const detail = dups.map((n) => `"${n}" (×${counts[n]})`).join(", ");
    throw new Error(
      `Duplicate tool name(s) passed to an LLM call: ${detail}. Tool names ` +
        `must be unique. This usually happens when several tools are derived ` +
        `from the same function via .partial() or .describe(), which preserve ` +
        `the base name. Give each derived tool a distinct name with ` +
        `.rename("...").`,
    );
  }
}

/** Test-only surface for the pure tool-result-cap helpers. Not part of
 *  the supported runtime API. */
export const _internal = {
  DEFAULT_TOOL_RESULT_CHARS,
  stringifyToolResult,
  capToolResultForLlm,
  assertUniqueToolNames,
};

async function _runPrompt({
  ctx,
  messages,
  tools,
  prompt,
  responseFormat,
  clientConfig,
  stateStack,
}: {
  ctx: RuntimeContext<GraphState>;
  messages: MessageThread;
  tools: Tool[];
  prompt: string;
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolConfig>;
  /** The branch-local stack, if this _runPrompt call is running inside a
   * fork/race branch. Used for branch-aware cancellation checks and for
   * scoping the LLM HTTP abort signal to the current branch. */
  stateStack?: StateStack;
}): Promise<RunPromptResult> {
  if (ctx.isCancelled(stateStack)) {
    throw new AgencyCancelledError();
  }

  // Pre-call cost-guard gate. If any active guard (including shared
  // parent guards inherited by this branch) is already over budget —
  // e.g. because a sibling branch's earlier LLM call pushed the shared
  // CostGuard over its limit, or because a prior call here did — refuse
  // to issue this call. Catches "another expensive call would have been
  // billed but we're already past the cap" before the request hits the
  // wire.
  const targetStack = stateStack ?? ctx.stateStack;
  targetStack.enforceGuards();

  // Note: the llmCall span is opened in the outer `runPrompt`, not here,
  // so that any tool executions triggered by this LLM response nest under
  // the same llmCall span (matching the design spec hierarchy
  // agentRun > nodeExecution > llmCall > toolExecution).
  const stream = !!(clientConfig as any)?.stream;
  const startTime = performance.now();

  await callHook({
    ctx,
    name: "onLLMCallStart",
    data: {
      prompt,
      tools,
      model: clientConfig.model,
      messages: messages.toJSON().messages,
    },
  });

  // Re-check after hook — cancellation may have occurred during the callback
  if (ctx.isCancelled(stateStack)) {
    throw new AgencyCancelledError();
  }

  const promptConfig: PromptConfig = {
    ...clientConfig,
    messages: messages.getMessages(),
    tools,
    responseFormat,
    abortSignal: ctx.getAbortSignal(stateStack),
    metadata: clientConfig,
  } as any;

  let completion: PromptResult;
  let toolCalls: ToolCallJSON[];
  try {
    ({ completion, toolCalls } = await dispatchLLMRequest({
      ctx,
      promptConfig,
      prompt,
      stream,
    }));
  } catch (err) {
    // Cancellation normalization. When WE aborted the request (user pressed
    // Esc → ctx.cancel(), a race loser, a timeout), the provider SDK
    // surfaces its OWN abort error — e.g. Anthropic throws a plain
    // `Error("Request was aborted.")` whose name isn't "AbortError", so
    // `isAbortError` can't recognize it by identity. Our cancellation state
    // is authoritative: if the call threw while we're cancelled, it's a
    // cancellation. Normalize to AgencyCancelledError so the rest of the
    // runtime (function/node catches re-throw it, the REPL prints
    // "cancelled") handles it as one — and skip the llmError log below,
    // since a user cancel isn't a request failure worth recording.
    if (ctx.isCancelled(stateStack) || isAbortError(err)) {
      throw new AgencyCancelledError();
    }
    // The success-path `promptCompletion` event below is the only place the
    // request payload (messages + tools) is logged, and it never runs when
    // the dispatch throws — so a provider rejection (e.g. a 400 over the
    // tool list) otherwise leaves no record of what was sent. Emit an
    // `llmError` carrying the tool list so the failed request is
    // diagnosable, then rethrow the ORIGINAL error unchanged. The emit is
    // best-effort: a statelog failure (e.g. a JSON.stringify error inside
    // post()) must not mask the real LLM/transport error, so swallow it.
    try {
      await ctx.statelogClient.error({
        errorType: "llmError",
        message: err instanceof Error ? err.message : String(err),
        tools,
      });
    } catch {
      // ignore — never let logging shadow the original failure
    }
    throw err;
  }

  // Capture endTime AFTER the response has been fully received. The
  // request Promise is created above but only awaited inside the
  // stream/non-stream branches; sampling earlier would only measure
  // request setup, not the actual round-trip time.
  const endTime = performance.now();

  const modelName = completion.model || clientConfig.model || "unknown model";

  ctx.statelogClient.promptCompletion({
    messages: messages.getMessages(),
    completion,
    model: JSON.stringify(modelName),
    timeTaken: endTime - startTime,
    tools,
    responseFormat,
    usage: completion.usage,
    cost: completion.cost,
    finishReason: (completion as any).finishReason ?? (completion as any).finish_reason,
    stream,
    threadId: __threads()?.activeId() ?? null,
  });

  if (toolCalls.length > 0) {
    messages.push(
      smoltalk.assistantMessage(completion.output, {
        toolCalls,
      }),
    );
  } else {
    messages.push(smoltalk.assistantMessage(completion.output));
  }

  updateTokenStats({
    globals: ctx.globals,
    usage: completion.usage,
    cost: completion.cost,
    model: modelName,
  });

  // Per-branch accumulator: adds to the active stack so std::thread's
  // getCost()/getTokens() can report per-branch totals; complementary
  // to the global __tokenStats above. Then bill every active guard
  // for this call's cost and enforce limits. Shared parent guards see
  // descendants' spend in real time; mid-fork trips fire on the next
  // enforceGuards() call. See docs/superpowers/specs/2026-05-20-thread-
  // builtins-and-stdlib-design.md.
  const callCost = completion.cost?.totalCost ?? 0;
  targetStack.localCost += callCost;
  targetStack.localTokens += completion.usage?.totalTokens ?? 0;
  targetStack.chargeGuards(callCost);
  targetStack.enforceGuards();

  // Memory layer: auto-extraction and compaction run unconditionally
  // whenever a MemoryManager is attached (resolved decision #6).
  // Tool-call results have not been pushed yet, so we operate on the
  // current message slice. Compaction is a best-effort hint — failures
  // never break the LLM call.
  const memoryManager = ctx.getActiveMemoryManager();
  if (memoryManager) {
    try {
      const original = messages.getMessages();
      await memoryManager.onTurn(original);
      const plan = await memoryManager.compactIfNeeded(original);
      if (plan) {
        // Reassemble the thread from the ORIGINAL smoltalk Message
        // instances so tool_call metadata, ids, and other class-level
        // fields survive untouched.
        const head = plan.systemPrefixIndices.map((i) => original[i]);
        const tail = plan.tailIndices.map((i) => original[i]);
        const summary = smoltalk.systemMessage(plan.summaryMessageContent);
        messages.setMessages([...head, summary, ...tail]);
      }
    } catch (err) {
      // Cost / time guard trips are NOT best-effort failures — they
      // signal the surrounding `withCostGuard` / `withTimeGuard` has
      // been exceeded and the agent should stop. Re-throw so the
      // signal reaches the user's scope instead of being silently
      // logged here.
      if (isGuardExceededError(err)) throw err;
      // The memory hook is best-effort: a failure here must never
      // break the LLM call. Logged at `warn` so users see the failure
      // by default; the manager already emitted finer-grained debug
      // lines and a statelog `error` event if applicable.
      createLogger(ctx.logLevel).warn(
        `[memory] post-turn hook failed: ${(err as Error).message}`,
      );
    }
  }

  await callHook({
    ctx,
    name: "onLLMCallEnd",
    data: {
      model: JSON.stringify(modelName),
      result: completion,
      usage: completion.usage,
      cost: completion.cost,
      timeTaken: endTime - startTime,
      messages: messages.toJSON().messages,
    },
  });

  return { messages, toolCalls };
}

/**
 * Leave a thread in a role-valid state after a hard cancellation
 * (AgencyCancelledError / abort). A cancel can land mid-tool-round, so the
 * thread may end on an assistant turn with unanswered `tool_calls` — which
 * some providers reject on the next call. Truncate back to this turn's user
 * message (within one runPrompt only assistant/tool messages follow it) and
 * append a neutral marker so the next call sees the interruption and the
 * thread alternates cleanly. `messages` is the live, persisted MessageThread
 * (see agencyLlm.llm), so this repair sticks for the next turn.
 */
function markThreadCancelled(messages: MessageThread): void {
  const all = messages.getMessages();
  let lastUser = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const kept = lastUser >= 0 ? all.slice(0, lastUser + 1) : all.slice();
  kept.push(smoltalk.assistantMessage("[Response cancelled.]"));
  messages.setMessages(kept);
}

// eslint-disable-next-line max-lines-per-function -- core prompt execution loop; refactor tracked separately
export async function runPrompt(args: {
  prompt: string;
  messages: MessageThread;
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolConfig> & { tools?: any[] };
  maxToolCallRounds?: number;
  removedTools?: string[];
  checkpointInfo?: SourceLocationOpts;
}): Promise<any> {
  const {
    prompt,
    responseFormat,
    maxToolCallRounds = 10,
    checkpointInfo,
  } = args;

  // ctx + stack come from the active ALS frame — the codegen used to
  // pass them explicitly as `ctx` / `stateStack` keys on `args`, but
  // post-ALS migration every Agency execution path runs inside an
  // `agencyStore.run(...)` frame seeded with the same values.
  const runtime = getRuntimeContext();
  const ctx = runtime.ctx as RuntimeContext<GraphState>;

  // Push a frame onto the state stack — runPrompt participates like any other function
  const { stateStack, stack } = setupFunction();
  const self = stack.locals;

  // Frame-backed locals (survive checkpoint/restore)
  if (self.__initialized === undefined) {
    self.__initialized = true;
    self.removedTools = args.removedTools || [];
    self.toolErrorCounts = {};
    self.toolCallRound = 0;
    self.messagesJSON = null;
    self.pendingToolCalls = null;
  }

  const removedTools: string[] = self.removedTools;
  const toolErrorCounts: Record<string, number> = self.toolErrorCounts;

  const rawTools: any[] = args.clientConfig?.tools || [];
  const agencyFunctions: AgencyFunction[] = rawTools.map((entry: any) => {
    if (!AgencyFunction.isAgencyFunction(entry)) {
      const receivedType =
        entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry;
      throw new TypeError(
        `Invalid tool in clientConfig.tools. Expected an AgencyFunction instance, but received ${receivedType}.`,
      );
    }
    return entry;
  });
  // Drop removed tools first — they're never exposed to the LLM, so they
  // shouldn't block the call with a backstop error for an unbound block
  // they wouldn't have been asked to invoke anyway.
  const exposedFunctions = agencyFunctions.filter(
    (fn) => !removedTools.includes(fn.name),
  );
  // Runtime backstop for compile-time-undetectable cases (dynamic tool
  // assembly, hand-written TS). Runs once per exposed tool — before the
  // LLM ever sees the schema — so failures surface at registration time,
  // not deep inside an invocation when the missing block is called.
  for (const fn of exposedFunctions) {
    fn.validateForLLM();
  }
  let tools = exposedFunctions
    .filter((fn) => fn.toolDefinition)
    .map((fn) => fn.toolDefinition!);
  // Pre-flight: reject duplicate tool names before they reach the provider,
  // where they surface as an opaque 400 with no request payload in the
  // statelog. See assertUniqueToolNames.
  assertUniqueToolNames(tools);
  let toolFunctions = exposedFunctions;

  // Remove tools key from clientConfig before passing to smoltalk.
  // Also strip `memory` — it's a runtime-only directive that smoltalk
  // doesn't understand.
  const {
    tools: _extractedTools,
    memory: memoryOption,
    maxToolResultChars: callMaxToolResultChars,
    ...restClientConfig
  } = (args.clientConfig || {}) as Partial<smoltalk.SmolConfig> & {
    tools?: any[];
    memory?: boolean | { model?: string };
    maxToolResultChars?: number;
  };

  // Run-wide LLM defaults set at runtime via `std::llm`
  // (setLlmOptions/setModel) live on the ACTIVE branch stack's
  // `other.llmDefaults` (branch-scoped, serialized; seeded from the
  // parent at fork time). Layer them BETWEEN the baked
  // `smoltalkDefaults` and the per-call options, so precedence is
  // baked agency.json < stack defaults < per-call `llm({...})`.
  const stackDefaults: Partial<LlmDefaults> =
    stateStack?.other?.llmDefaults ?? {};
  const { maxToolResultChars: stackMaxToolResultChars, ...stackSmolDefaults } =
    stackDefaults;
  const clientConfig = ctx.getSmoltalkConfig({
    ...stackSmolDefaults,
    ...restClientConfig,
  });

  // Cap on characters of a single tool result fed back to the LLM. The
  // full result is still cached for Agency code via `setResultOnBranch`;
  // only what the model sees is truncated. Resolution precedence:
  // per-call `llm(..., { maxToolResultChars })` > runtime
  // `setLlmOptions` (active stack) > agency.json (`ctx.maxToolResultChars`)
  // > default. `0`/non-finite disables.
  const toolResultCap =
    callMaxToolResultChars ??
    stackMaxToolResultChars ??
    ctx.maxToolResultChars ??
    DEFAULT_TOOL_RESULT_CHARS;

  // Restore or initialize messages.
  //
  // On resume we need `messages` to stay aliased to `args.messages` (the
  // caller's shared thread). Otherwise, mutations during the resumed run
  // (pushing tool responses, the final assistant message) won't propagate
  // back to the caller's thread. Then any subsequent reader — another
  // `llm()` call in a loop, a `thread {}` block, a debug hook — sees a
  // stale snapshot from the original interrupt time, missing everything
  // that was appended after resume.
  //
  // To keep the alias on resume, we write the saved JSON contents INTO
  // args.messages rather than constructing a fresh MessageThread. The
  // saved JSON and args.messages are equivalent on resume (both were
  // captured in the same checkpoint), so this is effectively a no-op
  // overwrite — but it preserves the alias for the rest of the run.
  let messages: MessageThread;
  if (self.messagesJSON) {
    const restored = MessageThread.fromJSON(self.messagesJSON);
    if (args.messages) {
      args.messages.setMessages(restored.getMessages());
      messages = args.messages;
    } else {
      messages = restored;
    }
  } else if (clientConfig.messages) {
    messages = MessageThread.fromJSON(clientConfig.messages);
  } else if (args.messages) {
    messages = args.messages;
  } else {
    messages = new MessageThread();
  }

  // Resumable-step + checkpoint-on-interrupt helper. See
  // docs/superpowers/plans/2026-05-22-prompt-runner.md.
  // `snapshotMessages` reads the current `messages` binding at call time;
  // reassignments below (e.g. `messages = result.messages`) are observed.
  const pr = new PromptRunner({
    self,
    ctx,
    stateStack,
    checkpointInfo,
    snapshotMessages: () => messages.toJSON().messages,
  });

  // Manage llmCall spans across the prompt round-trip loop. Each
  // llmCall span covers one `_runPrompt` call PLUS the tool executions
  // triggered by its returned tool_calls, so toolExecution spans nest
  // under their parent llmCall — matching the
  // agentRun > nodeExecution > llmCall > toolExecution hierarchy.
  let currentLlmSpanId: string | undefined;
  const closeLlmSpan = () => {
    if (currentLlmSpanId) {
      ctx.statelogClient.endSpan(currentLlmSpanId);
      currentLlmSpanId = undefined;
    }
  };

  // Tool calls: on resume, restore from frame; otherwise start at [] and
  // let the initialLlmCall step populate it.
  let toolCalls: smoltalk.ToolCallJSON[] = self.pendingToolCalls ?? [];

  let shouldPop = true;
  try {
    // Initial LLM call wrapped in pr.step so it's idempotent on resume
    // (re-entries after a later tool-batch bailout skip this step).
    await pr.step("initialLlmCall", async () => {
      let injectedFactsContent: string | null = null;
      const recallManager = ctx.getActiveMemoryManager();
      if (memoryOption && recallManager) {
        try {
          const facts = await recallManager.recallForInjection(prompt);
          if (facts) {
            injectedFactsContent = `Relevant context from memory:\n${facts}`;
            messages.push(smoltalk.systemMessage(injectedFactsContent));
          }
        } catch (err) {
          // Guard trips are signals, not best-effort failures — let
          // them bubble to the surrounding `withCostGuard` scope.
          if (isGuardExceededError(err)) throw err;
          createLogger(ctx.logLevel).warn(
            `[memory] recall injection failed: ${(err as Error).message}`,
          );
        }
      }
      messages.push(smoltalk.userMessage(prompt));
      currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
      let result: RunPromptResult;
      try {
        result = await _runPrompt({
          ctx,
          messages,
          tools: tools || [],
          prompt,
          responseFormat,
          clientConfig,
          stateStack,
        });
      } catch (e) {
        closeLlmSpan();
        throw e;
      }
      messages = result.messages;
      toolCalls = result.toolCalls;
      if (injectedFactsContent !== null) {
        const all = messages.getMessages();
        for (let i = all.length - 1; i >= 0; i--) {
          if (
            all[i].role === "system" &&
            all[i].content === injectedFactsContent
          ) {
            messages.setMessages([...all.slice(0, i), ...all.slice(i + 1)]);
            break;
          }
        }
      }
      self.messagesJSON = messages.toJSON().messages;
      self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
    });

    // After resume (initialLlmCall skipped), make sure there's an open
    // llmCall span if we have pending tool calls — the tool loop expects
    // one to be open so toolExecution spans nest correctly.
    if (toolCalls.length > 0 && currentLlmSpanId === undefined) {
      currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
    }

    // Inner helper for the per-branch tool invocation. Extracted from
    // the pr.parallel branchFn so that arrow stays within the
    // max-lines-per-function lint budget. Closes over `ctx`, `messages`,
    // `stack`, `removedTools`, and `toolErrorCounts` — all of which it
    // mutates in place. Returns the outcome so the caller can update its
    // own `toolResult` / `invokeOutcome` locals (which are then read by
    // the surrounding tool-call branch code).
    const runInvokeStep = async (args: {
      handler: AgencyFunction;
      toolCall: smoltalk.ToolCallJSON;
      namedArgs: Record<string, any>;
      branchKey: string;
      branchStack: StateStack;
    }): Promise<{
      toolResult: any;
      invokeOutcome:
      | "success"
      | "failed"
      | "rejected"
      | "interrupted"
      | "crashed";
      interrupts?: any[];
    }> => {
      const { handler, toolCall, namedArgs, branchKey, branchStack } = args;
      let toolResult: any;
      ctx.enterToolCall();
      try {
        // The tool body inherits the calling ALS frame's `ctx` and
        // `stack` (the branch's per-tool-call stack, set up by
        // `runBatch.runInBranchAlsFrame`) — those are correct for
        // branch-aware cancellation and per-branch state. The
        // `threads` slot, however, must NOT be inherited. If the tool
        // body issues its own `llm()` call, that nested prompt would
        // push messages into the OUTER prompt's MessageThread (whose
        // last message is `assistant(tool_calls=[this tool])`),
        // producing a thread shape OpenAI rejects with "An assistant
        // message with 'tool_calls' must be followed by tool
        // messages". A nested tool invocation is logically a fresh
        // conversation, so install a fresh ThreadStore for the
        // duration of this invoke. Pre-ALS, `setupFunction` produced
        // the same outcome via its `state.threads || new ThreadStore()`
        // fallback whenever a function was reached via tool dispatch.
        const parentFrame = agencyStore.getStore();
        const freshThreads = ThreadStore.withDefaultActive(ctx.statelogClient);
        const invokeAsTool = () =>
          handler.invoke({
            type: "named",
            positionalArgs: [],
            namedArgs,
          });
        toolResult = parentFrame
          ? await agencyStore.run(
            { ...parentFrame, threads: freshThreads },
            invokeAsTool,
          )
          : await invokeAsTool();
      } catch (error: unknown) {
        // A cancellation (user pressed Esc, race-loser, timeout) is not a
        // tool crash. Let it propagate so the turn unwinds cleanly —
        // logging it as an error and feeding a bogus failure message back
        // to the model (as the crash path below does) would both spam
        // "Tool call X crashed" for every tool on the stack and corrupt
        // the thread. Mirrors the function/node catch re-throws.
        if (isAbortError(error)) {
          stack.deleteBranch(branchKey);
          throw error;
        }
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(
          `Tool call "${handler.name}" crashed: ${errorMessage}`,
        );
        ctx.statelogClient.error({
          errorType: "toolError",
          message: errorMessage,
          functionName: handler.name,
          retryable: false,
        });
        toolErrorCounts[handler.name] =
          (toolErrorCounts[handler.name] || 0) + 1;
        messages.push(
          smoltalk.toolMessage(
            `Error: ${String(capToolResultForLlm(errorMessage, toolResultCap))}. This tool failed after performing side effects and cannot be retried.`,
            { tool_call_id: toolCall.id, name: toolCall.name },
          ),
        );
        removedTools.push(handler.name);
        stack.deleteBranch(branchKey);
        return { toolResult, invokeOutcome: "crashed" };
      } finally {
        ctx.exitToolCall();
      }

      if (isFailure(toolResult)) {
        const errorMessage =
          typeof toolResult.error === "string"
            ? toolResult.error
            : String(toolResult.error);
        // Cap only what the LLM sees; statelog keeps the full message.
        const cappedError = String(
          capToolResultForLlm(errorMessage, toolResultCap),
        );
        toolErrorCounts[handler.name] =
          (toolErrorCounts[handler.name] || 0) + 1;
        ctx.statelogClient.error({
          errorType: "toolError",
          message: errorMessage,
          functionName: handler.name,
          retryable: !!toolResult.retryable,
        });
        if (toolResult.retryable && toolErrorCounts[handler.name] < 5) {
          messages.push(
            smoltalk.toolMessage(
              `Error: ${cappedError}. You may retry this tool call with corrected arguments.`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ),
          );
        } else if (toolResult.retryable) {
          messages.push(
            smoltalk.toolMessage(
              `Error: ${cappedError}. This tool has failed too many times and can no longer be called.`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ),
          );
          removedTools.push(handler.name);
        } else {
          messages.push(
            smoltalk.toolMessage(
              `Error: ${cappedError}. This operation failed and cannot be retried.`,
              { tool_call_id: toolCall.id, name: toolCall.name },
            ),
          );
          removedTools.push(handler.name);
        }
        stack.deleteBranch(branchKey);
        return { toolResult, invokeOutcome: "failed" };
      }

      if (isRejected(toolResult)) {
        const message =
          typeof toolResult.value === "string"
            ? toolResult.value
            : "Tool call rejected by policy";
        messages.push(
          smoltalk.toolMessage(capToolResultForLlm(message, toolResultCap), {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          }),
        );
        stack.deleteBranch(branchKey);
        return { toolResult, invokeOutcome: "rejected" };
      }

      if (hasInterrupts(toolResult)) {
        stack.setInterruptOnBranch(
          branchKey,
          toolResult[0].interruptId,
          toolResult[0].interruptData,
          toolResult[0].checkpoint,
        );
        return {
          toolResult,
          invokeOutcome: "interrupted",
          interrupts: toolResult,
        };
      }

      // Success: cache the result, push tool message.
      toolResult =
        toolResult ||
        `${handler.name} ran successfully but did not return a value`;
      stack.setResultOnBranch(branchKey, toolResult);
      messages.push(
        smoltalk.toolMessage(capToolResultForLlm(toolResult, toolResultCap), {
          tool_call_id: toolCall.id,
          name: toolCall.name,
        }),
      );
      return { toolResult, invokeOutcome: "success" };
    };

    // Handle tool calls
    while (toolCalls.length > 0) {
      if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();
      // Capture round BEFORE incrementing so pr.step keys are stable
      // across resume. The actual increment happens inside the
      // `nextLlmCall` step body, after a successful LLM round — that
      // way bailout from a per-tool callback leaves the counter
      // unchanged and resume re-enters this iteration with the same
      // `round` value, so completedSteps keys match.
      const round = self.toolCallRound;

      // Tool calls in one round run concurrently via pr.parallel. Each
      // tool gets its own BranchRunner. If any branch's `step` returns
      // interrupts, sibling branches still run to completion; pr.parallel
      // batches the collected interrupts, stamps ONE shared checkpoint,
      // and throws PromptBailout — bailout is caught at the outer try.
      //
      // `removedTools` and `toolErrorCounts` use eventually-consistent
      // semantics across branches (strategy B in the plan): same-round
      // removal is best-effort and removals always take effect from the
      // NEXT round (the .filter() after this parallel call).
      const parallelResult = await pr.parallel(
        `round.${round}.tools`,
        toolCalls,
        // keyFor: MUST match the branchKey the body uses below
        // (`stack.getOrCreateBranch(branchKey)`) so runBatch and the body
        // operate on the same branch.
        (toolCall) => `tool_${toolCall.id}`,
        async (toolCall, b) => {
          if (ctx.isCancelled(stateStack)) throw new AgencyCancelledError();

          const handler = toolFunctions.find(
            (fn) => fn.name === toolCall.name,
          );
          if (!handler) {
            await b.step(
              `round.${round}.tool.${toolCall.id}.unhandled`,
              async () => {
                console.error(
                  `No handler found for tool call: ${toolCall.name}. This error will be sent back to the LLM.`,
                );
                messages.push(
                  smoltalk.toolMessage(
                    `Error: No handler found for tool call ${toolCall.name}`,
                    { tool_call_id: toolCall.id, name: toolCall.name },
                  ),
                );
              },
            );
            return;
          }

          if (self.toolCallRound >= maxToolCallRounds) {
            await b.step(
              `round.${round}.tool.${toolCall.id}.tooManyRounds`,
              async () => {
                messages.push(
                  smoltalk.toolMessage(
                    `Error: Maximum number of tool call rounds (${maxToolCallRounds}) exceeded. This tool call will not be executed.`,
                    { tool_call_id: toolCall.id, name: toolCall.name },
                  ),
                );
              },
            );
            return;
          }


          // Gated start (strategy B): if the tool is already in
          // removedTools (either from a prior round or from an earlier
          // sibling in this round that pushed first), skip with a
          // notice toolMessage.
          if (removedTools.includes(handler.name)) {
            await b.step(
              `round.${round}.tool.${toolCall.id}.removed`,
              async () => {
                messages.push(
                  smoltalk.toolMessage(
                    `Error: Handler for tool call ${handler.name} has been removed already due to previous errors, and will not be executed.`,
                    { tool_call_id: toolCall.id, name: toolCall.name },
                  ),
                );
              },
            );
            return;
          }

          const branchKey = `tool_${toolCall.id}`;
          // Note: a "cached result" short-circuit used to live here for
          // resume after a sibling interrupt; idempotency is now handled
          // uniformly by completedSteps inside b.step (start/invoke/end
          // each get marked done on success and skipped on resume).
          const branchStack = stack.getOrCreateBranch(branchKey).stack;
          const namedArgs = { ...toolCall.arguments };

          await b.step(
            `round.${round}.tool.${toolCall.id}.start`,
            async () => {
              // Pass `branchStack` so scoped callbacks registered inside
              // the branch's frame chain are discovered by
              // `gatherCallbacks`. Callback bodies cannot interrupt
              // (typechecker-enforced), so this is purely about scope
              // discovery, not interrupt routing.
              await invokeCallbacks({
                ctx,
                name: "onToolCallStart",
                data: { toolName: handler.name, args: namedArgs },
                stateStack: branchStack,
              });
            },
          );
          if (b.interrupts) return;

          const toolSpanId = ctx.statelogClient.startSpan("toolExecution");
          let toolResult: any;
          let invokeOutcome:
            | "success"
            | "failed"
            | "rejected"
            | "interrupted"
            | "crashed" = "success";

          // Persist the measured tool execution duration in
          // self.runnerState so resume (where the invoke step is
          // skipped) doesn't report ~0ms to onToolCallEnd /
          // statelogClient.toolCall. Keyed per tool call id; rides
          // along with completedSteps on the same frame.
          self.runnerState.toolTimings ??= {};
          // IMPORTANT: keep the toolExecution span open across the
          // invoke + end-hook + log steps so the toolCall event inherits
          // the toolExecution span_id (logsViewer aggregates tool
          // duration off that). try/finally guarantees we close it even
          // on bailout / unexpected throw.
          try {
            const toolCallStartTime = performance.now();
            // Emit toolCallStart inside the same toolExecution span as
            // the (later) toolCall end event so consumers can pair the
            // two by span_id. Wrap in b.step so resume-replay doesn't
            // duplicate the event. Designed to leave a trace of every
            // tool that began even when the run is killed before it
            // completes (the matching toolCall event won't fire).
            await b.step(
              `round.${round}.tool.${toolCall.id}.logStart`,
              async () => {
                ctx.statelogClient.toolCallStart({
                  toolName: handler.name,
                  args: namedArgs,
                  model: JSON.stringify(clientConfig.model),
                  threadId: __threads()?.activeId() ?? null,
                });
              },
            );
            // Invoke step: returns the interrupts when the tool halts
            // with them so BranchRunner.step can collect. All other
            // outcomes (success, failure, reject, crash) update outer
            // state in place via runInvokeStep; the step completes
            // (returns void unless interrupted) and is marked done so
            // resume skips this whole block.
            await b.step(
              `round.${round}.tool.${toolCall.id}.invoke`,
              async () => {
                const outcome = await runInvokeStep({
                  handler,
                  toolCall,
                  namedArgs,
                  branchKey,
                  branchStack,
                });
                toolResult = outcome.toolResult;
                invokeOutcome = outcome.invokeOutcome;
                if (outcome.invokeOutcome === "success") {
                  self.runnerState.toolTimings[toolCall.id] =
                    performance.now() - toolCallStartTime;
                }
                return outcome.interrupts;
              },
            );

            if (b.interrupts || invokeOutcome !== "success") return;

            // On resume after an end-hook bailout, the `invoke` step is
            // skipped and `toolResult` is undefined. Restore it from the
            // per-branch result that `setResultOnBranch` persisted before
            // the bailout, so the end-hook sees the actual tool output.
            if (toolResult === undefined) {
              toolResult = stack.getBranch(branchKey)?.result?.result;
            }

            // Reuse the persisted duration so onToolCallEnd /
            // statelogClient.toolCall always report the real exec time,
            // not the resume pass's overhead.
            const timeTaken: number =
              self.runnerState.toolTimings[toolCall.id] ?? 0;
            await b.step(
              `round.${round}.tool.${toolCall.id}.end`,
              async () => {
                // Same scope-discovery rationale as the .start hook.
                await invokeCallbacks({
                  ctx,
                  name: "onToolCallEnd",
                  data: {
                    toolName: handler.name,
                    result: toolResult,
                    timeTaken,
                  },
                  stateStack: branchStack,
                });
              },
            );
            // Wrap the toolCall log in its own b.step so it's idempotent
            // when pr.parallel re-runs a fully-completed branch on resume
            // (e.g. after a later `nextLlmCall` step bails). Without this
            // guard, every re-entry would emit a duplicate toolCall event.
            await b.step(
              `round.${round}.tool.${toolCall.id}.log`,
              async () => {
                ctx.statelogClient.toolCall({
                  toolName: handler.name,
                  args: namedArgs,
                  output: toolResult,
                  model: JSON.stringify(clientConfig.model),
                  timeTaken,
                  threadId: __threads()?.activeId() ?? null,
                });
              },
            );
          } finally {
            ctx.statelogClient.endSpan(toolSpanId);
          }
        },
      );

      // pr.parallel returns a RunBatchResult tagged union; if any tool
      // branch surfaced interrupts, runBatch already stamped the shared
      // checkpoint. Bail out of runPrompt with the merged batch — the
      // outer caller checkpoints / propagates as usual. (Replaces the
      // former PromptBailout throw with an explicit return so runBatch's
      // no-throw-Interrupt contract is preserved.)
      if (parallelResult.kind === "interrupts") {
        shouldPop = false;
        return parallelResult.interrupts;
      }

      // All tool calls complete — runBatch already popped branches on the
      // no-interrupt success path, but call again defensively in case any
      // branchFn-level cleanup added new branches mid-flight.
      stack.popBranches();
      tools = tools.filter((t) => !removedTools.includes(t.name));
      toolFunctions = toolFunctions.filter(
        (fn) => !removedTools.includes(fn.name),
      );

      // Next LLM call wrapped in pr.step for resume idempotency. Once
      // marked done, resume re-entries skip the LLM call.
      await pr.step(`round.${round}.nextLlmCall`, async () => {
        closeLlmSpan();
        currentLlmSpanId = ctx.statelogClient.startSpan("llmCall");
        let nextResult: RunPromptResult;
        try {
          nextResult = await _runPrompt({
            ctx,
            messages,
            tools: tools || [],
            prompt,
            responseFormat,
            clientConfig,
            stateStack,
          });
        } catch (e) {
          closeLlmSpan();
          throw e;
        }
        messages = nextResult.messages;
        toolCalls = nextResult.toolCalls;
        // Increment the round counter only after a successful LLM round,
        // so resume after a tool-batch interrupt re-enters the SAME round.
        self.toolCallRound = round + 1;
        self.messagesJSON = messages.toJSON().messages;
        self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
      });
    }
  } catch (error) {
    if (error instanceof PromptBailout) {
      shouldPop = false;
      return error.interrupts;
    }
    if (isAbortError(error)) {
      // Hard cancel (e.g. user pressed Esc): repair the live thread so the
      // next turn starts from a clean, role-valid state, then re-throw so
      // the cancellation still propagates to the caller / REPL.
      markThreadCancelled(messages);
      throw error;
    }
    throw error;
  } finally {
    // Close any open llmCall span. This covers normal completion,
    // thrown errors, and early returns when tool calls interrupted
    // (the resumed run opens a fresh llmCall span). The helper is a
    // no-op if no span is currently open.
    closeLlmSpan();
    if (shouldPop) stateStack.pop();
  }

  const responseMessage = messages.getMessages().at(-1);

  if (!responseMessage) {
    throw new Error(
      `No response message found after running prompt! This shouldn't happen. Messages: ${JSON.stringify(
        messages.getMessages(),
      )}`,
    );
  }

  if (responseFormat) {
    try {
      const rawResult = JSON.parse(responseMessage.content || "");
      const extracted = extractResponse(rawResult, responseFormat);
      return extracted;
    } catch (e) {
      try {
        const extracted = extractResponse(
          responseMessage.content,
          responseFormat,
        );
        return extracted;
      } catch (e) {
        return responseMessage.content;
      }
    }
  }

  return responseMessage.content;
}
