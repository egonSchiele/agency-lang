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
import { SymbolTable } from "../symbolTable.js";
import { uriToPath } from "./uri.js";
import { getWorkspaceForFile, invalidateWorkspace } from "./workspace.js";
import { runDiagnostics } from "./diagnostics.js";
import { handleDefinition } from "./definition.js";
import { getDocumentSymbols } from "./documentSymbol.js";
import { handleFormatting } from "./formatting.js";
import { handleHover } from "./hover.js";
import { getCompletions } from "./completion.js";
import { handleDocumentHighlight } from "./documentHighlight.js";
import { getFoldingRanges } from "./foldingRange.js";
import { getDocumentLinks } from "./documentLink.js";
import { handleSignatureHelp } from "./signatureHelp.js";
import { handleReferences } from "./references.js";
import { handleRename, handlePrepareRename } from "./rename.js";
import { getInlayHints } from "./inlayHint.js";
import type { DocumentState } from "./documentState.js";

export function startServer(): void {
  const connection = createConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
  );
  const documents = new TextDocuments(TextDocument);

  // Per-document state: parsed program, compilation info, semantic index, scopes, symbol table
  const docStates = new Map<string, DocumentState>();

  // Debounce timers for diagnostics (per URI)
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  connection.onInitialize((): InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        completionProvider: { triggerCharacters: ["."] },
        signatureHelpProvider: { triggerCharacters: ["(", ","] },
        definitionProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
        documentHighlightProvider: true,
        inlayHintProvider: true,
        foldingRangeProvider: true,
        documentLinkProvider: {},
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

    const { diagnostics, program, info, semanticIndex, scopes } = runDiagnostics(
      doc,
      fsPath,
      config,
      symbolTable,
    );
    connection.sendDiagnostics({ uri: doc.uri, diagnostics });

    if (program && info) {
      docStates.set(doc.uri, { program, info, semanticIndex, scopes, symbolTable });
    } else {
      docStates.delete(doc.uri);
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
    docStates.delete(event.document.uri);
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
    const state = docStates.get(params.textDocument.uri);
    return handleDefinition(params, doc, uriToPath(doc.uri), state?.semanticIndex ?? {});
  });

  connection.onDocumentSymbol((params) => {
    const state = docStates.get(params.textDocument.uri);
    if (!state) return [];
    return getDocumentSymbols(state.program);
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
    const state = docStates.get(params.textDocument.uri);
    if (!state) return null;
    return handleHover(params, doc, state.semanticIndex);
  });

  connection.onCompletion((params) => {
    const doc = documents.get(params.textDocument.uri);
    const state = docStates.get(params.textDocument.uri);
    if (!state || !doc) return CompletionList.create([], true);
    const context = {
      source: doc.getText(),
      line: params.position.line,
      character: params.position.character,
      scopes: state.scopes,
      program: state.program,
    };
    return CompletionList.create(getCompletions(state.info, context), false);
  });

  connection.onSignatureHelp((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const state = docStates.get(params.textDocument.uri);
    return handleSignatureHelp(params, doc, state?.semanticIndex ?? {});
  });

  connection.onReferences((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    return handleReferences(params, doc);
  });

  connection.onPrepareRename((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    return handlePrepareRename(params, doc);
  });

  connection.onRenameRequest((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    return handleRename(params, doc);
  });

  connection.onDocumentHighlight((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];
    return handleDocumentHighlight(params, doc);
  });

  connection.languages.inlayHint.on((params) => {
    const state = docStates.get(params.textDocument.uri);
    if (!state) return [];
    return getInlayHints(state.program, state.scopes);
  });

  connection.onFoldingRanges((params) => {
    const doc = documents.get(params.textDocument.uri);
    const state = docStates.get(params.textDocument.uri);
    if (!doc || !state) return [];
    return getFoldingRanges(state.program, doc);
  });

  connection.onDocumentLinks((params) => {
    const doc = documents.get(params.textDocument.uri);
    const state = docStates.get(params.textDocument.uri);
    if (!doc || !state) return [];
    return getDocumentLinks(state.program, doc, uriToPath(doc.uri));
  });

  documents.listen(connection);
  connection.listen();
}
