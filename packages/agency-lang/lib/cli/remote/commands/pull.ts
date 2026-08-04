import { createProjectClient } from "../../statelog/projectClient.js";
import { planSourcePull, applySourcePull } from "../pullPlan.js";
import { renderPullSummary } from "../render.js";
import { resolveProjectTarget, failProjectCommand } from "./util.js";
import type { ProjectCommandOptions, RemoteCommandContext } from "./util.js";

export type PullOptions = ProjectCommandOptions & {
  out?: string;
  force?: boolean;
};

/** `agency remote pull` — download the deployed source to disk (safe planner +
 *  atomic applicator; refuses to overwrite without --force). */
export async function runPull(
  options: PullOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveProjectTarget(context, options);
  try {
    const files = await createProjectClient(
      target.origin,
      target.projectSlug,
      target.apiKey,
    ).pullSource();
    const plan = planSourcePull(files, options.out ?? ".", options.force === true);
    applySourcePull(plan);
    console.log(renderPullSummary(plan.files.map((file) => file.name), plan.outputDir));
  } catch (error) {
    failProjectCommand(error);
  }
}
