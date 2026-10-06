import { defaultHost } from "#default-host";
import type { Host } from "../host/host.js";
import { currentRunOrNone } from "./asyncContext.js";

/**
 * The host of the current run, for a helper that Agency code calls as a
 * plain function and that was not handed the run. Read it on the first
 * line, before any `await`, like `currentRun()` (see
 * docs/dev/runtime/async-context.md).
 *
 * With no run current, which is where a unit test or a TypeScript caller
 * stands, this is the platform's default host, so the helper behaves as it
 * did when it read `process.env` itself. A helper that takes `run` reads
 * `run.ctx.host` instead and does not need this.
 */
export function currentHost(): Host {
  // run-read-ok: with no run current, the platform's default host answers.
  return currentRunOrNone()?.ctx.host ?? defaultHost();
}
