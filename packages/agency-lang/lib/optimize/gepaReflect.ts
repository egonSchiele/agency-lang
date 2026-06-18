import * as path from "path";

import { getAgentsDir } from "@/importPaths.js";

import type { AgencyRunner } from "./grading/agencyRunner.js";
import type { JSON } from "./grading/types.js";
import { MutationProposalSchema } from "./mutator.js";
import type { MutationProposal } from "./types.js";

export type ReflectionSections = { targets: string; feedback: string; history: string };

/** Run the GEPA reflective proposer and validate its structured proposal. */
export async function proposeReflective(runAgency: AgencyRunner, sections: ReflectionSections): Promise<MutationProposal> {
  const agentFile = path.join(getAgentsDir(), "optimize", "gepaReflect.agency");
  const args: JSON[] = [sections.targets, sections.feedback, sections.history];
  return runAgency.runStructured(agentFile, "gepaReflect", args, MutationProposalSchema) as Promise<MutationProposal>;
}
