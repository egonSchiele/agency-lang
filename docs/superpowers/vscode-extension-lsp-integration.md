# Adding LSP Client Support to the Agency VS Code Extension

This document describes the exact changes needed to add Language Server Protocol (LSP) client support to the `agency-vscode-extension` VS Code extension. The Agency language server already exists and works — it just needs a client in the extension to connect to it.

## Background

The Agency LSP server:
- Is started via the command `agency lsp`
- Communicates over **stdio** (stdin/stdout)
- Uses `vscode-languageserver` v9 on the server side
- Provides these capabilities:
  - `textDocumentSync`: Incremental
  - `hoverProvider`: true
  - `completionProvider`: triggers on `.`
  - `definitionProvider`: true (go-to-definition for functions, nodes, type aliases)
  - `documentSymbolProvider`: true (document outline)
  - `documentFormattingProvider`: true (full-document formatting)
  - `textDocument/publishDiagnostics`: pushed from server (parse errors, unresolved imports, type errors)
- Watches for `agency.json` changes and re-runs diagnostics when it changes
- Discovers project config by walking upward from the open file looking for `agency.json`

## What needs to change

### 1. Add npm dependencies

Add these to the extension's `package.json` under `dependencies`:

```json
{
  "dependencies": {
    "vscode-languageclient": "^9.0.1"
  }
}
```

The `vscode-languageclient` package is the official VS Code LSP client library. Version 9.x matches the `vscode-languageserver` v9 used by the Agency LSP server.

Run `npm install` after adding this.

### 2. Update `package.json` metadata

Make sure the extension's `package.json` has the following (some of this may already exist):

#### `activationEvents`

The extension should activate when an `.agency` file is opened. If you already have `onLanguage:agency`, that's fine. If not, add it:

```json
{
  "activationEvents": [
    "onLanguage:agency"
  ]
}
```

Note: if the extension's `contributes.languages` section already declares `agency` with the `.agency` extension, VS Code may auto-activate without an explicit `activationEvents` entry, but it's good to be explicit.

#### `contributes.languages`

Make sure the language is registered (this likely already exists for syntax highlighting):

```json
{
  "contributes": {
    "languages": [
      {
        "id": "agency",
        "aliases": ["Agency"],
        "extensions": [".agency"],
        "configuration": "./language-configuration.json"
      }
    ]
  }
}
```

#### `contributes.configuration` (optional but recommended)

Add a setting so users can configure the path to the `agency` CLI if it's not on their PATH:

```json
{
  "contributes": {
    "configuration": {
      "title": "Agency",
      "properties": {
        "agency.lsp.path": {
          "type": "string",
          "default": "agency",
          "description": "Path to the agency CLI executable. Defaults to 'agency' (found via PATH)."
        }
      }
    }
  }
}
```

### 3. Update `extension.ts` (or create it)

This is the main change. The extension entry point needs to create and manage an LSP client. Here is the complete implementation:

```typescript
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("agency.lsp");
  const command = config.get<string>("path", "agency");

  // The server is started as a child process communicating over stdio.
  // `agency lsp` starts the LSP server and reads/writes JSON-RPC on stdin/stdout.
  const serverOptions: ServerOptions = {
    run: {
      command,
      args: ["lsp"],
      transport: TransportKind.stdio,
    },
    debug: {
      command,
      args: ["lsp"],
      transport: TransportKind.stdio,
    },
  };

  const clientOptions: LanguageClientOptions = {
    // Activate the client for .agency files
    documentSelector: [{ scheme: "file", language: "agency" }],

    // If the user has a multi-root workspace, sync all workspace folders
    synchronize: {
      // Watch for agency.json changes so the server can reload config.
      // The server handles onDidChangeWatchedFiles for agency.json internally.
      fileEvents: vscode.workspace.createFileSystemWatcher("**/agency.json"),
    },
  };

  client = new LanguageClient(
    "agencyLanguageServer",
    "Agency Language Server",
    serverOptions,
    clientOptions,
  );

  // Start the client, which also starts the server process.
  client.start();

  context.subscriptions.push({
    dispose: () => {
      if (client) {
        client.stop();
      }
    },
  });
}

export function deactivate(): Promise<void> | undefined {
  if (client) {
    return client.stop();
  }
  return undefined;
}
```

### 4. Update the `main` entry point in `package.json`

Make sure `package.json` points to the compiled extension entry point:

```json
{
  "main": "./out/extension.js"
}
```

(Adjust the path to match your build output directory — it might be `./dist/extension.js` or `./out/extension.js` depending on your tsconfig/build setup.)

### 5. Make sure TypeScript compilation is set up

The extension needs to compile TypeScript. If there's already a `tsconfig.json`, make sure it includes the `extension.ts` file. If not, here's a minimal one:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "lib": ["ES2020"],
    "outDir": "out",
    "rootDir": "src",
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

Adjust `rootDir` based on where `extension.ts` lives (e.g., `src/` or the root).

### 6. Build script

Make sure `package.json` has a build script:

```json
{
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./"
  }
}
```

## How it all works together

1. User opens a `.agency` file in VS Code
2. The extension activates (triggered by `onLanguage:agency`)
3. `activate()` spawns `agency lsp` as a child process
4. The `LanguageClient` connects to it over stdio using JSON-RPC
5. As the user edits `.agency` files, the client sends `textDocument/didOpen` and `textDocument/didChange` notifications
6. The server responds with diagnostics (pushed via `textDocument/publishDiagnostics`), and handles requests for hover, completion, go-to-definition, document symbols, and formatting
7. The file watcher sends `workspace/didChangeWatchedFiles` when `agency.json` changes, causing the server to reload config and re-run diagnostics

## What users get

| Feature | Description |
|---|---|
| **Inline diagnostics** | Parse errors, unresolved imports, and type errors appear as red/yellow squiggles as you type |
| **Go-to-definition** | Cmd+Click (or F12) on a function, node, or type name jumps to its definition |
| **Document outline** | The Outline panel (and breadcrumbs) show all functions, nodes, type aliases, and classes |
| **Hover info** | Hovering over a symbol shows its kind (function/node/type) and parameter list |
| **Autocomplete** | Identifier completion from the current file's scope, triggered on `.` or manually |
| **Format document** | Shift+Alt+F formats the entire `.agency` file using the Agency formatter |

## Prerequisites for users

- `agency-lang` must be installed and the `agency` CLI must be on the user's PATH (or they set `agency.lsp.path` in VS Code settings)
- The project should be built (`pnpm run build` in the `agency-lang` repo, or install from npm)

## Testing the integration

1. Build the extension: `npm run compile`
2. Open the extension in VS Code and press F5 to launch the Extension Development Host
3. In the new VS Code window, open a folder with `.agency` files
4. Open an `.agency` file — you should see:
   - Syntax highlighting (from the existing TextMate grammar)
   - Diagnostics appearing for any errors
   - Hover working on function/node/type names
   - Cmd+Click jumping to definitions
   - Completion suggestions appearing as you type
5. Check the Output panel > "Agency Language Server" for any server logs or errors

## Troubleshooting

- If the LSP doesn't start, check that `agency lsp` works from your terminal. Run it directly — it should hang waiting for stdin input (that's normal, it means the server started).
- If you see "command not found", the `agency` CLI isn't on PATH. Set `agency.lsp.path` in VS Code settings to the full path.
- Check the Output panel in VS Code (View > Output, then select "Agency Language Server" from the dropdown) for error messages.
