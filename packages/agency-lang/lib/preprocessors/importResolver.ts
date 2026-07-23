import type { AgencyNode, AgencyProgram } from "../types.js";
import type {
  ImportNodeStatement,
  ImportStatement,
  NamedImport,
} from "../types/importStatement.js";
import type { SourceLocation } from "../types/base.js";
import type { SymbolTable, SymbolInfo, FileSymbols } from "../symbolTable.js";
import {
  resolveAgencyImportPath,
  isAgencyImport,
  isPkgImport,
} from "../importPaths.js";

/**
 * An import that cannot be resolved (unknown symbol, non-exported symbol, a
 * misused marker, …). Carries the offending import statement's `loc` so
 * callers can anchor a diagnostic to it instead of falling back to the top of
 * the file. The LSP relies on this to report the error on the import line
 * while still type-checking the rest of the document.
 */
export class ImportResolutionError extends Error {
  loc?: SourceLocation;
  constructor(message: string, loc?: SourceLocation) {
    super(message);
    this.name = "ImportResolutionError";
    this.loc = loc;
  }
}

/**
 * Resolve unified imports: rewrite `import { x, y } from "./foo.agency"`
 * into the appropriate specialized AST nodes (ImportNodeStatement for nodes,
 * ImportStatement for functions and types) based on what each symbol actually is.
 *
 * Only touches ImportStatement nodes whose modulePath is an Agency import
 * (.agency files, std:: imports, or pkg:: imports).
 * Leaves import node / import tool statements and non-Agency imports untouched.
 */

/**
 * May this import see this symbol? A test-only import (`import test { … }`,
 * honored only under the test harness — the per-statement gate in
 * resolveImports enforces that plus the first-party restriction) may see
 * non-exported symbols; a plain import may not.
 */
function assertImportable(
  name: string,
  modulePath: string,
  exported: boolean | undefined,
  testOnly: boolean | undefined,
  loc: SourceLocation | undefined,
  symbolKind = "Function",
): void {
  if (testOnly) {
    return;
  }
  if (!exported) {
    throw new ImportResolutionError(
      `${symbolKind} '${name}' in '${modulePath}' is not exported. Add the 'export' keyword to its definition.`,
      loc,
    );
  }
}

/** Coerce any thrown value into an ImportResolutionError, attaching `loc` when
 *  the original didn't already carry one (e.g. a plain Error from
 *  `resolveAgencyImportPath` for an uninstalled pkg::). */
function asImportResolutionError(
  err: unknown,
  loc: SourceLocation | undefined,
): ImportResolutionError {
  if (err instanceof ImportResolutionError) return err;
  return new ImportResolutionError(
    err instanceof Error ? err.message : String(err),
    loc,
  );
}

export function resolveImports(
  program: AgencyProgram,
  symbolTable: SymbolTable,
  currentFile: string,
  opts: {
    allowTestImports?: boolean;
    // Analysis mode (LSP): when set, an unresolvable import is not fatal.
    // Instead of throwing, resolveImports drops the offending name (or whole
    // statement) from the rewrite and reports it here, so every *other* import
    // still resolves and the rest of the file still type-checks. The compile
    // path leaves this unset and hard-fails on the first bad import.
    onUnresolvable?: (err: ImportResolutionError) => void;
  } = {},
): AgencyProgram {
  const allowTestImports = opts.allowTestImports ?? false;
  const onUnresolvable = opts.onUnresolvable;
  const newNodes: AgencyNode[] = [];

  for (const node of program.nodes) {
    if (node.type !== "importStatement") {
      newNodes.push(node);
      continue;
    }
    newNodes.push(
      ...resolveImportStatement(
        node,
        symbolTable,
        currentFile,
        allowTestImports,
        onUnresolvable,
      ),
    );
  }

  return { ...program, nodes: newNodes };
}

