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
  /** Stable AG#### diagnostic code — suppress one line with
   *  `// @tc-ignore AG####`, or match on it programmatically instead of
   *  parsing the message. */
  code: string;
  severity: "error" | "warning";
  message: string;
  loc?: {
    line: number;
    col: number;
    start: number;
    end: number;
  };
  /** Structured payload of the diagnostic (the values that were rendered
   *  into the message, e.g. `expected` / `actual` type strings). */
  params: Record<string, string | number>;
};

export type TypeCheckReport = {
  errors: TypeCheckDiagnostic[];
  warnings: TypeCheckDiagnostic[];
};

type TypeCheckErrorShape = {
  code: string;
  message: string;
  severity: "error" | "warning";
  loc: TypeCheckDiagnostic["loc"] | null;
  params: Record<string, string | number>;
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
    code: err.code,
    severity: err.severity,
    message: err.message,
    // File-level diagnostics carry loc: null internally; the public shape
    // uses absence.
    loc: err.loc ?? undefined,
    params: err.params,
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
/** Shared parse→symbols→resolve→lift→build→check pipeline. Both
 * typeCheckSource and getEffectsFromSource consume this; keep the
 * security-relevant allowTestImports: false decision HERE, once. */
function runCheckerPipeline<T>(
  source: string,
  sourcePath: string | undefined,
  fn: (result: {
    checkResult: ReturnType<typeof typeCheck>;
    symbolTable: SymbolTable;
    syntheticPath: string;
  }) => T,
): T {
  const parseResult = parseAgency(source, {}, true);
  if (!parseResult.success) {
    throw new Error(parseResult.message ?? "Failed to parse Agency source");
  }
  const program: AgencyProgram = parseResult.result;

  return withSourcePath(source, sourcePath, (syntheticPath) => {
    const symbolTable = SymbolTable.build(syntheticPath, {});
    const reExported = resolveReExports(program, symbolTable, syntheticPath);
    // This pipeline is agent-reachable (std::agency typecheck/getEffects),
    // not just an editor path — so it must agree with execution: code that
    // run()/compileSource would reject should not check as valid. Deny
    // `import test` here; the LSP (lib/lsp/diagnostics.ts) independently
    // allows it for editor support.
    const resolved = resolveImports(reExported, symbolTable, syntheticPath, {
      allowTestImports: false,
    });
    const lifted = liftCallbackBlocks(resolved);
    const info = buildCompilationUnit(lifted, symbolTable, syntheticPath, source);
    const checkResult = typeCheck(lifted, { typechecker: { enabled: true } }, info);
    return fn({ checkResult, symbolTable, syntheticPath });
  });
}

export function typeCheckSource(
  source: string,
  sourcePath?: string,
): TypeCheckReport {
  return runCheckerPipeline(source, sourcePath, ({ checkResult }) => {
    // Partition into errors and warnings in a single pass. The only severity
    // values the type-checker emits are "error" and "warning" (see
    // lib/typeChecker/types.ts), so anything not "warning" is treated as
    // "error" by toDiagnostic's default.
    const out: TypeCheckReport = { errors: [], warnings: [] };
    for (const err of checkResult.errors) {
      const d = toDiagnostic(err);
      (d.severity === "warning" ? out.warnings : out.errors).push(d);
    }
    return out;
  });
}

export type EffectsByExport = Record<string, string[]>;

/**
 * Map each EXPORTED node/function in `source` to the transitive list of
 * interrupt effects it can raise. Reads the propagated map typeCheck
 * returns (same data raises-checking enforces — see lib/cli/policy.ts
 * for the precedent). Bare `interrupt(...)` sites surface as the
 * "unknown" sentinel — the envelope is fail-closed by design. Type
 * errors in `source` do not prevent extraction; parse failures throw.
 */
export function getEffectsFromSource(source: string): EffectsByExport {
  return runCheckerPipeline(source, undefined, ({ checkResult, symbolTable, syntheticPath }) => {
    const { interruptEffectsByFunction } = checkResult;
    const out: EffectsByExport = {};
    const fileSymbols = symbolTable.getFile(syntheticPath) ?? {};
    for (const [name, sym] of Object.entries(fileSymbols)) {
      const isCallable = sym.kind === "function" || sym.kind === "node";
      if (!isCallable || !sym.exported) continue;
      const names = (interruptEffectsByFunction[name] ?? []).map((e) => e.effect);
      out[name] = names.filter((n, i) => names.indexOf(n) === i).sort();
    }
    return out;
  });
}
