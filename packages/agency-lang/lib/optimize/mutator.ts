import * as smoltalk from "smoltalk";
import { z } from "zod";

import type { AgencyConfig } from "@/config.js";

import type { MutationProposal } from "./types.js";

const MutationProposalSchema = z.object({
  prompt: z.string().min(1),
  rationale: z.string().min(1),
});

export type MutatorModelCaller = (args: {
  message: string;
  model: string;
}) => Promise<unknown>;

export function buildMutatorMessage(args: {
  goal: string;
  currentPrompt: string;
  history: string;
  validationFailure?: string;
}): string {
  return [
    "GOAL:",
    args.goal,
    "",
    "CURRENT PROMPT:",
    args.currentPrompt,
    ...(args.history ? ["", args.history] : []),
    "",
    "YOUR TASK:",
    "Propose a new prompt that better achieves the goal. Return JSON with:",
    "- \"prompt\": the new prompt text. Must preserve every `${...}` interpolation that the current prompt uses (no drops, no additions).",
    "- \"rationale\": 2-4 sentences explaining what you changed and why.",
    ...(args.validationFailure
      ? ["", `Your previous attempt failed validation: ${args.validationFailure}. Specifically, you must preserve every \${...} interpolation exactly. Try again.`]
      : []),
  ].join("\n");
}

export async function proposeMutation(args: {
  config: AgencyConfig;
  goal: string;
  currentPrompt: string;
  history: string;
  model?: string;
  validationFailure?: string;
  callModel?: MutatorModelCaller;
}): Promise<MutationProposal> {
  const model = args.model ?? args.config.client?.defaultModel ?? "gpt-4o-mini";
  const message = buildMutatorMessage({
    goal: args.goal,
    currentPrompt: args.currentPrompt,
    history: args.history,
    validationFailure: args.validationFailure,
  });
  const raw = await (args.callModel ?? defaultCallModel)({ message, model });
  const normalized = parseModelOutput(raw);
  const parsed = MutationProposalSchema.safeParse(normalized);
  if (!parsed.success) {
    const missingPrompt = !normalized || typeof normalized !== "object" || typeof (normalized as { prompt?: unknown }).prompt !== "string" || (normalized as { prompt?: string }).prompt?.length === 0;
    throw new Error(missingPrompt ? "Mutator response missing prompt" : `Malformed mutator response: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseModelOutput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function defaultCallModel(args: { message: string; model: string }): Promise<unknown> {
  const result = await smoltalk.textSync({
    messages: [smoltalk.userMessage(args.message)],
    model: args.model,
    responseFormat: MutationProposalSchema,
    responseFormatOptions: { strict: true },
  });
  if (!result.success) {
    throw new Error(`Error from LLM during optimization: ${result.error}`);
  }
  return result.value.output;
}
