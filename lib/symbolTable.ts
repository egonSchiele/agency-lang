import * as fs from "fs";
import * as path from "path";
import { parseAgency } from "./parser.js";
import type { AgencyConfig } from "./config.js";
import type { AgencyProgram } from "./types.js";
import { walkNodes } from "./utils/node.js";

export type SymbolKind = "node" | "function" | "type";

export type SymbolInfo = {
  kind: SymbolKind;
  name: string;
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
    const parseResult = parseAgency(contents, config);
    if (!parseResult.success) return;

    const program = parseResult.result;
    table[absPath] = classifySymbols(program);

    // Follow imports to other .agency files
    const dir = path.dirname(absPath);
    for (const { node } of walkNodes(program.nodes)) {
      if (node.type === "importNodeStatement") {
        visit(path.resolve(dir, node.agencyFile));
      } else if (node.type === "importToolStatement") {
        visit(path.resolve(dir, node.agencyFile));
      } else if (
        node.type === "importStatement" &&
        node.modulePath.endsWith(".agency")
      ) {
        visit(path.resolve(dir, node.modulePath));
      }
    }
  }

  visit(entrypoint);
  return table;
}
