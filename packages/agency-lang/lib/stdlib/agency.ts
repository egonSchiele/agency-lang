import { compileSource } from "../compiler/compile.js";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { nanoid } from "nanoid";

function compileAndPersist(source: string): { moduleId: string; path: string } {
  const result = compileSource(source, {
    typeCheck: true,
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
// stdlib-only restriction as _compile. The split (`dir`, `filename`) mirrors
// std::read / std::write so callers can use partial application to bind
// `dir` to a sandbox path: `runFile.bind(dir: "/safe/dir")`.
export function _compileFile(
  dir: string,
  filename: string,
): { moduleId: string; path: string } {
  const sourcePath = resolve(dir, filename);
  const source = readFileSync(sourcePath, "utf-8");
  return compileAndPersist(source);
}
