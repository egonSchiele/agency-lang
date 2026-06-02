/**
 * Pure compilation pipeline for Agency source strings.
 * No process.exit(), no console.log(). Returns errors as data.
 */
import { AgencyConfig } from "@/config.js";
import { AgencyProgram, generateTypeScript } from "@/index.js";
import { initPlanForModule } from "@/backends/typescriptGenerator.js";
import { resolveImports } from "@/preprocessors/importResolver.js";
import { resolveReExports } from "@/preprocessors/resolveReExports.js";
import { liftCallbackBlocks } from "@/preprocessors/liftCallbacks.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { SymbolTable } from "@/symbolTable.js";
import { formatErrors, typeCheck } from "@/typeChecker/index.js";
import {
  buildCompiledClosure,
  CompileClosureError,
} from "./compileClosure.js";
import { transformSync } from "esbuild";
import { nanoid } from "nanoid";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseAgency } from "@/parser.js";
import {
  ImportPolicy,
  isImportAllowed,
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
// `imports`. We keep `imports` out of the global AgencyConfig because it's
// only meaningful at this entry point — used when compiling
// agent-supplied source destined for subprocess execution.
export type CompileSourceOptions = AgencyConfig & {
  /**
   * Declarative import policy. Disallowed imports cause compilation to
   * fail with one error per violating import path.
   * See `lib/importPaths.ts` for the ImportPolicy shape.
   */
  imports?: ImportPolicy;
};

// Walk every import in the program and reject anything that fails the
// policy. Returns null if all imports pass, or a CompileFailure listing
// every violating import (not just the first).
//
// IMPORTANT: uses getAllImports (NOT getImports) so we see EVERY import,
// including raw npm/Node modules. getImports filters those out and would
// let `import fs from "fs"` slip past the check — that was the bug this
// check exists to close.
//
// `import nodes { ... }` (deprecated) is reported with kind "node" by
// getAllImports — but to the policy that's a "local" import because it
// always references another .agency file. Classify it that way so a
// `allowKinds: ["stdlib"]` policy still rejects it (the legacy behavior).
function checkImportPolicy(
  program: AgencyProgram,
  policy: ImportPolicy,
): CompileFailure | null {
  const violations: string[] = [];
  // getAllImports surfaces both `importStatement` and the deprecated
  // `import nodes { ... }` form. importKind() already classifies any
  // path ending in `.agency` as "local", so we can pass paths through
  // unchanged regardless of which import form they came from.
  for (const { path: importPath } of getAllImports(program)) {
    if (!isImportAllowed(importPath, policy)) {
      violations.push(
        `Import '${importPath}' is not allowed under the configured import policy.`,
      );
    }
  }
  if (violations.length === 0) return null;
  return { success: false, errors: violations };
}

export { typeCheckSource } from "./typecheck.js";
export type { TypeCheckDiagnostic, TypeCheckReport } from "./typecheck.js";

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

    // 2. Check imports against policy.
    if (config.imports) {
      const failure = checkImportPolicy(program, config.imports);
      if (failure) return failure;
    }

    // 3. Build symbol table and resolve imports
    const symbolTable = SymbolTable.build(syntheticPath, config);
    const reExportedProgram = resolveReExports(program, symbolTable, syntheticPath);
    const resolvedProgram = resolveImports(reExportedProgram, symbolTable, syntheticPath);

    // 3a. Lift `callback("onX") { ... }` block bodies to top-level defs.
    // Must run BEFORE buildCompilationUnit (so lifted defs appear in
    // functionDefinitions) and BEFORE typecheck (so undefined-variable
    // diagnostics catch captures of enclosing locals).
    const liftedProgram = liftCallbackBlocks(resolvedProgram);

    // 4. Build compilation unit
    const info = buildCompilationUnit(
      liftedProgram,
      symbolTable,
      syntheticPath,
      source,
    );

    // 5. Type check
    if (config.typechecker?.enabled || config.typechecker?.strict) {
      const { errors } = typeCheck(liftedProgram, config, info);
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
    liftedProgram.nodes.forEach((node) => {
      if (node.type !== "importStatement") return;
      if (isStdlibImport(node.modulePath) || isPkgImport(node.modulePath))
        return;
      node.modulePath = strategy.rewriteImport(
        node.modulePath,
        syntheticPath,
      );
    });

    // 6b. Build the closure analysis to detect cycles + populate the
    // per-module init plan (topsort ordering + cross-module awaits).
    // CompileClosureError surfaces as a `CompileFailure` per this
    // module's contract — no `process.exit`.
    let closure;
    try {
      closure = buildCompiledClosure(syntheticPath, config);
    } catch (e) {
      if (e instanceof CompileClosureError) {
        return { success: false, errors: [e.message] };
      }
      throw e;
    }

    // 7. Generate TypeScript
    const outputPath = path.join(os.tmpdir(), `${moduleId}.js`);
    const initPlan = initPlanForModule(closure, syntheticPath);
    const generatedCode = generateTypeScript(
      liftedProgram,
      config,
      info,
      moduleId,
      outputPath,
      initPlan,
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
