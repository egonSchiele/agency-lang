import type {
  AgencyProgram,
  FunctionDefinition,
  GraphNodeDefinition,
  Scope,
  VariableType,
} from "./types.js";
import { functionScope, nodeScope } from "./types.js";
import type {
  ImportNodeStatement,
  ImportToolStatement,
  ImportStatement,
} from "./types/importStatement.js";
import { walkNodes } from "./utils/node.js";

export const GLOBAL_SCOPE_KEY = "global";

export type ScopedTypeMap = Record<string, Record<string, VariableType>>;

export type ProgramInfo = {
  functionDefinitions: Record<string, FunctionDefinition>;
  typeAliases: ScopedTypeMap;
  typeHints: ScopedTypeMap;
  graphNodes: GraphNodeDefinition[];
  importedNodes: ImportNodeStatement[];
  importedTools: ImportToolStatement[];
  importStatements: ImportStatement[];
};

export function scopeKey(scope: Scope): string {
  switch (scope.type) {
    case "global":
      return GLOBAL_SCOPE_KEY;
    case "function":
      return `function:${scope.functionName}`;
    case "node":
      return `node:${scope.nodeName}`;
    case "imported":
      return "imported";
    case "shared":
      return "shared";
  }
}

/** Look up a variable in a scoped map, checking the given scope first, then falling back to global. */
export function lookupType(
  map: ScopedTypeMap,
  key: string,
  varName: string,
): VariableType | undefined {
  return map[key]?.[varName] ?? map[GLOBAL_SCOPE_KEY]?.[varName];
}

/** Get a flat map of all types visible in the given scope (scope-local overrides global). */
export function getVisibleTypes(
  map: ScopedTypeMap,
  key: string,
): Record<string, VariableType> {
  return { ...map[GLOBAL_SCOPE_KEY], ...map[key] };
}

function ensureScope(map: ScopedTypeMap, key: string): Record<string, VariableType> {
  if (!map[key]) map[key] = {};
  return map[key];
}

export function collectProgramInfo(program: AgencyProgram): ProgramInfo {
  const info: ProgramInfo = {
    functionDefinitions: {},
    typeAliases: { [GLOBAL_SCOPE_KEY]: {} },
    typeHints: { [GLOBAL_SCOPE_KEY]: {} },
    graphNodes: [],
    importedNodes: [],
    importedTools: [],
    importStatements: [],
  };

  // Top-level pass: collect functions, graph nodes, imports
  for (const node of program.nodes) {
    switch (node.type) {
      case "function":
        info.functionDefinitions[node.functionName] = node;
        break;
      case "graphNode":
        info.graphNodes.push(node);
        break;
      case "importNodeStatement":
        info.importedNodes.push(node);
        break;
      case "importToolStatement":
        info.importedTools.push(node);
        break;
      case "importStatement":
        info.importStatements.push(node);
        break;
    }
  }

  // Deep walk: collect all type aliases and type hints with their scope
  for (const { node, scopes } of walkNodes(program.nodes)) {
    const key = scopeKey(scopes[scopes.length - 1]);
    if (node.type === "typeAlias") {
      ensureScope(info.typeAliases, key)[node.aliasName] = node.aliasedType;
    } else if (node.type === "typeHint") {
      ensureScope(info.typeHints, key)[node.variableName] = node.variableType;
    }
  }

  return info;
}
