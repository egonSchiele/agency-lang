import * as fs from "fs";
import * as path from "path";

import { agentClosure, commonAncestor } from "@/analysis/closure.js";
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
