// The policy a session runs under, when it was started with policy flags.
// It is a file of its own beside the user's policy files:
// `<agent home>/session-policies/<session id>.json`. A front-end writes it.
// The core never sees it, and nothing in a checkpoint or an interrupt's
// data can change it. See docs/dev/agents/session-driver.md.
import { currentHost } from "../../runtime/currentHost.js";
import { validatePolicy, type Policy } from "../../runtime/policy.js";
import { failure, success, type Result } from "../../types/result.js";

/** The folder under the agent home that holds each session's policy. */
export const SESSION_POLICIES_DIR = "session-policies";

/** Why a session whose policy file can't be read is not resumed. */
export const POLICY_UNREADABLE =
  "This session's own policy can't be read, so it can't be continued here.";

function isPolicy(value: unknown): value is Policy {
  return validatePolicy(value).success;
}

/** The file's path under the agent home. An id that is not a plain file
 *  name would put it somewhere else. */
function policyFile(id: string): Result<string> {
  if (id === "" || id.startsWith(".") || /[\\/]/.test(id)) {
    return failure(`"${id}" is not a session id.`);
  }
  return success(`${SESSION_POLICIES_DIR}/${id}.json`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Saves the policy session `id` runs under. A front-end calls it when it
 *  starts a session with policy flags. A policy that is not valid is
 *  refused, and nothing is written. */
export async function saveCarriedPolicy(args: {
  home: string;
  id: string;
  policy: Policy;
}): Promise<Result<null>> {
  const { home, id, policy } = args;
  const valid = validatePolicy(policy);
  if (!valid.success) {
    return failure(`Session ${id}'s policy is not a valid policy: ${valid.error}`);
  }
  const file = policyFile(id);
  if (!file.success) {
    return file;
  }
  const host = currentHost();
  try {
    const root = await host.files.root(home);
    await host.files.writeText(root, file.value, JSON.stringify(policy, null, 2), {
      makeFolders: true,
    });
    return success(null);
  } catch (error) {
    return failure(`Could not save session ${id}'s policy: ${messageOf(error)}`);
  }
}

/** The policy session `id` runs under: null when it has no policy file,
 *  because it was started with no policy flag. A file that can't be read,
 *  or that is not a valid policy, is `POLICY_UNREADABLE`. Give the result
 *  to `sessionRunPolicy` as it is: a null there means "runs under the
 *  saved policy", and that must never stand in for a file that is there. */
export async function readCarriedPolicy(args: {
  home: string;
  id: string;
}): Promise<Result<Policy | null>> {
  const file = policyFile(args.id);
  if (!file.success) {
    return file;
  }
  const host = currentHost();
  try {
    const root = await host.files.root(args.home);
    if ((await host.files.stat(root, file.value)) === null) {
      return success(null);
    }
    const parsed: unknown = JSON.parse(await host.files.readText(root, file.value));
    return isPolicy(parsed) ? success(parsed) : failure(POLICY_UNREADABLE);
  } catch {
    return failure(POLICY_UNREADABLE);
  }
}

/** Carries session `from`'s policy to its fork `to`. A front-end calls it
 *  on the driver's `forked` event. Without it a session started with
 *  `--policy minimal` would run its fork under the saved policy. No file
 *  at `from` copies nothing; one that can't be read is a failure. */
export async function copyCarriedPolicy(args: {
  home: string;
  from: string;
  to: string;
}): Promise<Result<null>> {
  const { home, from, to } = args;
  const carried = await readCarriedPolicy({ home, id: from });
  if (!carried.success) {
    return carried;
  }
  if (carried.value === null) {
    return success(null);
  }
  return saveCarriedPolicy({ home, id: to, policy: carried.value });
}
