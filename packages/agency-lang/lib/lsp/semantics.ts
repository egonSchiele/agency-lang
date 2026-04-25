import { getWordAtPosition } from "../cli/definition.js";
import { formatTypeHint } from "../cli/util.js";
import { resolveAgencyImportPath, isAgencyImport } from "../importPaths.js";
import type { SymbolInfo, SymbolKind, SymbolTable } from "../symbolTable.js";
import type {
  AgencyProgram,
  ClassDefinition,
  FunctionDefinition,
  FunctionParameter,
  GraphNodeDefinition,
  TypeAlias,
} from "../types.js";
import type { SourceLocation, VariableType } from "../types.js";
import { toUserSourceLocation } from "./locations.js";

export type SemanticSymbol = {
  name: string;
  originalName: string;
  kind: SymbolKind;
  source: "local" | "imported";
  filePath: string;
  loc?: SourceLocation;
  parameters?: FunctionParameter[];
  returnType?: VariableType | null;
  aliasedType?: VariableType;
  importPath?: string;
};

export type SemanticIndex = Record<string, SemanticSymbol>;

function addSymbol(index: SemanticIndex, symbol: SemanticSymbol): void {
  index[symbol.name] = symbol;
}

function addLocalDefinition(
  index: SemanticIndex,
  fsPath: string,
  node: FunctionDefinition | GraphNodeDefinition | TypeAlias | ClassDefinition,
): void {
  switch (node.type) {
    case "function":
      addSymbol(index, {
        name: node.functionName,
        originalName: node.functionName,
        kind: "function",
        source: "local",
        filePath: fsPath,
        loc: toUserSourceLocation(node.loc),
        parameters: node.parameters,
        returnType: node.returnType,
      });
      break;
    case "graphNode":
      addSymbol(index, {
        name: node.nodeName,
        originalName: node.nodeName,
        kind: "node",
        source: "local",
        filePath: fsPath,
        loc: toUserSourceLocation(node.loc),
        parameters: node.parameters,
        returnType: node.returnType,
      });
      break;
    case "typeAlias":
      addSymbol(index, {
        name: node.aliasName,
        originalName: node.aliasName,
        kind: "type",
        source: "local",
        filePath: fsPath,
        loc: toUserSourceLocation(node.loc),
        aliasedType: node.aliasedType,
      });
      break;
    case "classDefinition":
      addSymbol(index, {
        name: node.className,
        originalName: node.className,
        kind: "class",
        source: "local",
        filePath: fsPath,
        loc: toUserSourceLocation(node.loc),
      });
      break;
  }
}

function addImportedSymbol(
  index: SemanticIndex,
  opts: {
    filePath: string;
    importPath: string;
    originalName: string;
    localName: string;
    symbol: SymbolInfo;
  },
): void {
  addSymbol(index, {
    name: opts.localName,
    originalName: opts.originalName,
    kind: opts.symbol.kind,
    source: "imported",
    filePath: opts.filePath,
    loc: opts.symbol.loc,
    parameters: opts.symbol.parameters,
    returnType: opts.symbol.returnType,
    aliasedType: opts.symbol.aliasedType,
    importPath: opts.importPath,
  });
}

function resolveImportedFile(
  fsPath: string,
  importPath: string,
): string | null {
  if (!isAgencyImport(importPath)) return null;
  try {
    return resolveAgencyImportPath(importPath, fsPath);
  } catch {
    return null;
  }
}

function collectImportedSymbols(
  program: AgencyProgram,
  fsPath: string,
  symbolTable: SymbolTable,
): SemanticIndex {
  const index: SemanticIndex = {};

  for (const node of program.nodes) {
    if (node.type === "importNodeStatement") {
      const importedFile = resolveImportedFile(fsPath, node.agencyFile);
      if (!importedFile) continue;
      const fileSymbols = symbolTable[importedFile] ?? {};
      for (const name of node.importedNodes) {
        const symbol = fileSymbols[name];
        if (!symbol) continue;
        addImportedSymbol(index, {
          filePath: importedFile,
          importPath: node.agencyFile,
          originalName: name,
          localName: name,
          symbol,
        });
      }
      continue;
    }

    if (node.type !== "importStatement") continue;
    const importedFile = resolveImportedFile(fsPath, node.modulePath);
    if (!importedFile) continue;
    const fileSymbols = symbolTable[importedFile] ?? {};
    for (const importedName of node.importedNames) {
      if (importedName.type !== "namedImport") continue;
      for (const name of importedName.importedNames) {
        const symbol = fileSymbols[name];
        if (!symbol) continue;
        addImportedSymbol(index, {
          filePath: importedFile,
          importPath: node.modulePath,
          originalName: name,
          localName: importedName.aliases[name] ?? name,
          symbol,
        });
      }
    }
  }

  return index;
}

export function buildSemanticIndex(
  program: AgencyProgram,
  fsPath: string,
  symbolTable: SymbolTable,
): SemanticIndex {
  const index: SemanticIndex = {};

  for (const node of program.nodes) {
    if (
      node.type === "function" ||
      node.type === "graphNode" ||
      node.type === "typeAlias" ||
      node.type === "classDefinition"
    ) {
      addLocalDefinition(index, fsPath, node);
    }
  }

  Object.assign(index, collectImportedSymbols(program, fsPath, symbolTable));

  return index;
}

export function lookupSemanticSymbol(
  source: string,
  line: number,
  character: number,
  index: SemanticIndex,
): SemanticSymbol | null {
  const word = getWordAtPosition(source, line, character);
  if (!word) return null;
  return index[word] ?? null;
}

function formatParameters(parameters: FunctionParameter[] | undefined): string {
  if (!parameters || parameters.length === 0) return "";
  return parameters
    .map((param) => `${param.name}${param.typeHint ? `: ${formatTypeHint(param.typeHint)}` : ""}`)
    .join(", ");
}

function formatSignature(symbol: SemanticSymbol): string {
  switch (symbol.kind) {
    case "function": {
      const params = formatParameters(symbol.parameters);
      const ret = symbol.returnType ? `: ${formatTypeHint(symbol.returnType)}` : "";
      return `${symbol.name}(${params})${ret}`;
    }
    case "node": {
      const params = formatParameters(symbol.parameters);
      const ret = symbol.returnType ? `: ${formatTypeHint(symbol.returnType)}` : "";
      return `${symbol.name}(${params})${ret}`;
    }
    case "type":
      return symbol.aliasedType
        ? `${symbol.name} = ${formatTypeHint(symbol.aliasedType)}`
        : symbol.name;
    case "class":
      return symbol.name;
  }
}

export function formatSemanticHover(symbol: SemanticSymbol): string {
  const heading = `**${symbol.kind}** \`${formatSignature(symbol)}\``;
  if (symbol.source === "local") {
    return heading;
  }

  const aliasNote = symbol.originalName !== symbol.name
    ? ` as \`${symbol.originalName}\``
    : "";
  return `${heading}\n\nImported from \`${symbol.importPath}\`${aliasNote}`;
}
