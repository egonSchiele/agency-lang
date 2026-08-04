import { createProjectClient } from "../../statelog/projectClient.js";
import { renderAgent } from "../render.js";
import { resolveProjectTarget, failProjectCommand } from "./util.js";
import type { ProjectCommandOptions, RemoteCommandContext } from "./util.js";

/** `agency remote inspect` — what's deployed (files + exported node names). */
export async function runInspect(
  options: ProjectCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveProjectTarget(context, options);
  try {
    const agent = await createProjectClient(
      target.origin,
      target.projectSlug,
      target.apiKey,
    ).inspectAgent();
    console.log(renderAgent(agent));
  } catch (error) {
    failProjectCommand(error);
  }
}
