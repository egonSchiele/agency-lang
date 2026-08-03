import { createAccountClient } from "../../statelog/accountClient.js";
import { renderWhoami } from "../render.js";
import { resolveAccountTarget, fail } from "./util.js";
import type { AccountCommandOptions, RemoteCommandContext } from "./util.js";

/** `agency remote whoami` — resolve and print the authenticated user. Accepts an
 *  account- or project-scoped key, so it doubles as a "is my key valid" check. */
export async function runWhoami(
  options: AccountCommandOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const target = resolveAccountTarget(context, options);
  try {
    const { userId } = await createAccountClient(target.origin, target.apiKey).whoami();
    console.log(renderWhoami(userId, target.origin));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
