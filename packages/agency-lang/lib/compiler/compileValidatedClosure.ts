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
import { compileSource, CompileResult, typeCheckSource, TypeCheckReport } from "./compile.js";
import type { ImportKind } from "../importPaths.js";
import { openValidatedClosure, ValidatedClosure } from "./closureValidator.js";
import { safeDeleteDirectoryWithin } from "../utils.js";

const PRIVATE_DIRECTORY_MODE = 0o700;

type MirroredModule = { relPath: string; source: string; mirrorPath: string };
type Mirror = { entry: MirroredModule; mirrored: MirroredModule[] };

/** Write every validated module to a fresh private mirror, run `fn` over
 *  the layout, and delete the mirror. `fn` gets null when the closure has
 *  no entry module. */
function withMirror<T>(closure: ValidatedClosure, fn: (mirror: Mirror | null) => T): T {
  const data = openValidatedClosure(closure);
  const mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agency-sandbox-"));
  fs.chmodSync(mirrorRoot, PRIVATE_DIRECTORY_MODE);
  try {
    let entry: MirroredModule | null = null;
    const mirrored: MirroredModule[] = [];
    for (const [moduleId, mod] of Object.entries(data.modules)) {
      const target = path.join(mirrorRoot, ...mod.relPath.split(path.posix.sep));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, mod.source, "utf-8");
      const module = { relPath: mod.relPath, source: mod.source, mirrorPath: target };
      if (moduleId === data.entryModuleId) {
        entry = module;
      } else {
        mirrored.push(module);
      }
    }
    return fn(entry === null ? null : { entry, mirrored });
  } finally {
    safeDeleteDirectoryWithin(os.tmpdir(), mirrorRoot);
  }
}

/** Type-check the entry from the mirror, so its relative imports resolve to
 *  the validated copies of its siblings. Throws when the closure has no
 *  entry; the stdlib caller turns that into a failure. */
export function typeCheckValidatedClosure(closure: ValidatedClosure): TypeCheckReport {
  return withMirror(closure, (mirror) => {
    if (mirror === null) {
      throw new Error("internal: validated closure has no entry module");
    }
    return typeCheckSource(mirror.entry.source, mirror.entry.mirrorPath);
  });
}

export function compileValidatedClosure(closure: ValidatedClosure): CompileResult {
  return withMirror(closure, (mirror) => {
    if (mirror === null) {
      return { success: false, errors: ["internal: validated closure has no entry module"] };
    }
    const entrySource = mirror.entry.source;
    const entryMirrorPath = mirror.entry.mirrorPath;
    const entryRelPath = mirror.entry.relPath;
    const mirrored = mirror.mirrored;
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
    // The entry keeps its place in the layout: a nested entry importing a
    // sibling emits "./helper.js", which only resolves from the same dir.
    return { ...entryResult, modules, entryPath: entryRelPath.replace(/\.agency$/, ".js") };
  });
}
