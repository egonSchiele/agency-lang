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
import { expandSplices } from "@/preprocessors/expandSplices.js";
import { formatSpliceDiagnostic } from "./splice/report.js";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { SymbolTable } from "@/symbolTable.js";
import { formatErrors, typeCheck } from "@/typeChecker/index.js";
import { buildCompiledClosure, CompileClosureError } from "./compileClosure.js";
import { transformSync } from "esbuild";
import { nanoid } from "nanoid";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseAgency } from "@/parser.js";
import { ImportPolicy, isImportAllowed, isStdlibImport, isPkgImport } from "../importPaths.js";
import { CompileStrategy } from "../importStrategy.js";
import { getAllImports } from "@/analysis/imports.js";

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
  /**
   * Real on-disk path of the file to compile. Given it, `compileSource` compiles
   * at that path — where sibling `.agency` files live — so relative imports
   * resolve. Without it, `source` is written to an isolated temp file, so
   * relative imports cannot resolve (single-file compile). A host that stores
   * multi-file agents on disk passes this to compile each file against its real
   * neighbors.
   *
   * When set, the file at this path is authoritative: it is parsed AND used for
   * symbol/import resolution, so the two can't diverge. The `source` argument is
   * ignored (pass the file's contents for clarity, but the disk file wins).
   */
  sourcePath?: string;
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
function checkImportPolicy(program: AgencyProgram, policy: ImportPolicy): CompileFailure | null {
  const violations: string[] = [];
  // getAllImports surfaces both `importStatement` and the deprecated
  // `import nodes { ... }` form. importKind() already classifies any
  // path ending in `.agency` as "local", so we can pass paths through
  // unchanged regardless of which import form they came from.
  for (const { path: importPath } of getAllImports(program)) {
    if (!isImportAllowed(importPath, policy)) {
      violations.push(`Import '${importPath}' is not allowed under the configured import policy.`);
    }
  }
  if (violations.length === 0) return null;
  return { success: false, errors: violations };
}

export { typeCheckSource, getEffectsFromSource } from "./typecheck.js";
export type { TypeCheckDiagnostic, TypeCheckReport } from "./typecheck.js";

export function compileSource(source: string, config: CompileSourceOptions): CompileResult {
  const moduleId = `agency_${nanoid()}`;
  // SymbolTable.build() walks the file system from the source's path to resolve
  // imports. With a caller-supplied sourcePath (the file is already on disk
  // beside its siblings), compile at that path so relative `.agency` imports
  // resolve. Otherwise write to an isolated temp file — relative imports cannot
  // resolve there, by design (single-file compile).
  let tempDir: string | undefined;
  let syntheticPath: string;
  if (config.sourcePath) {
    syntheticPath = config.sourcePath;
  } else {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-compile-"));
    syntheticPath = path.join(tempDir, `${moduleId}.agency`);
    fs.writeFileSync(syntheticPath, source, "utf-8");
  }

  // The file at `syntheticPath` is the single source of truth: SymbolTable.build
  // and buildCompiledClosure read the entrypoint and its imports from there, so
  // parse the SAME bytes rather than the passed `source`. In the temp-file case
  // that file IS `source` (just written); with a caller `sourcePath` this reads
  // the on-disk file, so the AST and symbol/import resolution can't diverge.
  const compiledSource = config.sourcePath ? fs.readFileSync(syntheticPath, "utf-8") : source;

  try {
    // 1. Parse
    const parseResult = parseAgency(compiledSource, config, true);
    if (!parseResult.success) {
      return {
        success: false,
        errors: [parseResult.message ?? "Failed to parse Agency source"],
      };
    }
    const parsedProgram: AgencyProgram = parseResult.result;

    // 2. Check imports against policy.
    if (config.imports) {
      const failure = checkImportPolicy(parsedProgram, config.imports);
      if (failure) return failure;
    }

    // 2b. Expand compile-time splices. After the policy check, since the
    // policy judges what the author wrote. Before everything else, since
    // generated declarations must reach the symbol table.
    const expanded = expandSplices(parsedProgram, syntheticPath, config);
    if (!expanded.ok) {
      return {
        success: false,
        errors: [formatSpliceDiagnostic(expanded.diagnostic, syntheticPath)],
      };
    }
    const program = expanded.value;

    // 2c. Re-check the policy against the EXPANDED program. A generator can
    // emit its own import lines, and those never went through the check
    // above. Checking twice is deliberate: the first pass refuses
    // disallowed source without running a generator at all, and this one
    // covers what the generator added.
    if (config.imports) {
      const failure = checkImportPolicy(program, config.imports);
      if (failure) return failure;
    }

    // 3. Build symbol table and resolve imports
    const symbolTable = SymbolTable.build(syntheticPath, config);
    const reExportedProgram = resolveReExports(program, symbolTable, syntheticPath);
    // Sandbox trust boundary: compileSource compiles agent-authored source
    // for the run() subprocess sandbox and must NEVER honor `import test`.
    const resolvedProgram = resolveImports(reExportedProgram, symbolTable, syntheticPath, {
      allowTestImports: false,
    });

    // 3a. Lift `callback("onX") { ... }` block bodies to top-level defs.
    // Must run BEFORE buildCompilationUnit (so lifted defs appear in
    // functionDefinitions) and BEFORE typecheck (so undefined-variable
    // diagnostics catch captures of enclosing locals).
    const liftedProgram = liftCallbackBlocks(resolvedProgram);

    // 4. Build compilation unit
    const info = buildCompilationUnit(liftedProgram, symbolTable, syntheticPath, compiledSource);

    // 5. Type check
    if (config.typechecker?.enabled || config.typechecker?.strict) {
      const { errors } = typeCheck(liftedProgram, config, info);
      if (errors.length > 0) {
        const hasFatal = errors.some((e) => e.severity === "error");
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
      if (isStdlibImport(node.modulePath) || isPkgImport(node.modulePath)) return;
      node.modulePath = strategy.rewriteImport(node.modulePath, syntheticPath);
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
    // Clean up temp source file (best-effort — OS cleans tmpdir eventually).
    // Skipped when compiling at a caller-owned sourcePath (no temp dir created).
    if (tempDir && tempDir.startsWith(os.tmpdir())) {
      try {
        fs.rmSync(tempDir, { recursive: true });
      } catch (_) {
        // Ignore cleanup failures — temp files in os.tmpdir() are ephemeral
      }
    }
  }
}
