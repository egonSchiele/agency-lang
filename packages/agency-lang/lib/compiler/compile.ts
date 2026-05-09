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
import { getImports } from "../cli/util.js";

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

export function compileSource(
  source: string,
  config: AgencyConfig,
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

    // 2. Check for restricted imports — only stdlib allowed
    if (config.restrictImports) {
      const imports = getImports(program);
      for (const importPath of imports) {
        if (!isStdlibImport(importPath)) {
          return {
            success: false,
            errors: [`Import '${importPath}' is not allowed. Only standard library (std::) imports are permitted.`],
          };
        }
      }
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
