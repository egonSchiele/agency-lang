import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import { z } from "zod";

import type { AgencyConfig } from "@/config.js";
import { executeNodeAsync } from "@/cli/util.js";

import type { MutationProposal } from "./types.js";

const MutationProposalSchema = z.object({
  prompt: z.string().min(1),
  rationale: z.string().min(1),
});

export type MutatorModelCaller = (args: {
  message: string;
  goal: string;
  currentPrompt: string;
  history: string;
  validationFailure?: string;
  config: AgencyConfig;
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
  const model = args.model || args.config.client?.defaultModel || "gpt-4o-mini";
  const message = buildMutatorMessage({
    goal: args.goal,
    currentPrompt: args.currentPrompt,
    history: args.history,
    validationFailure: args.validationFailure,
  });
  const raw = await (args.callModel ?? defaultCallModel)({
    message,
    goal: args.goal,
    currentPrompt: args.currentPrompt,
    history: args.history,
    validationFailure: args.validationFailure,
    config: args.config,
    model,
  });
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

async function defaultCallModel(args: {
  goal: string;
  currentPrompt: string;
  history: string;
  validationFailure?: string;
  config: AgencyConfig;
  model: string;
}): Promise<unknown> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-mutator-"));
  try {
    const config = {
      ...args.config,
      client: { ...args.config.client, defaultModel: args.model },
    };
    delete config.distDir;
    const result = await executeNodeAsync({
      config,
      agencyFile: path.resolve(currentDir, "../agents/mutatePrompt.agency"),
      nodeName: "mutatePrompt",
      hasArgs: true,
      argsString: [
        args.goal,
        args.currentPrompt,
        args.history,
        validationFailureMessage(args.validationFailure),
      ].map((value) => JSON.stringify(value)).join(", "),
      scratchDir,
    });
    return result.data;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

function validationFailureMessage(validationFailure?: string): string {
  return validationFailure
    ? `Your previous attempt failed validation: ${validationFailure}. Preserve every interpolation placeholder exactly. Try again.`
    : "";
}
