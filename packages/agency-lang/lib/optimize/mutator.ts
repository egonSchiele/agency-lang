import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import { z } from "zod";

import type { AgencyConfig } from "@/config.js";
import { executeNodeAsync } from "@/cli/util.js";
import type { EvalTask } from "@/eval/runTypes.js";

import type { OptimizeMutationDiagnostic } from "./sourceMutator.js";
import type { OptimizeTarget } from "./targets.js";
import type { MutationProposal } from "./types.js";

const MutationOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    target: z.string().min(1),
    kind: z.literal("variable"),
    op: z.literal("replaceInitializer"),
    value: z.string().min(1),
    expected: z.string().optional(),
    rationale: z.string().optional(),
  }),
  z.object({
    target: z.string().min(1),
    kind: z.literal("type"),
    op: z.literal("replaceTypeDefinition"),
    value: z.string().min(1),
    expected: z.string().optional(),
    rationale: z.string().optional(),
  }),
]);

const MutationProposalSchema = z.object({
  operations: z.array(MutationOperationSchema).min(1),
  rationale: z.string().min(1),
});

export type MutatorPromptInputs = {
  targets: OptimizeTarget[];
  tasks: EvalTask[];
  history: string;
  diagnostics?: OptimizeMutationDiagnostic[];
};

export type MutatorMessageSections = {
  targets: string;
  goals: string;
  history: string;
  diagnostics: string;
};

export type MutatorModelCaller = (args: {
  message: string;
  sections: MutatorMessageSections;
  config: AgencyConfig;
  model: string;
}) => Promise<unknown>;

export type ProposeMutationArgs = MutatorPromptInputs & {
  config: AgencyConfig;
  model?: string;
  callModel?: MutatorModelCaller;
};

export function buildMutatorSections(inputs: MutatorPromptInputs): MutatorMessageSections {
  const targets = [...inputs.targets]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((target) => [
      `- id: ${target.id}`,
      `  kind: ${target.kind}`,
      `  current value: ${JSON.stringify(target.value)}`,
    ].join("\n"))
    .join("\n");
  const goals = [...inputs.tasks]
    .sort((a, b) => a.task_id.localeCompare(b.task_id))
    .map((task) => `- [${task.task_id}] ${task.goal}`)
    .join("\n");
  const diagnostics = (inputs.diagnostics ?? []).length === 0
    ? ""
    : [
      "Your previous proposal failed validation:",
      ...(inputs.diagnostics ?? []).map((entry) => `- [${entry.code}] ${entry.message}`),
      "Fix every problem listed above and propose corrected operations.",
    ].join("\n");
  return { targets, goals, history: inputs.history, diagnostics };
}

export function buildMutatorMessage(sections: MutatorMessageSections): string {
  return [
    "OPTIMIZE TARGETS:",
    sections.targets,
    "",
    "GOALS:",
    sections.goals,
    ...(sections.history ? ["", sections.history] : []),
    "",
    "YOUR TASK:",
    "Propose replacement values for one or more of the optimize targets listed above so the agent better achieves the goals. Return JSON with:",
    "- \"operations\": one record per target you change. Each record needs \"target\" and \"kind\" copied exactly from the list above, \"op\" set to \"replaceInitializer\", \"value\" with the replacement as Agency source text including the surrounding quotes, and \"rationale\" with one sentence on what you changed. The replacement must preserve every interpolation placeholder the current value uses (no drops, no additions).",
    "- \"rationale\": 2-4 sentences explaining the overall change.",
    ...(sections.diagnostics ? ["", sections.diagnostics] : []),
  ].join("\n");
}

/**
 * Asks the mutator model for declarative mutation operations against the
 * supplied optimize targets. Performs no validation beyond response shape:
 * `OptimizeSourceMutator.preview()` owns semantic validation, and the
 * optimize loop feeds rejected-preview diagnostics back in via
 * `args.diagnostics` for a retry.
 */
export async function proposeMutation(args: ProposeMutationArgs): Promise<MutationProposal> {
  const model = args.model || args.config.client?.defaultModel || "gpt-4o-mini";
  const sections = buildMutatorSections(args);
  const message = buildMutatorMessage(sections);
  const raw = await (args.callModel ?? defaultCallModel)({
    message,
    sections,
    config: args.config,
    model,
  });
  const normalized = parseModelOutput(raw);
  const parsed = MutationProposalSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Malformed mutator response: ${parsed.error.message}`);
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

const defaultCallModel: MutatorModelCaller = async (args) => {
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
        args.sections.targets,
        args.sections.goals,
        args.sections.history,
        args.sections.diagnostics,
      ].map((value) => JSON.stringify(value)).join(", "),
      scratchDir,
      quietCompile: true,
    });
    return result.data;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
};
