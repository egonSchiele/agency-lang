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

export type ProgramInfo = {
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
    case "shared":
      return "shared";
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

export function collectProgramInfo(
  program: AgencyProgram,
  symbolTable?: SymbolTable,
): ProgramInfo {
  const info: ProgramInfo = {
    functionDefinitions: {},
    typeAliases: { [GLOBAL_SCOPE_KEY]: {} },
    graphNodes: [],
    importedNodes: [],
    importStatements: [],
    safeFunctions: {},
    importedFunctions: {},
    classDefinitions: {},
  };

  // Top-level pass: collect functions, graph nodes, imports
  for (const node of program.nodes) {
    switch (node.type) {
      case "function":
        info.functionDefinitions[node.functionName] = node;
        if (node.safe) {
          info.safeFunctions[node.functionName] = true;
        }
        break;
      case "graphNode":
        info.graphNodes.push(node);
        break;
      case "importNodeStatement":
        info.importedNodes.push(node);
        break;
      case "classDefinition":
        info.classDefinitions[node.className] = node;
        for (const method of node.methods) {
          if (method.safe) {
            info.safeFunctions[`${node.className}.${method.name}`] = true;
          }
        }
        break;
      case "importStatement":
        info.importStatements.push(node);
        for (const nameType of node.importedNames) {
          if (nameType.type === "namedImport") {
            for (const name of nameType.importedNames) {
              const localName = nameType.aliases[name] ?? name;
              info.importedFunctions[localName] = { parameters: [] };
            }
            for (const safeName of nameType.safeNames) {
              const localSafe = nameType.aliases[safeName] ?? safeName;
              info.safeFunctions[localSafe] = true;
            }
          }
        }
        break;
    }
  }

  // Enrich imported function info with parameter data from the symbol table
  if (symbolTable) {
    // Build a reverse map: originalName → localName for aliased imports
    const originalToLocal: Record<string, string> = {};
    for (const importStmt of info.importStatements) {
      for (const nameType of importStmt.importedNames) {
        if (nameType.type === "namedImport") {
          for (const [orig, alias] of Object.entries(nameType.aliases)) {
            originalToLocal[orig] = alias;
          }
        }
      }
    }

    for (const fileSymbols of Object.values(symbolTable)) {
      for (const [name, symbol] of Object.entries(fileSymbols)) {
        if (symbol.parameters) {
          const localName = originalToLocal[name] ?? name;
          if (info.importedFunctions[localName]) {
            info.importedFunctions[localName].parameters = symbol.parameters;
          }
        }
      }
    }
  }

  // Deep walk: collect all type aliases with their scope
  for (const { node, scopes } of walkNodes(program.nodes)) {
    const key = scopeKey(scopes[scopes.length - 1]);
    if (node.type === "typeAlias") {
      ensureScope(info.typeAliases, key)[node.aliasName] = node.aliasedType;
    }
  }

  // Collect type definitions from imported agency files via the symbol table.
  // This makes imported types available for Zod schema generation in LLM calls.
  if (symbolTable) {
    for (const importStmt of info.importStatements) {
      for (const nameType of importStmt.importedNames) {
        if (nameType.type !== "namedImport") continue;
        for (const name of nameType.importedNames) {
          const localName = nameType.aliases[name] ?? name;
          // Look up the type definition in any file's symbols
          for (const fileSymbols of Object.values(symbolTable)) {
            const symbol = fileSymbols[name];
            if (symbol?.kind === "type" && symbol.aliasedType) {
              ensureScope(info.typeAliases, GLOBAL_SCOPE_KEY)[localName] =
                symbol.aliasedType;
              break;
            }
          }
        }
      }
    }
  }

  return info;
}
