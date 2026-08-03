import { createAccountClient } from "../../statelog/accountClient.js";
import { renderKeys, renderCreatedKey } from "../render.js";
import { resolveAccountTarget, failAccount } from "./util.js";
import type { AccountCommandOptions, RemoteCommandContext } from "./util.js";

export type CreateKeyOptions = AccountCommandOptions & {
  project: string;
};

/** `agency remote keys` — list the account's API keys. */
export async function runKeysList(
  options: AccountCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveAccountTarget(context, options);
  try {
    const keys = await createAccountClient(target.origin, target.apiKey).listKeys();
    console.log(renderKeys(keys));
  } catch (error) {
    failAccount(error, target.apiKeyEnvName);
  }
}

/** `agency remote keys create <name> --project <slug>` — mint a project-scoped
 *  key. `--project` is the public slug; the client resolves it to the internal
 *  id. The plaintext key is printed once. */
export async function runKeysCreate(
  name: string,
  options: CreateKeyOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveAccountTarget(context, options);
  try {
    const created = await createAccountClient(target.origin, target.apiKey).createProjectKey({
      name,
      projectId: options.project,
    });
    console.log(renderCreatedKey(created));
  } catch (error) {
    failAccount(error, target.apiKeyEnvName);
  }
}
