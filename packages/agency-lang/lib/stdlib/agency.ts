import { compileSource } from "../compiler/compile.js";
import { writeFileSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { join, resolve, sep } from "path";
import { nanoid } from "nanoid";

function compileAndPersist(source: string): { moduleId: string; path: string } {
  const result = compileSource(source, {
    typechecker: { enabled: true },
    restrictImports: true,
  });

  if (!result.success) {
    throw new Error(result.errors.join("\n"));
  }

  // Write to .agency-tmp/ under cwd so the subprocess can resolve
  // agency-lang package imports via the project's node_modules.
  const tempDir = join(process.cwd(), ".agency-tmp", nanoid());
  mkdirSync(tempDir, { recursive: true });
  const tempPath = join(tempDir, `${result.moduleId}.js`);
  writeFileSync(tempPath, result.code, "utf-8");

  return { moduleId: result.moduleId, path: tempPath };
}

export function _compile(source: string): { moduleId: string; path: string } {
  return compileAndPersist(source);
}

// Read an agency source file from disk and compile it under the same
// stdlib-only restriction as _compile. The (dir, filename) split mirrors
// std::read / std::write so callers can use partial application to bind
// `dir` to a sandbox path: `runFile.bind(dir: "/safe/dir")`.
//
// SECURITY: `filename` is forbidden from escaping `dir`. A naive
// `path.resolve(dir, filename)` is unsafe in two ways:
//   1. If `filename` is absolute (e.g. "/etc/passwd"), `resolve` ignores
//      `dir` entirely.
//   2. `filename` may contain `..` segments that walk out of `dir`.
// We defend against both by realpath-ing the resolved file and checking
// it lives strictly inside the realpath-ed `dir`. realpath also collapses
// symlinks, so a symlink planted inside `dir` that points outside cannot
// be used as an escape hatch. The trailing `+ sep` on the prefix
// prevents a sibling directory (e.g. `/safedir-evil/`) from passing the
// startsWith check by sharing the same prefix string.
export function _compileFile(
  dir: string,
  filename: string,
): { moduleId: string; path: string } {
  const sandboxRoot = realpathSync(resolve(dir));
  const target = realpathSync(resolve(sandboxRoot, filename));
  if (!target.startsWith(sandboxRoot + sep)) {
    throw new Error(
      `Sandbox violation: '${filename}' resolves to '${target}', which is outside the sandbox dir '${sandboxRoot}'.`,
    );
  }
  const source = readFileSync(target, "utf-8");
  return compileAndPersist(source);
}
