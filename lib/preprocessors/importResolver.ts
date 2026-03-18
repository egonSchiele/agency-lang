import * as path from "path";
import type { AgencyNode, AgencyProgram } from "../types.js";
import type {
  ImportNodeStatement,
  ImportToolStatement,
  ImportStatement,
} from "../types/importStatement.js";
import type { SymbolTable } from "../symbolTable.js";

/**
 * Resolve unified imports: rewrite `import { x, y } from "./foo.agency"`
 * into the appropriate specialized AST nodes (ImportNodeStatement,
 * ImportToolStatement) based on what each symbol actually is.
 *
 * Only touches ImportStatement nodes whose modulePath ends with ".agency".
 * Leaves import node / import tool statements and non-.agency imports untouched.
 */
export function resolveImports(
  program: AgencyProgram,
  symbolTable: SymbolTable,
  currentFile: string,
): AgencyProgram {
  const currentDir = path.dirname(path.resolve(currentFile));
  const newNodes: AgencyNode[] = [];

  for (const node of program.nodes) {
    if (
      node.type !== "importStatement" ||
      !node.modulePath.endsWith(".agency")
    ) {
      newNodes.push(node);
      continue;
    }

    const importedFilePath = path.resolve(currentDir, node.modulePath);
    const fileSymbols = symbolTable[importedFilePath] ?? {};

    const nodeNames: string[] = [];
    const functionNames: string[] = [];
    const typeNames: string[] = [];

    for (const nameType of node.importedNames) {
      if (nameType.type !== "namedImport") {
        // Namespace or default imports of .agency files — keep as-is
        newNodes.push(node);
        continue;
      }

      for (const name of nameType.importedNames) {
        const symbol = fileSymbols[name];
        if (!symbol) {
          throw new Error(
            `Symbol '${name}' is not defined in '${node.modulePath}'`,
          );
        }
        switch (symbol.kind) {
          case "node":
            nodeNames.push(name);
            break;
          case "function":
            functionNames.push(name);
            break;
          case "type":
            typeNames.push(name);
            break;
        }
      }
    }

    if (nodeNames.length > 0) {
      const nodeImport: ImportNodeStatement = {
        type: "importNodeStatement",
        importedNodes: nodeNames,
        agencyFile: node.modulePath,
      };
      newNodes.push(nodeImport);
    }

    if (functionNames.length > 0) {
      const toolImport: ImportToolStatement = {
        type: "importToolStatement",
        importedTools: functionNames,
        agencyFile: node.modulePath,
      };
      newNodes.push(toolImport);
    }

    if (typeNames.length > 0) {
      const typeImport: ImportStatement = {
        type: "importStatement",
        importedNames: [
          { type: "namedImport", importedNames: typeNames, safeNames: [] },
        ],
        modulePath: node.modulePath,
      };
      newNodes.push(typeImport);
    }
  }

  return { ...program, nodes: newNodes };
}
