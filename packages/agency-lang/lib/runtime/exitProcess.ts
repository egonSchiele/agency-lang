import { defaultHost } from "#default-host";
import { flushPendingStatelogPosts } from "../statelogSender.js";

/**
 * End the process once the log requests still on their way have been sent.
 * `process.exit()` kills them, so every deliberate exit in the runtime, the
 * servers, and the standard library goes through this function. The lint
 * rule in eslint.config.js refuses a bare `process.exit()` in those
 * directories. Print any message for the user before calling this, so the
 * message does not wait on the uploads.
 */
export async function exitProcess(code: number): Promise<never> {
  await flushPendingStatelogPosts();
  return defaultHost().system.exit(code);
}

/**
 * End the process at once, without sending pending logs. Use it only where
 * waiting is wrong or impossible: a Ctrl+C or signal handler, a lost parent,
 * or an exit from code that cannot be async. Say why at the call site.
 */
export function exitProcessNow(code: number): never {
  return defaultHost().system.exit(code);
}
