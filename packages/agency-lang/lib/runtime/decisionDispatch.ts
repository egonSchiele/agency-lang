/**
 * The decision branch of an LLM dispatch. A call whose provider resolves to
 * `typesafe` does not go to `text()`. Its schema becomes questions, the
 * thread becomes the state, and the reply is shaped as a completion so that
 * everything after dispatch (the structured parse, the thread append, cost,
 * statelog) runs unchanged. See docs/dev/llm/decision-models.md.
 */
import * as smoltalk from "smoltalk";
import type { ModelDataBlob, PromptResult } from "smoltalk";
import type { DecideConfig, PromptConfig } from "./llmClient.js";
import { answersToValue, messagesToState, planDecision } from "./decisionQuestions.js";
import type { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";

/** The one decision provider. It names the wire protocol, so an unknown
 *  model or endpoint that speaks it is marked with `provider: "typesafe"`. */
export const DECISION_PROVIDER = "typesafe";

/** The per-provider maps `runPrompt` leaves on `metadata`, the same place
 *  `toSmolConfig` reads them from for a text call. */
type ConfigMaps = {
  apiKey?: DecideConfig["apiKey"];
  baseUrl?: DecideConfig["baseUrl"];
  modelData?: ModelDataBlob;
};

/** True when this call's provider resolves to `typesafe`. Never throws: an
 *  unknown model with no provider is not a decision call, and smoltalk
 *  reports it the way it always has when `text()` runs. */
export function isDecisionCall(config: PromptConfig): boolean {
  if (config.model === undefined && config.provider === undefined) return false;
  const maps = (config.metadata ?? {}) as ConfigMaps;
  try {
    return smoltalk.resolveProvider(config.model ?? "", config.provider, maps.modelData) === DECISION_PROVIDER;
  } catch {
    return false;
  }
}

/** The prompt is the last message, which `runPrompt` appended just before
 *  dispatch. It becomes the instructions when the annotation is one value. */
function promptText(config: PromptConfig): string {
  const last = config.messages[config.messages.length - 1];
  const content = last?.content;
  return typeof content === "string" ? content : "";
}

export async function dispatchDecision(
  ctx: RuntimeContext<GraphState>,
  config: PromptConfig,
): Promise<PromptResult> {
  if (config.tools !== undefined && config.tools.length > 0) {
    throw new Error("A decision model cannot call tools. Remove the tools option or use a text model.");
  }
  const plan = planDecision(config.responseFormat, promptText(config));
  if (!plan.success) {
    throw new Error(plan.error);
  }
  const decide = ctx.llmClient.decide;
  if (decide === undefined) {
    throw new Error("The active LLM client does not support decision models.");
  }

  // The same key rule a text call gets from toSmolConfig: the per-call map
  // merges over the config map, one provider slot at a time.
  const maps = (config.metadata ?? {}) as ConfigMaps;
  const decideConfig: DecideConfig = {
    model: config.model ?? "",
    provider: config.provider,
    apiKey: config.apiKey ? { ...maps.apiKey, ...config.apiKey } : maps.apiKey,
    baseUrl: maps.baseUrl,
    modelData: maps.modelData,
  };

  const signal = config.abortSignal ?? new AbortController().signal;
  const result = await decide.call(
    ctx.llmClient,
    messagesToState(config.messages),
    plan.value.questions,
    decideConfig,
    signal,
  );
  if (!result.success) {
    throw new Error(result.error);
  }
  const value = answersToValue(plan.value, result.value.answers);
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
