import * as fs from "fs";
import * as path from "path";

import { agentClosure, commonAncestor } from "@/analysis/closure.js";
import { mergeConfigOverrides, type AgencyConfig } from "@/config.js";
import { sha256Text } from "@/utils/hash.js";

export type ClosureFile = { file: string; sha256: string };
export type CodeIdentity = { entry: string; closureHash: string; closure: ClosureFile[] };

/** Which code an agent is: the entry file and every file it transitively
 *  imports, each hashed, plus one hash over the whole list. Paths are relative
 *  to the files' common ancestor (never the cwd, unlike `closureBaseDir`), so
 *  the same code hashes the same wherever it was run from. */
export function computeCodeIdentity(entryFile: string): CodeIdentity {
  const { files } = agentClosure(entryFile);
  const baseDir = commonAncestor(files.map((file) => path.dirname(file)));
  const closure = files
    .map((absoluteFile) => ({
      file: path.relative(baseDir, absoluteFile),
      sha256: sha256Text(fs.readFileSync(absoluteFile, "utf8")),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
  return {
    entry: path.relative(baseDir, fs.realpathSync(path.resolve(entryFile))),
    closureHash: closureHashOf(closure),
    closure,
  };
}

export function closureHashOf(closure: readonly ClosureFile[]): string {
  return sha256Text(closure.map((file) => `${file.file}\n${file.sha256}\n`).join(""));
}

/**
 * The config overrides a launcher hands its child, with `log.code` set to
 * the identity of the file that is actually about to run. Everything else in
 * `overrides` (an inherited statelog path, flags) survives; only `log.code`
 * is forced, because a `log.code` inherited from a parent process or a stale
 * shell names some other program, and a trace must never do that.
 */
export function withCodeIdentity(
  overrides: Partial<AgencyConfig>,
  entryFile: string,
): Partial<AgencyConfig> {
  return mergeConfigOverrides(overrides, { log: { code: computeCodeIdentity(entryFile) } });
}
