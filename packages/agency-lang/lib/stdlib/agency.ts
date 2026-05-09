import { compileSource } from "../compiler/compile.js";
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

  const tempDir = mkdtempSync(join(tmpdir(), "agency-"));
  const tempPath = join(tempDir, `${result.moduleId}.js`);
  writeFileSync(tempPath, result.code, "utf-8");

  return { moduleId: result.moduleId, path: tempPath };
}
