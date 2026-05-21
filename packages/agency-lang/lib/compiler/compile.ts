/**
 * Pure compilation pipeline for Agency source strings.
 * No process.exit(), no console.log(). Returns errors as data.
 */
import { AgencyConfig } from "@/config.js";
import { AgencyProgram, generateTypeScript } from "@/index.js";
import { resolveImports } from "@/preprocessors/importResolver.js";
import { resolveReExports } from "@/preprocessors/resolveReExports.js";
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
  ImportPolicy,
  isImportAllowed,
  isStdlibImport,
  isPkgImport,
} from "../importPaths.js";
import { CompileStrategy } from "../importStrategy.js";
import { getAllImports } from "../cli/util.js";
import { safeDeleteDirectory } from "../utils.js";

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
  /**
   * @deprecated Use `imports: { allowKinds: ["stdlib"] }` instead.
   * When true, reject every import that isn't a std:: import. This is
   * exactly equivalent to passing `imports: { allowKinds: ["stdlib"] }`.
   */
  restrictImports?: boolean;
  /**
   * Declarative import policy. Disallowed imports cause compilation to
   * fail with one error per violating import path.
   * See `lib/importPaths.ts` for the ImportPolicy shape.
   */
  imports?: ImportPolicy;
};

// Resolve the effective import policy from the (possibly-legacy) options.
// `restrictImports: true` is sugar for `{ allowKinds: ["stdlib"] }`.
// Passing both is a configuration error — fail loudly so callers don't
// accidentally trust the wrong one.
function resolveImportPolicy(config: CompileSourceOptions): ImportPolicy | null {
  if (config.imports && config.restrictImports) {
    throw new Error(
      "compileSource: pass either `imports` or `restrictImports`, not both. " +
        "`restrictImports` is the deprecated shorthand for " +
        "`imports: { allowKinds: ['stdlib'] }`.",
    );
  }
  if (config.imports) return config.imports;
  if (config.restrictImports) return { allowKinds: ["stdlib"] };
  return null;
}

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
  for (const { path: importPath, kind } of getAllImports(program)) {
    // For the deprecated `import nodes { ... }` form, treat the path
    // (which always points to a .agency file) as a local import so the
    // policy classifier handles it the same way as `import x from "./y.agency"`.
    const allowed =
      kind === "node"
        ? isImportAllowed(`./${importPath}`, policy)
        : isImportAllowed(importPath, policy);
    if (!allowed) {
      violations.push(
        `Import '${importPath}' is not allowed under the configured import policy.`,
      );
    }
  }
  if (violations.length === 0) return null;
  return { success: false, errors: violations };
}

export type TypeCheckDiagnostic = {
  severity: "error" | "warning";
  message: string;
  loc?: {
    line: number;
    col: number;
    start: number;
    end: number;
  };
  variableName?: string;
  expectedType?: string;
  actualType?: string;
};

export type TypeCheckReport = {
  errors: TypeCheckDiagnostic[];
  warnings: TypeCheckDiagnostic[];
};

// Provide a path the symbol table can use to resolve relative imports.
// If `sourcePath` is supplied we use it directly; otherwise we synthesize
// one in a tempdir that's cleaned up after `fn` returns. Used by
// typeCheckSource — separates "where does this source live on disk" from
// "what do we do once it's there."
function withSourcePath<T>(
  source: string,
  sourcePath: string | undefined,
  fn: (syntheticPath: string) => T,
): T {
  if (sourcePath) return fn(sourcePath);
  // Place the tempdir under cwd's .agency-tmp/ (same pattern as
  // compileAndPersist) so safeDeleteDirectory's project-containment check
  // accepts it on cleanup. os.tmpdir() would be outside the project.
  const moduleId = `agency_${nanoid()}`;
  const tempDir = path.join(process.cwd(), ".agency-tmp", `typecheck-${nanoid()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const syntheticPath = path.join(tempDir, `${moduleId}.agency`);
  fs.writeFileSync(syntheticPath, source, "utf-8");
  try {
    return fn(syntheticPath);
  } finally {
    safeDeleteDirectory(tempDir, false);
  }
}

function toDiagnostic(err: TypeCheckErrorShape): TypeCheckDiagnostic {
  return {
    severity: err.severity ?? "error",
    message: err.message,
    loc: err.loc,
    variableName: err.variableName,
    expectedType: err.expectedType,
    actualType: err.actualType,
  };
}

type TypeCheckErrorShape = {
  message: string;
  severity?: "error" | "warning";
  loc?: TypeCheckDiagnostic["loc"];
  variableName?: string;
  expectedType?: string;
  actualType?: string;
};

// Run parse → symbol table → import resolution → type check over a source
// string and return diagnostics. Errors thrown here (parse failure, import
// resolution failure) propagate to the caller — they signal "we couldn't
// type-check this", as opposed to "we type-checked it and found problems",
// which is what the returned report represents.
//
// If `sourcePath` is supplied, it's used as the synthetic file path the
// symbol table sees — letting relative imports in `source` resolve against
// that directory. Otherwise a fresh tempdir is used and relative imports
// will not resolve.
export function typeCheckSource(
  source: string,
  sourcePath?: string,
): TypeCheckReport {
  const parseResult = parseAgency(source, {}, true);
  if (!parseResult.success) {
    throw new Error(parseResult.message ?? "Failed to parse Agency source");
  }
  const program: AgencyProgram = parseResult.result;

  return withSourcePath(source, sourcePath, (syntheticPath) => {
    const symbolTable = SymbolTable.build(syntheticPath, {});
    const reExported = resolveReExports(program, symbolTable, syntheticPath);
    const resolved = resolveImports(reExported, symbolTable, syntheticPath);
    const info = buildCompilationUnit(resolved, symbolTable, syntheticPath, source);
    const { errors } = typeCheck(resolved, { typechecker: { enabled: true } }, info);

    const diagnostics = errors.map(toDiagnostic);
    return {
      errors: diagnostics.filter((d) => d.severity === "error"),
      warnings: diagnostics.filter((d) => d.severity === "warning"),
    };
  });
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

    // 2. Check imports against policy.
    const policy = resolveImportPolicy(config);
    if (policy) {
      const failure = checkImportPolicy(program, policy);
      if (failure) return failure;
    }

    // 3. Build symbol table and resolve imports
    const symbolTable = SymbolTable.build(syntheticPath, config);
    const reExportedProgram = resolveReExports(program, symbolTable, syntheticPath);
    const resolvedProgram = resolveImports(reExportedProgram, symbolTable, syntheticPath);

    // 4. Build compilation unit
    const info = buildCompilationUnit(
      resolvedProgram,
      symbolTable,
      syntheticPath,
      source,
    );

    // 5. Type check
    if (config.typechecker?.enabled || config.typechecker?.strict) {
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
