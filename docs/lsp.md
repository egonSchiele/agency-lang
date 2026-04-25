# Agency Language Server (LSP)

The Agency language server provides diagnostics, go-to-definition, document symbols, hover, completion, and formatting for `.agency` files over the standard Language Server Protocol.

Any LSP-capable editor can use it. For coding agents, the current first-class setup path is:

- OpenCode via `agency lsp setup opencode`
- Claude Code via `agency lsp setup claude-code`

As of April 21, 2026, Pi does not expose documented native LSP server configuration, so `agency lsp setup pi` returns an explicit unsupported message instead of writing guessed config.

Codex is handled through MCP instead of native LSP config:

```bash
agency mcp setup codex
```

For Codex MCP setup details, see [docs/mcp.md](mcp.md).

## Prerequisites

Build the project so the server binary is available:

```bash
pnpm run build
```

The server is invoked as:

```
agency lsp
```

## Coding Agents

Use this page for native editor/LSP integrations and agent clients that accept LSP server configuration. For Codex, use the MCP setup flow in [docs/mcp.md](mcp.md).

### OpenCode

Generate project-local config:

```bash
agency lsp setup opencode
```

This writes `opencode.json` with:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": {
    "agency": {
      "command": ["agency", "lsp"],
      "extensions": [".agency"]
    }
  }
}
```

### Claude Code

Scaffold a local Claude Code plugin:

```bash
agency lsp setup claude-code
```

This creates:

```text
.claude/plugins/agency-lsp/.claude-plugin/plugin.json
.claude/plugins/agency-lsp/.lsp.json
```

Then start Claude Code with the plugin loaded:

```bash
claude --plugin-dir ./.claude/plugins/agency-lsp
```

Or use that directory as the basis for a marketplace/plugin install later.

### Codex

Codex CLI uses MCP server configuration rather than a native LSP config block.

Generate a Codex MCP entry:

```bash
agency mcp setup codex
```

That updates `~/.codex/config.toml` with an MCP server entry that runs Agency's MCP server over stdio.

### Pi

Pi currently documents settings, packages, extensions, and RPC mode, but not native LSP server configuration. The setup command reports this directly:

```bash
agency lsp setup pi
```

## VS Code

The companion extension at [github.com/egonSchiele/agency-vscode-extension](https://github.com/egonSchiele/agency-vscode-extension) provides TextMate grammar and language configuration. Once the extension is updated to use `vscode-languageclient` (tracked in that repo), installing it is all that's needed.

In the meantime, you can wire up the LSP manually with a minimal `vscode-languageclient` snippet in `.vscode/settings.json` (requires the [vscode-languageclient](https://www.npmjs.com/package/vscode-languageclient) package in a local extension).

## Neovim

### Using `vim.lsp.start` (Neovim 0.8+)

Add to your `ftplugin/agency.lua` (or an `autocmd` for `BufEnter *.agency`):

```lua
vim.lsp.start({
  name = "agency",
  cmd = { "agency", "lsp" },
  root_dir = vim.fs.dirname(
    vim.fs.find({ "agency.json" }, { upward = true })[1]
  ) or vim.fn.getcwd(),
  filetypes = { "agency" },
})
```

### Using `nvim-lspconfig`

If the Agency language server is added to [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig), configure it as:

```lua
require("lspconfig").agency.setup({})
```

Until then, use the manual `vim.lsp.start` snippet above.

### File type detection

Neovim does not recognise `.agency` files by default. Add this to your config:

```lua
vim.filetype.add({ extension = { agency = "agency" } })
```

## Helix

Add to `~/.config/helix/languages.toml`:

```toml
[[language]]
name = "agency"
scope = "source.agency"
file-types = ["agency"]
comment-token = "//"
indent = { tab-width = 2, unit = "  " }

[language.language-server]
command = "agency"
args = ["lsp"]
```

## Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "languages": {
    "Agency": {
      "language_servers": ["agency-lsp"]
    }
  },
  "lsp": {
    "agency-lsp": {
      "binary": {
        "path": "agency",
        "args": ["lsp"]
      }
    }
  }
}
```

## Emacs (eglot)

```elisp
(require 'eglot)
(add-to-list 'eglot-server-programs
             '(agency-mode . ("agency" "lsp")))
(add-hook 'agency-mode-hook 'eglot-ensure)
```

## Project configuration

The server walks upward from the open file to find `agency.json`. If found, it loads compiler and runtime options from there (same file as `agency build` uses — see [docs/config.md](config.md)).

You can override the config path via `initializationOptions`:

```json
{
  "initializationOptions": {
    "configPath": "/absolute/path/to/agency.json"
  }
}
```

If no `agency.json` is found, the server falls back to default options.

## Capabilities

| LSP feature | What it does |
|---|---|
| `textDocument/publishDiagnostics` | Parse errors, unresolved imports, type errors |
| `textDocument/definition` | Jump to definition of a function, node, or type alias |
| `textDocument/documentSymbol` | Document outline (functions, nodes, type aliases, classes) |
| `textDocument/formatting` | Full-document format via the Agency formatter |
| `textDocument/hover` | Symbol kind and parameter list |
| `textDocument/completion` | Identifier completion from the current file's scope |
