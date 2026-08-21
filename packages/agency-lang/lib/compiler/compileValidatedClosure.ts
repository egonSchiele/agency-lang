/**
 * Compiles a ValidatedClosure from a private mirror of its validated bytes.
 *
 * The TOCTOU boundary this file owns: compilation must consume exactly what
 * the validator read. Local files are therefore written to a fresh private
 * mirror and every local import is rewritten to name its mirrored target, so
 * `compileSource` can never follow an absolute path or symlink alias back
 * into the caller's directory. `pkg::` files are the one documented re-read
 * boundary: they resolve from node_modules at compile time, which is
 * already-trusted executable content (whoever can write it can write this
 * process's own JS), unlike caller-owned directories.
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
    const mirrored: { moduleId: string; relPath: string; source: string; mirrorPath: string }[] =
      [];
    for (const [moduleId, mod] of Object.entries(data.modules)) {
      const rewritten = rewriteLocalImports(moduleId, mod.source, data);
      if (!rewritten.ok) {
        return { success: false, errors: [rewritten.error] };
      }
      const target = path.join(mirrorRoot, ...mod.relPath.split(path.posix.sep));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, rewritten.source, "utf-8");
      if (moduleId === data.entryModuleId) {
        entrySource = rewritten.source;
        entryMirrorPath = target;
      } else {
        mirrored.push({ moduleId, relPath: mod.relPath, source: rewritten.source, mirrorPath: target });
      }
    }
    if (entryMirrorPath === "") {
      return { success: false, errors: ["internal: validated closure has no entry module"] };
    }
    const sandboxOptions = {
      typechecker: { enabled: true },
      // Belt on top of validation: the mirror contains only validated
      // content, but keep the policy on so a regression fails closed.
      imports: { allowKinds: ["stdlib", "local", "pkg"] as ImportKind[] },
    };
    const entryResult = compileSource(entrySource, {
      ...sandboxOptions,
      sourcePath: entryMirrorPath,
    });
    if (!entryResult.success) return entryResult;
    // The entry's generated JS imports each local module by its rewritten
    // relative path ("./helper.js"), so every module in the closure must be
    // compiled and carried in the result — the runtime materializes them
    // beside the entry script at fork time.
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

type RewriteOutcome = { ok: true; source: string } | { ok: false; error: string };

/** Splice each local import's path (and its quotes) with a mirror-relative
 *  path, back-to-front so earlier offsets stay valid. Only parser-recorded
 *  module-path bytes change. The quote delimiter is re-chosen per import:
 *  whichever quote the rewritten path does not contain (the lexer has no
 *  escape sequences inside path strings, so a path containing both quote
 *  characters cannot be represented and fails closed). */
function rewriteLocalImports(
  moduleId: string,
  source: string,
  data: ReturnType<typeof openValidatedClosure>,
): RewriteOutcome {
  const edges = data.localEdges
    .filter((e) => e.fromModuleId === moduleId)
    .sort((a, b) => b.modulePathLoc.start - a.modulePathLoc.start);
  let out = source;
  const fromRel = data.modules[moduleId].relPath;
  const fromDir = path.posix.dirname(fromRel);
  for (const edge of edges) {
    const toRel = data.modules[edge.toModuleId].relPath;
    let relative = path.posix.relative(fromDir === "." ? "" : fromDir, toRel);
    if (!relative.startsWith(".")) relative = `./${relative}`;
    const delimiter = pickDelimiter(relative);
    if (delimiter === null) {
      return {
        ok: false,
        error:
          `cannot rewrite import '${edge.importPath}': the mirrored path '${relative}' ` +
          "contains both quote characters, which an Agency import path cannot represent",
      };
    }
    const start = edge.modulePathLoc.start - 1; // opening quote
    const end = edge.modulePathLoc.end + 1; // closing quote
    out = out.slice(0, start) + delimiter + relative + delimiter + out.slice(end);
  }
  return { ok: true, source: out };
}

function pickDelimiter(pathText: string): string | null {
  if (!pathText.includes('"')) return '"';
  if (!pathText.includes("'")) return "'";
  return null;
}
