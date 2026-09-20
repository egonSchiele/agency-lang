/**
 * The one pipeline from Agency source text to a `CompilationUnit`.
 *
 * Every path that checks names goes through here, so a new step is added
 * once. Callers differ only through `PrepareOptions`; see
 * docs/dev/compiler/prepare-program.md.
 */
import type { AgencyConfig } from "@/config/config.js";
import type { AgencyProgram } from "@/types.js";
import type { ImportStatement } from "@/types/importStatement.js";
import { buildCompilationUnit, type CompilationUnit } from "@/compilationUnit.js";
import { resolveAgencyImportPath } from "@/importPaths.js";
import { parseAgency, type ParseAgencyErrorData } from "@/parser.js";
import { PRELUDE_NAMES } from "@/prelude.js";
import { expandSplices } from "@/preprocessors/expandSplices.js";
import { resolveImports } from "@/preprocessors/importResolver.js";
import { liftCallbackBlocks } from "@/preprocessors/liftCallbacks.js";
import { prunePreludeShadows } from "@/preprocessors/prunePreludeShadows.js";
import { resolveReExports } from "@/preprocessors/resolveReExports.js";
import { SymbolTable } from "@/symbolTable.js";
import { formatSpliceDiagnostic } from "./splice/report.js";
import type { SpliceDiagnostic } from "./splice/types.js";

export type ParseFailure = {
  stage: "parse";
  message: string;
  errorData?: ParseAgencyErrorData;
};

/** `vet` refused the program. */
export type VetFailure = { stage: "vet"; message: string };

export type SpliceFailure = { stage: "splice"; splice: SpliceDiagnostic };

/** A failed symbol table build, re-export, or import. `error` is the value
 *  that was thrown, so a caller that wants the old throw can rethrow it. */
export type ImportFailure = { stage: "imports"; error: unknown };

export type PipelineDiagnostic = ParseFailure | VetFailure | SpliceFailure | ImportFailure;

export type PrepareOptions = {
  /** Prepend the prelude import to the text before parsing. The editor
   *  passes false so positions match the buffer; the prelude import is then
   *  added to the parsed program instead. Default true. */
  applyTemplate?: boolean;
  /** Honor `import test { ... }`. Only the editor and the test runner may;
   *  anything that compiles code to run it must not. Default false. */
  allowTestImports?: boolean;
  /** Continue past a splice that will not expand or an import that will not
   *  resolve, so the rest of the file is still checked. An editor and the
   *  analysis commands want this. A build does not. Default false. */
  keepGoing?: boolean;
  /** The editor uses a shorter limit than the build. */
  spliceWallClockMs?: number;
  /** A table the caller already built, for example one shared across files. */
  symbolTable?: SymbolTable;
  /** Reasons to refuse this program, or none. Runs on the program as written,
   *  before any generator does, and again once splices have expanded,
   *  because a generator can emit imports of its own. */
  vet?: (program: AgencyProgram) => string[];
};

export type PreparedProgram = {
  ok: true;
  program: AgencyProgram;
  info: CompilationUnit;
  symbolTable: SymbolTable;
  /** The parse as written, before any step rewrote it. The linter reads this. */
  parsed: AgencyProgram;
  /** Empty unless `keepGoing` let the pipeline past a failure. */
  diagnostics: PipelineDiagnostic[];
};

export type PrepareFailure = { ok: false; diagnostics: PipelineDiagnostic[] };

export type PrepareResult = PreparedProgram | PrepareFailure;

/** The import the parser template prepends, as a node. Both render
 *  PRELUDE_NAMES, so the editor and the compiler agree on what is in scope.
 *  Added next to any `std::index` import the user wrote, since theirs may
 *  name only a subset. Skipped when the table has no std::index loaded:
 *  every prelude name would then report as undefined. */
function withPreludeImport(
  program: AgencyProgram,
  symbolTable: SymbolTable,
  filePath: string,
): AgencyProgram {
  let stdlibPath: string;
  try {
    stdlibPath = resolveAgencyImportPath("std::index", filePath);
  } catch {
    // No stdlib to resolve against, so there is no prelude to import.
    return program;
  }
  if (!symbolTable.has(stdlibPath)) {
    return program;
  }
  const prelude: ImportStatement = {
    type: "importStatement",
    importedNames: [{ type: "namedImport", importedNames: [...PRELUDE_NAMES], aliases: {} }],
    modulePath: "std::index",
    isAgencyImport: true,
  };
  return { ...program, nodes: [prelude, ...program.nodes] };
}

