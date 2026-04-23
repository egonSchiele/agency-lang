import * as fs from "fs";
import * as path from "path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { buildSymbolTable } from "../symbolTable.js";
import { getWorkspaceForFile } from "../lsp/workspace.js";
import { runDiagnostics } from "../lsp/diagnostics.js";
import { handleDefinition } from "../lsp/definition.js";
import { handleHover } from "../lsp/hover.js";
import { getDocumentSymbols } from "../lsp/documentSymbol.js";
import { handleFormatting } from "../lsp/formatting.js";
import { getCompletions } from "../lsp/completion.js";
import { CompletionItemKind, DiagnosticSeverity, SymbolKind } from "vscode-languageserver-protocol";
import { fileURLToPath, pathToFileURL } from "url";

type DocumentInput = {
  file_path: string;
  text?: string;
};

type PositionInput = DocumentInput & {
  line: number;
  character: number;
};

function createDocument(input: DocumentInput): {
  fsPath: string;
  doc: TextDocument;
} {
  const fsPath = path.resolve(input.file_path);
  let text = input.text;
  if (text === undefined) {
    try {
      text = fs.readFileSync(fsPath, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read '${fsPath}': ${message}`);
    }
  }
  const doc = TextDocument.create(pathToFileURL(fsPath).href, "agency", 1, text);
  return { fsPath, doc };
}

function getSymbolTableAndConfig(fsPath: string) {
  const { config } = getWorkspaceForFile(fsPath);
  const symbolTable = buildSymbolTable(fsPath, config);
  return { config, symbolTable };
}

function summarizeSeverity(severity?: DiagnosticSeverity): string {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "error";
    case DiagnosticSeverity.Warning:
      return "warning";
    case DiagnosticSeverity.Information:
      return "info";
    case DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "unknown";
  }
}

function summarizeSymbolKind(kind: SymbolKind): string {
  switch (kind) {
    case SymbolKind.Function:
      return "function";
    case SymbolKind.Module:
      return "node";
    case SymbolKind.TypeParameter:
      return "type";
    case SymbolKind.Class:
      return "class";
    default:
      return "symbol";
  }
}

function summarizeCompletionKind(kind?: CompletionItemKind): string {
  switch (kind) {
    case CompletionItemKind.Function:
      return "function";
    case CompletionItemKind.Module:
      return "node";
    case CompletionItemKind.TypeParameter:
      return "type";
    case CompletionItemKind.Class:
      return "class";
    default:
      return "identifier";
  }
}

export function agencyDiagnostics(input: DocumentInput) {
  const { fsPath, doc } = createDocument(input);
  const { config, symbolTable } = getSymbolTableAndConfig(fsPath);
  const { diagnostics } = runDiagnostics(doc, fsPath, config, symbolTable);

  return {
    diagnostics: diagnostics.map((diagnostic) => ({
      severity: summarizeSeverity(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source ?? "agency",
      start: diagnostic.range.start,
      end: diagnostic.range.end,
    })),
  };
}

export function agencyDefinition(input: PositionInput) {
  const { fsPath, doc } = createDocument(input);
  const { config, symbolTable } = getSymbolTableAndConfig(fsPath);
  const { semanticIndex } = runDiagnostics(doc, fsPath, config, symbolTable);
  const location = handleDefinition(
    {
      textDocument: { uri: doc.uri },
      position: { line: input.line, character: input.character },
    },
    doc,
    fsPath,
    semanticIndex,
  );

  if (!location) {
    return { definition: null };
  }

  return {
    definition: {
      file_path: fileURLToPath(location.uri),
      start: location.range.start,
      end: location.range.end,
    },
  };
}

export function agencyHover(input: PositionInput) {
  const { fsPath, doc } = createDocument(input);
  const { config, symbolTable } = getSymbolTableAndConfig(fsPath);
  const { diagnostics, semanticIndex } = runDiagnostics(doc, fsPath, config, symbolTable);

  if (Object.keys(semanticIndex).length === 0 && diagnostics.length > 0) {
    return { hover: null, diagnostics: diagnostics.length };
  }

  const hover = handleHover(
    {
      textDocument: { uri: doc.uri },
      position: { line: input.line, character: input.character },
    },
    doc,
    semanticIndex,
  );

  const contents = hover?.contents;
  let hoverText: unknown = null;
  if (contents && typeof contents === "object" && "kind" in contents && "value" in contents) {
    hoverText = contents.value;
  } else if (Array.isArray(contents)) {
    hoverText = contents;
  } else if (typeof contents === "string") {
    hoverText = contents;
  }

  return { hover: hoverText };
}

export function agencyDocumentSymbols(input: DocumentInput) {
  const { fsPath, doc } = createDocument(input);
  const { config, symbolTable } = getSymbolTableAndConfig(fsPath);
  const { program } = runDiagnostics(doc, fsPath, config, symbolTable);
  const symbols = program ? getDocumentSymbols(program) : [];

  return {
    symbols: symbols.map((symbol) => ({
      name: symbol.name,
      kind: summarizeSymbolKind(symbol.kind),
      start: symbol.range.start,
      end: symbol.range.end,
    })),
  };
}

export function agencyFormat(input: DocumentInput) {
  const { fsPath, doc } = createDocument(input);
  const { config } = getWorkspaceForFile(fsPath);
  const edits = handleFormatting(
    {
      textDocument: { uri: doc.uri },
      options: { tabSize: 2, insertSpaces: true },
    },
    doc,
    config,
  );

  const formatted = edits.length > 0 ? edits[0].newText : doc.getText();
  return {
    changed: formatted !== doc.getText(),
    formatted,
    edit_count: edits.length,
  };
}

export function agencyCompletions(input: DocumentInput) {
  const { fsPath, doc } = createDocument(input);
  const { config, symbolTable } = getSymbolTableAndConfig(fsPath);
  const { info } = runDiagnostics(doc, fsPath, config, symbolTable);

  if (!info) {
    return { completions: [] };
  }

  const completions = getCompletions(info);

  return {
    completions: completions.map((item) => ({
      label: item.label,
      kind: summarizeCompletionKind(item.kind),
    })),
  };
}
