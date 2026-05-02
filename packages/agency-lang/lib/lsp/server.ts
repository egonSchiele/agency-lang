import {
  createConnection,
  ProposedFeatures,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocuments,
  TextDocumentSyncKind,
  InitializeResult,
  CompletionList,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { AgencyProgram } from "../types.js";
import { SymbolTable } from "../symbolTable.js";
import { uriToPath } from "./uri.js";
import { getWorkspaceForFile, invalidateWorkspace } from "./workspace.js";
import { runDiagnostics } from "./diagnostics.js";
import { handleDefinition } from "./definition.js";
import { getDocumentSymbols } from "./documentSymbol.js";
import { handleFormatting } from "./formatting.js";
import { handleHover } from "./hover.js";
import { getCompletions } from "./completion.js";
import type { ProgramInfo } from "../programInfo.js";
import type { SemanticIndex } from "./semantics.js";

export function startServer(): void {
  const connection = createConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
  );
  const documents = new TextDocuments(TextDocument);

  // Per-document state: latest parsed program and program info
  const docPrograms = new Map<string, AgencyProgram>();
  const docInfos = new Map<string, ProgramInfo>();
  const docSemanticIndexes = new Map<string, SemanticIndex>();

  // Debounce timers for diagnostics (per URI)
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  connection.onInitialize((): InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        completionProvider: { triggerCharacters: ["."] },
        definitionProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
      },
    };
  });

  function updateDocument(doc: TextDocument) {
    const fsPath = uriToPath(doc.uri);
    const { config } = getWorkspaceForFile(fsPath);

    let symbolTable = new SymbolTable();
    try {
      symbolTable = SymbolTable.build(fsPath, config);
    } catch {
      // If symbol table build fails (e.g. file not on disk yet), continue with empty table
    }

    const { diagnostics, program, info, semanticIndex } = runDiagnostics(
      doc,
      fsPath,
      config,
      symbolTable,
    );
    connection.sendDiagnostics({ uri: doc.uri, diagnostics });

    if (program && info) {
      docPrograms.set(doc.uri, program);
      docInfos.set(doc.uri, info);
      docSemanticIndexes.set(doc.uri, semanticIndex);
    } else {
      docPrograms.delete(doc.uri);
      docInfos.delete(doc.uri);
      docSemanticIndexes.delete(doc.uri);
    }
  }

  // Track URIs just opened so onDidChangeContent (which also fires on open)
  // doesn't schedule a redundant debounced update.
  const justOpened = new Set<string>();

  documents.onDidOpen((event) => {
    justOpened.add(event.document.uri);
    updateDocument(event.document);
  });

  documents.onDidChangeContent((change) => {
    // Skip the open case — already handled synchronously by onDidOpen above
    if (justOpened.delete(change.document.uri)) return;

    const uri = change.document.uri;
    const existing = debounceTimers.get(uri);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      uri,
      setTimeout(() => {
        debounceTimers.delete(uri);
        updateDocument(change.document);
      }, 150),
    );
  });

  documents.onDidClose((event) => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    docPrograms.delete(event.document.uri);
    docInfos.delete(event.document.uri);
    docSemanticIndexes.delete(event.document.uri);
  });

  connection.onDidChangeWatchedFiles((params) => {
    for (const change of params.changes) {
      if (change.uri.endsWith("agency.json")) {
        const root = uriToPath(change.uri).replace(/\/agency\.json$/, "");
        invalidateWorkspace(root);
        // Re-run diagnostics for all open documents in this workspace
        for (const doc of documents.all()) {
          const docPath = uriToPath(doc.uri);
          if (docPath.startsWith(root)) {
            updateDocument(doc);
          }
        }
      }
    }
  });

  connection.onDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const semanticIndex = docSemanticIndexes.get(params.textDocument.uri) ?? {};
    return handleDefinition(params, doc, uriToPath(doc.uri), semanticIndex);
  });

  connection.onDocumentSymbol((params) => {
    const program = docPrograms.get(params.textDocument.uri);
    if (!program) return [];
    return getDocumentSymbols(program);
  });

  connection.onDocumentFormatting((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    const fsPath = uriToPath(doc.uri);
    const { config } = getWorkspaceForFile(fsPath);
    return handleFormatting(params, doc, config);
  });

  connection.onHover((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const semanticIndex = docSemanticIndexes.get(params.textDocument.uri);
    if (!semanticIndex) return null;
    return handleHover(params, doc, semanticIndex);
  });

  connection.onCompletion((params) => {
    const info = docInfos.get(params.textDocument.uri);
    if (!info) return CompletionList.create([], true);
    return CompletionList.create(getCompletions(info), false);
  });

  documents.listen(connection);
  connection.listen();
}
