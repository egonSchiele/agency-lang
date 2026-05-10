import { compileSource } from "../compiler/compile.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { nanoid } from "nanoid";

export function _compile(source: string): { moduleId: string; path: string } {
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
