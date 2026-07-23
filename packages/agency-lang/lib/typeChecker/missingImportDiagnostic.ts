import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";
import type { SourceLocation } from "../types/base.js";
import type { AgencyNode } from "../types.js";
import { isExportedSymbol } from "../symbolTable.js";

/** A plain Agency import, normalized so the checker doesn't care which node
 *  kind it came from. */
type ImportSpec = {
  modulePath: string;
  names: readonly string[];
  loc: SourceLocation | null;
  // `import test { ... }` may see non-exported symbols (first-party test wiring),
  // so it bypasses the export-visibility check — matching the importResolver
  // preprocessor's `assertImportable`.
  testOnly: boolean;
};

/**
 * The "what": which plain Agency imports to check, and the names each brings in.
 * Returns null for anything out of scope (JS imports, non-import nodes). Keeps
 * the per-node-kind field access (the "how") in one place.
 */
function toImportSpec(node: AgencyNode): ImportSpec | null {
  if (node.type === "importStatement" && node.isAgencyImport) {
    const names = node.importedNames
      .filter((nameType) => nameType.type === "namedImport")
      .flatMap((nameType) =>
        nameType.importedNames.filter((n): n is string => typeof n === "string"),
      );
    return { modulePath: node.modulePath, names, loc: node.loc ?? null, testOnly: !!node.testOnly };
  }
  if (node.type === "importNodeStatement") {
    // Nodes are importable without `export`, so testOnly is irrelevant here.
    return { modulePath: node.agencyFile, names: node.importedNodes, loc: node.loc ?? null, testOnly: false };
  }
  return null;
}

/**
 * Error on plain imports that don't resolve to a real export:
 *   - a name a loaded Agency file doesn't define  → importNameNotFound
 *   - a module path that resolves to no file       → importModuleNotFound
 *
 * Covers `import { ... }` (Agency only) and `import node { ... }`. Skips JS
 * imports, `export { } from`, and unresolvable `pkg::` (the latter two already
 * throw in SymbolTable.build). Stays silent when the target exists but wasn't
 * loaded — that is a partial view, and the target's own error is the real one.
 */
export function checkMissingImports(ctx: TypeCheckerContext): void {
  const { symbolTable, currentFile } = ctx;
  if (!symbolTable || !currentFile) return;

  for (const node of ctx.programNodes) {
    const spec = toImportSpec(node);
    if (!spec) continue;

    const resolution = symbolTable.resolveImportModule(
      spec.modulePath,
      currentFile,
      ctx.config,
    );
    if (resolution.kind === "missing") {
      // One module error per statement, not one per imported name.
      ctx.errors.push(diagnostic("importModuleNotFound", { module: spec.modulePath }, spec.loc));
      continue;
    }
    if (resolution.kind === "notLoaded") {
      continue;
    }
    for (const name of spec.names) {
      if (!Object.prototype.hasOwnProperty.call(resolution.symbols, name)) {
        ctx.errors.push(
          diagnostic("importNameNotFound", { name, module: spec.modulePath }, spec.loc),
        );
        continue;
      }
      // Export-visibility: a name that exists but isn't `export`ed can't be
      // imported. `isExportedSymbol` owns the rule (nodes are exempt —
      // importable without `export`); `import test` is exempt too. Mirrors
      // importResolver's `assertImportable`, which already throws for this on
      // the compile path — this surfaces it in `tc` too.
      //
      // Note: a non-exported *constant* never reaches here — a `const` is only
      // recorded as a symbol when `exported && static` (classifySymbols), so it
      // trips importNameNotFound (AG4008) above instead. Consistent with
      // importResolver, which throws "is not defined" for the same case.
      const symbol = resolution.symbols[name];
      if (!spec.testOnly && !isExportedSymbol(symbol)) {
        ctx.errors.push(
          diagnostic("importNameNotExported", { name, module: spec.modulePath }, spec.loc),
        );
      }
    }
  }
}
