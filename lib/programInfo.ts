import type {
  AgencyProgram,
  FunctionDefinition,
  GraphNodeDefinition,
  TypeHintMap,
  VariableType,
} from "./types.js";
import type {
  ImportNodeStatement,
  ImportToolStatement,
  ImportStatement,
} from "./types/importStatement.js";

export type ProgramInfo = {
  functionDefinitions: Record<string, FunctionDefinition>;
  typeAliases: Record<string, VariableType>;
  typeHints: TypeHintMap;
  graphNodes: GraphNodeDefinition[];
  importedNodes: ImportNodeStatement[];
  importedTools: ImportToolStatement[];
  importStatements: ImportStatement[];
};

export function collectProgramInfo(program: AgencyProgram): ProgramInfo {
  const info: ProgramInfo = {
    functionDefinitions: {},
    typeAliases: {},
    typeHints: {},
    graphNodes: [],
    importedNodes: [],
    importedTools: [],
    importStatements: [],
  };

  for (const node of program.nodes) {
    switch (node.type) {
      case "function":
        info.functionDefinitions[node.functionName] = node;
        break;
      case "typeAlias":
        info.typeAliases[node.aliasName] = node.aliasedType;
        break;
      case "typeHint":
        info.typeHints[node.variableName] = node.variableType;
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

  return info;
}
