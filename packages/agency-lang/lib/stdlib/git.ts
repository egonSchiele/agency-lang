import path from "path";
import { statSync } from "fs";
import process from "process";
import { getRuntimeContext } from "../runtime/asyncContext.js";
import { abortableSpawn } from "./abortable.js";
import { assertContained } from "./assertContained.js";
import { GIT_HARDENING_FLAGS, scrubEnv } from "./gitCore.js";

// Re-export the pure core + parsers so stdlib/git.agency imports everything
// from one "agency-lang/stdlib-lib/git.js".
export * from "./gitCore.js";
export * from "./gitParse.js";

// Default 30s wall-clock cap; abortableSpawn maps a timeout to exitCode 1.
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
// Cap returned output so an auto-approved read can't blow context/memory.
// (spawn has no maxBuffer; we truncate the returned string.)
const DEFAULT_MAX_OUTPUT_BYTES = 2_000_000;

/**
 * Run git against an EXPLICIT repo directory. Never inherits process.cwd():
 * empty/relative/missing cwd throws, so a lost directory can never silently
 * target the process's own repo. Prepends hardening flags, scrubs the env,
 * enforces a timeout, throws on non-zero exit (stderr as message), truncates
 * oversized output, and returns stdout.
 */
export async function gitRunImpl(
  cwd: string,
  args: string[],
  opts?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number },
): Promise<string> {
  if (!cwd || !path.isAbsolute(cwd)) {
    throw new Error(
      `git: no repo directory — pass an explicit absolute "cwd" or set the agent working directory (got "${cwd}")`,
    );
  }
  let stats;
  try {
    stats = statSync(cwd);
  } catch {
    throw new Error(`git: repo directory does not exist: ${cwd}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`git: repo directory is not a directory: ${cwd}`);
  }
  const env = scrubEnv(opts?.env ?? process.env);
  // Bound stdout in abortableSpawn (UTF-8 bytes, kills the child once
  // exceeded) so an auto-approved read can't buffer unbounded memory.
  const res = await abortableSpawn(
    "git",
    [...GIT_HARDENING_FLAGS, ...args],
    {
      cwd,
      env,
      signal: opts?.signal,
      timeout: opts?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      maxOutputBytes: opts?.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    },
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `git exited with code ${res.exitCode}`);
  }
  return res.stdout;
}

/** ALS-reading wrapper Agency calls; mirrors `_exec` in shell.ts. */
export async function _gitRun(cwd: string, args: string[]): Promise<string> {
  const { ctx, stack } = getRuntimeContext();
  return gitRunImpl(cwd, args, { signal: ctx.getAbortSignal(stack) });
}

/**
 * Enforce `allowedPaths` on a set of repo-relative paths using the shared
 * symlink-aware `assertContained` (the same check exec/bash/fs use). No-op
 * when allowedPaths is empty. Paths resolve against `cwd` (the repo).
 */
export async function assertPathsContained(
  paths: string[],
  allowedPaths: string[],
  cwd: string,
): Promise<void> {
  if (allowedPaths.length === 0) {
    return;
  }
  for (const p of paths) {
    await assertContained(p, allowedPaths, cwd);
  }
}

/**
 * Fail closed: `git add -A` (all=true) stages everything and ignores the
 * explicit paths list, so `allowedPaths` containment would be a no-op. Reject
 * the combination rather than silently letting `-A` escape the restriction.
 */
export function assertAllNotRestricted(all: boolean, allowedPaths: string[]): void {
  if (all && allowedPaths.length > 0) {
    throw new Error(
      "git: cannot combine all=true with allowedPaths — `git add -A` ignores path restrictions",
    );
  }
}
