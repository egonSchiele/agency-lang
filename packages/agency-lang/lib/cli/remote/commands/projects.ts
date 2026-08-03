import { createAccountClient } from "../../statelog/accountClient.js";
import { renderProjects, renderProjectCreated } from "../render.js";
import { resolveAccountTarget, failAccount, fail } from "./util.js";
import type { AccountCommandOptions, RemoteCommandContext } from "./util.js";

// Matches statelog's server rule so a bad slug fails instantly, before any call.
const PROJECT_ID_PATTERN = /^[a-z0-9-]+$/;
const MAX_PROJECT_ID_LENGTH = 20;

export type CreateProjectOptions = AccountCommandOptions & {
  name: string;
  description?: string;
};

/** `agency remote projects` — list the account's projects. */
export async function runProjectsList(
  options: AccountCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveAccountTarget(context, options);
  try {
    const projects = await createAccountClient(target.origin, target.apiKey).listProjects();
    console.log(renderProjects(projects));
  } catch (error) {
    failAccount(error, target.apiKeyEnvName);
  }
}

/** `agency remote projects create <project_id>` — create a project. */
export async function runProjectsCreate(
  projectId: string,
  options: CreateProjectOptions,
  context: RemoteCommandContext,
): Promise<void> {
  if (!PROJECT_ID_PATTERN.test(projectId) || projectId.length > MAX_PROJECT_ID_LENGTH) {
    fail(
      `Invalid project id "${projectId}" — lowercase letters, digits, and dashes only, ` +
        `${MAX_PROJECT_ID_LENGTH} characters or fewer.`,
    );
  }
  const target = resolveAccountTarget(context, options);
  try {
    const project = await createAccountClient(target.origin, target.apiKey).createProject({
      name: options.name,
      projectId,
      description: options.description,
    });
    console.log(renderProjectCreated(project));
  } catch (error) {
    failAccount(error, target.apiKeyEnvName);
  }
}
