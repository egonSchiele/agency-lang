import { compileSource } from "agency-lang/compiler";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export function _compile(source: string): { moduleId: string; path: string } {
  const result = compileSource(source, {
    typeCheck: true,
    restrictImports: true,
  });

  if (!result.success) {
    throw new Error(result.errors.join("\n"));
  }

  // Write compiled JS to a temp file for subprocess execution.
  // Cleanup is the caller's responsibility (e.g., _run() cleans up after execution).
  const tempDir = mkdtempSync(join(tmpdir(), "agency-"));
  const tempPath = join(tempDir, `${result.moduleId}.js`);
  writeFileSync(tempPath, result.code, "utf-8");

  return { moduleId: result.moduleId, path: tempPath };
}
