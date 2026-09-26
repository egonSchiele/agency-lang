/**
 * The decision branch of an LLM dispatch. A call whose provider resolves to
 * `typesafe` does not go to `text()`. Its schema becomes questions, the
 * thread becomes the state, and the reply is shaped as a completion so that
 * everything after dispatch (the structured parse, the thread append, cost,
 * statelog) runs unchanged. See docs/dev/llm/decision-models.md.
 */
import * as smoltalk from "smoltalk";
import type { Message, ModelDataBlob, PromptResult } from "smoltalk";
import type { DecideConfig, PromptConfig } from "./llmClient.js";
import {
  answersToValue,
  messagesToState,
  planDecision,
  type DecisionPlan,
} from "./decisionQuestions.js";
import type { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";

/** The one decision provider. It names the wire protocol, so a model or
 *  endpoint the registry does not know is marked with `provider: "typesafe"`. */
export const DECISION_PROVIDER = "typesafe";

/** The per-provider maps `runPrompt` leaves on `metadata`, the same place
 *  `toSmolConfig` reads them from for a text call. */
type ConfigMaps = {
  apiKey?: DecideConfig["apiKey"];
  baseUrl?: DecideConfig["baseUrl"];
  modelData?: ModelDataBlob;
};

/** The registry's record for a model name, or undefined for a name the
 *  registry does not know. */
function registryRecord(
  model: string | undefined,
  modelData: ModelDataBlob | undefined,
): smoltalk.ModelType | undefined {
  if (model === undefined) {
    return undefined;
  }
  return smoltalk.getModel(model as smoltalk.ModelName, modelData);
}

/** True when this call is for a decision model.
 *
 *  A name the registry knows belongs to one provider, and only the
 *  registry's word counts: `jev-1.13` is a decision call whatever provider
 *  is on the call, and `gpt-5-mini` never is. A name the registry does not
 *  know (a local Laya server, say) is a decision call when the call's
 *  provider is `typesafe`.
 *
 *  The call's provider is not trusted for a known name because the user
 *  may not have written it: the compiler bakes the config's default
 *  provider into every generated call that named only a model. */
export function isDecisionCall(config: PromptConfig): boolean {
  const maps = (config.metadata ?? {}) as ConfigMaps;
  const known = registryRecord(config.model, maps.modelData);
  if (known !== undefined) {
    return known.provider === DECISION_PROVIDER;
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
  const maps = (config.metadata ?? {}) as ConfigMaps;
  const record = registryRecord(config.model, maps.modelData);
  const maxQuestions = record?.type === "decision" ? record.maxQuestions : undefined;
  const count = Object.keys(plan.value.questions).length;
  if (maxQuestions !== undefined && count > maxQuestions) {
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
  const decideConfig: DecideConfig = {
    model: config.model ?? "",
    // Never the call's own provider, which may be the baked-in default.
    provider: DECISION_PROVIDER,
    apiKey: config.apiKey ? { ...maps.apiKey, ...config.apiKey } : maps.apiKey,
    baseUrl: maps.baseUrl,
    modelData: maps.modelData,
  };

  const signal = config.abortSignal ?? new AbortController().signal;
  const result = await decide.call(
    ctx.llmClient,
    messagesToState(stateMessages(config.messages)),
    plan.questions,
    decideConfig,
    signal,
  );
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
