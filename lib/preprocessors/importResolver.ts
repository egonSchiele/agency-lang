import type { AgencyNode, AgencyProgram } from "../types.js";
import type {
  ImportNodeStatement,
  ImportStatement,
} from "../types/importStatement.js";
import type { SymbolTable } from "../symbolTable.js";
import { resolveAgencyImportPath, isAgencyImport } from "../importPaths.js";

/**
 * Resolve unified imports: rewrite `import { x, y } from "./foo.agency"`
 * into the appropriate specialized AST nodes (ImportNodeStatement for nodes,
 * ImportStatement for functions and types) based on what each symbol actually is.
 *
 * Only touches ImportStatement nodes whose modulePath is an Agency import
 * (.agency files, std:: imports, or pkg:: imports).
 * Leaves import node / import tool statements and non-Agency imports untouched.
 */
function assertExported(name: string, modulePath: string, exported?: boolean, symbolKind = "Function"): void {
  if (!exported) {
    throw new Error(
      `${symbolKind} '${name}' in '${modulePath}' is not exported. Add the 'export' keyword to its definition.`,
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
    const aliases: Record<string, string> = {};

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
        // Carry forward any alias from the original import
        if (nameType.aliases[name]) {
          aliases[name] = nameType.aliases[name];
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
            assertExported(name, node.modulePath, symbol.exported, "Type");
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

    // Combine functions and types into a single import statement
    const allNames = [...functionNames, ...typeNames];
    if (allNames.length > 0) {
      const allAliases: Record<string, string> = {};
      for (const name of allNames) {
        if (aliases[name]) allAliases[name] = aliases[name];
      }
      const importStmt: ImportStatement = {
        type: "importStatement",
        importedNames: [
          { type: "namedImport", importedNames: allNames, safeNames: safeFunctionNames, aliases: allAliases },
        ],
        modulePath: node.modulePath,
        isAgencyImport: true,
      };
      newNodes.push(importStmt);
    }
  }

  return { ...program, nodes: newNodes };
}