/** prunePreludeShadows edits `std::index` imports in place, including ones
 *  the user wrote. Copying those few nodes keeps `parsed` as written. */
function withOwnPreludeImports(program: AgencyProgram): AgencyProgram {
  const nodes = program.nodes.map((node) =>
    node.type === "importStatement" && node.modulePath === "std::index"
      ? structuredClone(node)
      : node,
  );
  return { ...program, nodes };
}

export function prepareProgram(
  source: string,
  filePath: string,
  config: AgencyConfig,
  options: PrepareOptions = {},
): PrepareResult {
  const applyTemplate = options.applyTemplate ?? true;
  const keepGoing = options.keepGoing ?? false;
  const vet = options.vet ?? (() => []);
  const diagnostics: PipelineDiagnostic[] = [];
  const failed = (diagnostic: PipelineDiagnostic): PrepareFailure => ({
    ok: false,
    diagnostics: [...diagnostics, diagnostic],
  });
  const refusals = (program: AgencyProgram): VetFailure[] =>
    vet(program).map((message) => ({ stage: "vet", message }));

  const parseResult = parseAgency(source, config, applyTemplate);
  if (!parseResult.success) {
    return failed({
      stage: "parse",
      message: parseResult.message ?? "Failed to parse Agency source",
      errorData: parseResult.errorData,
    });
  }
  const parsed = parseResult.result;

  const refusedAsWritten = refusals(parsed);
  if (refusedAsWritten.length > 0) {
    return { ok: false, diagnostics: refusedAsWritten };
  }

  let symbolTable: SymbolTable;
  try {
    symbolTable = options.symbolTable ?? SymbolTable.build(filePath, config);
  } catch (error) {
    return failed({ stage: "imports", error });
  }

  // Splices first: the declarations a generator returns must be in the
  // program before anything looks names up in it.
  const spliced = expandSplices(parsed, filePath, config, {
    symbolTable,
    wallClockMs: options.spliceWallClockMs,
  });
  if (!spliced.ok) {
    const failure: SpliceFailure = { stage: "splice", splice: spliced.diagnostic };
    if (!keepGoing) {
      return failed(failure);
    }
    diagnostics.push(failure);
  }
  const expanded = spliced.ok ? spliced.value : parsed;

  const refusedExpanded = refusals(expanded);
  if (refusedExpanded.length > 0) {
    return { ok: false, diagnostics: [...diagnostics, ...refusedExpanded] };
  }

  const withPrelude = applyTemplate ? expanded : withPreludeImport(expanded, symbolTable, filePath);
  // A file may declare its own `map` or `print`. The build drops that name
  // from the prelude import; doing it here keeps the checker from reporting
  // a clash the build has already settled.
  const pruned = withOwnPreludeImports(withPrelude);
  prunePreludeShadows(pruned);

  let reExported: AgencyProgram;
  try {
    reExported = resolveReExports(pruned, symbolTable, filePath);
  } catch (error) {
    // A bad re-export (a cycle, say) leaves no usable module graph, so this
    // stops even under keepGoing.
    return failed({ stage: "imports", error });
  }

  let resolved = reExported;
  try {
    resolved = resolveImports(reExported, symbolTable, filePath, {
      allowTestImports: options.allowTestImports ?? false,
      onUnresolvable: keepGoing
        ? (error) => diagnostics.push({ stage: "imports", error })
        : undefined,
    });
  } catch (error) {
    if (!keepGoing) {
      return failed({ stage: "imports", error });
    }
    // Keep the program with its imports unresolved: one bad import must
    // not blank every other diagnostic in the file.
    diagnostics.push({ stage: "imports", error });
  }

  // Lifting makes each `callback("onX") { ... }` body a top-level def, so it
  // lands in the compilation unit and is checked like any other function.
  const program = liftCallbackBlocks(resolved);
  const info = buildCompilationUnit(program, symbolTable, filePath, source);
  return { ok: true, program, info, symbolTable, parsed, diagnostics };
}

/** Rethrow what an "imports" failure caught. For callers whose contract is
 *  that a bad import throws. */
export function throwImportFailures(diagnostics: PipelineDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.stage === "imports") {
      throw diagnostic.error;
    }
  }
}

/** One failure as a line of text, for callers that report errors as strings. */
export function describeDiagnostic(found: PipelineDiagnostic, filePath: string): string {
  if (found.stage === "splice") {
    return formatSpliceDiagnostic(found.splice, filePath);
  }
  if (found.stage === "imports") {
    return found.error instanceof Error ? found.error.message : String(found.error);
  }
  return found.message;
}
