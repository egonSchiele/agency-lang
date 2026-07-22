import {
  createConnection,
  ProposedFeatures,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocuments,
  TextDocumentSyncKind,
  InitializeResult,
  InitializeParams,
  CompletionList,
  CodeActionKind,
  DidChangeWatchedFilesNotification,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as path from "path";
import { SymbolTable } from "../symbolTable.js";
import { evictParseCache } from "../parseCache.js";
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
import { handleTypeDefinition } from "./typeDefinition.js";
import { getCodeActions, REMOVE_UNUSED_IMPORTS_KIND } from "./codeAction.js";
import { getWorkspaceSymbols } from "./workspaceSymbol.js";
import type { DocumentState } from "./documentState.js";

// eslint-disable-next-line max-lines-per-function -- LSP server wiring; refactor tracked separately
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

  // Whether the client can accept a dynamic `didChangeWatchedFiles`
  // registration. When true we register a `**/*.agency` watcher ourselves in
  // `onInitialized` so file-change events arrive regardless of how (or whether)
  // the client was configured to watch Agency files.
  let supportsWatchedFilesRegistration = false;

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    supportsWatchedFilesRegistration =
      params.capabilities.workspace?.didChangeWatchedFiles
        ?.dynamicRegistration ?? false;
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        completionProvider: { triggerCharacters: [".", "/", ":"] },
        signatureHelpProvider: { triggerCharacters: ["(", ","] },
        definitionProvider: true,
        typeDefinitionProvider: true,
        documentSymbolProvider: true,
        documentFormattingProvider: true,
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
        documentHighlightProvider: true,
        foldingRangeProvider: true,
        codeActionProvider: {
          codeActionKinds: [
            CodeActionKind.QuickFix,
            CodeActionKind.SourceFixAll,
            REMOVE_UNUSED_IMPORTS_KIND,
          ],
        },
        workspaceSymbolProvider: true,
        documentLinkProvider: {},
      },
    };
  });

  connection.onInitialized(() => {
    if (!supportsWatchedFilesRegistration) return;
    // Watch both Agency source and config files. `agency.json` changes were
    // already handled by `onDidChangeWatchedFiles`; registering the watcher
    // here makes that (and the new `.agency` handling) work even for clients
    // that do not watch these globs on their own.
    connection.client
      .register(DidChangeWatchedFilesNotification.type, {
        watchers: [
          { globPattern: "**/*.agency" },
          { globPattern: "**/agency.json" },
        ],
      })
      .catch(() => {
        // Registration is best-effort; some clients reject it. Open-document
        // edits still update via onDidChangeContent.
      });
  });

  function updateDocument(doc: TextDocument) {
    const fsPath = uriToPath(doc.uri);
    const { config } = getWorkspaceForFile(fsPath);

    let symbolTable = new SymbolTable();
    try {
      // Feed every open document's live buffer as an override so unsaved edits
      // (e.g. a just-typed `import`) are reflected in the symbol table. Building
      // purely from disk would resolve imports against the stale saved files,
      // making `resolveImports` reject symbols from a module a buffer imports
      // but the saved file does not — for the active file OR any open file it
      // imports.
      const overrides: Record<string, string> = {};
      for (const open of documents.all()) {
        overrides[path.resolve(uriToPath(open.uri))] = open.getText();
      }
      symbolTable = SymbolTable.build(fsPath, config, overrides);
    } catch {
      // If symbol table build fails (e.g. file not on disk yet), continue with empty table
    }

    const { diagnostics, program, info, semanticIndex, scopes, lintFindings, lintBatchEdits } =
      runDiagnostics(doc, fsPath, config, symbolTable);
    connection.sendDiagnostics({ uri: doc.uri, diagnostics });

    if (program && info) {
      docStates.set(doc.uri, {
        program,
        info,
        semanticIndex,
        scopes,
        symbolTable,
        lintFindings,
        lintBatchEdits,
        lintVersion: doc.version,
      });
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
    let anyAgencyChanged = false;
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
      } else if (change.uri.endsWith(".agency")) {
        // A saved (or externally changed) .agency file may be imported by open
        // documents, so their symbol tables are now stale. Evict the file's
        // cached parse — the mtime+size cache key can miss same-size edits in a
        // long-lived process — and rebuild every open document below.
        evictParseCache(path.resolve(uriToPath(change.uri)));
        anyAgencyChanged = true;
      }
    }
    if (anyAgencyChanged) {
      // Import graphs cross files and workspaces, so a single .agency change can
      // invalidate any open document. Rebuilding all open docs is the simple,
      // always-correct choice; there are only ever a handful open at once.
      for (const doc of documents.all()) {
        updateDocument(doc);
      }
    }
  });

  connection.onDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const state = docStates.get(params.textDocument.uri);
    return handleDefinition(params, doc, uriToPath(doc.uri), state?.semanticIndex ?? {}, state?.program, state?.scopes);
  });

  connection.onTypeDefinition((params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const state = docStates.get(params.textDocument.uri);
    if (!state) return null;
    return handleTypeDefinition(params, doc, state.program, state.scopes, state.semanticIndex);
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
    return handleHover(params, doc, state.semanticIndex, state.program, state.scopes);
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
      fsPath: uriToPath(doc.uri),
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

  connection.onFoldingRanges((params) => {
    const doc = documents.get(params.textDocument.uri);
    const state = docStates.get(params.textDocument.uri);
    if (!doc || !state) return [];
    return getFoldingRanges(state.program, doc);
  });

  connection.onCodeAction((params) => {
    const doc = documents.get(params.textDocument.uri);
    const state = docStates.get(params.textDocument.uri);
    if (!doc || !state) return [];
    // Reuse the lint results the diagnostics pass already computed — but only
    // when the buffer has not changed since (diagnostics run debounced, so a
    // code-action request can be newer). On a version mismatch getCodeActions
    // falls back to a fresh parse; stale offset edits would corrupt the text.
    const cachedLint =
      state.lintVersion === doc.version
        ? { findings: state.lintFindings, batchEdits: state.lintBatchEdits }
        : undefined;
    return getCodeActions(params, doc, state.symbolTable, cachedLint);
  });

  connection.onDocumentLinks((params) => {
    const doc = documents.get(params.textDocument.uri);
    const state = docStates.get(params.textDocument.uri);
    if (!doc || !state) return [];
    return getDocumentLinks(state.program, doc, uriToPath(doc.uri));
  });

  connection.onWorkspaceSymbol((params) => {
    const firstState = docStates.values().next().value;
    if (!firstState) return [];
    return getWorkspaceSymbols(params.query, firstState.symbolTable);
  });

  documents.listen(connection);
  connection.listen();
}
