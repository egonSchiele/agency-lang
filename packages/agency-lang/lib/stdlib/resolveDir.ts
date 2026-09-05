import path from "node:path";
import process from "node:process";
import { assertContained } from "./assertContained.js";
import { expandPath } from "./expandPath.js";

/** Expand shorthands and resolve against the cwd, with no filesystem
 *  access. `contained.ts` does the same as the first step of `root()`.
 *  Use this only for a path that is about to be handed to `contained.ts`
 *  or checked by `assertContained`. */
export function resolveCwdPath(target: string): string {
  return path.resolve(process.cwd(), expandPath(target));
}

/**
 * Resolve a directory argument and apply the program's own allow-list:
 *
 *  1. Expand user shorthands (currently `~`) via `expandPath`.
 *  2. Resolve against `process.cwd()`. A relative path always means
 *     "relative to where the program was run". Agency code that wants
 *     a path relative to its own file passes `__dirname`.
 *  3. Assert containment against `allowedPaths`, the guardrail a program
 *     sets on itself.
 *
 * Returns the absolute directory. This does not touch the filesystem
 * and does not refuse symlinks. A function that then reads, writes,
 * lists, or probes anything must go through `contained.ts`
 * (docs/dev/stdlib/contained-files.md). `exec` and `bash` use this for
 * their working directory, which is handed to a child process rather
 * than opened.
 */
export async function resolveDir(dir: string, allowedPaths: string[] = []): Promise<string> {
  const root = resolveCwdPath(dir);
  await assertContained(root, allowedPaths, process.cwd());
  return root;
}
