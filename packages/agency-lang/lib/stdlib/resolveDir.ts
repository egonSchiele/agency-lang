import path from "#path";
import type { Host } from "../host/host.js";
import { assertContained } from "./assertContained.js";
import { expandPath } from "./expandPath.js";

/** Expand shorthands and resolve against the run's working directory,
 *  with no filesystem access. The host's `root` does the same as its
 *  first step. Use this only for a path that is about to be handed to
 *  `host.files` or checked by `assertContained`. */
export function resolveCwdPath(host: Host, target: string): string {
  return path.resolve(host.system.cwd(), expandPath(target, host.system.homeDir()));
}

/**
 * Resolve a directory argument and apply the program's own allow-list:
 *
 *  1. Expand user shorthands (currently `~`) via `expandPath`.
 *  2. Resolve against the run's working directory. A relative path always means
 *     "relative to where the program was run". Agency code that wants
 *     a path relative to its own file passes `__dirname`.
 *  3. Assert containment against `allowedPaths`, the guardrail a program
 *     sets on itself.
 *
 * Returns the absolute directory. This does not touch the filesystem
 * and does not refuse symlinks. A function that then reads, writes,
 * lists, or probes anything must go through `host.files`
 * (docs/dev/stdlib/contained-files.md). `exec` and `bash` use this for
 * their working directory, which is handed to a child process rather
 * than opened.
 */
export async function resolveDir(
  host: Host,
  dir: string,
  allowedPaths: string[] = [],
): Promise<string> {
  const root = resolveCwdPath(host, dir);
  await assertContained(host, root, allowedPaths, host.system.cwd());
  return root;
}
