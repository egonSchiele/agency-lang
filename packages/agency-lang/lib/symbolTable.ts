import * as fs from "fs";
import * as path from "path";
import { parseAgency } from "./parser.js";
import type { AgencyConfig } from "./config.js";
import type {
  AgencyProgram,
  FunctionParameter,
  VariableType,
} from "./types.js";
import type { SourceLocation } from "./types/base.js";
import type {
  ImportNodeStatement,
  ImportStatement,
} from "./types/importStatement.js";
import { walkNodes } from "./utils/node.js";
import {
  resolveAgencyImportPath,
  isAgencyImport,
  getStdlibDir,
} from "./importPaths.js";

export type SymbolKind = "node" | "function" | "type" | "class";

export type FunctionSymbol = {
  kind: "function";
  name: string;
  loc?: SourceLocation;
  safe: boolean;
  exported: boolean;
  parameters: FunctionParameter[];
  returnType: VariableType | null;
};

export type NodeSymbol = {
  kind: "node";
  name: string;
  loc?: SourceLocation;
  parameters: FunctionParameter[];
  returnType: VariableType | null;
};

export type TypeSymbol = {
  kind: "type";
  name: string;
  loc?: SourceLocation;
  exported: boolean;
  aliasedType: VariableType;
};

export type ClassSymbol = {
  kind: "class";
  name: string;
  loc?: SourceLocation;
};

export type SymbolInfo = FunctionSymbol | NodeSymbol | TypeSymbol | ClassSymbol;

/** Maps symbol name → info for a single file. */
export type FileSymbols = Record<string, SymbolInfo>;

/**
 * One named symbol resolved through an import: where it lives, what name
 * the importing file uses, and what it actually is.
 */
export type ResolvedImport = {
  file: string;
  originalName: string;
  localName: string;
  symbol: SymbolInfo;
};

/**
 * Cross-file index of every declaration reachable from an entrypoint.
 * Built eagerly: parses every reachable .agency file, classifies its
 * top-level (and nested type-alias) declarations, and follows imports.
 */
export class SymbolTable {
  private readonly files: Record<string, FileSymbols>;

  constructor(files: Record<string, FileSymbols> = {}) {
    this.files = files;
  }

  static build(entrypoint: string, config: AgencyConfig = {}): SymbolTable {
    const files: Record<string, FileSymbols> = {};
    const visited = new Set<string>();

    function visit(filePath: string): void {
      const absPath = path.resolve(filePath);
      if (visited.has(absPath)) return;
      visited.add(absPath);

      if (!fs.existsSync(absPath)) return;

      const contents = fs.readFileSync(absPath, "utf-8");
      const isStdlibIndex =
        absPath === path.join(getStdlibDir(), "index.agency");
      const parseResult = parseAgency(contents, config, !isStdlibIndex);
      if (!parseResult.success) return;

      const program = parseResult.result;
      files[absPath] = classifySymbols(program);

      for (const { node } of walkNodes(program.nodes)) {
        if (node.type === "importNodeStatement") {
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
    return new SymbolTable(files);
  }

  has(absPath: string): boolean {
    return absPath in this.files;
  }

  getFile(absPath: string): FileSymbols | undefined {
    return this.files[absPath];
  }

  filePaths(): string[] {
    return Object.keys(this.files);
  }

  /**
   * Walk every file looking for a type alias with the given name. Returns
   * the first match in iteration order. Used to surface imported type
   * definitions for Zod schema generation.
   */
  findTypeAcrossFiles(name: string): SymbolInfo | undefined {
    for (const fileSymbols of Object.values(this.files)) {
      const sym = fileSymbols[name];
      if (sym?.kind === "type") return sym;
    }
    return undefined;
  }

  /**
   * Resolve every named symbol in an import statement to its source file
   * + SymbolInfo. Skips namespace and default imports. Returns [] for
   * non-Agency imports.
   */
  resolveImport(stmt: ImportStatement, fromFile: string): ResolvedImport[] {
    if (!isAgencyImport(stmt.modulePath)) return [];
    const file = resolveAgencyImportPath(stmt.modulePath, fromFile);
    const out: ResolvedImport[] = [];
    for (const nameType of stmt.importedNames) {
      if (nameType.type !== "namedImport") continue;
      for (const originalName of nameType.importedNames) {
        const symbol = this.files[file]?.[originalName];
        if (!symbol) continue;
        out.push({
          file,
          originalName,
          localName: nameType.aliases[originalName] ?? originalName,
          symbol,
        });
      }
    }
    return out;
  }

  resolveImportedNodes(
    stmt: ImportNodeStatement,
    fromFile: string,
  ): ResolvedImport[] {
    const file = resolveAgencyImportPath(stmt.agencyFile, fromFile);
    const out: ResolvedImport[] = [];
    for (const name of stmt.importedNodes) {
      const symbol = this.files[file]?.[name];
      if (!symbol) continue;
      out.push({ file, originalName: name, localName: name, symbol });
    }
    return out;
  }
}

/**
 * Classify symbols in a parsed Agency program.
 * Uses walkNodes to find symbols at all nesting levels (e.g. type aliases inside functions).
 */
export function classifySymbols(program: AgencyProgram): FileSymbols {
  const symbols: FileSymbols = {};

  for (const { node } of walkNodes(program.nodes)) {
    switch (node.type) {
      case "graphNode":
        symbols[node.nodeName] = {
          kind: "node",
          name: node.nodeName,
          loc: node.loc,
          parameters: node.parameters,
          returnType: node.returnType ?? null,
        };
        break;
      case "function":
        symbols[node.functionName] = {
          kind: "function",
          name: node.functionName,
          loc: node.loc,
          safe: !!node.safe,
          exported: !!node.exported,
          parameters: node.parameters,
          returnType: node.returnType ?? null,
        };
        break;
      case "typeAlias":
        symbols[node.aliasName] = {
          kind: "type",
          name: node.aliasName,
          loc: node.loc,
          exported: !!node.exported,
          aliasedType: node.aliasedType,
        };
        break;
      case "classDefinition":
        symbols[node.className] = {
          kind: "class",
          name: node.className,
          loc: node.loc,
        };
        break;
    }
  }

  return symbols;
}

