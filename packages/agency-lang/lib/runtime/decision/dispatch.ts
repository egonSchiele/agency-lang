/**
 * Converts a typed LLM call into decision questions and its thread into state.
 * Returns a completion for schema validation, conversation history, and metering.
 * See docs/dev/llm/decision-models.md.
 *
 * A call inside a fork or parallel block hands its request to the block's
 * collector (`lib/runtime/decision/collector.ts`) on the async-context frame,
 * which may batch it with sibling calls. Other calls send individually.
 */
import * as smoltalk from "smoltalk";
import type { Message, ModelDataBlob, PromptResult } from "smoltalk";
import type { DecideConfig, PromptConfig } from "../llmClient.js";
import { answersToValue, messagesToState, planDecision, type DecisionPlan } from "./questions.js";
import type { RuntimeContext } from "../state/context.js";
import type { GraphState } from "../types.js";
import { agencyStore } from "../asyncContext.js";
import { DEFAULT_QUESTION_CAP } from "./collector.js";
import { modelRecord } from "../llmConfig.js";

/** The provider of a decision model the registry does not know. It names
 *  the wire protocol Jev and Laya speak; a registry model carries its own. */
export const DECISION_PROVIDER = "typesafe";

/** The per-provider maps `runPrompt` leaves on `metadata`, the same place
 *  `toSmolConfig` reads them from for a text call. */
type ConfigMaps = {
  apiKey?: DecideConfig["apiKey"];
  baseUrl?: DecideConfig["baseUrl"];
  modelData?: ModelDataBlob;
};

function registryRecord(config: PromptConfig): smoltalk.ModelType | undefined {
  const maps = (config.metadata ?? {}) as ConfigMaps;
  return modelRecord({
    model: config.model,
    provider: config.provider,
    modelData: maps.modelData,
  });
}

/** Known models use their registry type. An unknown local decision model
 * can opt into the TypeSafe protocol with provider: "typesafe". */
export function isDecisionCall(config: PromptConfig): boolean {
  const known = registryRecord(config);
  if (known !== undefined) {
    return known.type === "decision";
  }
  return config.provider === DECISION_PROVIDER;
}

/** The thread as a decision model reads it: everything before the prompt,
 *  which `runPrompt` appended last. The prompt itself becomes the questions'
 *  instructions. A thread that holds only the prompt sends it as the state,
 *  so the model never sees an empty state. */
export function stateMessages(messages: Message[]): Message[] {
  return messages.length > 1 ? messages.slice(0, -1) : messages;
}

/** The prompt is the last message, which `runPrompt` appended just before
 *  dispatch. It becomes the instructions when the annotation is one value. */
function promptText(config: PromptConfig): string {
  const last = config.messages[config.messages.length - 1];
  const content = last?.content;
  return typeof content === "string" ? content : "";
}

/** Everything that can refuse a decision call before a request exists: the
 *  tools check, the schema mapping, and the client capability. Runs before
 *  metering so a refusal is never counted as an attempt. */
/** The most questions one request to this call's model may carry: the
 *  registry's `maxQuestions` for a known decision model, else Jev's cap. */
export function questionCapFor(config: PromptConfig): number {
  const record = registryRecord(config);
  if (record?.type === "decision" && record.maxQuestions !== undefined) {
    return record.maxQuestions;
  }
  return DEFAULT_QUESTION_CAP;
}

export function prepareDecision(
  ctx: RuntimeContext<GraphState>,
  config: PromptConfig,
): DecisionPlan {
  if (config.tools !== undefined && config.tools.length > 0) {
    throw new Error(
      "A decision model cannot call tools. Remove the tools option or use a text model.",
    );
  }
  const plan = planDecision(config.responseFormat, promptText(config));
  if (!plan.success) {
    throw new Error(plan.error);
  }
  const maxQuestions = questionCapFor(config);
  const count = Object.keys(plan.value.questions).length;
  if (count > maxQuestions) {
    throw new Error(
      `A decision model accepts at most ${maxQuestions} questions per call, but the object type has ${count} fields.`,
    );
  }
  if (ctx.llmClient.decide === undefined) {
    throw new Error("The active LLM client does not support decision models.");
  }
  return plan.value;
}

/** A failed request as a thrown error. The HTTP status, when the failure
 *  came from one, rides along so the retry classifier can read it. */
function decisionRequestError(failed: { error: string; status?: number }): Error {
  const err = new Error(failed.error);
  if (failed.status === undefined) {
    return err;
  }
  return Object.assign(err, { status: failed.status });
}

export async function dispatchDecision(
  ctx: RuntimeContext<GraphState>,
  config: PromptConfig,
  plan: DecisionPlan = prepareDecision(ctx, config),
): Promise<PromptResult> {
  const decide = ctx.llmClient.decide;
  if (decide === undefined) {
    throw new Error("The active LLM client does not support decision models.");
  }

  // The same key rule `toSmolConfig` applies to a text call: the per-call
  // map merges over the config map.
  const maps = (config.metadata ?? {}) as ConfigMaps;
  const known = registryRecord(config);
  const decideConfig: DecideConfig = {
    model: config.model ?? "",
    provider: config.provider ?? known?.provider ?? DECISION_PROVIDER,
    apiKey: config.apiKey ? { ...maps.apiKey, ...config.apiKey } : maps.apiKey,
    baseUrl: maps.baseUrl,
    modelData: maps.modelData,
  };

  const signal = config.abortSignal ?? new AbortController().signal;
  // Inside a fork or parallel block, a collector on the frame batches this
  // call with its siblings. Outside one, the call sends on its own. Either
  // way the answer comes back in the same `Result<DecideResult>` shape, so
  // nothing after the send changes.
  const state = messagesToState(stateMessages(config.messages));
  const scope = agencyStore.getStore()?.decisions;
  const result =
    scope === undefined
      ? await decide.call(ctx.llmClient, state, plan.questions, decideConfig, signal)
      : await scope.collector.submit(scope.armKey, {
          state,
          questions: plan.questions,
          config: decideConfig,
          questionCap: questionCapFor(config),
          signal,
        });
  if (!result.success) {
    throw decisionRequestError(result);
  }
  const value = answersToValue(plan, result.value.answers);
  if (!value.success) {
    throw new Error(value.error);
  }

  return smoltalk.promptResult({
    output: JSON.stringify({ response: value.value }),
    toolCalls: [],
    usage: result.value.usage,
    cost: result.value.cost,
    model: result.value.model as PromptResult["model"],
    stopReason: "stop",
    rawData: result.value,
  });
}
