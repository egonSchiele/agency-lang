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
import {
  answersToValue,
  messagesToState,
  planDecision,
  type DecisionPlan,
} from "./decisionQuestions.js";
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

/** The registry's provider for a model name, or undefined for a name the
 *  registry does not know. Never throws. */
function registryProvider(
  model: string | undefined,
  modelData: ModelDataBlob | undefined,
): string | undefined {
  if (model === undefined) return undefined;
  try {
    return smoltalk.resolveProvider(model, undefined, modelData);
  } catch {
    return undefined;
  }
}

/** The registry's per-request question cap for a model, if it has one. */
function registryMaxQuestions(
  model: string | undefined,
  modelData: ModelDataBlob | undefined,
): number | undefined {
  if (model === undefined) return undefined;
  const record = smoltalk.getModel(model as smoltalk.ModelName, modelData);
  return record?.type === "decision" ? record.maxQuestions : undefined;
}

/** True when this call is for a decision model.
 *
 *  Two rules, and which one applies depends on whether the registry knows
 *  the model name. A known name belongs to one provider, and only the
 *  registry's word counts: `jev-1.13` is a decision call whatever provider
 *  is on the call, and `gpt-5-mini` never is. An unknown name (a local Laya
 *  server, say) is a decision call when the call's provider is `typesafe`.
 *
 *  The call's provider is not trusted for a known name because it may not
 *  have been written by the user. The compiler bakes the config's default
 *  provider into every generated call that named only a model, so at
 *  dispatch `config.provider` cannot tell "written" from "defaulted". With
 *  an explicit-provider-wins rule, `jev-1.13` with no provider written
 *  went to `text()`, and a default provider of `typesafe` captured every
 *  call in the run, including stdlib calls that name a text model. */
export function isDecisionCall(config: PromptConfig): boolean {
  const maps = (config.metadata ?? {}) as ConfigMaps;
  const known = registryProvider(config.model, maps.modelData);
  if (known !== undefined) return known === DECISION_PROVIDER;
  return config.provider === DECISION_PROVIDER;
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
  const maxQuestions = registryMaxQuestions(config.model, maps.modelData);
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

/** smoltalk reports an HTTP error as a failure whose text names the status.
 *  Lift it onto the thrown error so the retry classifier can read it. */
function decisionRequestError(message: string): Error {
  const match = /\bstatus (\d{3})\b/.exec(message);
  const err = new Error(message);
  if (match) {
    return Object.assign(err, { status: Number(match[1]) });
  }
  return err;
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

  // The same key rule a text call gets from toSmolConfig: the per-call map
  // merges over the config map, one provider slot at a time.
  const maps = (config.metadata ?? {}) as ConfigMaps;
  const decideConfig: DecideConfig = {
    model: config.model ?? "",
    // Always explicit: the call's provider may be the filled-in default.
    provider: DECISION_PROVIDER,
    apiKey: config.apiKey ? { ...maps.apiKey, ...config.apiKey } : maps.apiKey,
    baseUrl: maps.baseUrl,
    modelData: maps.modelData,
  };

  const signal = config.abortSignal ?? new AbortController().signal;
  const result = await decide.call(
    ctx.llmClient,
    messagesToState(config.messages),
    plan.questions,
    decideConfig,
    signal,
  );
  if (!result.success) {
    throw decisionRequestError(result.error);
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
