/**
 * Pure type-checking entry point for Agency source strings.
 * Returns diagnostics as data — never calls process.exit() or console.log().
 */
import { AgencyProgram } from "@/index.js";
import { resolveImports } from "@/preprocessors/importResolver.js";
import { resolveReExports } from "@/preprocessors/resolveReExports.js";
import { liftCallbackBlocks } from "@/preprocessors/liftCallbacks.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { SymbolTable } from "@/symbolTable.js";
import { typeCheck } from "@/typeChecker/index.js";
import { nanoid } from "nanoid";
import * as fs from "fs";
import * as path from "path";
import { parseAgency } from "@/parser.js";
import { safeDeleteDirectory } from "../utils.js";

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

type TypeCheckErrorShape = {
  message: string;
  severity?: "error" | "warning";
  loc?: TypeCheckDiagnostic["loc"];
  variableName?: string;
  expectedType?: string;
  actualType?: string;
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
  // Place the tempdir under cwd's .agency-tmp/ (same location _run's
  // materializeCompiledScript uses) so safeDeleteDirectory's project-containment check
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
    const lifted = liftCallbackBlocks(resolved);
    const info = buildCompilationUnit(lifted, symbolTable, syntheticPath, source);
    const { errors } = typeCheck(lifted, { typechecker: { enabled: true } }, info);

    // Partition into errors and warnings in a single pass. The only severity
    // values the type-checker emits are "error" and "warning" (see
    // lib/typeChecker/types.ts), so anything not "warning" is treated as
    // "error" by toDiagnostic's default.
    const out: TypeCheckReport = { errors: [], warnings: [] };
    for (const err of errors) {
      const d = toDiagnostic(err);
      (d.severity === "warning" ? out.warnings : out.errors).push(d);
    }
    return out;
  });
}
