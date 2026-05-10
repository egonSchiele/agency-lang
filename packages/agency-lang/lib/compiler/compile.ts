/**
 * Pure compilation pipeline for Agency source strings.
 * No process.exit(), no console.log(). Returns errors as data.
 */
import { AgencyConfig } from "@/config.js";
import { AgencyProgram, generateTypeScript } from "@/index.js";
import { resolveImports } from "@/preprocessors/importResolver.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { SymbolTable } from "@/symbolTable.js";
import { formatErrors, typeCheck } from "@/typeChecker/index.js";
import { transformSync } from "esbuild";
import { nanoid } from "nanoid";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseAgency } from "@/parser.js";
import {
  isStdlibImport,
  isPkgImport,
} from "../importPaths.js";
import { CompileStrategy } from "../importStrategy.js";
import { getAllImports } from "../cli/util.js";

type CompileSuccess = {
  success: true;
  code: string;
  moduleId: string;
};

type CompileFailure = {
  success: false;
  errors: string[];
};

export type CompileResult = CompileSuccess | CompileFailure;

// Options accepted by compileSource. Mostly the standard AgencyConfig that
// the rest of the pipeline takes, plus one compileSource-specific knob:
// `restrictImports`. We keep `restrictImports` out of the global AgencyConfig
// because it's only meaningful at this entry point — used when compiling
// agent-supplied source destined for subprocess execution.
export type CompileSourceOptions = AgencyConfig & {
  /** When true, reject every import that isn't a std:: import. This includes
   *  relative .agency files, pkg:: imports, and raw npm/Node modules
   *  (`fs`, `child_process`, etc.). Set by std::agency.compile so that the
   *  compiled subprocess code can only call into the standard library. */
  restrictImports?: boolean;
};

// Human-readable label for the kind of disallowed import. Used in error
// messages so the user knows whether they wrote an npm import, a pkg::
// import, or a path-based .agency import. Note: ".agency file import"
// covers both relative and absolute paths — we don't distinguish because
// both are equally rejected here.
function classifyImport(importPath: string): string {
  if (isPkgImport(importPath)) return "package import";
  if (importPath.endsWith(".agency")) return ".agency file import";
  return "npm/Node module import";
}

// Walk every import in the program and reject anything that isn't a std::
// import. Returns null if all imports pass, or a CompileFailure describing
// the offender.
//
// IMPORTANT: uses getAllImports (NOT getImports) so we see EVERY import,
// including raw npm/Node modules. getImports filters those out and would
// let `import fs from "fs"` slip past the check — that was the bug this
// helper exists to close.
function checkRestrictedImports(program: AgencyProgram): CompileFailure | null {
  for (const { path: importPath, kind } of getAllImports(program)) {
    if (kind === "node") {
      // `import nodes { ... }` always references another .agency file.
      // The path can be relative or absolute — we reject both forms here
      // since neither is a stdlib import.
      return {
        success: false,
        errors: [`Tool/node import '${importPath}' is not allowed when restrictImports is set. Only standard library (std::) imports are permitted.`],
      };
    }
    if (!isStdlibImport(importPath)) {
      const what = classifyImport(importPath);
      return {
        success: false,
        errors: [`${what} '${importPath}' is not allowed. Only standard library (std::) imports are permitted.`],
      };
    }
  }
  return null;
}

export function compileSource(
  source: string,
  config: CompileSourceOptions,
): CompileResult {
  const moduleId = `agency_${nanoid()}`;
  // Write source to a temp file so SymbolTable.build() can read it.
  // The symbol table walks the file system to resolve imports and find builtins.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-compile-"));
  const syntheticPath = path.join(tempDir, `${moduleId}.agency`);
  fs.writeFileSync(syntheticPath, source, "utf-8");

  try {
    // 1. Parse
    const parseResult = parseAgency(source, config, true);
    if (!parseResult.success) {
      return {
        success: false,
        errors: [parseResult.message ?? "Failed to parse Agency source"],
      };
    }
    const program: AgencyProgram = parseResult.result;

    // 2. Check for restricted imports — only std:: allowed.
    if (config.restrictImports) {
      const failure = checkRestrictedImports(program);
      if (failure) return failure;
    }

    // 3. Build symbol table and resolve imports
    const symbolTable = SymbolTable.build(syntheticPath, config);
    const resolvedProgram = resolveImports(program, symbolTable, syntheticPath);

    // 4. Build compilation unit
    const info = buildCompilationUnit(
      resolvedProgram,
      symbolTable,
      syntheticPath,
      source,
    );

    // 5. Type check
    if (config.typeCheck || config.typeCheckStrict) {
      const { errors } = typeCheck(resolvedProgram, config, info);
      if (errors.length > 0) {
        const hasFatal = errors.some(
          (e) => (e.severity ?? "error") === "error",
        );
        if (hasFatal) {
          return {
            success: false,
            errors: [formatErrors(errors)],
          };
        }
      }
    }

    // 6. Rewrite import paths
    const strategy = new CompileStrategy({ targetExt: ".js" });
    resolvedProgram.nodes.forEach((node) => {
      if (node.type !== "importStatement") return;
      if (isStdlibImport(node.modulePath) || isPkgImport(node.modulePath))
        return;
      node.modulePath = strategy.rewriteImport(
        node.modulePath,
        syntheticPath,
      );
    });

    // 7. Generate TypeScript
    const outputPath = path.join(os.tmpdir(), `${moduleId}.js`);
    const generatedCode = generateTypeScript(
      resolvedProgram,
      config,
      info,
      moduleId,
      outputPath,
    );

    // 8. Transpile TS → JS
    const result = transformSync(generatedCode, {
      loader: "ts",
      format: "esm",
      supported: { "top-level-await": true },
    });

    return {
      success: true,
      code: result.code,
      moduleId,
    };
  } catch (error) {
    return {
      success: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  } finally {
    // Clean up temp source file (best-effort — OS cleans tmpdir eventually)
    if (tempDir.startsWith(os.tmpdir())) {
      try {
        fs.rmSync(tempDir, { recursive: true });
      } catch (_) {
        // Ignore cleanup failures — temp files in os.tmpdir() are ephemeral
      }
    }
  }
}
