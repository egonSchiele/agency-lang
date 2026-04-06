import * as fs from "fs";
import * as path from "path";
import { parseAgency } from "./parser.js";
import type { AgencyConfig } from "./config.js";
import type { AgencyProgram, FunctionParameter } from "./types.js";
import { walkNodes } from "./utils/node.js";
import { resolveAgencyImportPath, isAgencyImport, getStdlibDir } from "./importPaths.js";

export type SymbolKind = "node" | "function" | "type";

export type SymbolInfo = {
  kind: SymbolKind;
  name: string;
  safe?: boolean;
  exported?: boolean;
  parameters?: FunctionParameter[];
};

/** Maps symbol name → info for a single file. */
export type FileSymbols = Record<string, SymbolInfo>;

/** Maps absolute file path → symbols for all reachable .agency files. */
export type SymbolTable = Record<string, FileSymbols>;

/**
 * Classify symbols in a parsed Agency program.
 * Uses walkNodes to find symbols at all nesting levels (e.g. type aliases inside functions).
 */
export function classifySymbols(program: AgencyProgram): FileSymbols {
  const symbols: FileSymbols = {};

  for (const { node } of walkNodes(program.nodes)) {
    switch (node.type) {
      case "graphNode":
        symbols[node.nodeName] = { kind: "node", name: node.nodeName };
        break;
      case "function":
        symbols[node.functionName] = {
          kind: "function",
          name: node.functionName,
          safe: node.safe,
          exported: node.exported,
          parameters: node.parameters,
        };
        break;
      case "typeAlias":
        symbols[node.aliasName] = { kind: "type", name: node.aliasName };
        break;
    }
  }

  return symbols;
}

/**
 * Build a symbol table for all .agency files reachable from the entrypoint.
 * Parses each file, classifies its symbols, and follows imports recursively.
 */
export function buildSymbolTable(
  entrypoint: string,
  config: AgencyConfig = {},
): SymbolTable {
  const table: SymbolTable = {};
  const visited = new Set<string>();

  function visit(filePath: string): void {
    const absPath = path.resolve(filePath);
    if (visited.has(absPath)) return;
    visited.add(absPath);

    if (!fs.existsSync(absPath)) return;

    const contents = fs.readFileSync(absPath, "utf-8");
    const isStdlibFile = absPath.startsWith(getStdlibDir());
    const parseResult = parseAgency(contents, config, !isStdlibFile);
    if (!parseResult.success) return;

    const program = parseResult.result;
    table[absPath] = classifySymbols(program);

    // Follow imports to other .agency files
    for (const { node } of walkNodes(program.nodes)) {
      if (node.type === "importNodeStatement") {
        visit(resolveAgencyImportPath(node.agencyFile, absPath));
      } else if (node.type === "importToolStatement") {
        visit(resolveAgencyImportPath(node.agencyFile, absPath));
      } else if (
        node.type === "importStatement" &&
        isAgencyImport(node.modulePath)
      ) {
        visit(resolveAgencyImportPath(node.modulePath, absPath));
      }
    }
  }

  visit(entrypoint);
  return table;
}
