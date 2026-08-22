/**
 * Compiles a ValidatedClosure from a private mirror of its validated bytes.
 *
 * The TOCTOU boundary this file owns: compilation must consume exactly what
 * the validator read. Every validated file is written to a fresh private
 * mirror at its own relative path, so `compileSource` (which reads imports
 * from disk) resolves each relative import to the mirrored copy and never
 * touches the caller's directory again. This works because the validator
 * refused symlinks: with no links, a file's relative imports resolve the
 * same way in the mirror as in the original tree.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compileSource, CompileResult } from "./compile.js";
import type { ImportKind } from "../importPaths.js";
import { openValidatedClosure, ValidatedClosure } from "./closureValidator.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

const PRIVATE_DIRECTORY_MODE = 0o700;

export function compileValidatedClosure(closure: ValidatedClosure): CompileResult {
  const data = openValidatedClosure(closure);
  const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sandbox-"));
  fs.chmodSync(mirrorRoot, PRIVATE_DIRECTORY_MODE);
  try {
    let entrySource = "";
    let entryMirrorPath = "";
    const mirrored: { relPath: string; source: string; mirrorPath: string }[] = [];
    for (const [moduleId, mod] of Object.entries(data.modules)) {
      const target = path.join(mirrorRoot, ...mod.relPath.split(path.posix.sep));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, mod.source, "utf-8");
      if (moduleId === data.entryModuleId) {
        entrySource = mod.source;
        entryMirrorPath = target;
      } else {
        mirrored.push({ relPath: mod.relPath, source: mod.source, mirrorPath: target });
      }
    }
    if (entryMirrorPath === "") {
      return { success: false, errors: ["internal: validated closure has no entry module"] };
    }
    const sandboxOptions = {
      typechecker: { enabled: true },
      // Belt on top of validation: the mirror contains only validated
      // content, but keep the policy on so a regression fails closed.
      imports: { allowKinds: ["stdlib", "local"] as ImportKind[] },
    };
    const entryResult = compileSource(entrySource, {
      ...sandboxOptions,
      sourcePath: entryMirrorPath,
    });
    if (!entryResult.success) return entryResult;
    // The entry's generated JS imports each local module by relative path
    // ("./helper.js"), so every module in the closure must be compiled and
    // carried in the result — the runtime materializes them beside the
    // entry script at fork time.
    const modules: Record<string, string> = {};
    for (const mod of mirrored) {
      const result = compileSource(mod.source, {
        ...sandboxOptions,
        sourcePath: mod.mirrorPath,
      });
      if (!result.success) {
        return {
          success: false,
          errors: result.errors.map((err) => `${mod.relPath}: ${err}`),
        };
      }
      modules[mod.relPath.replace(/\.agency$/, ".js")] = result.code;
    }
    if (mirrored.length === 0) {
      return entryResult;
    }
    return { ...entryResult, modules };
  } finally {
    safeDeleteDirectoryWithin(os.tmpdir(), mirrorRoot);
  }
}
