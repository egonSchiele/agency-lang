import { getWordAtPosition } from "../cli/definition.js";
import { formatTypeHint } from "../cli/util.js";
import type { FileSymbols, InterruptKind, SymbolInfo, SymbolKind, SymbolTable } from "../symbolTable.js";
import type {
  AgencyProgram,
  ClassDefinition,
  FunctionDefinition,
  FunctionParameter,
  GraphNodeDefinition,
  TypeAlias,
} from "../types.js";
import type { SourceLocation, VariableType } from "../types.js";

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
  interruptKinds?: InterruptKind[];
};

export type SemanticIndex = Record<string, SemanticSymbol>;

function addSymbol(index: SemanticIndex, symbol: SemanticSymbol): void {
  index[symbol.name] = symbol;
}

function interruptKindsFor(fileSymbols: FileSymbols | undefined, name: string): InterruptKind[] | undefined {
  const sym = fileSymbols?.[name];
  if (sym?.kind === "function" || sym?.kind === "node") return sym.interruptKinds;
  return undefined;
}

function addLocalDefinition(
  index: SemanticIndex,
  fsPath: string,
  node: FunctionDefinition | GraphNodeDefinition | TypeAlias | ClassDefinition,
  fileSymbols: FileSymbols | undefined,
): void {
  switch (node.type) {
    case "function":
      addSymbol(index, {
        name: node.functionName,
        originalName: node.functionName,
        kind: "function",
        source: "local",
        filePath: fsPath,
        loc: node.loc,
        parameters: node.parameters,
        returnType: node.returnType,
        interruptKinds: interruptKindsFor(fileSymbols, node.functionName),
      });
      break;
    case "graphNode":
      addSymbol(index, {
        name: node.nodeName,
        originalName: node.nodeName,
        kind: "node",
        source: "local",
        filePath: fsPath,
        loc: node.loc,
        parameters: node.parameters,
        returnType: node.returnType,
        interruptKinds: interruptKindsFor(fileSymbols, node.nodeName),
      });
      break;
    case "typeAlias":
      addSymbol(index, {
        name: node.aliasName,
        originalName: node.aliasName,
        kind: "type",
        source: "local",
        filePath: fsPath,
        loc: node.loc,
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
        loc: node.loc,
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
  const sym = opts.symbol;
  const isCallable = sym.kind === "function" || sym.kind === "node";
  addSymbol(index, {
    name: opts.localName,
    originalName: opts.originalName,
    kind: sym.kind,
    source: "imported",
    filePath: opts.filePath,
    loc: sym.loc,
    parameters: isCallable ? sym.parameters : undefined,
    returnType: isCallable ? sym.returnType : undefined,
    aliasedType: sym.kind === "type" ? sym.aliasedType : undefined,
    importPath: opts.importPath,
    interruptKinds: isCallable ? sym.interruptKinds : undefined,
  });
}

function collectImportedSymbols(
  program: AgencyProgram,
  fsPath: string,
  symbolTable: SymbolTable,
): SemanticIndex {
  const index: SemanticIndex = {};

  for (const node of program.nodes) {
    if (node.type === "importNodeStatement") {
      let resolved;
      try {
        resolved = symbolTable.resolveImportedNodes(node, fsPath);
      } catch {
        continue;
      }
      for (const r of resolved) {
        addImportedSymbol(index, {
          filePath: r.file,
          importPath: node.agencyFile,
          originalName: r.originalName,
          localName: r.localName,
          symbol: r.symbol,
        });
      }
    } else if (node.type === "importStatement") {
      let resolved;
      try {
        resolved = symbolTable.resolveImport(node, fsPath);
      } catch {
        continue;
      }
      for (const r of resolved) {
        addImportedSymbol(index, {
          filePath: r.file,
          importPath: node.modulePath,
          originalName: r.originalName,
          localName: r.localName,
          symbol: r.symbol,
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
  interruptKindsByFunction?: Record<string, InterruptKind[]>,
): SemanticIndex {
  const index: SemanticIndex = {};
  const fileSymbols = enrichWithInterruptKinds(symbolTable.getFile(fsPath), interruptKindsByFunction);

  for (const node of program.nodes) {
    if (
      node.type === "function" ||
      node.type === "graphNode" ||
      node.type === "typeAlias" ||
      node.type === "classDefinition"
    ) {
      addLocalDefinition(index, fsPath, node, fileSymbols);
    }
  }

  Object.assign(index, collectImportedSymbols(program, fsPath, symbolTable));

  // Overlay transitive interrupt kinds onto imported symbols
  if (interruptKindsByFunction) {
    for (const [name, sym] of Object.entries(index)) {
      if (sym.source === "imported" && interruptKindsByFunction[name]) {
        index[name] = { ...sym, interruptKinds: interruptKindsByFunction[name] };
      }
    }
  }

  return index;
}

/** Merge transitive interrupt kinds into a copy of file symbols. */
function enrichWithInterruptKinds(
  fileSymbols: FileSymbols | undefined,
  interruptKindsByFunction?: Record<string, InterruptKind[]>,
): FileSymbols | undefined {
  if (!fileSymbols || !interruptKindsByFunction) return fileSymbols;
  const enriched: FileSymbols = {};
  for (const [name, sym] of Object.entries(fileSymbols)) {
    if ((sym.kind === "function" || sym.kind === "node") && interruptKindsByFunction[name]) {
      enriched[name] = { ...sym, interruptKinds: interruptKindsByFunction[name] };
    } else {
      enriched[name] = sym;
    }
  }
  return enriched;
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

function prettyPrintType(vt: VariableType, indent: number = 0): string {
  if (vt.type === "objectType") {
    if (vt.properties.length === 0) return "{}";
    const inner = indent + 2;
    const pad = " ".repeat(inner);
    const lines = vt.properties.map(
      (p) => `${pad}${p.key}: ${prettyPrintType(p.value, inner)}`,
    );
    return `{\n${lines.join("\n")}\n${" ".repeat(indent)}}`;
  }
  return formatTypeHint(vt);
}

function formatSignature(symbol: SemanticSymbol): string {
  switch (symbol.kind) {
    case "function": {
      const params = formatParameters(symbol.parameters);
      const ret = symbol.returnType ? `: ${formatTypeHint(symbol.returnType)}` : "";
      return `def ${symbol.name}(${params})${ret}`;
    }
    case "node": {
      const params = formatParameters(symbol.parameters);
      const ret = symbol.returnType ? `: ${formatTypeHint(symbol.returnType)}` : "";
      return `node ${symbol.name}(${params})${ret}`;
    }
    case "type":
      return symbol.aliasedType
        ? `type ${symbol.name} = ${prettyPrintType(symbol.aliasedType)}`
        : `type ${symbol.name}`;
    case "class":
      return `class ${symbol.name}`;
    case "constant":
      return `static const ${symbol.name}${symbol.returnType ? `: ${formatTypeHint(symbol.returnType)}` : ""}`;
  }
}

function formatInterruptKinds(interruptKinds: InterruptKind[] | undefined): string {
  if (!interruptKinds || interruptKinds.length === 0) return "";
  const kinds = interruptKinds.map((ik) => `\`${ik.kind}\``).join(", ");
  return `\n\n**Interrupts:** ${kinds}`;
}

export function formatSemanticHover(symbol: SemanticSymbol): string {
  const signature = formatSignature(symbol);
  const codeBlock = `\`\`\`typescript\n${signature}\n\`\`\``;
  const interrupts = formatInterruptKinds(symbol.interruptKinds);
  if (symbol.source === "local") {
    return `${codeBlock}${interrupts}`;
  }

  const aliasNote = symbol.originalName !== symbol.name
    ? ` as \`${symbol.originalName}\``
    : "";
  return `${codeBlock}\n\nImported from \`${symbol.importPath}\`${aliasNote}${interrupts}`;
}