/** The imported names, bucketed by what each symbol turned out to be. */
type ImportBuckets = {
  nodeNames: string[];
  functionNames: string[];
  destructiveFunctionNames: string[];
  idempotentFunctionNames: string[];
  typeNames: string[];
  constantNames: string[];
};

/**
 * Sort one imported name into the right bucket based on the kind of symbol it
 * resolves to, and enforce the per-kind rules (export visibility, retry-safety
 * markers). Throws an {@link ImportResolutionError} on a violation.
 */
function classifyImportedName(
  name: string,
  symbol: SymbolInfo,
  nameType: NamedImport,
  node: ImportStatement,
  buckets: ImportBuckets,
): void {
  switch (symbol.kind) {
    case "node":
      if (
        nameType.destructiveNames?.includes(name) ||
        nameType.idempotentNames?.includes(name)
      ) {
        throw new ImportResolutionError(
          `A retry-safety marker (destructive/idempotent) cannot be applied to node '${name}' from '${node.modulePath}'. ` +
            `Markers are only meaningful for functions; nodes do not carry them.`,
          node.loc,
        );
      }
      buckets.nodeNames.push(name);
      break;
    case "function":
      assertImportable(name, node.modulePath, symbol.exported, node.testOnly, node.loc);
      buckets.functionNames.push(name);
      // A marker propagates when the defining function carries it OR this
      // import explicitly marked the name.
      if (
        symbol.markers?.destructive ||
        (nameType.destructiveNames?.includes(name) ?? false)
      ) {
        buckets.destructiveFunctionNames.push(name);
      }
      if (
        symbol.markers?.idempotent ||
        (nameType.idempotentNames?.includes(name) ?? false)
      ) {
        buckets.idempotentFunctionNames.push(name);
      }
      break;
    case "type":
      assertImportable(name, node.modulePath, symbol.exported, node.testOnly, node.loc, "Type");
      buckets.typeNames.push(name);
      break;
    case "constant":
      assertImportable(name, node.modulePath, symbol.exported, node.testOnly, node.loc, "Constant");
      buckets.constantNames.push(name);
      break;
  }
}

/**
 * Enforce the `import test` gates: the keyword is only for first-party (std::
 * and local) Agency modules, and only under the test harness. Throws an
 * {@link ImportResolutionError} on a violation. Must run BEFORE the non-Agency
 * short-circuit in the caller — otherwise `import test { x } from "./foo.ts"`
 * (or a bare npm path) would slip through untouched, making the keyword a
 * silent no-op — and before symbol lookup, so a pkg:: rejection does not
 * depend on the package resolving.
 */
function assertTestOnlyImportable(
  node: ImportStatement,
  allowTestImports: boolean,
): void {
  if (!node.testOnly) return;
  if (isPkgImport(node.modulePath)) {
    throw new ImportResolutionError(
      "`import test` cannot be used with pkg:: imports; it is only for first-party (std:: and local) modules.",
      node.loc,
    );
  }
  if (!isAgencyImport(node.modulePath)) {
    throw new ImportResolutionError(
      "`import test` cannot be used with TypeScript or npm imports; it is only for first-party (std:: and local) modules.",
      node.loc,
    );
  }
  if (!allowTestImports) {
    throw new ImportResolutionError(
      "`import test` is only allowed under the test harness.",
      node.loc,
    );
  }
}

/**
 * Resolve a single `import { ... }` statement into the specialized node(s) it
 * expands to (an ImportNodeStatement for imported nodes, an ImportStatement for
 * functions/types/constants), returning them in the order they should appear.
 *
 * Without `onUnresolvable`, throws an {@link ImportResolutionError} on the
 * first problem (the compile path). With it, each unresolvable name is dropped
 * from the rewrite and reported through the callback instead, so good names in
 * the same statement still resolve. Non-Agency and namespace/default imports
 * pass through unchanged.
 */
