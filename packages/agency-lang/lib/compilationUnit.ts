import type {
  AgencyProgram,
  ClassDefinition,
  FunctionDefinition,
  FunctionParameter,
  GraphNodeDefinition,
  Scope,
  VariableType,
} from "./types.js";
import type {
  ImportNodeStatement,
  ImportStatement,
} from "./types/importStatement.js";
import type { SymbolTable } from "./symbolTable.js";
import { walkNodes } from "./utils/node.js";

export const GLOBAL_SCOPE_KEY = "global";

export type ScopedTypeMap = Record<string, Record<string, VariableType>>;

/**
 * Per-compilation aggregate. Holds the rich AST nodes for the entry file's
 * local declarations plus a typechecker-shaped scoped type-alias map. For
 * any cross-file question — what does this name resolve to in another
 * file? — call methods on the SymbolTable directly.
 */
export type CompilationUnit = {
  functionDefinitions: Record<string, FunctionDefinition>;
  typeAliases: ScopedTypeMap;
  graphNodes: GraphNodeDefinition[];
  importedNodes: ImportNodeStatement[];
  importStatements: ImportStatement[];
  safeFunctions: Record<string, boolean>;
  importedFunctions: Record<string, { parameters: FunctionParameter[] }>;
  classDefinitions: Record<string, ClassDefinition>;
};

export function scopeKey(scope: Scope): string {
  switch (scope.type) {
    case "global":
      return GLOBAL_SCOPE_KEY;
    case "function":
      return `function:${scope.functionName}`;
    case "node":
      return `node:${scope.nodeName}`;
    case "local":
      return `local`;
    case "imported":
      return "imported";
    case "static":
      return "static";
    case "block":
      return `block:${scope.blockName}`;
  }
}

/** Get a flat map of all types visible in the given scope (scope-local overrides global). */
export function getVisibleTypes(
  map: ScopedTypeMap,
  key: string,
): Record<string, VariableType> {
  return { ...map[GLOBAL_SCOPE_KEY], ...map[key] };
}

function ensureScope(
  map: ScopedTypeMap,
  key: string,
): Record<string, VariableType> {
  if (!map[key]) map[key] = {};
  return map[key];
}

export function buildCompilationUnit(
  program: AgencyProgram,
  symbolTable?: SymbolTable,
  fromFile?: string,
): CompilationUnit {
  const unit: CompilationUnit = {
    functionDefinitions: {},
    typeAliases: { [GLOBAL_SCOPE_KEY]: {} },
    graphNodes: [],
    importedNodes: [],
    importStatements: [],
    importedFunctions: {},
    classDefinitions: {},
    safeFunctions: {},
  };

  // Top-level pass: collect functions, graph nodes, imports.
  for (const node of program.nodes) {
    switch (node.type) {
      case "function":
        unit.functionDefinitions[node.functionName] = node;
        if (node.safe) unit.safeFunctions[node.functionName] = true;
        break;
      case "graphNode":
        unit.graphNodes.push(node);
        break;
      case "importNodeStatement":
        unit.importedNodes.push(node);
        break;
      case "classDefinition":
        unit.classDefinitions[node.className] = node;
        for (const method of node.methods) {
          if (method.safe) {
            unit.safeFunctions[`${node.className}.${method.name}`] = true;
          }
        }
        break;
      case "importStatement":
        unit.importStatements.push(node);
        for (const nameType of node.importedNames) {
          if (nameType.type !== "namedImport") continue;
          if (node.isAgencyImport) {
            for (const name of nameType.importedNames) {
              const localName = nameType.aliases[name] ?? name;
              unit.importedFunctions[localName] = { parameters: [] };
            }
          }
          for (const safeName of nameType.safeNames) {
            const localSafe = nameType.aliases[safeName] ?? safeName;
            unit.safeFunctions[localSafe] = true;
          }
        }
        break;
    }
  }

  // Deep walk: collect every type alias keyed by its enclosing scope.
  for (const { node, scopes } of walkNodes(program.nodes)) {
    const key = scopeKey(scopes[scopes.length - 1]);
    if (node.type === "typeAlias") {
      ensureScope(unit.typeAliases, key)[node.aliasName] = node.aliasedType;
    }
  }

  // Stitch in cross-file information from imports. Both passes use
  // resolveImport, so the (file, original→local) mapping is computed once
  // per statement instead of being re-derived from raw symbol-table loops.
  if (symbolTable && fromFile) {
    for (const stmt of unit.importStatements) {
      for (const r of symbolTable.resolveImport(stmt, fromFile)) {
        if (
          (r.symbol.kind === "function" || r.symbol.kind === "node") &&
          unit.importedFunctions[r.localName]
        ) {
          unit.importedFunctions[r.localName].parameters = r.symbol.parameters;
        }
        if (r.symbol.kind === "function" && r.symbol.safe) {
          unit.safeFunctions[r.localName] = true;
        }
        if (r.symbol.kind === "type") {
          ensureScope(unit.typeAliases, GLOBAL_SCOPE_KEY)[r.localName] =
            r.symbol.aliasedType;
        }
      }
    }
  }

  return unit;
}
