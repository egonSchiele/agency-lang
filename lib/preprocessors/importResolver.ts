import type { AgencyNode, AgencyProgram } from "../types.js";
import type {
  ImportNodeStatement,
  ImportToolStatement,
  ImportStatement,
} from "../types/importStatement.js";
import { getImportedToolNames } from "../types/importStatement.js";
import type { SymbolTable } from "../symbolTable.js";
import { resolveAgencyImportPath, isAgencyImport } from "../importPaths.js";

/**
 * Resolve unified imports: rewrite `import { x, y } from "./foo.agency"`
 * into the appropriate specialized AST nodes (ImportNodeStatement,
 * ImportToolStatement) based on what each symbol actually is.
 *
 * Only touches ImportStatement nodes whose modulePath is an Agency import
 * (.agency files, std:: imports, or pkg:: imports).
 * Leaves import node / import tool statements and non-Agency imports untouched.
 */
function assertExported(name: string, modulePath: string, exported?: boolean): void {
  if (!exported) {
    throw new Error(
      `Function '${name}' in '${modulePath}' is not exported. Add the 'export' keyword to its definition.`,
    );
  }
}

export function resolveImports(
  program: AgencyProgram,
  symbolTable: SymbolTable,
  currentFile: string,
): AgencyProgram {
  const newNodes: AgencyNode[] = [];

  for (const node of program.nodes) {
    // Validate that directly-written import tool statements reference exported functions
    if (node.type === "importToolStatement") {
      const importedFilePath = resolveAgencyImportPath(node.agencyFile, currentFile);
      const fileSymbols = symbolTable[importedFilePath] ?? {};
      for (const name of getImportedToolNames(node)) {
        const symbol = fileSymbols[name];
        if (!symbol) {
          throw new Error(
            `Symbol '${name}' is not defined in '${node.agencyFile}'`,
          );
        }
        if (symbol.kind !== "function") {
          throw new Error(
            `Symbol '${name}' in '${node.agencyFile}' is not a function and cannot be imported as a tool.`,
          );
        }
        assertExported(name, node.agencyFile, symbol.exported);
      }
      newNodes.push(node);
      continue;
    }

    if (
      node.type !== "importStatement" ||
      !isAgencyImport(node.modulePath)
    ) {
      newNodes.push(node);
      continue;
    }

    const importedFilePath = resolveAgencyImportPath(node.modulePath, currentFile);
    const fileSymbols = symbolTable[importedFilePath] ?? {};

    const nodeNames: string[] = [];
    const functionNames: string[] = [];
    const safeFunctionNames: string[] = [];
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
            assertExported(name, node.modulePath, symbol.exported);
            functionNames.push(name);
            // Mark as safe if the function definition is safe OR if the
            // original import explicitly marked it safe
            if (symbol.safe || nameType.safeNames.includes(name)) {
              safeFunctionNames.push(name);
            }
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
        importedTools: [{
          type: "namedImport",
          importedNames: functionNames,
          safeNames: safeFunctionNames,
        }],
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