function resolveImportStatement(
  node: ImportStatement,
  symbolTable: SymbolTable,
  currentFile: string,
  allowTestImports: boolean,
  onUnresolvable?: (err: ImportResolutionError) => void,
): AgencyNode[] {
  let fileSymbols: FileSymbols;
  try {
    assertTestOnlyImportable(node, allowTestImports);
    if (!isAgencyImport(node.modulePath)) return [node];
    // Namespace/default imports (including mixed `import foo, { bar }`) pass
    // through unchanged — rewriting only the named part would duplicate the
    // default/namespace binding still carried by this original statement.
    if (node.importedNames.some((n) => n.type !== "namedImport")) return [node];
    // May throw a plain Error for a pkg:: that isn't installed; the caller's
    // `onUnresolvable` path coerces it so it stays skippable, not fatal.
    fileSymbols = symbolTable.getFile(resolveAgencyImportPath(node.modulePath, currentFile)) ?? {};
  } catch (err) {
    // A statement-level failure (bad `import test`, unresolvable module path)
    // means nothing in this statement resolves — drop it whole and report.
    if (onUnresolvable) {
      onUnresolvable(asImportResolutionError(err, node.loc));
      return [];
    }
    throw err;
  }

  const out: AgencyNode[] = [];
  const buckets: ImportBuckets = {
    nodeNames: [],
    functionNames: [],
    destructiveFunctionNames: [],
    idempotentFunctionNames: [],
    typeNames: [],
    constantNames: [],
  };
  const aliases: Record<string, string> = {};

  for (const nameType of node.importedNames) {
    if (nameType.type !== "namedImport") continue; // guaranteed above

    for (const name of nameType.importedNames) {
      // A hole specifier (template file) has no symbol to resolve; leave it
      // for fill to replace.
      if (typeof name !== "string") continue;
      try {
        const symbol = fileSymbols[name];
        if (!symbol) {
          throw new ImportResolutionError(
            `Symbol '${name}' is not defined in '${node.modulePath}'`,
            node.loc,
          );
        }
        // Carry forward any alias from the original import
        if (nameType.aliases[name]) {
          aliases[name] = nameType.aliases[name];
        }
        classifyImportedName(name, symbol, nameType, node, buckets);
      } catch (err) {
        // Per-name failure: drop just this name (good names still resolve) and
        // report it. The compile path (no callback) rethrows to hard-fail.
        if (onUnresolvable) {
          onUnresolvable(asImportResolutionError(err, node.loc));
          continue;
        }
        throw err;
      }
    }
  }

  const {
    nodeNames,
    functionNames,
    destructiveFunctionNames,
    idempotentFunctionNames,
    typeNames,
    constantNames,
  } = buckets;

  if (nodeNames.length > 0) {
    const nodeImport: ImportNodeStatement = {
      type: "importNodeStatement",
      importedNodes: nodeNames,
      agencyFile: node.modulePath,
    };
    out.push(nodeImport);
  }

  // Combine functions, types, and static-const imports into a single import statement.
  // Constants need to flow through even when only referenced via a tag
  // argument (e.g. `@jsonSchema({ ...emailFormat })`) — without including
  // them here the generated TS would have a dangling reference.
  const allNames = [...functionNames, ...typeNames, ...constantNames];
  if (allNames.length > 0) {
    const allAliases: Record<string, string> = {};
    for (const name of allNames) {
      if (aliases[name]) allAliases[name] = aliases[name];
    }
    const namedImport: NamedImport = {
      type: "namedImport",
      importedNames: allNames,
      aliases: allAliases,
    };
    if (destructiveFunctionNames.length > 0) {
      namedImport.destructiveNames = destructiveFunctionNames;
    }
    if (idempotentFunctionNames.length > 0) {
      namedImport.idempotentNames = idempotentFunctionNames;
    }
    const importStmt: ImportStatement = {
      type: "importStatement",
      importedNames: [namedImport],
      modulePath: node.modulePath,
      isAgencyImport: true,
    };
    out.push(importStmt);
  }

  return out;
}
